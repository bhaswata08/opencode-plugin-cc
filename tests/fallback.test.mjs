import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACKS,
  resolveFallback,
  isTransportFailure,
  isEmptyResult,
  fallbackBlockedReason,
  runWithFallback,
} from "../plugins/opencode/scripts/lib/fallback.mjs";

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
