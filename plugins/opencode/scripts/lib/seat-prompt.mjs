// Carry an opencode seat's system prompt onto a backend that has no seats.
//
// A seat is a file at ~/.config/opencode/agent/<name>.md: frontmatter picking
// the model, variant and temperature, then a body that is the seat's system
// prompt. opencode reads it when --agent names the seat.
//
// agy does not. agy-runner maps an agent name to a --mode (plan vs
// accept-edits) and nothing else, so everything below the frontmatter is
// dropped. That was tolerable while agy was a rare degraded fallback. It is
// not tolerable now that the coder seat's default transport IS agy: without
// this, every default coder dispatch runs with no coder prompt at all, only
// the tool policy.
//
// The frontmatter still cannot cross over — agy takes its model from --model
// and has no variant or temperature flag — but the prompt can, and the prompt
// is the part that decides whether the job is finished end to end or stops at
// a plan.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Path to a seat's agent file, or null when the name is not a plain seat name.
 * Seat names come from --agent, which is user input, so a name containing a
 * separator or traversal is refused rather than joined.
 *
 * @param {string|undefined} agent
 * @returns {string|null}
 */
export function resolveAgentFilePath(agent) {
  const name = String(agent ?? "").trim();
  if (!name) return null;
  if (name !== path.basename(name)) return null;
  if (name.startsWith(".")) return null;

  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "agent", `${name}.md`);
}

/**
 * The seat's system prompt: its agent file with the YAML frontmatter removed.
 * @param {string|undefined} agent
 * @returns {string|null} null when there is no agent file or it has no body
 */
export function readSeatPrompt(agent) {
  const file = resolveAgentFilePath(agent);
  if (!file) return null;

  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const body = stripFrontmatter(raw).trim();
  return body.length > 0 ? body : null;
}

/**
 * Remove a leading `---` YAML block. Only the block that opens the file
 * counts, so a horizontal rule further down does not truncate the prompt.
 * @param {string} raw
 * @returns {string}
 */
function stripFrontmatter(raw) {
  if (!raw.startsWith("---")) return raw;
  const lines = raw.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  // An unterminated opening block means the file is not frontmatter at all.
  return raw;
}

/**
 * Prepend the seat's system prompt to a prompt bound for a backend that
 * cannot read agent files. Idempotent, because a fallback retry rebuilds the
 * prompt from text that may already carry it.
 *
 * @param {string} promptText
 * @param {string|undefined} agent
 * @returns {string}
 */
export function withSeatPrompt(promptText, agent) {
  const seat = readSeatPrompt(agent);
  if (!seat) return promptText;
  if (!promptText) return seat;
  if (promptText.includes(seat)) return promptText;
  return `${seat}\n\n${promptText}`;
}
