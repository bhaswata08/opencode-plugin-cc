// Git utilities for the OpenCode companion.

import { runCommand } from "./process.mjs";

/**
 * Get the git repository root for a given directory.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getGitRoot(cwd) {
  const { stdout, exitCode } = await runCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd }
  );
  return exitCode === 0 ? stdout.trim() : null;
}

/**
 * Get the current branch name.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function getCurrentBranch(cwd) {
  const { stdout, exitCode } = await runCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd }
  );
  return exitCode === 0 ? stdout.trim() : null;
}

/**
 * Get the diff for review, supporting base-branch and working-tree modes.
 * @param {string} cwd
 * @param {{ base?: string, cached?: boolean }} opts
 * @returns {Promise<string>}
 */
export async function getDiff(cwd, opts = {}) {
  const args = ["diff"];
  if (opts.base) {
    args.push(`${opts.base}...HEAD`);
  } else if (opts.cached) {
    args.push("--cached");
  }
  const { stdout } = await runCommand("git", args, { cwd });
  return stdout;
}

/**
 * Get a short diff stat for size estimation.
 * @param {string} cwd
 * @param {{ base?: string, cached?: boolean }} opts
 * @returns {Promise<string>}
 */
export async function getDiffStat(cwd, opts = {}) {
  const args = ["diff", "--shortstat"];
  if (opts.base) {
    args.push(`${opts.base}...HEAD`);
  } else if (opts.cached) {
    args.push("--cached");
  }
  const { stdout } = await runCommand("git", args, { cwd });
  return stdout.trim();
}

/**
 * Get git status (short format).
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function getStatus(cwd) {
  const { stdout } = await runCommand(
    "git",
    ["status", "--short", "--untracked-files=all"],
    { cwd }
  );
  return stdout.trim();
}

/**
 * Get the list of changed files.
 * @param {string} cwd
 * @param {{ base?: string }} opts
 * @returns {Promise<string[]>}
 */
export async function getChangedFiles(cwd, opts = {}) {
  const args = ["diff", "--name-only"];
  if (opts.base) {
    args.push(`${opts.base}...HEAD`);
  }
  const { stdout } = await runCommand("git", args, { cwd });
  return stdout.trim().split("\n").filter(Boolean);
}

/**
 * Get untracked files (not yet added to git), respecting .gitignore.
 * `git diff` never reports these, so callers that want a full picture of
 * what a task changed (tracked edits + brand-new files) need both.
 * @param {string} cwd
 * @returns {Promise<string[]>}
 */
export async function getUntrackedFiles(cwd) {
  const { stdout } = await runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd }
  );
  return stdout.trim().split("\n").filter(Boolean);
}
