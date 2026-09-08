// Backend selection for the companion's transport layer.
//
// One explicit mechanism: the OPENCODE_BACKEND env var ("opencode" default,
// "agy" alternative). Everything above the transport (companion handlers,
// hooks, tracked jobs, state, render, prompts, git) stays shared; only the
// four transport entry points dispatched here differ per backend.
//
// Usage in the three former opencode-server.mjs importers:
//   import { isServerRunning, ensureServer, createClient, connect } from "./lib/backend.mjs";
// Signatures are unchanged, so those call sites work for both backends.

import { upsertJob } from "./state.mjs";
import { isOpencodeInstalled, getOpencodeVersion } from "./process.mjs";
import * as opencode from "./opencode-server.mjs";
import * as agy from "./agy-runner.mjs";

export const BACKENDS = ["opencode", "agy"];
export const DEFAULT_BACKEND = "opencode";

/**
 * Resolve the active backend name. Throws on unknown values so a typo
 * fails fast instead of silently running the wrong backend mid-A/B test.
 * @param {string} [override]
 * @returns {"opencode"|"agy"}
 */
export function resolveBackendName(override) {
  const raw = override ?? process.env.OPENCODE_BACKEND ?? DEFAULT_BACKEND;
  const v = String(raw).trim().toLowerCase();
  if (v === "opencode" || v === "agy") return v;
  throw new Error(
    `Unknown OPENCODE_BACKEND=${JSON.stringify(String(raw))} (expected "opencode" or "agy")`,
  );
}

/**
 * Validate a backend name from CLI flag or options.
 * @param {string|undefined} raw
 * @param {string} [flagName]
 * @returns {"opencode"|"agy"|undefined}
 */
export function validateBackend(raw, flagName = "--backend") {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (BACKENDS.includes(v)) return v;
  const expected = BACKENDS.map((b) => JSON.stringify(b)).join(" or ");
  throw new Error(
    `Unknown ${flagName}=${JSON.stringify(String(raw))} (expected ${expected})`,
  );
}

function impl(backend) {
  return resolveBackendName(backend) === "agy" ? agy : opencode;
}

export async function isServerRunning(opts = {}, ...args) {
  return impl(opts?.backend).isServerRunning(opts, ...args);
}

export async function ensureServer(opts = {}, ...args) {
  return impl(opts?.backend).ensureServer(opts, ...args);
}

export function createClient(...args) {
  const backend = args[0]?.backend ?? args[1]?.backend;
  return impl(backend).createClient(...args);
}

export async function connect(opts = {}) {
  return impl(opts?.backend).connect(opts);
}

/** Backend-aware "is the CLI installed" for setup/doctor output. */
export async function isBackendInstalled(backend) {
  if (resolveBackendName(backend) === "agy") return agy.isAgyInstalled();
  return isOpencodeInstalled();
}

/** Backend-aware version string for setup/doctor output. */
export async function getBackendVersion(backend) {
  if (resolveBackendName(backend) === "agy") return agy.getAgyVersion();
  return getOpencodeVersion();
}

/**
 * Learn the real session id after an agy prompt.
 *
 * agy createSession is a no-op ({id: null}) because agy mints the
 * conversation_id on the first --print. After sendPrompt, the response
 * carries it at response.agy.conversation_id; persist it to the job record
 * so resume/cancel/heal keep working. Returns the effective id.
 *
 * No-op for opencode responses (no .agy metadata): returns prevId unchanged
 * and writes nothing, so opencode behaviour is byte-for-byte identical.
 *
 * @param {string} workspace
 * @param {string} jobId
 * @param {string|null} prevId
 * @param {any} response
 * @returns {string|null}
 */
export function effectiveSessionId(workspace, jobId, prevId, response) {
  const cid = response?.agy?.conversation_id;
  if (cid && cid !== prevId) {
    try {
      upsertJob(workspace, { id: jobId, opencodeSessionId: cid });
    } catch {
      // State write failure must not fail the job that just succeeded.
    }
    return cid;
  }
  return prevId;
}
