import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FIX_ROUNDS,
  BLOCKING_SEVERITIES,
  shouldRunLoop,
  partitionFindings,
  runReviewLoop,
  renderLoopOutcome,
  recentLoopVerdict,
} from "../plugins/opencode/scripts/lib/review-loop.mjs";

// ------------------------------------------------------------------
// Trigger policy
// ------------------------------------------------------------------

describe("shouldRunLoop", () => {
  const big = { isWrite: true, changedFiles: ["a.mjs", "b.mjs"], changedLines: 80 };

  test("runs for a write dispatch whose diff clears the floor", () => {
    assert.equal(shouldRunLoop(big).run, true);
  });

  test("does not run for a read-only dispatch", () => {
    const got = shouldRunLoop({ ...big, isWrite: false });
    assert.equal(got.run, false);
    assert.match(got.reason, /read-only/i);
  });

  test("does not run when the dispatch produced no diff", () => {
    const got = shouldRunLoop({ isWrite: true, changedFiles: [], changedLines: 0 });
    assert.equal(got.run, false);
    assert.match(got.reason, /no (diff|change)/i);
  });

  test("does not run for a one-file diff below the line floor", () => {
    const got = shouldRunLoop({ isWrite: true, changedFiles: ["a.mjs"], changedLines: 4 });
    assert.equal(got.run, false);
    assert.match(got.reason, /floor|small|below/i);
  });

  test("runs for a one-file diff that clears the line floor", () => {
    assert.equal(
      shouldRunLoop({ isWrite: true, changedFiles: ["a.mjs"], changedLines: 40 }).run,
      true,
    );
  });

  test("runs for a two-file diff even when it is only a few lines", () => {
    assert.equal(
      shouldRunLoop({ isWrite: true, changedFiles: ["a.mjs", "b.mjs"], changedLines: 6 }).run,
      true,
    );
  });

  test("does not run on a resumed session, where the user is iterating by hand", () => {
    const got = shouldRunLoop({ ...big, resumed: true });
    assert.equal(got.run, false);
    assert.match(got.reason, /resum/i);
  });

  test("rounds:0 disables the loop even for a diff that clears the floor", () => {
    const got = shouldRunLoop({ ...big, rounds: 0 });
    assert.equal(got.run, false);
    assert.match(got.reason, /disabled|--review-rounds/i);
  });

  test("an explicit round count forces the loop on below the floor", () => {
    const got = shouldRunLoop({
      isWrite: true,
      changedFiles: ["a.mjs"],
      changedLines: 1,
      rounds: 1,
    });
    assert.equal(got.run, true);
    assert.match(got.reason, /request/i);
  });

  test("an explicit round count still cannot force the loop onto a read-only dispatch", () => {
    assert.equal(shouldRunLoop({ isWrite: false, rounds: 2, changedFiles: ["a"] }).run, false);
  });
});

// ------------------------------------------------------------------
// Severity gate
// ------------------------------------------------------------------

describe("partitionFindings", () => {
  test("correctness severities are the only ones sent back to the coder", () => {
    const { blocking, advisory } = partitionFindings([
      { severity: "critical", title: "null deref" },
      { severity: "high", title: "off by one" },
      { severity: "medium", title: "missing error handling" },
      { severity: "low", title: "rename this" },
      { severity: "info", title: "consider extracting" },
    ]);
    assert.deepEqual(
      blocking.map((f) => f.title),
      ["null deref", "off by one"],
    );
    assert.deepEqual(
      advisory.map((f) => f.title),
      ["missing error handling", "rename this", "consider extracting"],
    );
  });

  test("an unrecognised severity is advisory, so an odd label cannot spend a round", () => {
    const { blocking, advisory } = partitionFindings([{ severity: "spicy", title: "?" }]);
    assert.deepEqual(blocking, []);
    assert.equal(advisory.length, 1);
  });

  test("a missing severity is advisory", () => {
    const { blocking } = partitionFindings([{ title: "no severity at all" }]);
    assert.deepEqual(blocking, []);
  });

  test("severity matching ignores case and surrounding space", () => {
    const { blocking } = partitionFindings([{ severity: " HIGH ", title: "x" }]);
    assert.equal(blocking.length, 1);
  });

  test("a non-array input partitions to empty rather than throwing", () => {
    assert.deepEqual(partitionFindings(undefined), { blocking: [], advisory: [] });
  });

  test("BLOCKING_SEVERITIES is the documented pair", () => {
    assert.deepEqual([...BLOCKING_SEVERITIES].sort(), ["critical", "high"]);
  });
});

// ------------------------------------------------------------------
// The loop itself
// ------------------------------------------------------------------

const blockingFinding = (title = "boom") => ({ severity: "critical", title });

describe("runReviewLoop", () => {
  test("a clean first review costs no fix round", async () => {
    const calls = [];
    const got = await runReviewLoop({
      review: async () => {
        calls.push("review");
        return { findings: [] };
      },
      fix: async () => {
        calls.push("fix");
        return {};
      },
    });
    assert.equal(got.status, "clean");
    assert.equal(got.fixRounds, 0);
    assert.deepEqual(calls, ["review"]);
  });

  test("a blocking finding is fixed and the fix is verified", async () => {
    const calls = [];
    let reviews = 0;
    const got = await runReviewLoop({
      review: async () => {
        calls.push("review");
        return { findings: reviews++ === 0 ? [blockingFinding()] : [] };
      },
      fix: async () => {
        calls.push("fix");
        return {};
      },
    });
    assert.equal(got.status, "clean");
    assert.equal(got.fixRounds, 1);
    assert.deepEqual(calls, ["review", "fix", "review"]);
  });

  test("the verify pass is told which findings it is verifying", async () => {
    const seen = [];
    await runReviewLoop({
      review: async ({ round, previousFindings }) => {
        seen.push({ round, previousFindings });
        return { findings: round === 1 ? [blockingFinding("leak")] : [] };
      },
      fix: async () => ({}),
    });
    assert.equal(seen[0].previousFindings, undefined);
    assert.equal(seen[1].round, 2);
    assert.deepEqual(
      seen[1].previousFindings.map((f) => f.title),
      ["leak"],
    );
  });

  test("advisory-only findings do not spend a fix round", async () => {
    const calls = [];
    const got = await runReviewLoop({
      review: async () => {
        calls.push("review");
        return { findings: [{ severity: "low", title: "rename" }] };
      },
      fix: async () => {
        calls.push("fix");
        return {};
      },
    });
    assert.equal(got.status, "clean");
    assert.deepEqual(calls, ["review"]);
    assert.deepEqual(
      got.advisory.map((f) => f.title),
      ["rename"],
    );
  });

  test("a diff that never comes clean stops at the cap instead of looping", async () => {
    let fixes = 0;
    const got = await runReviewLoop({
      review: async () => ({ findings: [blockingFinding()] }),
      fix: async () => {
        fixes++;
        return {};
      },
    });
    assert.equal(got.status, "exhausted");
    assert.equal(fixes, MAX_FIX_ROUNDS);
    assert.equal(got.fixRounds, MAX_FIX_ROUNDS);
    assert.equal(got.findings.length, 1);
  });

  test("a reviewer handoff halts the loop instead of spinning", async () => {
    let fixes = 0;
    const got = await runReviewLoop({
      review: async () => ({ handoff: { handoff: "claude-subagent", model: "sonnet" } }),
      fix: async () => {
        fixes++;
        return {};
      },
    });
    assert.equal(got.status, "halted");
    assert.equal(got.handoff.model, "sonnet");
    assert.equal(fixes, 0);
  });

  test("a handoff on the verify pass halts and keeps the findings it already has", async () => {
    const got = await runReviewLoop({
      review: async ({ round }) =>
        round === 1
          ? { findings: [blockingFinding("first")] }
          : { handoff: { handoff: "claude-subagent", model: "sonnet" } },
      fix: async () => ({}),
    });
    assert.equal(got.status, "halted");
    assert.equal(got.fixRounds, 1);
    assert.deepEqual(
      got.findings.map((f) => f.title),
      ["first"],
    );
  });

  test("a coder that fell back to the metered seat halts before a second paid round", async () => {
    let fixes = 0;
    const got = await runReviewLoop({
      review: async () => ({ findings: [blockingFinding()] }),
      fix: async () => {
        fixes++;
        return { usedFallback: true };
      },
    });
    assert.equal(got.status, "halted");
    assert.match(got.reason, /fallback/i);
    assert.equal(fixes, 1);
  });

  test("allowFallback lets the loop keep going through a fallback", async () => {
    let fixes = 0;
    const got = await runReviewLoop({
      allowFallback: true,
      review: async () => ({ findings: [blockingFinding()] }),
      fix: async () => {
        fixes++;
        return { usedFallback: true };
      },
    });
    assert.equal(got.status, "exhausted");
    assert.equal(fixes, MAX_FIX_ROUNDS);
  });

  test("a fix that throws halts the loop and keeps the error", async () => {
    const got = await runReviewLoop({
      review: async () => ({ findings: [blockingFinding()] }),
      fix: async () => {
        throw new Error("coder died");
      },
    });
    assert.equal(got.status, "halted");
    assert.match(got.reason, /coder died/);
  });

  test("a review that throws on the first round halts rather than fixing blind", async () => {
    let fixes = 0;
    const got = await runReviewLoop({
      review: async () => {
        throw new Error("reviewer died");
      },
      fix: async () => {
        fixes++;
        return {};
      },
    });
    assert.equal(got.status, "halted");
    assert.match(got.reason, /reviewer died/);
    assert.equal(fixes, 0);
  });

  test("maxRounds can be lowered per dispatch", async () => {
    let fixes = 0;
    const got = await runReviewLoop({
      maxRounds: 1,
      review: async () => ({ findings: [blockingFinding()] }),
      fix: async () => {
        fixes++;
        return {};
      },
    });
    assert.equal(fixes, 1);
    assert.equal(got.status, "exhausted");
  });

  test("the cap is two fix rounds", () => {
    assert.equal(MAX_FIX_ROUNDS, 2);
  });
});

describe("renderLoopOutcome", () => {
  test("a clean loop says so in one line", () => {
    const out = renderLoopOutcome({
      status: "clean",
      reason: "fix verified",
      fixRounds: 1,
      findings: [],
      advisory: [],
    });
    assert.match(out, /Review loop/);
    assert.match(out, /clean/i);
    assert.match(out, /1 fix round/);
  });

  test("an exhausted loop lists what is still open, because the user has to act on it", () => {
    const out = renderLoopOutcome({
      status: "exhausted",
      reason: "1 blocking finding(s) still open after 2 fix round(s)",
      fixRounds: 2,
      findings: [{ severity: "critical", title: "still broken", file: "a.mjs", line_start: 3 }],
      advisory: [],
    });
    assert.match(out, /still broken/);
    assert.match(out, /a\.mjs:3/);
    assert.match(out, /CRITICAL/);
  });

  test("a halted loop states why it stopped rather than implying the work is clean", () => {
    const out = renderLoopOutcome({
      status: "halted",
      reason: "reviewer handed off to the orchestrator",
      fixRounds: 0,
      findings: [],
      advisory: [],
      handoff: { handoff: "claude-subagent", model: "sonnet" },
    });
    assert.match(out, /halted/i);
    assert.match(out, /handed off/);
    assert.doesNotMatch(out, /clean/i);
  });

  test("advisory findings are reported to the user, not silently dropped", () => {
    const out = renderLoopOutcome({
      status: "clean",
      reason: "first review found nothing blocking",
      fixRounds: 0,
      findings: [],
      advisory: [{ severity: "low", title: "rename this", file: "b.mjs", line_start: 9 }],
    });
    assert.match(out, /rename this/);
    assert.match(out, /advisory/i);
  });
});

describe("recentLoopVerdict", () => {
  const at = (iso, extra = {}) => ({
    type: "task",
    reviewLoop: { status: "clean", fixRounds: 1, completedAt: iso, ...extra },
  });
  const now = new Date("2026-01-01T12:00:00Z").getTime();

  test("finds a loop that ran moments ago", () => {
    const got = recentLoopVerdict([at("2026-01-01T11:59:00Z")], now);
    assert.equal(got.status, "clean");
  });

  test("ignores a loop from an hour ago, which reviewed a different change", () => {
    assert.equal(recentLoopVerdict([at("2026-01-01T11:00:00Z")], now), null);
  });

  test("prefers the newest loop when several jobs carry one", () => {
    const got = recentLoopVerdict(
      [at("2026-01-01T11:58:00Z", { status: "exhausted" }), at("2026-01-01T11:59:30Z")],
      now,
    );
    assert.equal(got.status, "clean");
  });

  test("returns null when no job ran a loop", () => {
    assert.equal(recentLoopVerdict([{ type: "task" }], now), null);
    assert.equal(recentLoopVerdict([], now), null);
    assert.equal(recentLoopVerdict(undefined, now), null);
  });

  test("a marker with no timestamp is ignored rather than trusted forever", () => {
    assert.equal(
      recentLoopVerdict([{ type: "task", reviewLoop: { status: "clean" } }], now),
      null,
    );
  });
});
