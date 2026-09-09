// Cross-process locking tests for the state.json read-modify-write.
//
// The race is cross-process, so the concurrency test drives the real exported
// functions (upsertJob/updateState) as actual separate node processes against
// a throwaway workspace. Never /tmp/opencode-companion (live job state):
// every test sets OPENCODE_COMPANION_DATA to a fresh tmp dir.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  loadState,
  updateState,
  upsertJob,
  stateRoot,
  stateLockPath,
  STATE_LOCK_STALE_MS,
  STATE_LOCK_TIMEOUT_MS,
} from "../plugins/opencode/scripts/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateUrl = pathToFileURL(
  path.join(here, "..", "plugins", "opencode", "scripts", "lib", "state.mjs")
).href;

/**
 * Run a closure with OPENCODE_COMPANION_DATA pointed at a throwaway dir.
 * Restores the previous value afterwards so tests cannot leak into each
 * other (or into the live /tmp/opencode-companion state).
 */
async function withThrowawayDataDir(fn) {
  const dataDir = createTmpDir("opencode-lock-data");
  const prev = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = dataDir;
  try {
    return await fn(dataDir);
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_COMPANION_DATA;
    else process.env.OPENCODE_COMPANION_DATA = prev;
    cleanupTmpDir(dataDir);
  }
}

async function waitForFile(file, timeoutMs, label) {
  const start = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label} (${file})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function waitForExit(child, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not exit within ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/**
 * Spawn a child and capture its exit from birth. A 'close' listener attached
 * only after the child has already exited never fires (one-time emission),
 * so any exit we await must be subscribed at spawn time: a child can go from
 * "wrote its last output file" to "exited" in under a millisecond, well
 * within one poll slice of waitForFile.
 */
function spawnObserved(file, args, env) {
  const child = spawn(process.execPath, [file, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
  });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    getStderr: () => stderr,
    waitForExit: (timeoutMs, label) => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not exit within ${timeoutMs}ms`)),
          timeoutMs
        );
        timer.unref?.();
      });
      return Promise.race([exited, timeout]).finally(() => clearTimeout(timer));
    },
  };
}

describe("state cross-process lock", () => {
  it(
    "concurrent upsertJob from separate processes loses no records",
    { timeout: 120000 },
    async () => {
      await withThrowawayDataDir(async (dataDir) => {
        const scratchDir = createTmpDir("opencode-lock-scratch");
        try {
          const workspace = "/test/lock-concurrency-ws";
          const WRITERS = 4;
          const PER_WRITER = 10;

          const readyDir = path.join(scratchDir, "ready");
          fs.mkdirSync(readyDir, { recursive: true });
          const goFile = path.join(scratchDir, "go");

          const workerFile = path.join(scratchDir, "worker.mjs");
          fs.writeFileSync(
            workerFile,
            `import fs from "node:fs";
import { upsertJob } from ${JSON.stringify(stateUrl)};
const workspace = process.argv[2];
const writerId = process.argv[3];
const count = Number(process.argv[4]);
const readyDir = process.argv[5];
const goFile = process.argv[6];
fs.writeFileSync(\`\${readyDir}/ready-\${writerId}\`, "ready", "utf8");
// Start barrier: all writers enter their tight upsert loops together.
{
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) {
      console.error(\`worker \${writerId}: timed out waiting for start barrier\`);
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
try {
  for (let i = 0; i < count; i++) {
    upsertJob(workspace, { id: \`w\${writerId}-job-\${i}\`, status: "completed", writer: \`w\${writerId}\` });
  }
} catch (err) {
  console.error(\`worker \${writerId} failed:\`, err?.stack ?? err);
  process.exit(1);
}
`,
            "utf8"
          );

          const children = [];
          const outputs = [];
          for (let w = 0; w < WRITERS; w++) {
            const child = spawn(
              process.execPath,
              [workerFile, workspace, String(w), String(PER_WRITER), readyDir, goFile],
              {
                env: { ...process.env, OPENCODE_COMPANION_DATA: dataDir },
                stdio: ["ignore", "pipe", "pipe"],
              }
            );
            let stderr = "";
            child.stderr.on("data", (d) => {
              stderr += String(d);
            });
            outputs.push({ child, getStderr: () => stderr, writer: w });
            children.push(child);
          }

          try {
            // Wait until every writer is spawned and parked on the barrier,
            // then release them all at once for maximum overlap.
            for (let w = 0; w < WRITERS; w++) {
              await waitForFile(
                path.join(readyDir, `ready-${w}`),
                60000,
                `worker ${w} ready`
              );
            }
            fs.writeFileSync(goFile, "go", "utf8");

            const results = await Promise.all(
              outputs.map(({ child, writer }) =>
                waitForExit(child, 60000, `worker ${writer}`)
              )
            );
            results.forEach(({ code, signal }, w) => {
              assert.equal(
                code,
                0,
                `worker ${w} exited ${code} signal ${signal}: ${outputs[w].getStderr()}`
              );
            });

            const state = loadState(workspace);
            const ids = new Set((state.jobs ?? []).map((j) => j.id));
            assert.equal(
              ids.size,
              WRITERS * PER_WRITER,
              `expected ${WRITERS * PER_WRITER} records, got ${ids.size}`
            );
            for (let w = 0; w < WRITERS; w++) {
              for (let i = 0; i < PER_WRITER; i++) {
                assert.ok(ids.has(`w${w}-job-${i}`), `missing record w${w}-job-${i}`);
              }
            }

            // On-disk format unchanged: state.json keeps exactly its old shape
            // and no lock residue is left behind after the writers finish.
            assert.deepEqual(Object.keys(state).sort(), ["config", "jobs", "workspacePath"]);
            assert.deepEqual(fs.readdirSync(stateRoot(workspace)).sort(), ["state.json"]);
            assert.equal(fs.existsSync(stateLockPath(workspace)), false);
          } finally {
            for (const { child } of outputs) {
              try {
                child.kill("SIGKILL");
              } catch {
                // Already exited.
              }
            }
          }
        } finally {
          cleanupTmpDir(scratchDir);
        }
      });
    }
  );

  it(
    "a writer whose lock is stolen mid-update retries instead of overwriting",
    { timeout: 120000 },
    async () => {
      await withThrowawayDataDir(async (dataDir) => {
        const scratchDir = createTmpDir("opencode-locksteal-scratch");
        try {
          const workspace = "/test/lock-steal-ws";
          const readyA = path.join(scratchDir, "ready-A");
          const goA = path.join(scratchDir, "go-A");
          const doneA = path.join(scratchDir, "done-A");

          // Writer A parks INSIDE its critical section (mutator waits on a
          // file gate), simulating a suspend/SIGSTOP-length stall. The push
          // is guarded so a retried mutator run does not duplicate it.
          const writerAFile = path.join(scratchDir, "writer-a.mjs");
          fs.writeFileSync(
            writerAFile,
            `import fs from "node:fs";
import { updateState } from ${JSON.stringify(stateUrl)};
const workspace = process.argv[2];
const dir = process.argv[3];
updateState(workspace, (state) => {
  state.jobs = state.jobs ?? [];
  if (!state.jobs.some((j) => j.id === "writer-A")) {
    state.jobs.push({ id: "writer-A", status: "running" });
  }
  if (!fs.existsSync(\`\${dir}/go-A\`)) {
    fs.writeFileSync(\`\${dir}/ready-A\`, "ready", "utf8");
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(\`\${dir}/go-A\`)) {
      if (Date.now() > deadline) throw new Error("writer A: timed out waiting for go-A");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
});
fs.writeFileSync(\`\${dir}/done-A\`, "done", "utf8");
`,
            "utf8"
          );

          const writerBFile = path.join(scratchDir, "writer-b.mjs");
          fs.writeFileSync(
            writerBFile,
            `import { upsertJob } from ${JSON.stringify(stateUrl)};
upsertJob(process.argv[2], { id: "writer-B", status: "completed" });
`,
            "utf8"
          );

          const spawnWithEnv = (file, args) =>
            spawnObserved(file, args, {
              ...process.env,
              OPENCODE_COMPANION_DATA: dataDir,
            });

          const a = spawnWithEnv(writerAFile, [workspace, scratchDir]);
          try {
            await waitForFile(readyA, 30000, "writer A parked in critical section");

            // Force A's lock stale while keeping its identity (nonce), as a
            // suspend would: both mtime and createdAt read old afterwards.
            const lockPath = stateLockPath(workspace);
            const lockData = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            assert.ok(lockData.nonce, "holder lock must carry a nonce");
            const old = Date.now() - (STATE_LOCK_STALE_MS + 5000);
            lockData.createdAt = old;
            fs.writeFileSync(lockPath, JSON.stringify(lockData), "utf8");
            fs.utimesSync(lockPath, new Date(old), new Date(old));

            // Writer B (a separate process) legitimately breaks the stale
            // lock and commits while A is still parked.
            const b = spawnWithEnv(writerBFile, [workspace]);
            const bRes = await b.waitForExit(60000, "writer B");
            assert.equal(bRes.code, 0, `writer B failed: ${b.getStderr()}`);
            assert.ok(
              (loadState(workspace).jobs ?? []).some((j) => j.id === "writer-B"),
              "writer B must have committed while A was parked"
            );

            // Let A finish. Without an ownership re-check it would now save
            // its pre-B snapshot and wipe writer-B; with the fix it retries
            // on fresh state and both records survive.
            fs.writeFileSync(goA, "go", "utf8");
            await waitForFile(doneA, 30000, "writer A to finish");
            const aRes = await a.waitForExit(30000, "writer A");
            assert.equal(aRes.code, 0, `writer A failed: ${a.getStderr()}`);

            const ids = new Set((loadState(workspace).jobs ?? []).map((j) => j.id));
            assert.ok(ids.has("writer-B"), "writer B's record must survive writer A's finish");
            assert.ok(ids.has("writer-A"), "writer A's record must be committed");
            assert.equal(fs.existsSync(stateLockPath(workspace)), false);
          } finally {
            try {
              a.child.kill("SIGKILL");
            } catch {
              // Already exited.
            }
          }
        } finally {
          cleanupTmpDir(scratchDir);
        }
      });
    }
  );

  it(
    "a lock left by a killed holder is broken within a bounded wait",
    { timeout: 60000 },
    async () => {
      await withThrowawayDataDir(async (dataDir) => {
        const scratchDir = createTmpDir("opencode-lockholder-scratch");
        try {
          const workspace = "/test/lock-killed-holder-ws";

          const holderFile = path.join(scratchDir, "holder.mjs");
          fs.writeFileSync(
            holderFile,
            `import fs from "node:fs";
import { acquireStateLock } from ${JSON.stringify(stateUrl)};
const workspace = process.argv[2];
const readyFile = process.argv[3];
// Acquire and hold until killed. Intentionally never releases: SIGKILL
// leaves the lock file behind, which is exactly the stale-lock scenario.
acquireStateLock(workspace);
fs.writeFileSync(readyFile, String(process.pid), "utf8");
await new Promise((r) => setTimeout(r, 60000));
`,
            "utf8"
          );
          const readyFile = path.join(scratchDir, "holder-ready");

          const holder = spawn(process.execPath, [holderFile, workspace, readyFile], {
            env: { ...process.env, OPENCODE_COMPANION_DATA: dataDir },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let holderStderr = "";
          holder.stderr.on("data", (d) => {
            holderStderr += String(d);
          });
          try {
            await waitForFile(readyFile, 30000, "lock holder to acquire");
            assert.equal(
              fs.existsSync(stateLockPath(workspace)),
              true,
              "holder must leave a lock file behind"
            );

            holder.kill("SIGKILL");
            const { code, signal } = await waitForExit(holder, 15000, "lock holder");
            assert.equal(signal, "SIGKILL", `holder stderr: ${holderStderr}`);
            assert.equal(code, null);

            // The next writer must not hang: the fresh-looking lock left by
            // the dead holder is recognised as stale and broken. Worst case
            // is one stale period plus backoff, well under the hard timeout.
            const start = Date.now();
            upsertJob(workspace, { id: "after-kill", status: "completed" });
            const elapsed = Date.now() - start;
            assert.ok(
              elapsed < STATE_LOCK_STALE_MS + 10000,
              `stale lock recovery took ${elapsed}ms, expected < ${STATE_LOCK_STALE_MS + 10000}ms`
            );
            assert.ok(
              elapsed < STATE_LOCK_TIMEOUT_MS + 10000,
              `must recover without hitting the acquire timeout, took ${elapsed}ms`
            );

            const state = loadState(workspace);
            assert.ok(
              (state.jobs ?? []).some((j) => j.id === "after-kill"),
              "record written after stale-break must persist"
            );
            assert.equal(fs.existsSync(stateLockPath(workspace)), false);
          } finally {
            try {
              holder.kill("SIGKILL");
            } catch {
              // Already dead.
            }
          }
        } finally {
          cleanupTmpDir(scratchDir);
        }
      });
    }
  );

  it("a synthetically aged lock file is broken immediately", { timeout: 30000 }, async () => {
    await withThrowawayDataDir(async () => {
      const workspace = "/test/lock-aged-ws";
      const lockPath = stateLockPath(workspace);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const old = Date.now() - (STATE_LOCK_STALE_MS + 5000);
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999999, nonce: "stale-fake", createdAt: old }),
        "utf8"
      );
      fs.utimesSync(lockPath, new Date(old), new Date(old));

      const start = Date.now();
      upsertJob(workspace, { id: "after-aged-lock", status: "completed" });
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed < STATE_LOCK_STALE_MS,
        `aged lock must break without waiting out a stale period, took ${elapsed}ms`
      );

      const state = loadState(workspace);
      assert.ok((state.jobs ?? []).some((j) => j.id === "after-aged-lock"));
      assert.equal(fs.existsSync(lockPath), false);
    });
  });

  it("a mutator that throws does not leave the lock held", async () => {
    await withThrowawayDataDir(async () => {
      const workspace = "/test/lock-throw-ws";
      assert.throws(
        () =>
          updateState(workspace, () => {
            throw new Error("boom");
          }),
        /boom/
      );
      assert.equal(
        fs.existsSync(stateLockPath(workspace)),
        false,
        "lock file must be released when the mutator throws"
      );
      // Nothing was written, and the next update proceeds normally.
      assert.deepEqual(loadState(workspace), { config: {}, jobs: [] });
      const result = updateState(workspace, (state) => {
        state.config.ok = true;
      });
      assert.equal(result.config.ok, true);
      assert.equal(loadState(workspace).config.ok, true);
      assert.equal(fs.existsSync(stateLockPath(workspace)), false);
    });
  });

  it("lock files live outside the state.json payload", async () => {
    // Guard for the oco-tui reader: scratch/lock/tmp files must never leak
    // fields into state.json itself.
    await withThrowawayDataDir(async () => {
      const workspace = "/test/lock-format-ws";
      upsertJob(workspace, { id: "fmt-1", status: "running" });
      const raw = fs.readFileSync(path.join(stateRoot(workspace), "state.json"), "utf8");
      const parsed = JSON.parse(raw);
      assert.deepEqual(Object.keys(parsed).sort(), ["config", "jobs", "workspacePath"]);
      assert.ok(!("nonce" in parsed), "lock nonce must not appear in state.json");
      assert.ok(!("pid" in parsed), "lock pid must not appear in state.json");
    });
  });
});
