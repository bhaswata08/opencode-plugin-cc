// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API.

import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Re-export for spec-compliance / discoverability: probeSessionTerminal lives
// in auto-heal.mjs because it is tightly coupled to heal-decision logic, but
// conceptually it is a server probe.
export { probeSessionTerminal } from "./auto-heal.mjs";
import { ensureOpencodeConfig } from "./opencode-config.mjs";
import { classifyError } from "./errors.mjs";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;

// Long-running tasks (e.g. engine builds, large refactors) can easily exceed
// the old 5-10 min caps, causing `fetch failed` at a fixed deadline. Default
// PROMPT_TIMEOUT_MS to 4 hours — absolute safety cap. Real stall detection
// lives in the watcher via IDLE_TIMEOUT_MS + pgrep child-process check.
const REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS) || 1_800_000;
const PROMPT_TIMEOUT_MS = Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS) || 14_400_000;
const STRICT_TERMINAL = process.env.OPENCODE_STRICT_TERMINAL === "1";
// How long a session may go without ANY activity signal before we assume it
// is stuck. Activity = new message, new parts, tool output growth, status
// change. Previously defaulted to 1h, but with MAX_IDLE_EXTENSIONS that meant
// a hung session could tie up a worker slot for 3 hours before giving up or
// falling back. 10 minutes gives silent tool invocations plenty of headroom
// while bounding the worst-case stall.
const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 600_000;
// Maximum consecutive idle extensions granted when opencode serve has live
// child processes. Prevents a stuck or sleeping child from suppressing the
// idle timeout forever.
const MAX_IDLE_EXTENSIONS = Number(process.env.OPENCODE_MAX_IDLE_EXTENSIONS) || 2;
// An incomplete assistant message with zero tokens and zero parts that sits
// silent for this long indicates the provider rejected or dropped the stream
// without surfacing an error to the session API (e.g. rate limit exceeded).
const STREAM_STALL_MS = Number(process.env.OPENCODE_STREAM_STALL_MS) || 90_000;
// Bash-tool "no child process" consecutive-miss threshold. If the latest
// tool is a bash in status=running but opencode serve has zero child
// processes for N polls in a row, declare stuck. 3 × 5s = 15s grace.
const PGREP_MISS_THRESHOLD = Number(process.env.OPENCODE_PGREP_MISS_THRESHOLD) || 3;

/**
 * Find the PID of `opencode serve` listening on `port`, if we can.
 * Returns null on Windows or any detection failure (caller degrades gracefully).
 */
function resolveServePid(port) {
  if (IS_WINDOWS) return null;
  try {
    // macOS + Linux: lsof works the same way. Short timeout so we never block
    // the watcher loop if the tool is slow/missing.
    const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const lines = r.stdout.split("\n").slice(1).filter(Boolean);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // lsof missing or errored — degrade to no pgrep checks
  }
  return null;
}

/**
 * Count direct child processes of `pid`. Returns:
 *   -1 — feature unavailable (Windows, pgrep missing, etc.) — caller should skip check
 *    0 — no children
 *   >0 — that many children
 */
function countChildren(pid) {
  if (!pid || IS_WINDOWS) return -1;
  try {
    const r = spawnSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (r.error) return -1;
    // pgrep exits 1 when no matches (empty stdout) — that's a real "zero", not a failure
    const out = (r.stdout || "").trim();
    if (!out) return 0;
    return out.split("\n").filter(Boolean).length;
  } catch {
    return -1;
  }
}

/**
 * Detect a provider quota or retry notice in a polled session message.
 *
 * Checks structured error fields first (info.error, HTTP 429, FreeUsageLimitError).
 * If structured data is absent, falls back to matching opencode's exact prose
 * retry wording in text parts.
 *
 * Prose matching is fragile: opencode's wording ("Free usage exceeded, subscribe to Go",
 * "retrying in <N>s - attempt #<M>") can shift across releases or subscription tiers.
 * Structured fields like info.error are preferred when present.
 *
 * @param {object|null|undefined} msg - message object with { info, parts }
 * @returns {string|null} description of the quota notice, or null if none
 */
export function detectQuotaNotice(msg) {
  if (!msg || typeof msg !== "object") return null;

  const info = msg.info;
  if (info?.error) {
    const err = info.error;
    const statusCode = err.data?.statusCode ?? err.statusCode ?? err.status;
    const respBody = typeof err.data?.responseBody === "string" ? err.data.responseBody : "";
    const msgText = String(err.data?.message ?? err.message ?? "");

    if (statusCode === 429) {
      return msgText || "provider rate limit (status 429)";
    }
    if (/FreeUsageLimitError|rate_limit|\bquota\b/i.test(respBody)) {
      return msgText || respBody;
    }
    if (/rate[\s_-]?limit|\bquota\b|Free usage exceeded/i.test(msgText)) {
      return msgText;
    }
  }

  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;

    // Structured error part
    if (part.type === "error") {
      const errStr = String(part.error ?? part.message ?? part.text ?? "");
      if (/rate[\s_-]?limit|\bquota\b|FreeUsageLimitError|429/i.test(errStr)) {
        return errStr || "error part indicates rate limit / quota";
      }
    }

    // Text part: match only opencode's specific daemon notices.
    // Generic words like "quota" or "rate limit" must not match here because
    // an assistant discussing or writing rate-limiting code would trigger a false abort.
    if (part.type === "text" && typeof part.text === "string") {
      if (/Free usage exceeded/i.test(part.text)) {
        return part.text.trim();
      }
      if (/retrying in \d+s\s*-\s*attempt #\d+/i.test(part.text)) {
        return part.text.trim();
      }
    }
  }

  return null;
}

/**
 * Resolve the path to opencode's server log.
 * Resolved via a helper so it can be overridden in tests via OPENCODE_LOG_PATH.
 *
 * @returns {string}
 */
export function resolveOpencodeLogPath() {
  return (
    process.env.OPENCODE_LOG_PATH ||
    path.join(os.homedir(), ".local", "share", "opencode", "log", "opencode.log")
  );
}

/**
 * Parse out the error value from opencode server log lines matching the session id and level=ERROR.
 * Scans backwards so the newest error line is preferred.
 *
 * @param {string} content
 * @param {string} sessionId
 * @returns {string|null}
 */
export function parseOpencodeLogError(content, sessionId) {
  if (!content || !sessionId) return null;
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes("level=ERROR") || !line.includes(sessionId)) continue;

    // Extract error.error="..." or error.error=...
    const m = line.match(/error\.error="([^"]+)"/) || line.match(/error\.error=([^\s]+)/);
    if (m) {
      let errStr = m[1];
      if (errStr.startsWith("AI_APICallError: ")) {
        errStr = errStr.slice("AI_APICallError: ".length).trim();
      }
      return errStr || null;
    }
    const msgMatch = line.match(/message="([^"]+)"/) || line.match(/message=([^\s]+)/);
    return msgMatch ? msgMatch[1] : "opencode stream error";
  }
  return null;
}

/**
 * Read opencode's server log and return any error matching sessionId.
 * Tolerates the file being absent or unreadable, reads only the tail up to
 * 256KB, and caps read time to 1500ms so a slow read never blocks the watcher.
 *
 * @param {string} sessionId
 * @param {string} [logPath]
 * @returns {Promise<string|null>}
 */
export async function readOpencodeLogError(sessionId, logPath = resolveOpencodeLogPath()) {
  if (!sessionId || !logPath) return null;

  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), 1500);
  });

  const readPromise = (async () => {
    try {
      const stat = await fsp.stat(logPath).catch(() => null);
      if (!stat || !stat.isFile() || stat.size === 0) return null;

      const readSize = Math.min(stat.size, 262_144);
      const offset = stat.size - readSize;
      const buf = Buffer.alloc(readSize);

      const handle = await fsp.open(logPath, "r");
      try {
        await handle.read(buf, 0, readSize, offset);
      } finally {
        await handle.close();
      }
      return parseOpencodeLogError(buf.toString("utf8"), sessionId);
    } catch {
      return null;
    }
  })();

  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if an OpenCode server is already running on the given port.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isServerRunning(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://${host}:${port}/global/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the OpenCode server if not already running.
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.cwd]
 * @returns {Promise<{ url: string, pid?: number, alreadyRunning: boolean }>}
 */
export async function ensureServer(opts = {}) {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const url = `http://${host}:${port}`;

  if (await isServerRunning(host, port)) {
    return { url, alreadyRunning: true };
  }

  // Self-heal permissions BEFORE spawning the server. The running daemon reads
  // opencode.json at startup; fixing it after the spawn would require a restart.
  try {
    ensureOpencodeConfig();
  } catch (err) {
    process.stderr.write(`[opencode-companion] ensureOpencodeConfig failed: ${err.message}\n`);
  }

  // Start the server
  // Windows npm shims are .cmd/.ps1; spawn() only resolves those via a shell.
  const proc = spawn("opencode", ["serve", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd: opts.cwd,
    shell: IS_WINDOWS,
  });
  proc.unref();

  // Wait for the server to become ready
  const deadline = Date.now() + SERVER_START_TIMEOUT;
  while (Date.now() < deadline) {
    if (await isServerRunning(host, port)) {
      return { url, pid: proc.pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`OpenCode server failed to start within ${SERVER_START_TIMEOUT / 1000}s`);
}

/**
 * Create an API client bound to a running OpenCode server.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {string} [opts.directory] - workspace directory for x-opencode-directory header
 * @returns {OpenCodeClient}
 */
export function createClient(baseUrl, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (opts.directory) {
    headers["x-opencode-directory"] = opts.directory;
  }
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    const cred = Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }

  async function request(method, path, body) {
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw classifyError(err, { baseUrl, startedAt, timeoutMs: REQUEST_TIMEOUT_MS, op: `request ${method} ${path}` });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw classifyError(
        new Error(`OpenCode API ${method} ${path} returned ${res.status}: ${text}`),
        { baseUrl, startedAt, timeoutMs: REQUEST_TIMEOUT_MS, op: `request ${method} ${path}` },
      );
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  return {
    baseUrl,

    // Health
    health: () => request("GET", "/global/health"),

    // Sessions
    listSessions: () => request("GET", "/session"),
    createSession: (opts = {}) => request("POST", "/session", opts),
    getSession: (id) => request("GET", `/session/${id}`),
    deleteSession: (id) => request("DELETE", `/session/${id}`),
    abortSession: (id) => request("POST", `/session/${id}/abort`),
    getSessionStatus: () => request("GET", "/session/status"),
    getSessionDiff: (id) => request("GET", `/session/${id}/diff`),

    // Messages
    getMessages: (sessionId, opts = {}) => {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.before) params.set("before", opts.before);
      const qs = params.toString();
      return request("GET", `/session/${sessionId}/message${qs ? "?" + qs : ""}`);
    },

    /**
     * Send a prompt (synchronous / streaming).
     * Returns the full response text from SSE stream.
     *
     * NOTE: OpenCode's POST /session/:id/message occasionally fails to close
     * its HTTP response body after the session emits its terminal assistant
     * message (observed against glm-5 backend, opencode 1.4.x). Relying on
     * res.json() alone means the caller hangs until AbortSignal fires, which
     * breaks downstream job-completion detection in the companion.
     *
     * Workaround: race the fetch against a session-completion watcher that
     * polls GET /session/:id/message. When the latest assistant message has
     * info.time.completed set AND finish !== undefined, the session is done;
     * we abort the hanging fetch and synthesize the response from the poll.
     */
    sendPrompt: async (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      if (opts.system) body.system = opts.system;

      const ac = new AbortController();
      const timeoutId = setTimeout(() => ac.abort(new Error("prompt timeout")), PROMPT_TIMEOUT_MS);
      const startedAt = Date.now();
      // Grace period so we don't mistake "session had no prior activity" for
      // completion before the new prompt has even begun generating.
      const MIN_POLL_DELAY_MS = process.env.OPENCODE_MIN_POLL_DELAY_MS !== undefined
        ? Number(process.env.OPENCODE_MIN_POLL_DELAY_MS)
        : 5_000;
      const POLL_INTERVAL_MS = Number(process.env.OPENCODE_COMPLETION_POLL_MS) || 5_000;
      const streamStallMs = process.env.OPENCODE_STREAM_STALL_MS !== undefined
        ? Number(process.env.OPENCODE_STREAM_STALL_MS)
        : STREAM_STALL_MS;
      const idleTimeoutMs = process.env.OPENCODE_IDLE_TIMEOUT_MS !== undefined
        ? Number(process.env.OPENCODE_IDLE_TIMEOUT_MS)
        : IDLE_TIMEOUT_MS;

      const fetchPromise = (async () => {
        const res = await fetch(`${baseUrl}/session/${sessionId}/message`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`OpenCode prompt failed ${res.status}: ${text}`);
        }
        return { source: "fetch", data: await res.json() };
      })();

      const watcherPromise = (async () => {
        // Wait briefly so the new generation has a chance to start and we
        // don't latch onto a stale completed message from before this prompt.
        await new Promise((r) => setTimeout(r, MIN_POLL_DELAY_MS));

        // Resolve the opencode serve PID once so we can check for child
        // processes later. If this fails (Windows, no lsof, permissions)
        // we silently skip the pgrep-based stuck detector — idle timeout
        // still covers most cases.
        const urlObj = (() => {
          try { return new URL(baseUrl); } catch { return null; }
        })();
        const port = Number(urlObj?.port) || DEFAULT_PORT;
        const opencodePid = resolveServePid(port);

        let prevSig = "";
        let lastActivityMs = Date.now();
        let pgrepMissCount = 0;
        let idleExtensions = 0;

        while (!ac.signal.aborted) {
          try {
            const params = new URLSearchParams({ limit: "1" });
            const r = await fetch(
              `${baseUrl}/session/${sessionId}/message?${params.toString()}`,
              { headers, signal: AbortSignal.timeout(10_000) },
            );
            if (r.ok) {
              const arr = await r.json();
              const last = Array.isArray(arr) ? arr[arr.length - 1] : null;
              const info = last?.info;
              const parts = Array.isArray(last?.parts) ? last.parts : [];
              const completed = typeof info?.time?.completed === "number" ? info.time.completed : 0;
              const hasTerminalFinish = typeof info?.finish === "string";
              // Most recent tool part — the one actually "running" if any.
              let lastTool = null;
              for (let i = parts.length - 1; i >= 0; i--) {
                if (parts[i]?.type === "tool") { lastTool = parts[i]; break; }
              }

              // Activity signature: any change here = progress was made.
              const sig = JSON.stringify({
                mid: info?.id,
                created: info?.time?.created,
                completed: info?.time?.completed,
                parts: parts.length,
                tStatus: lastTool?.state?.status,
                tOutLen: (lastTool?.state?.output || "").length,
              });
              if (sig !== prevSig) {
                lastActivityMs = Date.now();
                prevSig = sig;
                pgrepMissCount = 0;
                idleExtensions = 0;
              }

              // Quota detection: abort immediately if opencode entered its
              // retry backoff loop or reported a quota / rate limit error.
              const quotaNotice = detectQuotaNotice(last);
              if (quotaNotice) {
                const err = new Error(`opencode rate limit / quota exceeded: ${quotaNotice}`);
                ac.abort(err);
                throw err;
              }

              // Server log signal: opencode writes stream errors directly to
              // its server log even when GET /session/:id/message leaves error null.
              const logError = await readOpencodeLogError(sessionId);
              if (logError) {
                const err = new Error(logError);
                ac.abort(err);
                throw err;
              }

              // Completion signal: assistant message created after our prompt
              // started. Some OpenCode versions omit `finish` on terminal messages.
              if (
                info &&
                info.role === "assistant" &&
                completed >= startedAt &&
                (STRICT_TERMINAL ? hasTerminalFinish : hasTerminalFinish || completed > 0)
              ) {
                return { source: "watcher", data: last };
              }

              // Stream stall detection: an incomplete assistant message with 0 input
              // tokens and 0 parts older than STREAM_STALL_MS never reached the model.
              // A live stream produces its first part within seconds.
              const role = info?.role ?? last?.role;
              const tokens = info?.tokens ?? last?.tokens;
              const time = info?.time ?? last?.time;
              const created = typeof time?.created === "number" ? time.created : 0;
              const isIncompleteAssistant =
                role === "assistant" &&
                !hasTerminalFinish &&
                completed === 0;

              if (
                isIncompleteAssistant &&
                parts.length === 0 &&
                Number(tokens?.input ?? 0) === 0 &&
                created > 0 &&
                (Date.now() - created) >= streamStallMs
              ) {
                const stallSec = Math.floor(streamStallMs / 1000);
                const desc = `opencode stream stalled: no tokens and no parts after ${stallSec}s (provider likely rate limited)`;
                const err = new Error(desc);
                ac.abort(err);
                throw err;
              }

              // Bash-tool stuck detector: latest tool is bash in status=running
              // but opencode serve has zero children for N consecutive polls.
              // This is the signature of the "ask permission deadlock" bug
              // (sst/opencode#14473): the shell process already exited cleanly
              // but tool state never flipped to completed.
              if (
                opencodePid &&
                lastTool?.tool === "bash" &&
                lastTool?.state?.status === "running"
              ) {
                const n = countChildren(opencodePid);
                if (n === 0) {
                  pgrepMissCount += 1;
                  if (pgrepMissCount >= PGREP_MISS_THRESHOLD) {
                    ac.abort(
                      new Error(
                        `bash tool stuck — opencode serve (pid ${opencodePid}) has no child for ${pgrepMissCount} polls while tool.status=running`,
                      ),
                    );
                    throw new Error("bash tool stuck (no child)");
                  }
                } else if (n > 0) {
                  pgrepMissCount = 0;
                }
                // n === -1 → feature unavailable, don't count either way
              }

              // Idle timeout: nothing happened in the session for too long.
              // Covers all tool types (not just bash), including non-pgrep
              // platforms (Windows).
              const idleMs = Date.now() - lastActivityMs;
              if (idleMs > idleTimeoutMs) {
                const liveChildren = opencodePid ? countChildren(opencodePid) : 0;
                if (liveChildren > 0 && idleExtensions < MAX_IDLE_EXTENSIONS) {
                  idleExtensions += 1;
                  lastActivityMs = Date.now();
                  process.stderr.write(
                    `opencode watcher: session idle ${Math.floor(idleMs / 1000)}s, but opencode serve (pid ${opencodePid}) has ${liveChildren} child process(es); extension ${idleExtensions}/${MAX_IDLE_EXTENSIONS}\n`,
                  );
                } else {
                  const reason = liveChildren > 0
                    ? `session idle timeout: exceeded max extensions (${MAX_IDLE_EXTENSIONS}) with ${liveChildren} child process(es) alive`
                    : `session idle timeout: ${Math.floor(idleMs / 1000)}s > ${idleTimeoutMs / 1000}s`;
                  const err = new Error(reason);
                  ac.abort(err);
                  throw err;
                }
              }
            }
          } catch (err) {
            // If we aborted above, propagate so the outer race sees a failure.
            if (ac.signal.aborted) throw err;
            // Otherwise it's a transient network/server blip — keep polling.
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        throw new Error("watcher aborted");
      })();

      // Settle-wrap each so a single rejection doesn't lose the other side.
      // Server-side 5-min POST cap means fetchPromise often rejects LONG
      // before the agent is actually done; we must still wait on the watcher.
      const wrap = (p, via) =>
        p.then(
          (v) => ({ ok: true, via, data: v.data }),
          (err) => ({ ok: false, via, err }),
        );
      const runFetch = wrap(fetchPromise, "fetch");
      const runWatcher = wrap(watcherPromise, "watcher");

      try {
        const first = await Promise.race([runFetch, runWatcher]);
        if (first.ok) {
          ac.abort();
          fetchPromise.catch(() => {});
          watcherPromise.catch(() => {});
          return first.data;
        }
        // First to settle was a failure — the other promise may still succeed.
        // Do NOT abort yet: in particular, the watcher needs to keep polling
        // when the POST was killed by the server's 5-min cap but generation
        // is still running.
        const second = first.via === "fetch" ? await runWatcher : await runFetch;
        ac.abort();
        fetchPromise.catch(() => {});
        watcherPromise.catch(() => {});
        if (second.ok) return second.data;
        // Both failed - surface the more informative error.
        // If the abort controller was triggered with an explicit reason (quota,
        // idle timeout, prompt timeout, bash stuck), prefer that over a generic
        // fetch failure.
        const rawErr =
          ac.signal.aborted && ac.signal.reason instanceof Error
            ? ac.signal.reason
            : first.via === "fetch"
              ? first.err
              : second.err;
        throw classifyError(rawErr, {
          baseUrl,
          startedAt,
          timeoutMs: PROMPT_TIMEOUT_MS,
          op: "sendPrompt",
        });
      } finally {
        clearTimeout(timeoutId);
      }
    },

    /**
     * Send a prompt asynchronously (returns immediately).
     */
    sendPromptAsync: (sessionId, promptText, opts = {}) => {
      const body = {
        parts: [{ type: "text", text: promptText }],
      };
      if (opts.agent) body.agent = opts.agent;
      if (opts.model) body.model = opts.model;
      return request("POST", `/session/${sessionId}/prompt_async`, body);
    },

    // Agents
    listAgents: () => request("GET", "/agent"),

    // Providers
    listProviders: () => request("GET", "/provider"),
    getProviderAuth: () => request("GET", "/provider/auth"),

    // Config
    getConfig: () => request("GET", "/config"),

    // Events (SSE) - returns a ReadableStream
    subscribeEvents: async () => {
      const res = await fetch(`${baseUrl}/event`, {
        headers: { ...headers, Accept: "text/event-stream" },
      });
      return res.body;
    },
  };
}

/**
 * Connect to OpenCode: ensure server is running, create client.
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {number} [opts.port]
 * @returns {Promise<ReturnType<typeof createClient> & { serverInfo: object }>}
 */
export async function connect(opts = {}) {
  const { url } = await ensureServer(opts);
  const client = createClient(url, { directory: opts.cwd });
  return { ...client, serverInfo: { url } };
}

export const __test = {
  detectQuotaNotice,
  countChildren,
  resolveServePid,
  IDLE_TIMEOUT_MS,
  MAX_IDLE_EXTENSIONS,
  STREAM_STALL_MS,
  resolveOpencodeLogPath,
  parseOpencodeLogError,
  readOpencodeLogError,
};
