// Reviewer -> coder feedback loop.
//
// A write dispatch finishes, the reviewer reads the diff it produced, and the
// blocking findings go straight back to the coder instead of to the user. The
// loop is bounded in four separate ways, because every one of them is a way it
// has gone wrong before:
//
//  1. Two fix rounds, hard. A reviewer with open licence always finds
//     something, so "the reviewer says it is clean" is not a stop condition you
//     can reach. Round three is taste, not defects.
//  2. The second review is a VERIFY pass, scoped to the previous findings and
//     the fix. A fresh full review re-litigates the same design choices every
//     round and never converges.
//  3. Only correctness findings go back to the coder. A full coder round for a
//     rename costs more than the rename.
//  4. It halts, never spins, on a handoff (the reviewer fallback is a Claude
//     Code subagent, which a worker cannot spawn) and on a coder fallback
//     (which leaves the paid seat for the metered one, once per round).
//
// The loop runs inside the caller's already-tracked job, so it holds ONE
// concurrency slot for its whole life rather than re-acquiring one per round.
// That is deliberate: see the fan-out note on MAX_CONCURRENT_CODING.

/** Hard ceiling on coder rounds. See (1) above. */
export const MAX_FIX_ROUNDS = 2;

/** A one-file diff smaller than this is not worth a reviewer round. */
export const MIN_LOOP_LINES = 30;

/**
 * Severities that go back to the coder. Everything else, including anything
 * unrecognised, is returned to the user as advice. Failing open here would
 * mean a mislabelled nitpick spending a full round, so it fails closed.
 */
export const BLOCKING_SEVERITIES = new Set(["critical", "high"]);

/**
 * Should a finished write dispatch run the loop?
 *
 * @param {object} opts
 * @param {boolean} opts.isWrite - did the dispatch have write access
 * @param {string[]} [opts.changedFiles] - files the dispatch actually touched
 * @param {number} [opts.changedLines] - lines it actually changed
 * @param {boolean} [opts.resumed] - was this a resumed session
 * @param {number} [opts.rounds] - explicit --review-rounds, if the caller passed one
 * @returns {{run: boolean, reason: string}}
 */
export function shouldRunLoop({
  isWrite,
  changedFiles = [],
  changedLines = 0,
  resumed = false,
  rounds,
} = {}) {
  // A read-only dispatch has nothing to review and nothing to fix, so not even
  // an explicit round count turns the loop on.
  if (!isWrite) return { run: false, reason: "read-only dispatch" };
  if (rounds === 0) return { run: false, reason: "disabled by --review-rounds 0" };

  // Resumed means the user is iterating by hand and is already the reviewer.
  if (resumed) return { run: false, reason: "resumed session" };

  if (rounds > 0) return { run: true, reason: `requested ${rounds} round(s)` };

  if (changedFiles.length === 0) {
    return { run: false, reason: "no diff: the dispatch changed nothing" };
  }
  if (changedFiles.length === 1 && changedLines < MIN_LOOP_LINES) {
    return {
      run: false,
      reason: `below the floor: 1 file, ${changedLines} line(s) < ${MIN_LOOP_LINES}`,
    };
  }
  return {
    run: true,
    reason: `${changedFiles.length} file(s), ${changedLines} line(s) changed`,
  };
}

/**
 * Split reviewer findings into the ones the coder gets and the ones the user gets.
 * @param {object[]|undefined} findings
 * @returns {{blocking: object[], advisory: object[]}}
 */
export function partitionFindings(findings) {
  if (!Array.isArray(findings)) return { blocking: [], advisory: [] };
  const blocking = [];
  const advisory = [];
  for (const f of findings) {
    const sev = String(f?.severity ?? "").trim().toLowerCase();
    if (BLOCKING_SEVERITIES.has(sev)) blocking.push(f);
    else advisory.push(f);
  }
  return { blocking, advisory };
}

/**
 * Run the review -> fix -> verify loop.
 *
 * Both callbacks are injected so the loop itself never touches a transport:
 * that keeps the bounding rules testable without a model behind them.
 *
 * @param {object} opts
 * @param {(ctx: {round: number, previousFindings?: object[]}) => Promise<{findings?: object[], handoff?: object, usedFallback?: boolean}>} opts.review
 * @param {(ctx: {round: number, findings: object[]}) => Promise<{handoff?: object, usedFallback?: boolean}>} opts.fix
 * @param {number} [opts.maxRounds] - lower the cap for one dispatch; it cannot be raised past MAX_FIX_ROUNDS
 * @param {boolean} [opts.allowFallback] - keep going after a seat fell back to its metered backup
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{status: "clean"|"exhausted"|"halted", reason: string, fixRounds: number, findings: object[], advisory: object[], handoff: object|null}>}
 */
export async function runReviewLoop({
  review,
  fix,
  maxRounds = MAX_FIX_ROUNDS,
  allowFallback = false,
  log = () => {},
}) {
  const cap = Math.min(maxRounds, MAX_FIX_ROUNDS);

  let round = 1;
  let fixRounds = 0;
  let blocking = [];
  let advisory = [];

  const done = (status, reason, handoff = null) => ({
    status,
    reason,
    fixRounds,
    findings: blocking,
    advisory,
    handoff,
  });

  for (;;) {
    let result;
    try {
      result = await review(
        round === 1 ? { round } : { round, previousFindings: blocking },
      );
    } catch (err) {
      return done("halted", `review failed: ${err.message}`);
    }

    if (result?.handoff) {
      log(`Review loop halted: reviewer needs a ${result.handoff.handoff} handoff.`);
      return done("halted", "reviewer handed off to the orchestrator", result.handoff);
    }
    if (result?.usedFallback && !allowFallback) {
      log("Review loop halted: the reviewer fell back to its backup seat.");
      return done("halted", "reviewer used its fallback seat");
    }

    const split = partitionFindings(result?.findings);
    blocking = split.blocking;
    advisory = split.advisory;

    if (blocking.length === 0) {
      return done("clean", round === 1 ? "first review found nothing blocking" : "fix verified");
    }
    if (fixRounds >= cap) {
      log(`Review loop stopping at the ${cap}-round cap with ${blocking.length} finding(s) open.`);
      return done(
        "exhausted",
        `${blocking.length} blocking finding(s) still open after ${cap} fix round(s)`,
      );
    }

    let fixResult;
    try {
      fixResult = await fix({ round, findings: blocking });
    } catch (err) {
      return done("halted", `fix failed: ${err.message}`);
    }
    fixRounds++;

    if (fixResult?.handoff) {
      return done("halted", "coder handed off to the orchestrator", fixResult.handoff);
    }
    if (fixResult?.usedFallback && !allowFallback) {
      // The paid seat went down and the fix landed on the metered one. One
      // round of that is a fallback; a loop of it is a bill.
      log("Review loop halted: the coder fell back to its metered seat.");
      return done("halted", "coder used its fallback seat, which is metered");
    }

    round++;
  }
}

/**
 * One finding, on one line, for the loop's summary.
 * @param {object} f
 * @returns {string}
 */
function summariseFinding(f) {
  const where = f.file ? ` (${f.file}:${f.line_start ?? "?"})` : "";
  return `  - ${String(f.severity ?? "?").toUpperCase()}: ${f.title}${where}`;
}

/**
 * Render the loop's outcome for the user.
 *
 * "halted" deliberately never reads as a pass: the loop stopping early is the
 * one case where nobody has confirmed the change is fine, so the summary has
 * to say what stopped it rather than fall back to reassuring wording.
 *
 * @param {{status: string, reason: string, fixRounds: number, findings: object[], advisory: object[], handoff?: object|null}} loop
 * @returns {string}
 */
export function renderLoopOutcome(loop) {
  const rounds = `${loop.fixRounds} fix round${loop.fixRounds === 1 ? "" : "s"}`;
  const lines = [];

  if (loop.status === "clean") {
    lines.push(`Review loop: clean after ${rounds}.`);
  } else if (loop.status === "exhausted") {
    lines.push(`Review loop: stopped at the cap after ${rounds}. ${loop.reason}`);
  } else {
    lines.push(`Review loop: halted after ${rounds}. ${loop.reason}`);
    if (loop.handoff) {
      lines.push(
        `  Needs a ${loop.handoff.handoff} on ${loop.handoff.model}; run it from Claude Code.`,
      );
    }
  }

  if (loop.findings?.length) {
    lines.push("", "Still open:");
    lines.push(...loop.findings.map(summariseFinding));
  }
  if (loop.advisory?.length) {
    lines.push("", "Advisory (not sent to the coder):");
    lines.push(...loop.advisory.map(summariseFinding));
  }

  return lines.join("\n");
}

/**
 * How long a loop verdict stands in for a stop-gate review. Past this the
 * tree has almost certainly moved on, so the gate does its own pass again.
 */
export const LOOP_VERDICT_TTL_MS = 10 * 60 * 1000;

/**
 * The most recent review-loop verdict, if one is fresh enough to stand for
 * the change the stop gate is about to review.
 *
 * The gate and the loop are two mechanisms pointed at the same diff. Running
 * both means paying twice for one review, so whichever went first wins.
 *
 * @param {object[]|undefined} jobs
 * @param {number} [now]
 * @returns {object|null}
 */
export function recentLoopVerdict(jobs, now = Date.now()) {
  if (!Array.isArray(jobs)) return null;

  let best = null;
  let bestAt = -Infinity;
  for (const job of jobs) {
    const loop = job?.reviewLoop;
    const at = loop?.completedAt ? new Date(loop.completedAt).getTime() : NaN;
    if (!Number.isFinite(at)) continue;
    if (now - at > LOOP_VERDICT_TTL_MS) continue;
    if (at > bestAt) {
      best = loop;
      bestAt = at;
    }
  }
  return best;
}
