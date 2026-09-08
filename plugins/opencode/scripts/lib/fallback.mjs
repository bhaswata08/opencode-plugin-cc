// Per-agent model fallback.
//
// Each seat names a second model that takes over when the first one cannot be
// reached. The point is availability, not a second opinion: a fallback fires
// because the provider failed, never because the agent did its work and the
// work was wrong.
//
// That distinction is the whole design. A job that ends "failed" because the
// tests the coder wrote did not pass is a real result. Re-running it on another
// model wastes a long turn and, in write mode, layers a second model's edits on
// top of the first one's on the same worktree. So isTransportFailure() below
// lists what counts, and everything not listed is left alone.

import { readAgySettings } from "./agy-runner.mjs";

/**
 * Fallback per agent seat. `backend` names the transport to retry on, so a
 * seat can fall across backends; `agent` swaps the whole agent file, which
 * carries model, variant and system prompt together; `model` overrides just
 * the model on the current agent.
 *
 * `handoff` means the plugin cannot run this fallback itself and must hand it
 * back to the orchestrator. Claude Code's own subscription is the only route
 * to Sonnet here (opencode has no Anthropic credential), and a detached worker
 * cannot spawn a Claude Code subagent.
 */
export const FALLBACKS = {
  // muse spark is free only while opencode's contributor tier lasts. gemini
  // through agy runs on an account that is paid for, so it is the seat that
  // survives the free tier going away.
  coder: { backend: "agy", model: "gemini-3.8-flash-high" },
  // "build" is the default agent for write tasks and means the same seat.
  build: { backend: "agy", model: "gemini-3.8-flash-high" },

  reviewer: { handoff: "claude-subagent", model: "sonnet" },

  // Same backend, so the whole agent file swaps: muse spark at variant xhigh
  // with the adversary prompt intact.
  adversary: { backend: "opencode", agent: "adversary-fallback" },
};

/**
 * Look up the fallback for an agent seat.
 * @param {string|undefined} agent
 * @returns {{backend?: string, agent?: string, model?: string, handoff?: string}|null}
 */
export function resolveFallback(agent) {
  if (!agent) return null;
  return FALLBACKS[String(agent).trim().toLowerCase()] ?? null;
}

// Failures that mean "this model was not reachable". Matched against the error
// message, because every transport funnels its own error shapes through
// classifyError into a string before it reaches here.
const TRANSPORT_PATTERNS = [
  // socket-level
  /\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEPIPE\b/i,
  /socket hang up/i,
  /fetch failed/i,
  // the CLI itself is missing or will not start
  /spawn\s+\S+\s+ENOENT/i,
  /\bEACCES\b/i,
  // provider said no: auth, quota, overload, or the model does not exist
  /returned\s+(401|403|404|408|409|429|5\d\d)\b/,
  /\b(401|403|429|500|502|503|504)\b.*\b(unauthorized|forbidden|rate|quota|overloaded|unavailable|internal)\b/i,
  /rate[\s_-]?limit/i,
  /\bquota\b/i,
  /overloaded/i,
  /model[^.]{0,40}\b(not found|unavailable|unsupported|does not exist|unknown)\b/i,
  /no such model/i,
  // timeouts: prompt-level deadline or session stall
  /prompt timeout/i,
  /session idle/i,
  /stream stall/i,
  /stream error/i,
  // the run produced nothing at all
  /no output produced/i,
  /empty response/i,
];

/**
 * Does this failure mean the model was unreachable, rather than that the agent
 * ran and produced a bad result?
 * @param {any} err
 * @returns {boolean}
 */
export function isTransportFailure(err) {
  if (!err) return false;
  // A caller-side timeout means we never got an answer, whoever's fault it is.
  if (err.name === "AbortError") return true;
  const code = err.code || err.cause?.code || "";
  if (/^E[A-Z]+$/.test(String(code))) return true;
  const msg = String(err.message ?? err);
  return TRANSPORT_PATTERNS.some((re) => re.test(msg));
}

/**
 * A response that arrived but carries no text is a failed turn, not a result.
 * @param {string|undefined} text
 * @returns {boolean}
 */
export function isEmptyResult(text) {
  return !text || String(text).trim().length === 0;
}

/**
 * Why a fallback was refused, or null when it may run. Kept separate from
 * resolveFallback so the reason can be logged rather than silently dropped.
 * @param {{backend?: string, handoff?: string}} fb
 * @returns {string|null}
 */
export function fallbackBlockedReason(fb) {
  if (!fb) return "no fallback configured for this agent";
  if (fb.handoff) {
    return `fallback is a ${fb.handoff} handoff, which a background worker cannot spawn`;
  }
  if (fb.backend === "agy") {
    const settings = readAgySettings();
    if (!settings.exists) {
      return `agy fallback needs ${settings.path}, which does not exist`;
    }
    if (!settings.deny.length) {
      return "agy fallback refused: permissions.deny is empty, and it is the only floor under --dangerously-skip-permissions";
    }
  }
  return null;
}

/**
 * Run `attempt` on the primary seat, and once more on the fallback if the
 * first failure was a transport failure.
 *
 * @param {object} opts
 * @param {string} opts.agent - agent seat name
 * @param {(sel: {agent: string, model?: string, backend?: string}, ctx?: any) => Promise<{text: string, value: any}>} opts.attempt
 * @param {string} [opts.model] - primary model override
 * @param {string} [opts.backend] - primary backend name (defaults to OPENCODE_BACKEND or "opencode")
 * @param {(backend: string) => Promise<any>} [opts.connect] - connects and creates session for the given backend
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{value: any, usedFallback: boolean, handoff: object|null}>}
 */
export async function runWithFallback({
  agent,
  attempt,
  model,
  backend,
  connect,
  log = () => {},
}) {
  const primaryBackend = backend ?? process.env.OPENCODE_BACKEND ?? "opencode";
  const primary = { agent, model, backend: primaryBackend };
  let firstError;

  try {
    let primaryCtx;
    if (connect) {
      primaryCtx = await connect(primaryBackend);
    }
    const res = await attempt(primary, primaryCtx);
    if (!isEmptyResult(res?.text)) {
      return { value: res.value, usedFallback: false, handoff: null };
    }
    firstError = new Error("empty response from the primary model");
  } catch (err) {
    firstError = err;
  }

  const fb = resolveFallback(agent);

  if (!isTransportFailure(firstError)) {
    log(`No fallback: ${firstError.message} is a result, not a transport failure.`);
    throw firstError;
  }

  const blocked = fallbackBlockedReason(fb);
  if (blocked) {
    if (fb?.handoff) {
      // Not a silent drop: the job carries the handoff so the orchestrator can
      // run the fallback itself and knows which model to use.
      log(`Primary unreachable (${firstError.message}). Handing off to ${fb.handoff}.`);
      return {
        value: null,
        usedFallback: false,
        handoff: { ...fb, agent, reason: firstError.message },
      };
    }
    log(`Primary unreachable (${firstError.message}), but ${blocked}.`);
    throw firstError;
  }

  const fallbackBackend = fb.backend ?? primaryBackend;
  const fallbackModel = fb.model ?? (fallbackBackend === primaryBackend ? model : undefined);

  const previousBackend = process.env.OPENCODE_BACKEND;
  if (fb.backend) process.env.OPENCODE_BACKEND = fb.backend;
  const previousAgyModel = process.env.AGY_MODEL;
  if (fb.backend === "agy" && fb.model) process.env.AGY_MODEL = fb.model;

  log(
    `Primary unreachable (${firstError.message}). Falling back to ` +
      `${fb.agent ?? agent} on ${fb.backend ?? "the same backend"}` +
      `${fb.model ? ` (${fb.model})` : ""}.`,
  );

  try {
    let fallbackCtx;
    if (connect) {
      fallbackCtx = await connect(fallbackBackend);
    }
    const res = await attempt(
      { agent: fb.agent ?? agent, model: fallbackModel, backend: fallbackBackend },
      fallbackCtx,
    );
    if (!isEmptyResult(res?.text)) {
      return { value: res.value, usedFallback: true, handoff: null };
    }
    throw new Error("empty response from the fallback model");
  } catch (err) {
    // Report the failure the user actually needs to fix: the primary went
    // down, and the backup did not cover for it.
    const e = new Error(
      `Both models failed. Primary (${agent}): ${firstError.message}. ` +
        `Fallback (${fb.agent ?? fb.model}): ${err.message}`,
    );
    e.cause = err;
    throw e;
  } finally {
    // Restore the environment in case other callers or subprocesses read it,
    // so leaving it switched does not silently move later work onto the fallback.
    if (previousBackend === undefined) delete process.env.OPENCODE_BACKEND;
    else process.env.OPENCODE_BACKEND = previousBackend;
    if (previousAgyModel === undefined) delete process.env.AGY_MODEL;
    else process.env.AGY_MODEL = previousAgyModel;
  }
}
