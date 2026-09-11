// File-system-based persistent state for the OpenCode companion.
// Mirrors the codex-plugin-cc state.mjs pattern: SHA-256 hash of workspace path,
// JSON state file, per-job files and logs.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, readJson, writeJson } from "./fs.mjs";

const MAX_JOBS = 50;

// ---------------------------------------------------------------------------
// Cross-process lock for state.json read-modify-write.
//
// Why a lock file (and why this shape):
// - Node has no portable fcntl-style locking, so the usual same-machine
//   primitive is an atomic create-exclusive operation with bounded retry and
//   backoff. O_EXCL open ("wx") is used here instead of atomic mkdir because
//   it lets the lock carry content (owner nonce + timestamp for staleness) in
//   the same atomic step that creates it, and ownership can later be verified
//   by reading that content back. A mkdir lock would need a second file inside
//   the directory for the same metadata, with a partial-creation window.
// - The lock file lives alongside the state file it guards
//   (<root>/state.json.lock). It is NOT part of the on-disk state format:
//   state.json keeps exactly the same shape ({config, jobs, workspacePath}),
//   and the Rust TUI (oco-tui) only ever reads <root>/state.json, so it never
//   sees the lock file.
// - Readers (loadState) deliberately do NOT take the lock. Every persisted
//   write goes through writeJson's temp-file-then-rename, and rename(2) is
//   atomic: a concurrent reader observes either the complete old file or the
//   complete new file, never a torn one. Locking readers would serialize the
//   hot status-poll loop against writers for no correctness gain. Readers may
//   observe a slightly stale snapshot, which polling callers already tolerate.
// - Only updateState (the sole read-modify-write, used by upsertJob and the
//   review-gate toggles) takes the lock. saveState stays a low-level blind
//   overwrite for seeding/tests; callers that need read-modify-write must use
//   updateState. The lock is non-reentrant: a mutator must not call
//   updateState/saveState-protected paths recursively.
// - The prune-to-MAX_JOBS step in upsertJob runs inside the mutator, i.e.
//   inside the critical section, so concurrent upserts can no longer each
//   read N jobs, each append one, and each prune back to MAX_JOBS while
//   losing the other's record. No change to the prune logic itself was needed.
// - A mutator that throws cannot leak the lock: updateState releases it in a
//   finally block, and since saveState never ran, the file is untouched.
// - Ownership is re-verified AFTER the mutator runs and BEFORE the write
//   lands: if the critical section ever outlives STALE_MS (laptop suspend,
//   SIGSTOP, hypervisor stall), another writer legitimately broke the lock
//   and committed on top of the snapshot we read. Writing now would silently
//   wipe their record, so updateState instead drops the stale snapshot,
//   re-acquires, reloads (which now includes their commit), and re-runs the
//   mutator, bounded by STATE_LOCK_MAX_RMW_ATTEMPTS. A missing lock file
//   counts as lost too: "breaker committed and released" is indistinguishable
//   from "nobody touched anything", so we retry rather than risk the overwrite.
//   Retry (not throw) is correct here because every real mutator recomputes
//   from the state it is handed; mutators must therefore be pure and
//   idempotent w.r.t. re-execution (no external side effects).
//
// Timeout policy:
// - STALE_MS (5s) is ~5000x a conservative 1ms hold budget (measured ~0.15ms
//   per updateState with 40 jobs; single-digit ms even on slow disks), so a
//   live holder is never falsely declared stale even under heavy scheduling
//   jitter, while a dead holder blocks writers for at most ~5s.
// - TIMEOUT_MS (10s) bounds total acquisition: long enough to drain a burst
//   of queued contenders (dozens of processes x ms each), short enough that a
//   genuinely stuck lock surfaces as an error instead of hanging forever.
// - Worst-case wait: a lock left by a holder that dies while holding a fresh
//   lock is broken after STALE_MS (~5s + one backoff slice); a lock that
//   never becomes available fails with an error after TIMEOUT_MS (10s).
// ---------------------------------------------------------------------------

/** Suffix for the lock file guarding a state.json file. */
export const STATE_LOCK_SUFFIX = ".lock";
/** Age after which an unreleased lock is treated as left by a dead holder. */
export const STATE_LOCK_STALE_MS = 5000;
/** Maximum time updateState waits to acquire the lock before throwing. */
export const STATE_LOCK_TIMEOUT_MS = 10000;
/** Initial retry delay; doubles per attempt up to STATE_LOCK_RETRY_MAX_MS. */
export const STATE_LOCK_RETRY_BASE_MS = 10;
export const STATE_LOCK_RETRY_MAX_MS = 100;
/**
 * How many times updateState retries the whole read-modify-write when its
 * lock is stolen mid-update before failing loudly instead of looping forever.
 * Each retry implies a stall longer than STATE_LOCK_STALE_MS plus a racing
 * breaker, so reaching the bound means something is deeply wrong.
 */
export const STATE_LOCK_MAX_RMW_ATTEMPTS = 3;

/**
 * Path of the lock file guarding a workspace's state.json.
 * @param {string} workspacePath
 * @returns {string}
 */
export function stateLockPath(workspacePath) {
  return stateFile(stateRoot(workspacePath)) + STATE_LOCK_SUFFIX;
}

/**
 * Synchronous sleep for lock backoff. Atomics.wait blocks without spinning,
 * unlike a Date.now() busy loop.
 * @param {number} ms
 */
function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Fallback spin; unreachable on supported Node versions.
    }
  }
}

/**
 * Decide whether an existing lock file was left behind by a dead holder.
 *
 * A lock is stale when EITHER its filesystem mtime OR the createdAt timestamp
 * recorded inside it is older than the stale threshold. Both clocks are the
 * same machine's clock (the lock is same-machine by design), so they agree to
 * within milliseconds for a legitimately held lock; either one reading old
 * means the holder has been gone (or stalled) far beyond any legitimate hold
 * time. Unparseable content (e.g. a holder killed between O_EXCL create and
 * writing its payload) falls back to mtime alone. A vanished file is not
 * stale -- the next acquire attempt will simply succeed.
 *
 * Liveness of the recorded pid is deliberately NOT consulted: pids are
 * reused, so "pid alive" can be true for an unrelated process and "pid dead"
 * tells nothing without a start-time pair. The pid is recorded for
 * diagnostics only; the (pid, nonce) pair identifies the owner, where the
 * random nonce is what makes ownership checks safe against pid reuse.
 *
 * @param {string} lockPath
 * @param {number} [now]
 * @returns {boolean}
 */
function isStateLockStale(lockPath, now = Date.now()) {
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }
  let createdAt = null;
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (typeof data?.createdAt === "number" && Number.isFinite(data.createdAt)) {
      createdAt = data.createdAt;
    }
  } catch {
    // Empty/partial/unparseable payload: judge by mtime alone.
  }
  // Future timestamps (clock adjustment) count as fresh, never stale.
  if (mtimeMs !== null && now - mtimeMs > STATE_LOCK_STALE_MS) return true;
  if (createdAt !== null && now - createdAt > STATE_LOCK_STALE_MS) return true;
  return false;
}

/**
 * Acquire the exclusive lock for a workspace's state file.
 * @param {string} workspacePath
 * @returns {{ lockPath: string, nonce: string }} handle for releaseStateLock
 * @throws {Error} if the lock cannot be acquired within STATE_LOCK_TIMEOUT_MS
 */
export function acquireStateLock(workspacePath) {
  const root = stateRoot(workspacePath);
  ensureDir(root);
  const lockPath = stateFile(root) + STATE_LOCK_SUFFIX;
  // Random per-acquisition nonce paired with the pid: pid alone is unsafe
  // because pids are reused, so ownership is proven by this nonce.
  const nonce = `${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  let delay = STATE_LOCK_RETRY_BASE_MS;

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(
          fd,
          JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() })
        );
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath, nonce };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // Another process holds (or held) the lock. A stale one is unlinked --
      // if two processes break it at once, both unlink (one gets ENOENT,
      // ignored) and both retry the O_EXCL create, of which exactly one wins.
      if (isStateLockStale(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Already removed by a racing breaker; retry the create.
        }
      } else {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `Timed out acquiring state lock for workspace ${workspacePath} after ${STATE_LOCK_TIMEOUT_MS}ms`
          );
        }
        // Small jitter to keep a burst of contenders from waking in lockstep.
        sleepSync(Math.min(delay + Math.floor(Math.random() * 10), remaining));
        delay = Math.min(delay * 2, STATE_LOCK_RETRY_MAX_MS);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out acquiring state lock for workspace ${workspacePath} after ${STATE_LOCK_TIMEOUT_MS}ms`
        );
      }
    }
  }
}

/**
 * Check that a lock handle still owns the lock file: the file must exist and
 * still carry our nonce. Conservative by design -- see the ownership note in
 * the header comment and in updateState.
 * @param {{ lockPath: string, nonce: string }} handle
 * @returns {boolean}
 */
function lockStillOurs(handle) {
  try {
    const data = JSON.parse(fs.readFileSync(handle.lockPath, "utf8"));
    return data?.nonce === handle.nonce;
  } catch {
    return false;
  }
}

/**
 * Release a lock previously acquired by acquireStateLock. Only removes the
 * file if it still carries our nonce: if our lock went stale and another
 * process broke it and acquired its own, we must not delete theirs.
 * @param {{ lockPath: string, nonce: string }|null|undefined} handle
 */
export function releaseStateLock(handle) {
  if (!handle?.lockPath || !handle?.nonce) return;
  try {
    const raw = fs.readFileSync(handle.lockPath, "utf8");
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data?.nonce !== handle.nonce) return;
    fs.unlinkSync(handle.lockPath);
  } catch {
    // ENOENT (broken/stolen by a racing breaker, or already released) and
    // unlink races are all best-effort outcomes; nothing left to do.
  }
}

/**
 * Derive the opencode-companion's own plugin data directory from the script's
 * install path. Claude Code installs plugins at
 *   <root>/plugins/cache/<owner>-<repo>/<plugin>/<version>/scripts/lib/state.mjs
 * and assigns per-plugin data at
 *   <root>/plugins/data/<plugin>-<owner>-<repo>/
 * If CLAUDE_PLUGIN_DATA is exported by an UNRELATED plugin (e.g. codex
 * companion), env-based lookup would leak opencode state into that plugin's
 * data dir. Deriving our own path avoids that cross-contamination.
 *
 * Returns null if the path layout doesn't match (e.g. running from repo source).
 */
function deriveOwnDataDir() {
  try {
    const here = fileURLToPath(import.meta.url);
    const parts = here.split(path.sep);
    const cacheIdx = parts.lastIndexOf("cache");
    if (cacheIdx < 1 || cacheIdx + 4 >= parts.length) return null;
    const ownerRepo = parts[cacheIdx + 1];
    const pluginName = parts[cacheIdx + 2];
    const rootBase = parts.slice(0, cacheIdx).join(path.sep);
    return path.join(rootBase, "data", `${pluginName}-${ownerRepo}`);
  } catch {
    return null;
  }
}

/**
 * Compute the state directory root for a workspace.
 *
 * Priority:
 *   1. Explicit opt-in via OPENCODE_COMPANION_DATA (per-plugin override)
 *   2. Self-derived path from script location (correct under normal install)
 *   3. Only trust CLAUDE_PLUGIN_DATA when it already names our own plugin —
 *      otherwise ignore it (another plugin may have exported it into our env)
 *   4. Fallback: /tmp/opencode-companion
 *
 * @param {string} workspacePath
 * @returns {string}
 */
export function stateRoot(workspacePath) {
  let base;
  if (process.env.OPENCODE_COMPANION_DATA) {
    base = path.join(process.env.OPENCODE_COMPANION_DATA, "state");
  } else {
    const own = deriveOwnDataDir();
    const envData = process.env.CLAUDE_PLUGIN_DATA;
    if (own) {
      base = path.join(own, "state");
    } else if (envData && /opencode/i.test(path.basename(envData))) {
      base = path.join(envData, "state");
    } else {
      base = path.join("/tmp", "opencode-companion");
    }
  }
  const hash = crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
  return path.join(base, hash);
}

/**
 * Path to the main state.json file.
 * @param {string} root
 * @returns {string}
 */
function stateFile(root) {
  return path.join(root, "state.json");
}

/**
 * Load the state for a workspace.
 * @param {string} workspacePath
 * @returns {{ config: object, jobs: object[] }}
 */
export function loadState(workspacePath) {
  const root = stateRoot(workspacePath);
  const data = readJson(stateFile(root));
  return data ?? { config: {}, jobs: [] };
}

/**
 * Save the state for a workspace, stamping workspacePath onto state.
 * @param {string} workspacePath
 * @param {object} state
 */
export function saveState(workspacePath, state) {
  const root = stateRoot(workspacePath);
  if (workspacePath) {
    state.workspacePath = workspacePath;
  }
  writeJson(stateFile(root), state);
}

/**
 * Update the state atomically using a mutator function. The whole
 * read-modify-write is serialised across processes with the state lock file,
 * so concurrent upsertJob/report/heal traffic cannot lose records. The lock
 * is always released, even if the mutator throws (in which case nothing is
 * written). The underlying write stays crash-atomic temp-then-rename; the
 * lock is in addition to it, not instead of it.
 *
 * If the lock is stolen mid-update (this section outlived STATE_LOCK_STALE_MS
 * and another writer legitimately broke in and committed), the write is NOT
 * allowed to land over their commit: the stale snapshot is dropped and the
 * whole read-modify-write is retried on fresh state, up to
 * STATE_LOCK_MAX_RMW_ATTEMPTS times, then a clear error is thrown. The
 * mutator must therefore be pure and idempotent w.r.t. re-execution: no
 * external side effects, recompute from the state it is handed. All real
 * mutators satisfy this (review-gate toggles, clear filter, upsertJob merge).
 * @param {string} workspacePath
 * @param {(state: object) => void} mutator
 * @returns {object} the updated state
 */
export function updateState(workspacePath, mutator) {
  let handle = acquireStateLock(workspacePath);
  try {
    for (let attempt = 1; ; attempt++) {
      const state = loadState(workspacePath);
      mutator(state);
      if (lockStillOurs(handle)) {
        saveState(workspacePath, state);
        releaseStateLock(handle);
        handle = null;
        return state;
      }
      // Stolen (or vanished) mid-update: our snapshot predates a concurrent
      // commit, so writing it would reintroduce the lost-record race.
      releaseStateLock(handle);
      if (attempt >= STATE_LOCK_MAX_RMW_ATTEMPTS) {
        throw new Error(
          `Lost state lock for workspace ${workspacePath} mid-update ${attempt} time(s); refusing to overwrite a concurrent commit`
        );
      }
      handle = acquireStateLock(workspacePath);
    }
  } finally {
    releaseStateLock(handle);
  }
}

/**
 * Generate a unique job ID.
 * @param {string} prefix - e.g. "review", "task"
 * @returns {string}
 */
export function generateJobId(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Insert or update a job in the state.
 * @param {string} workspacePath
 * @param {object} job
 */
export function upsertJob(workspacePath, job) {
  updateState(workspacePath, (state) => {
    if (!state.jobs) state.jobs = [];
    const idx = state.jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      state.jobs[idx] = { ...state.jobs[idx], ...job, updatedAt: new Date().toISOString() };
    } else {
      state.jobs.push({ ...job, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    // Prune old jobs beyond MAX_JOBS
    if (state.jobs.length > MAX_JOBS) {
      state.jobs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      state.jobs = state.jobs.slice(0, MAX_JOBS);
    }
  });
}

// Statuses that still hold a slot on a model. "pending" and "queued" count
// because the worker is already committed to starting; only a terminal status
// releases the slot.
const ACTIVE_STATUSES = new Set(["pending", "queued", "running"]);

// How long a job record may go untouched before it stops counting against the
// concurrency cap. A worker killed with SIGKILL leaves its record reading
// "running" forever, and a cap that one dead record can wedge shut is worse
// than no cap. Liveness comes from the job's own trace log rather than from
// the state record, because the log is appended on every tool call whether or
// not the record is rewritten.
const STALE_ACTIVE_MS = Number(process.env.OPENCODE_ACTIVE_STALE_MS) || 900_000;

/**
 * Every job still holding a slot, across every workspace sharing this state
 * root. Cross-workspace on purpose: two Claude Code sessions in different
 * repos draw on the same provider account, and neither can see the other.
 *
 * @param {string} workspacePath  any workspace; only its state root is used
 * @param {number} [now]
 * @returns {Array<{id: string, agent: string|undefined, status: string, workspacePath: string}>}
 */
export function listActiveJobs(workspacePath, now = Date.now()) {
  const base = path.dirname(stateRoot(workspacePath));
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const active = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    const state = readJson(path.join(dir, "state.json"));
    if (!state || !Array.isArray(state.jobs)) continue;

    for (const job of state.jobs) {
      if (!ACTIVE_STATUSES.has(String(job.status))) continue;

      let logTouched = 0;
      const logFile = job.logFile || path.join(dir, "jobs", `${job.id}.log`);
      try {
        logTouched = fs.statSync(logFile).mtimeMs;
      } catch {
        // No log yet: the job may have only just been recorded.
      }
      const recordTouched = Date.parse(job.updatedAt ?? job.createdAt ?? "") || 0;
      if (now - Math.max(logTouched, recordTouched) > STALE_ACTIVE_MS) continue;

      active.push({
        id: job.id,
        agent: job.agent,
        status: String(job.status),
        workspacePath: state.workspacePath ?? dir,
      });
    }
  }
  return active;
}

/**
 * Get the path for a job's log file.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {string}
 */
export function jobLogPath(workspacePath, jobId) {
  return path.join(stateRoot(workspacePath), "jobs", `${jobId}.log`);
}

/**
 * Get the path for a job's data file.
 * @param {string} workspacePath
 * @param {string} jobId
 * @returns {string}
 */
export function jobDataPath(workspacePath, jobId) {
  return path.join(stateRoot(workspacePath), "jobs", `${jobId}.json`);
}
