import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  FALLBACKS,
  resolveFallback,
  isTransportFailure,
  isEmptyResult,
  fallbackBlockedReason,
  runWithFallback,
} from "../plugins/opencode/scripts/lib/fallback.mjs";
import {
  detectQuotaNotice,
  createClient,
  parseOpencodeLogError,
  readOpencodeLogError,
  resolveOpencodeLogPath,
  __test,
} from "../plugins/opencode/scripts/lib/opencode-server.mjs";

test("every seat the user configured has a fallback", () => {
  assert.equal(FALLBACKS.coder.backend, "agy");
  assert.equal(FALLBACKS.coder.model, "gemini-3.8-flash-high");
  assert.equal(FALLBACKS.reviewer.handoff, "claude-subagent");
  assert.equal(FALLBACKS.reviewer.model, "sonnet");
  assert.equal(FALLBACKS.adversary.agent, "adversary-fallback");
});

test("build resolves to the same fallback as coder", () => {
  assert.deepEqual(resolveFallback("build"), resolveFallback("coder"));
});

test("resolveFallback is case-insensitive and safe on unknown seats", () => {
  assert.equal(resolveFallback("CODER").backend, "agy");
  assert.equal(resolveFallback("nonesuch"), null);
  assert.equal(resolveFallback(undefined), null);
});

test("transport failures are recognised", () => {
  const yes = [
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4096"), {}),
    new Error("socket hang up"),
    new Error("fetch failed"),
    new Error("OpenCode API POST /session returned 503: unavailable"),
    new Error("OpenCode API POST /session returned 429: rate limited"),
    new Error("provider says model gemini-x is not found"),
    new Error("jetski: no output produced - a tool required the command permission"),
    new Error("spawn agy ENOENT"),
    Object.assign(new Error("whatever"), { name: "AbortError" }),
    Object.assign(new Error("opaque"), { code: "ETIMEDOUT" }),
    new Error("session idle timeout"),
    new Error("session idle 3601s > 3600s"),
    new Error("session idle timeout: exceeded max extensions (2) with 1 child process(es) alive"),
    new Error("prompt timeout"),
    new Error("Aborted after 14400s (OPENCODE_PROMPT_TIMEOUT_MS=14400000). For longer tasks set OPENCODE_PROMPT_TIMEOUT_MS=3600000 or higher. [prompt timeout]"),
    new Error("opencode rate limit / quota exceeded: Free usage exceeded, subscribe to Go"),
    new Error("opencode rate limit / quota exceeded: retrying in 52049s - attempt #1"),
    new Error("opencode rate limit / quota exceeded: provider rate limit (status 429)"),
    new Error("opencode stream stalled: no tokens and no parts after 90s (provider likely rate limited)"),
    new Error("opencode stream stalled: no tokens and no parts after 90s"),
    new Error("Rate limit exceeded. Please try again later."),
  ];
  for (const err of yes) {
    assert.equal(isTransportFailure(err), true, `should be transport: ${err.message}`);
  }
});

test("a bad result is not a transport failure", () => {
  // This is the case the whole design exists to keep out. The agent ran, the
  // provider was fine, and the work was wrong.
  const no = [
    new Error("2 tests failed in src/duration.test.mjs"),
    new Error("agent finished but left the worktree dirty"),
    new Error("TypeError: parseDuration is not a function"),
    new Error("lint reported 4 errors"),
    new Error("assertion failed: expected 26280000"),
    new Error("test timed out after 5000ms"),
    new Error("timeout waiting for condition in test"),
    new Error("idle connection dropped by test server"),
  ];
  for (const err of no) {
    assert.equal(isTransportFailure(err), false, `should NOT be transport: ${err.message}`);
  }
});

test("empty results count as a failed turn", () => {
  assert.equal(isEmptyResult(""), true);
  assert.equal(isEmptyResult("   \n "), true);
  assert.equal(isEmptyResult(undefined), true);
  assert.equal(isEmptyResult("ok"), false);
});

test("the reviewer fallback is blocked in-process and reported as a handoff", () => {
  const reason = fallbackBlockedReason(FALLBACKS.reviewer);
  assert.match(reason, /claude-subagent handoff/);
});

test("a successful primary never touches the fallback", async () => {
  let calls = 0;
  const out = await runWithFallback({
    agent: "coder",
    attempt: async () => { calls++; return { text: "done", value: "done" }; },
  });
  assert.equal(out.value, "done");
  assert.equal(out.usedFallback, false);
  assert.equal(calls, 1);
});

test("a bad result is rethrown without a second model running", async () => {
  let calls = 0;
  await assert.rejects(
    runWithFallback({
      agent: "coder",
      attempt: async () => { calls++; throw new Error("3 tests failed"); },
    }),
    /3 tests failed/,
  );
  assert.equal(calls, 1, "the fallback must not run on a real result");
});

test("a transport failure switches backend and model for the retry", async () => {
  const seen = [];
  const out = await runWithFallback({
    agent: "coder",
    attempt: async (sel) => {
      seen.push({
        agent: sel.agent,
        backend: process.env.OPENCODE_BACKEND,
        agyModel: process.env.AGY_MODEL,
      });
      if (seen.length === 1) throw new Error("connect ECONNREFUSED 127.0.0.1:4096");
      return { text: "recovered", value: "recovered" };
    },
  });
  assert.equal(out.value, "recovered");
  assert.equal(out.usedFallback, true);
  assert.equal(seen[1].backend, "agy");
  assert.equal(seen[1].agyModel, "gemini-3.8-flash-high");
});

test("a transport failure re-resolves transport and mints fresh session on fallback backend", async () => {
  const sessions = [];
  const attempts = [];

  const connect = async (backend) => {
    const session = { id: `${backend}-ses-${sessions.length + 1}` };
    sessions.push({ backend, session });
    return {
      session,
      client: {
        backend,
        sendPrompt: async (sid, text, opts) => {
          attempts.push({
            backend,
            sessionId: sid,
            agent: opts?.agent,
            model: opts?.model,
          });
          if (backend === "opencode") {
            throw new Error("OpenCode API POST /session returned 429: rate limited");
          }
          return { text: "ok from agy", value: "ok from agy" };
        },
      },
    };
  };

  const out = await runWithFallback({
    agent: "coder",
    backend: "opencode",
    connect,
    attempt: async (sel, ctx) => {
      const res = await ctx.client.sendPrompt(ctx.session.id, "run task", {
        agent: sel.agent,
        model: sel.model,
      });
      return { text: res.text, value: res.value };
    },
  });

  assert.equal(out.usedFallback, true);
  assert.equal(sessions.length, 2, "must mint a fresh session for the fallback backend");
  assert.equal(sessions[0].backend, "opencode");
  assert.equal(sessions[1].backend, "agy");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].backend, "opencode");
  assert.equal(attempts[1].backend, "agy");
  assert.equal(
    attempts[1].sessionId,
    sessions[1].session.id,
    "retry must run against the freshly minted fallback session, not the primary session",
  );
  assert.equal(attempts[1].model, "gemini-3.8-flash-high");
});


test("the environment is restored after a fallback runs", async () => {
  const before = process.env.OPENCODE_BACKEND;
  await runWithFallback({
    agent: "coder",
    attempt: async (sel) => {
      if (sel.agent === "coder" && process.env.OPENCODE_BACKEND !== "agy") {
        throw new Error("fetch failed");
      }
      return { text: "ok", value: "ok" };
    },
  });
  assert.equal(process.env.OPENCODE_BACKEND, before,
    "a leaked backend would move every later job onto the fallback");
  assert.equal(process.env.AGY_MODEL, undefined);
});

test("the environment is restored even when the fallback also fails", async () => {
  const before = process.env.OPENCODE_BACKEND;
  await assert.rejects(
    runWithFallback({
      agent: "coder",
      attempt: async () => { throw new Error("fetch failed"); },
    }),
    /Both models failed/,
  );
  assert.equal(process.env.OPENCODE_BACKEND, before);
  assert.equal(process.env.AGY_MODEL, undefined);
});

test("an unreachable reviewer returns a handoff instead of throwing", async () => {
  const out = await runWithFallback({
    agent: "reviewer",
    attempt: async () => { throw new Error("OpenCode API POST /session returned 503: down"); },
  });
  assert.equal(out.value, null);
  assert.equal(out.handoff.handoff, "claude-subagent");
  assert.equal(out.handoff.model, "sonnet");
  assert.match(out.handoff.reason, /503/);
});

test("a seat with no fallback rethrows the transport failure", async () => {
  await assert.rejects(
    runWithFallback({
      agent: "nonesuch",
      attempt: async () => { throw new Error("socket hang up"); },
    }),
    /socket hang up/,
  );
});

test("an empty primary response triggers the fallback", async () => {
  let calls = 0;
  const out = await runWithFallback({
    agent: "coder",
    attempt: async () => {
      calls++;
      if (calls === 1) return { text: "  ", value: null };
      return { text: "real answer", value: "real answer" };
    },
  });
  assert.equal(out.usedFallback, true);
  assert.equal(out.value, "real answer");
});

test("detectQuotaNotice handles structured provider errors and retry notices", () => {
  assert.equal(detectQuotaNotice(null), null);
  assert.equal(detectQuotaNotice({}), null);

  // Structured HTTP 429 error on the assistant message
  const err429 = {
    info: {
      role: "assistant",
      error: {
        name: "APIError",
        data: {
          statusCode: 429,
          message: "Error from provider (Console): Rate limit exceeded. Please try again later.",
        },
      },
    },
    parts: [],
  };
  assert.match(detectQuotaNotice(err429), /Rate limit exceeded/i);

  // Structured FreeUsageLimitError payload
  const freeUsage = {
    info: {
      role: "assistant",
      error: {
        name: "APIError",
        data: {
          statusCode: 429,
          responseBody: JSON.stringify({
            type: "error",
            error: {
              type: "FreeUsageLimitError",
              message: "Rate limit exceeded.",
            },
          }),
        },
      },
    },
    parts: [],
  };
  assert.match(detectQuotaNotice(freeUsage), /FreeUsageLimitError|Rate limit/i);

  // Structured error part in parts array
  const partErr = {
    info: { role: "assistant" },
    parts: [{ type: "error", error: "Rate limit exceeded (429)" }],
  };
  assert.match(detectQuotaNotice(partErr), /Rate limit exceeded/i);

  // Exact opencode daemon prose in text part
  const proseNotice = {
    info: { role: "assistant" },
    parts: [
      {
        type: "text",
        text: "Free usage exceeded, subscribe to Go\nretrying in 52049s - attempt #1",
      },
    ],
  };
  assert.match(detectQuotaNotice(proseNotice), /Free usage exceeded/i);

  const retryNotice = {
    info: { role: "assistant" },
    parts: [{ type: "text", text: "retrying in 3600s - attempt #2" }],
  };
  assert.match(detectQuotaNotice(retryNotice), /retrying in 3600s/i);

  // Must not false-positive on assistant discussing rate limits in prose
  const proseAssistant = {
    info: { role: "assistant" },
    parts: [
      {
        type: "text",
        text: "I will add a rate limit retry loop to the client and ensure no per-chunk quota exists.",
      },
    ],
  };
  assert.equal(detectQuotaNotice(proseAssistant), null);

  // Must not false-positive on code edits inside tool inputs
  const toolPart = {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: {
            content: 'if (err.code === "rate_limit") throw new Error("quota exceeded");',
          },
        },
      },
    ],
  };
  assert.equal(detectQuotaNotice(toolPart), null);
});

test("sendPrompt watcher aborts promptly on quota notice with a transport failure", async () => {
  const originalFetch = global.fetch;
  const originalDelay = process.env.OPENCODE_MIN_POLL_DELAY_MS;
  const originalInterval = process.env.OPENCODE_COMPLETION_POLL_MS;
  process.env.OPENCODE_MIN_POLL_DELAY_MS = "10";
  process.env.OPENCODE_COMPLETION_POLL_MS = "10";

  try {
    global.fetch = async (url, init) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/message")) {
        return new Promise((_, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason);
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal.reason);
          });
        });
      }
      if (u.includes("/message?limit=1")) {
        return {
          ok: true,
          json: async () => [
            {
              info: {
                id: "msg-retry",
                role: "assistant",
                time: { created: Date.now() },
              },
              parts: [
                {
                  type: "text",
                  text: "Free usage exceeded, subscribe to Go\nretrying in 52049s - attempt #1",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    };

    const client = createClient("http://127.0.0.1:4096");
    let caughtErr = null;
    try {
      await client.sendPrompt("sess-quota-1", "test prompt");
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "expected sendPrompt to abort and throw");
    assert.match(caughtErr.message, /quota|rate limit/i);
    assert.equal(isTransportFailure(caughtErr), true, "quota abort must be classified as a transport failure");
  } finally {
    global.fetch = originalFetch;
    if (originalDelay !== undefined) {
      process.env.OPENCODE_MIN_POLL_DELAY_MS = originalDelay;
    } else {
      delete process.env.OPENCODE_MIN_POLL_DELAY_MS;
    }
    if (originalInterval !== undefined) {
      process.env.OPENCODE_COMPLETION_POLL_MS = originalInterval;
    } else {
      delete process.env.OPENCODE_COMPLETION_POLL_MS;
    }
  }
});

test("sendPrompt watcher aborts promptly on structured info.error 429", async () => {
  const originalFetch = global.fetch;
  const originalDelay = process.env.OPENCODE_MIN_POLL_DELAY_MS;
  const originalInterval = process.env.OPENCODE_COMPLETION_POLL_MS;
  process.env.OPENCODE_MIN_POLL_DELAY_MS = "10";
  process.env.OPENCODE_COMPLETION_POLL_MS = "10";

  try {
    global.fetch = async (url, init) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/message")) {
        return new Promise((_, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason);
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal.reason);
          });
        });
      }
      if (u.includes("/message?limit=1")) {
        return {
          ok: true,
          json: async () => [
            {
              info: {
                id: "msg-429",
                role: "assistant",
                time: { created: Date.now() },
                error: {
                  name: "APIError",
                  data: {
                    statusCode: 429,
                    message: "Error from provider (Console): Rate limit exceeded. Please try again later.",
                  },
                },
              },
              parts: [],
            },
          ],
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    };

    const client = createClient("http://127.0.0.1:4096");
    let caughtErr = null;
    try {
      await client.sendPrompt("sess-quota-2", "test prompt");
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "expected sendPrompt to abort on 429");
    assert.match(caughtErr.message, /quota|rate limit/i);
    assert.equal(isTransportFailure(caughtErr), true, "429 abort must be classified as a transport failure");
  } finally {
    global.fetch = originalFetch;
    if (originalDelay !== undefined) {
      process.env.OPENCODE_MIN_POLL_DELAY_MS = originalDelay;
    } else {
      delete process.env.OPENCODE_MIN_POLL_DELAY_MS;
    }
    if (originalInterval !== undefined) {
      process.env.OPENCODE_COMPLETION_POLL_MS = originalInterval;
    } else {
      delete process.env.OPENCODE_COMPLETION_POLL_MS;
    }
  }
});

test("quota error triggers runWithFallback to retry on agy", async () => {
  let calls = 0;
  const out = await runWithFallback({
    agent: "coder",
    attempt: async (sel) => {
      calls++;
      if (calls === 1) {
        throw new Error("opencode rate limit / quota exceeded: Free usage exceeded, subscribe to Go");
      }
      return { text: "recovered on agy", value: "recovered on agy" };
    },
  });
  assert.equal(out.usedFallback, true);
  assert.equal(out.value, "recovered on agy");
});

test("session idle timeout triggers runWithFallback to retry on agy", async () => {
  let calls = 0;
  const out = await runWithFallback({
    agent: "coder",
    attempt: async (sel) => {
      calls++;
      if (calls === 1) {
        throw new Error("session idle timeout: 3601s > 3600s");
      }
      return { text: "recovered after idle timeout", value: "recovered after idle timeout" };
    },
  });
  assert.equal(out.usedFallback, true);
  assert.equal(out.value, "recovered after idle timeout");
});

test("prompt timeout triggers runWithFallback to retry on agy", async () => {
  let calls = 0;
  const out = await runWithFallback({
    agent: "coder",
    attempt: async (sel) => {
      calls++;
      if (calls === 1) {
        throw new Error("Aborted after 14400s (OPENCODE_PROMPT_TIMEOUT_MS=14400000). [prompt timeout]");
      }
      return { text: "recovered after prompt timeout", value: "recovered after prompt timeout" };
    },
  });
  assert.equal(out.usedFallback, true);
  assert.equal(out.value, "recovered after prompt timeout");
});

test("parseOpencodeLogError extracts error.error and strips AI_APICallError prefix", () => {
  const sid = "ses_f841ce2d3ffeWiSyQozsPIXXrq";
  const logContent = [
    'timestamp=2026-09-07T12:40:00.000Z level=INFO message="session created" session.id=' + sid,
    'timestamp=2026-09-07T12:41:19.826Z level=ERROR message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free session.id=' + sid + ' error.error="AI_APICallError: Rate limit exceeded. Please try again later."',
    'timestamp=2026-09-07T12:42:00.000Z level=INFO message="heartbeat"',
  ].join("\n");

  const err = parseOpencodeLogError(logContent, sid);
  assert.equal(err, "Rate limit exceeded. Please try again later.");

  // Non-matching session returns null
  assert.equal(parseOpencodeLogError(logContent, "ses_other"), null);

  // Plain error without AI_APICallError prefix
  const plainLog = 'timestamp=... level=ERROR session.id=ses_test error.error="Direct error message"';
  assert.equal(parseOpencodeLogError(plainLog, "ses_test"), "Direct error message");

  // Missing error.error field falls back to message
  const msgLog = 'timestamp=... level=ERROR session.id=ses_test message="stream failed abruptly"';
  assert.equal(parseOpencodeLogError(msgLog, "ses_test"), "stream failed abruptly");
});

test("readOpencodeLogError handles missing, empty, and valid files", async () => {
  // Missing file
  const missing = await readOpencodeLogError("ses_test", "/path/to/definitely/nonexistent/log.log");
  assert.equal(missing, null);

  // Valid fixture file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "octest-"));
  const logFile = path.join(tmpDir, "opencode.log");
  try {
    fs.writeFileSync(
      logFile,
      'timestamp=2026-09-07T12:41:19.826Z level=ERROR message="stream error" session.id=ses_fix1 error.error="AI_APICallError: Rate limit exceeded. Please try again later."\n',
      "utf8",
    );
    const parsed = await readOpencodeLogError("ses_fix1", logFile);
    assert.equal(parsed, "Rate limit exceeded. Please try again later.");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sendPrompt watcher aborts on stalled stream (zero tokens, zero parts, past threshold)", async () => {
  const originalFetch = global.fetch;
  const originalDelay = process.env.OPENCODE_MIN_POLL_DELAY_MS;
  const originalInterval = process.env.OPENCODE_COMPLETION_POLL_MS;
  const originalStall = process.env.OPENCODE_STREAM_STALL_MS;
  process.env.OPENCODE_MIN_POLL_DELAY_MS = "10";
  process.env.OPENCODE_COMPLETION_POLL_MS = "10";
  process.env.OPENCODE_STREAM_STALL_MS = "50";

  try {
    global.fetch = async (url, init) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/message")) {
        return new Promise((_, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason);
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal.reason);
          });
        });
      }
      if (u.includes("/message?limit=1")) {
        return {
          ok: true,
          json: async () => [
            {
              role: "assistant",
              error: null,
              parts: [],
              model: "muse-spark-1.3-contributor-free",
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: Date.now() - 100 },
            },
          ],
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    };

    const client = createClient("http://127.0.0.1:4096");
    let caughtErr = null;
    try {
      await client.sendPrompt("sess-stall-1", "test prompt");
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "expected sendPrompt to abort on stalled stream");
    assert.match(caughtErr.message, /stream stalled: no tokens and no parts/i);
    assert.equal(isTransportFailure(caughtErr), true, "stalled stream must be classified as a transport failure");
  } finally {
    global.fetch = originalFetch;
    if (originalDelay !== undefined) process.env.OPENCODE_MIN_POLL_DELAY_MS = originalDelay;
    else delete process.env.OPENCODE_MIN_POLL_DELAY_MS;
    if (originalInterval !== undefined) process.env.OPENCODE_COMPLETION_POLL_MS = originalInterval;
    else delete process.env.OPENCODE_COMPLETION_POLL_MS;
    if (originalStall !== undefined) process.env.OPENCODE_STREAM_STALL_MS = originalStall;
    else delete process.env.OPENCODE_STREAM_STALL_MS;
  }
});

test("sendPrompt watcher aborts promptly when server log records an error for the session", async () => {
  const originalFetch = global.fetch;
  const originalDelay = process.env.OPENCODE_MIN_POLL_DELAY_MS;
  const originalInterval = process.env.OPENCODE_COMPLETION_POLL_MS;
  const originalLogPath = process.env.OPENCODE_LOG_PATH;
  process.env.OPENCODE_MIN_POLL_DELAY_MS = "10";
  process.env.OPENCODE_COMPLETION_POLL_MS = "10";

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "octest-log-"));
  const logFile = path.join(tmpDir, "opencode.log");
  process.env.OPENCODE_LOG_PATH = logFile;

  try {
    fs.writeFileSync(
      logFile,
      'timestamp=2026-09-07T12:41:19.826Z level=ERROR message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free session.id=sess-log-err-1 error.error="AI_APICallError: Rate limit exceeded. Please try again later."\n',
      "utf8",
    );

    global.fetch = async (url, init) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/message")) {
        return new Promise((_, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason);
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal.reason);
          });
        });
      }
      if (u.includes("/message?limit=1")) {
        return {
          ok: true,
          json: async () => [
            {
              role: "assistant",
              error: null,
              parts: [],
              time: { created: Date.now() },
            },
          ],
        };
      }
      throw new Error(`unexpected fetch: ${u}`);
    };

    const client = createClient("http://127.0.0.1:4096");
    let caughtErr = null;
    try {
      await client.sendPrompt("sess-log-err-1", "test prompt");
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr, "expected sendPrompt to abort on server log error");
    assert.match(caughtErr.message, /Rate limit exceeded\. Please try again later\./);
    assert.equal(isTransportFailure(caughtErr), true, "log rate limit must be classified as transport failure");
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalDelay !== undefined) process.env.OPENCODE_MIN_POLL_DELAY_MS = originalDelay;
    else delete process.env.OPENCODE_MIN_POLL_DELAY_MS;
    if (originalInterval !== undefined) process.env.OPENCODE_COMPLETION_POLL_MS = originalInterval;
    else delete process.env.OPENCODE_COMPLETION_POLL_MS;
    if (originalLogPath !== undefined) process.env.OPENCODE_LOG_PATH = originalLogPath;
    else delete process.env.OPENCODE_LOG_PATH;
  }
});

test("stalled stream error triggers runWithFallback to retry on agy", async () => {
  let calls = 0;
  const out = await runWithFallback({
    agent: "coder",
    attempt: async (sel) => {
      calls++;
      if (calls === 1) {
        throw new Error("opencode stream stalled: no tokens and no parts after 90s (provider likely rate limited)");
      }
      return { text: "recovered on fallback", value: "recovered on fallback" };
    },
  });
  assert.equal(out.usedFallback, true);
  assert.equal(out.value, "recovered on fallback");
});
