// Antigravity CLI (`agy`) transport.
//
// Selectable alternative to the OpenCode HTTP transport in
// opencode-server.mjs. There is NO agy server (no `serve` subcommand, no REST
// API, no health endpoint), so this module shells out to `agy --print` per
// prompt instead of speaking HTTP+SSE.
//
// Backend selection lives in backend.mjs (OPENCODE_BACKEND env var, default
// "opencode"). This module only implements the agy side behind the same
// function names (isServerRunning / ensureServer / createClient / connect)
// plus the five client methods the plugin uses:
//   sendPrompt / createSession / listProviders / getSessionDiff / abortSession
//
// Verified against agy 1.1.19 (see report):
//   - `agy --output-format json --print "..."`
//       -> {"conversation_id","status","response","duration_seconds",
//           "num_turns","usage"}; status is SUCCESS, ERROR or CANCELED.
//       Exit code stays 0 even on ERROR/CANCELED, so the `status` field (not
//       the exit code) decides success.
//   - `--conversation <id>` resumes; `--continue` resumes the most recent.
//     A fresh UUID passed to --conversation is NOT adopted (agy warns
//     "conversation not found" and mints a new id), so createSession is a
//     no-op and the conversation_id is learned from the first --print.
//   - `--model` and `--output-format` MUST precede `-p`/`--print`: the print
//     flag swallows the next token as its prompt value (hard error since
//     1.1.18). buildPrintArgs() always appends --print last.
//   - `agy models` prints `<id>\t<Name>` lines on stdout (progress spinner
//     on stderr). `agy agents` returns empty (treated as unsupported).
//   - Sessions persist as sqlite at
//     ~/.gemini/antigravity-cli/conversations/<id>.db.
//
// Permissions (verified): headless agy denies every tool call by default.
// Workspace trust does NOT change this. The permissions.allow list in
// ~/.gemini/antigravity-cli/settings.json DOES apply in print mode, matching
// on `command(<...>)` rules with argument-prefix semantics, but chained
// commands (`&&`, `;`) are always denied. So:
//   1. Users need a scoped allow-list (AGY_SCOPED_ALLOWLIST below), NOT
//      --dangerously-skip-permissions.
//   2. AGY_TOOL_POLICY (appended to every prompt) tells the model to issue
//      ONE command per tool call and never chain.
//   3. Denials surface as status CANCELED (empty response) or ERROR with an
//      "error" field; sendPrompt throws an actionable error in both cases
//      instead of returning empty text that looks like a hang.
//
// Flags used below - all verified against the real binary, agy 1.1.19, not
// only unit-tested against a fake: --effort, --mode accept-edits,
// --print-timeout, and --json-schema all work as used here. --json-schema in
// particular was checked end to end: it correctly returned a
// structured_output field shaped {"ok":true} for a trivial schema. Do not
// re-flag these as unverified without testing against the real binary.
//
// Working directory (verified against the real binary, not a fake): headless
// `agy --print` has NO working-directory concept. `spawn(..., {cwd})` sets
// the child's process cwd, but a RELATIVE path in a file write still lands
// in `~/.gemini/antigravity-cli/scratch/`, never that cwd. None of
// `trustedWorkspaces`, `--add-dir .`, or `--project <abspath>` change this;
// only an ABSOLUTE path in the file operation itself works. Left unfixed,
// agy silently writes into its scratch dir, `getSessionDiff` runs git diff
// on an untouched repo, and the job reports success having changed nothing.
// Fix: withAgyPolicy(promptText, directory) appends a workspace-root
// instruction giving that absolute path, so every file operation the model
// issues is absolute. Also verified: a prompt must never say "the current
// working directory" - that phrasing makes agy shell out to `pwd`, then
// `readlink -f /proc/$PPID/cwd`, then a `ps` self-lookup to find itself, all
// denied by the allow-list, failing the run. The workspace policy text below
// states the absolute root directly instead and never uses that phrasing.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getChangedFiles, getUntrackedFiles } from "./git.mjs";

// ---------------------------------------------------------------------------
// Env conventions (mirror the OPENCODE_*_TIMEOUT_MS pattern)
// ---------------------------------------------------------------------------

const AGY_BINARY = process.env.AGY_BINARY || "agy";

// Windows shell note (verified reasoning, F2): agy is a native binary, not an
// npm shim (unlike `opencode`, which needs shell:true to reach its .cmd
// wrapper). `shell: true` on win32 makes node join argv into a single string
// with NO quoting, so every multi-line prompt (every prompt after
// withAgyPolicy appends the policy text) gets shattered - --print only
// captures the first token and agy hard-errors on the rest. It also means
// proc.kill() kills cmd.exe, not agy, leaking the real process past the
// timeout escalation and abortSession. Only shell out when AGY_BINARY is
// itself a script that requires it (.cmd/.bat/.ps1, e.g. a user override);
// plain "agy" (native .exe) is spawned directly so argv quoting and kill()
// both work correctly.
function needsWindowsShell(bin) {
  if (process.platform !== "win32") return false;
  return /\.(cmd|bat|ps1)$/i.test(bin);
}

// Absolute safety cap for one --print invocation. Defaults to the opencode
// prompt cap so both backends share one knob; AGY_PRINT_TIMEOUT_MS overrides
// per-backend. Passed to agy as --print-timeout AND enforced client-side by
// killing the child, so a stuck agy cannot hang the worker past this.
function printTimeoutMs() {
  const v = Number(process.env.AGY_PRINT_TIMEOUT_MS);
  if (Number.isFinite(v) && v > 0) return v;
  const fallback = Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS);
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  return 14_400_000;
}

function defaultModel() {
  return process.env.AGY_MODEL || undefined;
}

function defaultEffort() {
  const e = process.env.AGY_EFFORT;
  return e === "low" || e === "medium" || e === "high" ? e : undefined;
}

// ---------------------------------------------------------------------------
// Prompt policy + allow-list docs
// ---------------------------------------------------------------------------

// Appended (not prepended) to every prompt so the task's own format
// instructions keep recency... no: appended LAST gives it the final word on
// tool mechanics while the explicit "output format unchanged" line keeps
// review JSON / task text intact for A/B fairness.
//
// agy's built-in Grep tool ignores .gitignore and the fileFiltering settings
// key. On repos whose trees carry heavy directories like .venv (such as a 4.6 GB
// virtualenv with 18,000+ torch-wheel files), an unscoped Grep scans all of it,
// hits an internal per-Grep deadline, and fails the whole run with status ERROR
// ("context deadline exceeded").
//
// Verified end to end on 2026-09-07: agy's Grep DOES honor a .geminiignore
// file at the workspace root. Adding .venv/ dropped the reproduction run from
// dying at 1m50s to completing in 30s with correct matches. The settings key
// alone does nothing; the file is the actual mechanism.
//
// The runner guarantees a .geminiignore exists at the workspace root before
// sending a prompt by writing a small default set (.venv/, node_modules/, .git/)
// if the file is absent. If the file already exists, the runner leaves it
// untouched because the user's own rules must win. Appending to a user file, or
// merging, could corrupt user configuration, which is worse than the bug. This
// means a workspace with an existing but partial .geminiignore that omits heavy
// directories can still die of the bug. For those repositories, the policy
// rule below directing the model toward scoped rg is the remaining defense.
export const AGY_TOOL_POLICY = [
  "Headless-runner tool policy (mechanics only; the requested output format above is unchanged):",
  "issue exactly ONE shell command per run_command tool call,",
  "never chain commands with && or ; (chained calls are auto-denied),",
  "prefer the rg shell command over the Grep tool, always with a scoped path or --glob, never repo-wide,",
  "and if a tool call is denied, do not retry the same call: continue with other work",
  "and note the denial briefly in your final summary.",
].join(" ");

/**
 * Workspace-root instruction (P0 fix): headless agy has no working-directory
 * concept, so a relative path in a file read/write/edit lands in agy's own
 * scratch directory, not the task's files (verified against the real
 * binary). Give the model the absolute workspace root directly and tell it
 * to use it for every file operation. Deliberately never says "the current
 * working directory" (see header comment) - that phrasing alone makes agy
 * shell out to pwd/readlink/ps to locate itself, all denied by the
 * allow-list, failing the run.
 * @param {string|undefined} directory
 * @returns {string} empty string when no directory is known
 */
export function workspacePolicy(directory) {
  if (!directory) return "";
  return [
    "Every file read, write, and edit in this task must use an absolute path",
    `rooted at exactly: ${directory}`,
    "A relative path in a file operation is silently lost (it lands outside",
    `this task entirely), so always use ${directory} itself or an absolute`,
    `path built from it (e.g. ${directory}/src/foo.js) - you already know`,
    "the location, so there is no need to look it up first.",
    "File reads and writes need no allow-list rule; only shell commands go",
    "through permissions.allow.",
    "Every shell command must also run with its working directory set to",
    `exactly ${directory}. That working directory defaults to the home`,
    "directory, not to this task's files, so a command left at the default",
    "runs in the wrong place and reports a failure that looks unrelated",
    "(a test runner finds no project, a build finds no sources).",
  ].join(" ");
}

export function withAgyPolicy(promptText, directory) {
  const ws = workspacePolicy(directory);
  const fullPolicy = ws ? `${AGY_TOOL_POLICY}\n\n${ws}` : AGY_TOOL_POLICY;
  if (!promptText) return fullPolicy;
  if (promptText.includes(AGY_TOOL_POLICY)) return promptText;
  return `${promptText}\n\n${fullPolicy}`;
}

// ---------------------------------------------------------------------------
// Workspace ignore defaults (.geminiignore)
// ---------------------------------------------------------------------------

// Minimal set of heavy directory trees agy Grep must never scan. agy Grep
// ignores .gitignore and fileFiltering settings, but honors a .geminiignore
// file at the workspace root.
export const DEFAULT_GEMINIIGNORE = [
  ".venv/",
  "node_modules/",
  ".git/",
];

/**
 * Ensure a .geminiignore file exists at the workspace root before a prompt is
 * sent to agy. If the file is absent, writes the default ignore set. If the
 * file exists, leaves it completely untouched so user rules win.
 *
 * @param {string|undefined} directory
 * @returns {boolean} true if created, false if already present or invalid directory
 */
export function ensureWorkspaceGeminiignore(directory) {
  if (!directory) return false;
  try {
    const st = fs.statSync(directory);
    if (!st.isDirectory()) return false;
  } catch {
    return false;
  }
  const target = path.join(directory, ".geminiignore");
  if (fs.existsSync(target)) return false;
  fs.writeFileSync(target, `${DEFAULT_GEMINIIGNORE.join("\n")}\n`, "utf8");
  return true;
}

// Starting point for the user's permissions.allow list in
// ~/.gemini/antigravity-cli/settings.json. Rules use `command(<...>)`
// syntax with argument-prefix matching (verified: rule `command(ls -la)`
// covers `ls -la /tmp` but NOT `ls -la && echo CHAINED`). Extend with the
// exact commands your tasks need; keep it scoped, never a blanket rule.
export const AGY_SCOPED_ALLOWLIST = [
  "command(ls)",
  "command(cat)",
  "command(rg)",
  "command(head)",
  "command(tail)",
  "command(git status)",
  "command(git diff)",
  "command(git log)",
  "command(git rev-parse)",
];

export const AGY_ALLOWLIST_DOC = [
  "Headless agy denies every tool call until allow-listed in",
  "  ~/.gemini/antigravity-cli/settings.json  ->  permissions.allow",
  "Add scoped rules (argument-prefix match, no chaining):",
  ...AGY_SCOPED_ALLOWLIST.map((r) => `  "${r}",`),
  "This runner passes --dangerously-skip-permissions, so the allow list is",
  "inert while that holds and permissions.deny is the only floor. A deny rule",
  "beats the flag (verified against agy 1.1.19); an allow rule is what the",
  "flag makes redundant. Keep the allow list current anyway: dropping the flag",
  "restores it, and it documents what the agent actually needs.",
  "See AGY_SCOPED_ALLOWLIST and denyListPreflight in lib/agy-runner.mjs.",
].join("\n");

// ---------------------------------------------------------------------------
// arg building / output parsing (pure, unit-tested)
// ---------------------------------------------------------------------------

// Seats that must never write. On the opencode backend they are held to that
// by `tools: {write: false, edit: false, patch: false}` in their agent file;
// agy has no equivalent, and its only read-only mode is plan. Anything not
// listed here gets agy's edit-capable default, so a new read-only seat that
// is not added here would silently gain write access on this backend.
const READ_ONLY_AGENTS = new Set(["plan", "reviewer", "adversary", "reviewer-fallback", "adversary-fallback"]);

/**
 * Map an opencode agent name to an agy --mode. agy has two modes that matter:
 * plan (read-only) and accept-edits. Unknown agents omit the flag and take
 * agy's default.
 * @param {string|undefined} agent
 * @returns {string|undefined}
 */
export function agentToMode(agent) {
  if (!agent) return undefined;
  const a = String(agent).toLowerCase();
  if (READ_ONLY_AGENTS.has(a)) return "plan";
  if (a === "build" || a === "coder") return "accept-edits";
  return undefined;
}

/**
 * Convert milliseconds to a Go duration string for --print-timeout.
 * @param {number} ms
 * @returns {string}
 */
export function msToGoDuration(ms) {
  const sec = Math.max(1, Math.ceil(Number(ms) / 1000));
  return `${sec}s`;
}

/**
 * Build argv for `agy --print`. --print is ALWAYS last because it swallows
 * the next token as its prompt value.
 * @param {string} promptText - full prompt (policy already applied by caller)
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {string} [opts.effort] - low|medium|high
 * @param {string} [opts.agent] - opencode agent name, mapped to --mode
 * @param {string} [opts.mode] - explicit agy mode, wins over agent mapping
 * @param {string} [opts.conversationId] - resume via --conversation
 * @param {string} [opts.jsonSchema] - raw --json-schema value
 * @param {number} [opts.timeoutMs]
 * @returns {string[]}
 */
export function buildPrintArgs(promptText, opts = {}) {
  const args = [];
  const model = opts.model ?? defaultModel();
  if (model) args.push("--model", model);
  const effort = opts.effort ?? defaultEffort();
  if (effort) args.push("--effort", effort);
  const mode = opts.mode ?? agentToMode(opts.agent);
  if (mode) args.push("--mode", mode);
  const outputFormat = opts.outputFormat ?? "stream-json";
  args.push("--output-format", outputFormat);
  // Headless agy cannot prompt, so without this every command that is not
  // allow-listed cancels the whole run. The floor is permissions.deny, which
  // this flag does NOT override (verified against 1.1.19), and
  // denyListPreflight refuses to launch when that list is empty.
  //
  // Deliberately NOT passing --sandbox. The sandbox does not start on every
  // machine, and when it fails while this flag is set, agy auto-approves the
  // bypass and runs the command unsandboxed instead of refusing. Without the
  // flag it correctly fails closed. So --sandbox plus this flag is worse than
  // either alone, and it must stay out until a startup check can gate it.
  args.push("--dangerously-skip-permissions");
  args.push("--print-timeout", msToGoDuration(opts.timeoutMs ?? printTimeoutMs()));
  if (opts.conversationId) args.push("--conversation", opts.conversationId);
  if (opts.jsonSchema) args.push("--json-schema", opts.jsonSchema);
  // --print last: it swallows the next token as the prompt.
  args.push("--print", promptText);
  return args;
}

/**
 * Parse one `agy models` stdout into [{id, name}]. Skips blank lines and
 * anything that is not an `<id><TAB|2+ spaces><Name>` row.
 * @param {string} stdout
 * @returns {{ id: string, name: string }[]}
 */
export function parseModelsOutput(stdout) {
  const out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const m = line.match(/^(\S+)(?:\t|\s{2,})(.+)$/);
    if (!m) continue;
    const id = m[1].trim();
    const name = m[2].trim();
    if (!id || !name) continue;
    if (/^fetching$/i.test(id)) continue;
    out.push({ id, name });
  }
  return out;
}

/**
 * Format a tool call parameter summary into a readable string.
 * @param {string} toolName
 * @param {object} [params]
 * @returns {string}
 */
export function formatToolDetail(toolName, params) {
  if (!params || typeof params !== "object") return "";
  const raw = params.CommandLine
    || params.TargetFile
    || params.AbsolutePath
    || params.DirectoryPath
    || params.Pattern
    || params.Query
    || params.query
    || params.Url
    || params.Prompt
    || params.Action
    || (typeof Object.values(params)[0] === "string" ? Object.values(params)[0] : "");
  const detail = String(raw).trim();
  if (!detail) return "";
  return detail.length > 120 ? `${detail.slice(0, 117)}...` : detail;
}

/**
 * Format an NDJSON stream event from agy into a human-readable log line.
 * Returns null for uninteresting or redundant events (such as intermediate deltas).
 *
 * @param {object} evt - parsed NDJSON event object
 * @param {Set<number>} [seenSteps] - track step indices to avoid duplicate lines
 * @returns {string|null}
 */
export function formatProgressEvent(evt, seenSteps = new Set()) {
  if (!evt || typeof evt !== "object") return null;

  if (evt.event === "init") {
    const cid = evt.conversation_id || evt.init?.conversation_id;
    return cid ? `session started (${cid})` : "session started";
  }

  if (evt.event === "step_update" && evt.step_update) {
    const su = evt.step_update;
    const stepType = su.step_type;
    const state = su.state;
    const stepIndex = su.step_index;

    if (stepType === "tool") {
      const toolName = su.tool_name || su.tool_info?.name || "tool";
      if (state === "ACTIVE") {
        const detail = formatToolDetail(toolName, su.tool_info?.parameters);
        return detail ? `tool: ${toolName} (${detail})` : `tool: ${toolName}`;
      }
      if (state === "DONE") {
        const dur = typeof su.duration_seconds === "number"
          ? ` (${su.duration_seconds.toFixed(2)}s)`
          : "";
        return `tool: ${toolName} completed${dur}`;
      }
      if (state === "ERROR") {
        const errMsg = su.tool_info?.error?.message || "unknown error";
        return `tool: ${toolName} failed: ${errMsg}`;
      }
    }

    if (stepType === "agent_response") {
      if (state === "ACTIVE") {
        if (!seenSteps.has(stepIndex)) {
          seenSteps.add(stepIndex);
          return "agent responding";
        }
      } else if (state === "DONE") {
        if (!seenSteps.has(stepIndex)) {
          seenSteps.add(stepIndex);
          const dur = typeof su.duration_seconds === "number"
            ? ` (${su.duration_seconds.toFixed(2)}s)`
            : "";
          return `agent thinking completed${dur}`;
        }
      }
    }
  }

  return null;
}

/**
 * Parse `agy --output-format stream-json --print` (or legacy json) stdout.
 * @param {string} stdout
 * @returns {{ conversation_id: string, status: string, response: string, error?: string, duration_seconds?: number, num_turns?: number, usage?: object }}
 */
export function parsePrintResult(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("agy produced no output (empty stdout)");

  // 1. Try parsing whole text first (single JSON document).
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object") {
      if (data.event === "result" && data.result && typeof data.result.status === "string") {
        return data.result;
      }
      if (typeof data.status === "string") {
        return data;
      }
      throw new Error(`agy output missing status field: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    if (err.message.includes("missing status field")) throw err;
  }

  // 2. Parse as NDJSON (stream-json emits one JSON object per line).
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let foundJson = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
      foundJson = true;
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object") {
      if (parsed.event === "result" && parsed.result && typeof parsed.result.status === "string") {
        return parsed.result;
      }
      if (typeof parsed.status === "string") {
        return parsed;
      }
    }
  }

  if (!foundJson) {
    throw new Error(`agy output was not JSON: ${text.slice(0, 200)}`);
  }
  throw new Error(`agy output missing status field: ${text.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Capability check (analogue of isServerRunning/ensureServer)
// ---------------------------------------------------------------------------

function settingsDir() {
  return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

/**
 * Read the agy settings.json permission lists (never throws).
 * @returns {{ path: string, exists: boolean, allow: string[], deny: string[] }}
 */
export function readAgySettings() {
  const p = path.join(settingsDir(), "settings.json");
  const strings = (v) => (Array.isArray(v) ? v.filter((r) => typeof r === "string") : []);
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      path: p,
      exists: true,
      allow: strings(data?.permissions?.allow),
      deny: strings(data?.permissions?.deny),
    };
  } catch {
    return { path: p, exists: fs.existsSync(p), allow: [], deny: [] };
  }
}

/**
 * The runner passes --dangerously-skip-permissions, so the deny list is the
 * only thing left standing between the agent and `sudo`, `git push` or
 * `rm -rf`. Verified against agy 1.1.19: a deny rule beats that flag, which is
 * what makes the trade viable at all.
 *
 * That inverts the usual failure direction. An empty allow list produced a
 * loud, harmless denial; an empty DENY list produces a silent, unrestricted
 * run. So refuse to launch rather than run with no floor. The allow list had
 * exactly this trap - AGY_SCOPED_ALLOWLIST was documentation nothing
 * installed - and it cost three failed runs to notice.
 *
 * @param {{ exists: boolean, deny: string[], path: string }} settings
 * @returns {string|null} error message, or null when it is safe to launch
 */
export function denyListPreflight(settings) {
  if (!settings.exists) {
    return `agy settings not found at ${settings.path}. Refusing to run with --dangerously-skip-permissions and no deny list.`;
  }
  if (!settings.deny.length) {
    return (
      `agy settings at ${settings.path} declare no permissions.deny rules. ` +
      "Refusing to run: this runner passes --dangerously-skip-permissions, so " +
      "an empty deny list means every command is permitted, including sudo, " +
      "git push and rm -rf."
    );
  }
  return null;
}

function authTokenPresent() {
  try {
    const st = fs.statSync(path.join(settingsDir(), "antigravity-oauth-token"));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function runBinary(args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(AGY_BINARY, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: needsWindowsShell(AGY_BINARY),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      resolve({ stdout, stderr: `${stderr}\n(timed out after ${timeoutMs}ms)`, exitCode: 1 });
    }, timeoutMs);
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: String(err), exitCode: 1 });
    });
  });
}

/**
 * Check the agy backend is usable: binary present, version resolvable, auth
 * token exists. Never throws - returns a capability object.
 * @returns {Promise<{ ok: boolean, binary: string, version: string|null, authPresent: boolean, problems: string[] }>}
 */
export async function getCapability() {
  const problems = [];
  const r = await runBinary(["--version"]);
  const version = r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim().split("\n")[0].trim() : null;
  if (!version) {
    problems.push(
      `agy binary not usable ("${AGY_BINARY} --version" failed${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 200)}` : ""}). Install agy and ensure it is on PATH.`,
    );
  }
  const authPresent = authTokenPresent();
  if (!authPresent) {
    problems.push(
      `no agy auth token at ${path.join(settingsDir(), "antigravity-oauth-token")}. Run agy interactively once to authenticate.`,
    );
  }
  return { ok: problems.length === 0, binary: AGY_BINARY, version, authPresent, problems };
}

/** @returns {Promise<boolean>} */
export async function isAgyInstalled() {
  const cap = await getCapability();
  return cap.version !== null;
}

/** @returns {Promise<string|null>} */
export async function getAgyVersion() {
  const cap = await getCapability();
  return cap.version;
}

/**
 * Capability-check analogue of isServerRunning. Ignores host/port args so
 * the shared call sites compile unchanged.
 * @returns {Promise<boolean>}
 */
export async function isServerRunning() {
  return (await getCapability()).ok;
}

/**
 * Capability-check analogue of ensureServer. Throws with actionable guidance
 * when agy is missing or unauthenticated.
 */
export async function ensureServer() {
  const cap = await getCapability();
  if (!cap.ok) {
    throw new Error(`agy backend not ready: ${cap.problems.join(" ")}`);
  }
  return { url: "agy:cli", alreadyRunning: true, backend: "agy", capability: cap };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// In-flight agy children, keyed by the id sendPrompt was CALLED with (the
// resumed conversation id, or "" for a fresh conversation whose id is only
// known from the final --print output). Lets abortSession kill a running
// --print from the same process (e.g. tests, library use). Cross-process
// cancel is covered by handleCancel killing the worker's process group.
//
// F1 fix: a conversation_id learned only AFTER the process has already
// exited and been untracked is useless for aborting a running process - by
// the time it's known, there is nothing left to abort. The old code
// re-inserted the finished (dead) entry under `conv:<id>` anyway, which then
// (a) leaked forever, since nothing ever deleted that key, and (b) shadowed
// the LIVE entry the next resume of that same conversation created under
// `req:<id>`, because findEntry checked `conv:` first: abortSession on a
// resumed conversation would find the stale dead entry, report success, and
// leave the real process running. Fix: track only by the requested id, one
// entry per key, so a finished run is fully gone once untracked and a
// resume's live entry is the only thing `req:<id>` can ever point at.
const inflight = new Map();

function trackProc(key, proc) {
  const entry = { proc, requestedId: key, startedAt: Date.now() };
  inflight.set(`req:${key ?? ""}`, entry);
  return entry;
}

function untrack(entry) {
  for (const [k, v] of inflight) {
    if (v === entry) inflight.delete(k);
  }
}

function findEntry(sessionId) {
  return inflight.get(`req:${sessionId ?? ""}`) ?? null;
}

function tailLines(text, n = 10) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim() !== "");
  return lines.slice(-n).join("\n");
}

function deniedHint() {
  return (
    "Headless agy auto-denies tool calls that are not allow-listed " +
    `(settings.json -> permissions.allow). ${AGY_ALLOWLIST_DOC.split("\n").slice(0, 2).join(" ")}`
  );
}

function toFailure(data, stderrText, learnedCid) {
  const cid = data?.conversation_id || learnedCid || null;
  const status = data?.status || "UNKNOWN";
  const agyErr = data?.error ? `: ${data.error}` : "";
  const emptyResponse = !data?.response;
  const hint = status === "CANCELED" && emptyResponse
    // CANCELED + empty response is the observed signature of a permission
    // auto-denial (a tool needed approval headless mode cannot prompt for).
    ? ` Likely a permission denial - ${deniedHint()}`
    : "";
  const err = new Error(
    `agy run ${status}${agyErr}${hint}` +
      (cid ? ` [conversation ${cid}]` : "") +
      (stderrText.trim() ? ` [stderr: ${tailLines(stderrText, 5).slice(0, 500)}]` : ""),
  );
  err.conversationId = cid;
  err.agyStatus = status;
  err.deniedLikely = status === "CANCELED" && emptyResponse;
  return err;
}

/**
 * Create an agy client. Accepts (opts) or (baseUrl, opts) so the shared
 * backend.mjs dispatcher can forward opencode-shaped call sites unchanged;
 * the string baseUrl is ignored (there is no server).
 */
export function createClient(baseUrlOrOpts, maybeOpts) {
  const opts = typeof baseUrlOrOpts === "object" && baseUrlOrOpts !== null
    ? baseUrlOrOpts
    : (maybeOpts ?? {});
  const directory = opts.directory ?? opts.cwd;
  const defaultOnProgress = opts.onProgress ?? opts.log;

  return {
    backend: "agy",
    directory,

    /**
     * No-op: agy mints conversation_id on the first --print (a client-made
     * UUID is NOT adopted), so there is nothing to create up front. Callers
     * learn the real id from sendPrompt's response (see agy.conversation_id)
     * and backend.mjs effectiveSessionId persists it to the job record.
     */
    createSession: async (sessOpts = {}) => {
      if (directory) ensureWorkspaceGeminiignore(directory);
      return {
        id: null,
        title: sessOpts.title ?? null,
        backend: "agy",
        pending: true,
      };
    },

    /**
     * Spawn `agy --print` and return the result in the opencode message
     * shape ({info, parts:[{type:"text"}]}) the existing consumers
     * (extractResponseText, tryParseJson, renderReview) already expect,
     * with raw agy metadata under `.agy`.
     */
    sendPrompt: async (sessionId, promptText, promptOpts = {}) => {
      // Fail closed before spawning: buildPrintArgs passes
      // --dangerously-skip-permissions, and permissions.deny is the only floor
      // left under it.
      const preflightError = denyListPreflight(readAgySettings());
      if (preflightError) throw new Error(preflightError);

      if (directory) ensureWorkspaceGeminiignore(directory);

      const fullPrompt = withAgyPolicy(promptText, directory);
      const timeoutMs = Number(promptOpts.timeoutMs) || printTimeoutMs();
      const args = buildPrintArgs(fullPrompt, {
        model: promptOpts.model,
        effort: promptOpts.effort,
        agent: promptOpts.agent,
        mode: promptOpts.mode,
        conversationId: sessionId ?? undefined,
        jsonSchema: promptOpts.jsonSchema,
        outputFormat: promptOpts.outputFormat,
        timeoutMs,
      });

      const startedAt = Date.now();
      const proc = spawn(AGY_BINARY, args, {
        // stdin from /dev/null: older agy builds blocked on piped stdin.
        stdio: ["ignore", "pipe", "pipe"],
        cwd: directory,
        env: { ...process.env },
        shell: needsWindowsShell(AGY_BINARY),
      });
      const entry = trackProc(sessionId ?? null, proc);
      let stdout = "";
      let stderr = "";
      let stdoutBuffer = "";
      let learnedConversationId = sessionId ?? null;
      const seenSteps = new Set();
      const progressCb = promptOpts.onProgress ?? promptOpts.log ?? defaultOnProgress;

      proc.stdout.on("data", (chunk) => {
        const str = chunk.toString();
        stdout += str;
        stdoutBuffer += str;

        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed);
            if (evt?.conversation_id && !learnedConversationId) {
              learnedConversationId = evt.conversation_id;
            } else if (evt?.init?.conversation_id && !learnedConversationId) {
              learnedConversationId = evt.init.conversation_id;
            } else if (evt?.result?.conversation_id && !learnedConversationId) {
              learnedConversationId = evt.result.conversation_id;
            }
            if (progressCb) {
              const msg = formatProgressEvent(evt, seenSteps);
              if (msg) {
                try { progressCb(msg, evt); } catch { /* ignore logging failures */ }
              }
            }
          } catch {
            // Partial or non-JSON line, continue buffering
          }
        }
      });
      proc.stderr.on("data", (d) => (stderr += d));

      const exitCode = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { proc.kill("SIGTERM"); } catch { /* already gone */ }
          // Escalate so a wedged child cannot outlive the timeout. Unref'd:
          // the primary close/error handlers below already settle the wait.
          const esc = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } }, 10_000);
          esc.unref?.();
        }, timeoutMs);
        proc.on("close", (code) => { clearTimeout(timer); resolve(code ?? 1); });
        proc.on("error", () => { clearTimeout(timer); resolve(1); });
      });
      untrack(entry);

      // Process any trailing buffered line after process exit
      if (stdoutBuffer.trim()) {
        try {
          const evt = JSON.parse(stdoutBuffer.trim());
          if (evt?.conversation_id && !learnedConversationId) {
            learnedConversationId = evt.conversation_id;
          } else if (evt?.result?.conversation_id && !learnedConversationId) {
            learnedConversationId = evt.result.conversation_id;
          }
          if (progressCb) {
            const msg = formatProgressEvent(evt, seenSteps);
            if (msg) {
              try { progressCb(msg, evt); } catch { /* ignore logging failures */ }
            }
          }
        } catch {
          // ignore
        }
      }

      if (exitCode !== 0 && !stdout.trim()) {
        const err = new Error(
          `agy exited ${exitCode} with no output` +
            (stderr.trim() ? `: ${tailLines(stderr, 5).slice(0, 500)}` : "") +
            (Date.now() - startedAt >= timeoutMs
              ? ` (AGY_PRINT_TIMEOUT_MS=${timeoutMs})`
              : ""),
        );
        err.agyStatus = "EXIT_NONZERO";
        if (learnedConversationId) err.conversationId = learnedConversationId;
        throw err;
      }

      let data;
      try {
        data = parsePrintResult(stdout);
      } catch (err) {
        err.message += stderr.trim() ? ` [stderr: ${tailLines(stderr, 5).slice(0, 500)}]` : "";
        if (learnedConversationId && !err.conversationId) {
          err.conversationId = learnedConversationId;
        }
        throw err;
      }

      const text = typeof data.response === "string" ? data.response : "";
      const cid = data.conversation_id || learnedConversationId;
      const hasResponse = Boolean(text && text.trim().length > 0);

      // agy sets status ERROR when any single tool call inside the run fails
      // argument validation (such as a relative path passed to write_to_file),
      // even when the model observed the error and completed the rest of the
      // task with a usable response. We treat ERROR with a non-empty response
      // as a completed run, attaching the error as a warning field so callers
      // and the job log can show it. Throw only when ERROR comes with an empty response.
      if (data.status !== "SUCCESS") {
        if (data.status !== "ERROR" || !hasResponse) {
          throw toFailure(data, stderr, learnedConversationId);
        }
      }

      const warning = data.status === "ERROR" && data.error ? data.error : undefined;

      return {
        info: {
          id: cid,
          role: "assistant",
          backend: "agy",
          ...(warning ? { warning } : {}),
        },
        parts: [{ type: "text", text }],
        agy: {
          conversation_id: cid,
          status: data.status,
          duration_seconds: data.duration_seconds,
          num_turns: data.num_turns,
          usage: data.usage,
          denied: false,
          ...(warning ? { warning } : {}),
        },
        ...(warning ? { warning } : {}),
      };
    },

    /**
     * No agy diff endpoint exists; plan mode writes outside the repo anyway.
     * Reuse lib/git.mjs: report working-tree changes in the
     * {files:[{path}]} shape handleTask already consumes. Includes
     * untracked files (F4): `git diff --name-only` alone only reports
     * tracked modifications, so a task that creates a new file would
     * otherwise report nothing for it, unlike the opencode session diff.
     */
    getSessionDiff: async () => {
      if (!directory) {
        throw new Error("agy client has no directory set; cannot compute git diff");
      }
      const [changed, untracked] = await Promise.all([
        getChangedFiles(directory),
        getUntrackedFiles(directory),
      ]);
      const files = [...new Set([...changed, ...untracked])];
      return {
        files: files.map((p) => ({ path: p })),
        source: "git-working-tree",
      };
    },

    /**
     * Kill the in-flight --print for this conversation, if tracked in this
     * process. Cross-process cancel also kills the worker's process group
     * (see handleCancel), which covers the agy grandchild.
     * @param {string|null} id - conversation_id (may be null for never-started)
     */
    abortSession: async (id) => {
      const entry = findEntry(id);
      if (!entry) return false;
      try { entry.proc.kill("SIGTERM"); } catch { return false; }
      const esc = setTimeout(() => { try { entry.proc.kill("SIGKILL"); } catch { /* already gone */ } }, 5_000);
      esc.unref?.();
      return true;
    },

    /** `agy models`, shaped like opencode GET /provider ({connected:[ids]}). */
    listProviders: async () => {
      const r = await runBinary(["models"]);
      if (r.exitCode !== 0) {
        throw new Error(`agy models failed: ${tailLines(r.stderr, 5).slice(0, 300)}`);
      }
      const models = parseModelsOutput(r.stdout);
      return {
        all: models,
        default: null,
        connected: models.map((m) => m.id),
      };
    },
  };
}

/**
 * Connect analogue: capability-check, then create a client bound to cwd.
 */
export async function connect(opts = {}) {
  const info = await ensureServer();
  const client = createClient({
    directory: opts.cwd ?? opts.directory,
    onProgress: opts.onProgress ?? opts.log,
  });
  return { ...client, serverInfo: { url: "agy:cli", backend: "agy", capability: info.capability } };
}

// Test-only escape hatch (lets tests assert the timeout knob resolution).
export const __test = { printTimeoutMs, settingsDir, needsWindowsShell };
