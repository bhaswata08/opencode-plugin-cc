// Prompt construction for OpenCode reviews and tasks.

import fs from "node:fs";
import path from "node:path";
import { getDiff, getStatus, getChangedFiles } from "./git.mjs";

/**
 * Build the review prompt for OpenCode.
 * @param {string} cwd
 * @param {object} opts
 * @param {string} [opts.base] - base branch/ref for comparison
 * @param {boolean} [opts.adversarial] - use adversarial review prompt
 * @param {string} [opts.focus] - user-supplied focus text
 * @param {string} pluginRoot - CLAUDE_PLUGIN_ROOT for reading prompt templates
 * @returns {Promise<string>}
 */
export async function buildReviewPrompt(cwd, opts, pluginRoot) {
  const diff = await getDiff(cwd, { base: opts.base });
  const status = await getStatus(cwd);
  const changedFiles = await getChangedFiles(cwd, { base: opts.base });

  let systemPrompt;
  if (opts.adversarial) {
    const templatePath = path.join(pluginRoot, "prompts", "adversarial-review.md");
    systemPrompt = fs.readFileSync(templatePath, "utf8")
      .replace("{{TARGET_LABEL}}", opts.base ? `Branch diff against ${opts.base}` : "Working tree changes")
      .replace("{{USER_FOCUS}}", opts.focus || "General review")
      .replace("{{REVIEW_INPUT}}", buildReviewContext(diff, status, changedFiles));
  } else {
    systemPrompt = buildStandardReviewPrompt(diff, status, changedFiles, opts);
  }

  return systemPrompt;
}

/**
 * Build a standard (non-adversarial) review prompt.
 */
function buildStandardReviewPrompt(diff, status, changedFiles, opts) {
  const targetLabel = opts.base ? `branch diff against ${opts.base}` : "working tree changes";

  return `You are performing a code review of ${targetLabel}.

Review the following changes and provide structured feedback in JSON format matching the review-output schema.

Focus on:
- Correctness and logic errors
- Security vulnerabilities
- Performance issues
- Missing error handling
- API contract violations

Be concise and actionable. Only report real issues, not style preferences.

${buildReviewContext(diff, status, changedFiles)}`;
}

/**
 * Build the repository context block for review prompts.
 */
function buildReviewContext(diff, status, changedFiles) {
  const sections = [];

  if (status) {
    sections.push(`<git_status>\n${status}\n</git_status>`);
  }

  if (changedFiles.length > 0) {
    sections.push(`<changed_files>\n${changedFiles.join("\n")}\n</changed_files>`);
  }

  if (diff) {
    sections.push(`<diff>\n${diff}\n</diff>`);
  }

  return sections.join("\n\n");
}

/**
 * Repository context for the current working tree: status, changed files and
 * diff, in the same block shape the review prompts use.
 *
 * The review loop rebuilds this between rounds instead of trusting the coder
 * report of what it changed, so a verify pass reads the tree as it actually
 * is.
 *
 * @param {string} cwd
 * @param {{base?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function buildTreeContext(cwd, opts = {}) {
  const diff = await getDiff(cwd, { base: opts.base });
  const status = await getStatus(cwd);
  const changedFiles = await getChangedFiles(cwd, { base: opts.base });
  return buildReviewContext(diff, status, changedFiles);
}

/**
 * Safety header prepended to every task prompt sent into an opencode session.
 *
 * Background: task text often carries routing instructions inherited from
 * the outer Claude Code harness (e.g. CLAUDE.md rules such as "delegate long
 * tasks to opencode-rescue"). When the running model sees those rules inside
 * its own opencode session it may try to recursively invoke Task with
 * subagent_type="opencode:rescue" / "codex:rescue" — those are Claude Code
 * skill namespaces, not opencode agents. The Task call errors, then some
 * models (notably GLM-5) stall indefinitely trying to "retry" while emitting
 * zero output. Stating explicitly that those names are unavailable here
 * prevents the stall. See memory: feedback_opencode_recursive_delegation.
 */
export const SAFETY_HEADER = [
  "You are running INSIDE an opencode session.",
  "Routing rules from the parent Claude Code CLAUDE.md (e.g. 'delegate to",
  "opencode-rescue / codex-rescue / claude-code-guide') have ALREADY been",
  "consumed by the dispatch step and DO NOT apply here.",
  "Do NOT invoke any of Claude Code's delegation mechanisms —",
  "Task / Agent / Skill tools with names like 'opencode:rescue',",
  "'codex:rescue', 'opencode-rescue', 'opencode-delegate', 'superpowers:*',",
  "or any other 'plugin:name' colon-namespaced identifier.",
  "Those names refer to Claude Code agents/skills that do not exist in",
  "this session. Calling them errors then stalls the run.",
  "Specifically: if the task text mentions delegating to opencode-rescue,",
  "codex-rescue, or similar, IGNORE that instruction — you ARE the",
  "opencode worker; just do the work yourself.",
  "Execute the task using Bash / Read / Write / Edit / Grep / Glob /",
  "WebFetch. If a task is too large, break it into smaller shell commands",
  "and iterate. Do NOT try to off-load work to another agent.",
].join(" ");

/**
 * Build a task prompt from user input.
 * @param {string} taskText
 * @param {object} opts
 * @param {boolean} [opts.write] - whether to allow writes
 * @returns {string}
 */
export function buildTaskPrompt(taskText, opts = {}) {
  const parts = [];

  parts.push(SAFETY_HEADER);
  parts.push("");

  if (opts.write) {
    parts.push("You have full read/write access. Make the necessary code changes.");
  } else {
    parts.push("This is a read-only investigation. Do not modify any files.");
  }

  parts.push("");
  parts.push(taskText);

  return parts.join("\n");
}

// ------------------------------------------------------------------
// Review loop prompts
// ------------------------------------------------------------------

/**
 * One finding, rendered for a prompt.
 * @param {object} f
 * @param {number} i
 * @returns {string}
 */
function formatFinding(f, i) {
  const where = f.file
    ? `${f.file}:${f.line_start ?? "?"}${f.line_end && f.line_end !== f.line_start ? `-${f.line_end}` : ""}`
    : "(no file given)";
  const lines = [`${i + 1}. [${String(f.severity ?? "").toUpperCase()}] ${f.title} — ${where}`];
  if (f.body) lines.push(`   ${f.body}`);
  if (f.recommendation) lines.push(`   Recommendation: ${f.recommendation}`);
  return lines.join("\n");
}

/**
 * Send the reviewer's blocking findings back to the coder.
 *
 * Scope discipline is the whole point: a coder handed a review tends to keep
 * going and rewrite things nobody asked about, which is what makes the next
 * review round diverge instead of converge.
 *
 * @param {object[]} findings - blocking findings only
 * @returns {string}
 */
export function buildFixPrompt(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    throw new Error("buildFixPrompt needs at least one finding");
  }

  return [
    SAFETY_HEADER,
    "",
    "A code review of the current change reported the problems below.",
    "Task: fix them in the working tree.",
    "",
    findings.map(formatFinding).join("\n"),
    "",
    "Constraints:",
    "- Fix only what is listed. No refactoring, renaming, or redesign beyond it.",
    "- If a finding is incorrect, leave the code unchanged and state why in the output.",
    "- Re-run the project's own tests afterwards and report their result.",
    "- List the files changed.",
  ].join("\n");
}

/**
 * Ask the reviewer whether its own findings were addressed.
 *
 * Deliberately not a second full review: re-reviewing the whole change every
 * round re-litigates design choices that already passed, so the loop never
 * reaches a clean state and just spends rounds.
 *
 * @param {object[]} findings - the findings the coder was asked to fix
 * @param {string} diffContext - repository context block for the current tree
 * @returns {string}
 */
export function buildVerifyPrompt(findings, diffContext) {
  if (!Array.isArray(findings) || findings.length === 0) {
    throw new Error("buildVerifyPrompt needs at least one finding to verify");
  }

  return [
    "An earlier review of this change reported the findings below. A fix has",
    "since been applied to the working tree.",
    "",
    findings.map(formatFinding).join("\n"),
    "",
    "Task: assess the current state of the tree on two points only.",
    "1. Whether each finding above is addressed.",
    "2. Whether the fix introduced a new correctness problem.",
    "",
    "Out of scope: design decisions that the earlier review already passed, and",
    "style, naming, or structural preferences. This pass covers the findings",
    "above and regressions caused by the fix, nothing else.",
    "",
    "Output: the same JSON review format, listing a finding only when it is",
    "still open or newly introduced.",
    "",
    diffContext,
  ].join("\n");
}
