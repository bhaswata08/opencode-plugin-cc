// Git utilities for the OpenCode companion.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

/**
 * Parse `git diff --shortstat` into counts.
 *
 * The review loop's trigger floor needs a size, and shortstat is the cheapest
 * way to get one: no diff body to read, and git prints nothing at all when
 * there is no change, which is the case the caller most needs to recognise.
 *
 * @param {string|undefined} stat - e.g. " 3 files changed, 40 insertions(+), 2 deletions(-)"
 * @returns {{files: number, lines: number}} lines is insertions + deletions
 */
export function parseShortstat(stat) {
  const text = String(stat ?? "");
  const files = Number(text.match(/(\d+)\s+files?\s+changed/)?.[1] ?? 0);
  const inserted = Number(text.match(/(\d+)\s+insertions?\(\+\)/)?.[1] ?? 0);
  const deleted = Number(text.match(/(\d+)\s+deletions?\(-\)/)?.[1] ?? 0);
  return { files, lines: inserted + deleted };
}

/**
 * Record the whole working tree, tracked edits and untracked files alike, as
 * a git tree object, without touching the real index or HEAD.
 *
 * A write task must be judged by what IT changed, and a plain `git diff`
 * against HEAD cannot tell that apart from uncommitted work already in the
 * tree (another session's edits, a half-finished refactor). Snapshot before
 * the task, snapshot after, diff the two trees.
 *
 * Uses a throwaway index seeded from the real one, so unchanged files reuse
 * its stat cache and are not rehashed. Ignored files stay out, as with
 * `git add`. The tree objects land in the object store unreferenced and are
 * collected by a later `git gc`.
 *
 * @param {string} cwd
 * @returns {Promise<string|null>} tree sha, or null when cwd is not a git
 *   work tree or the snapshot failed
 */
export async function snapshotWorktree(cwd) {
  const idx = await runCommand("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd });
  if (idx.exitCode !== 0) return null;
  const tmpIndex = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "oc-snapshot-")),
    "index",
  );
  try {
    try {
      fs.copyFileSync(idx.stdout.trim(), tmpIndex);
    } catch {
      // No index yet (fresh repo): start from an empty one.
    }
    const env = { GIT_INDEX_FILE: tmpIndex };
    const add = await runCommand("git", ["add", "--all", "--", ":/"], { cwd, env });
    if (add.exitCode !== 0) return null;
    const tree = await runCommand("git", ["write-tree"], { cwd, env });
    if (tree.exitCode !== 0) return null;
    return tree.stdout.trim() || null;
  } finally {
    fs.rmSync(path.dirname(tmpIndex), { recursive: true, force: true });
  }
}

/**
 * Files the transport itself writes into the workspace during a task. They
 * are plumbing, not the agent's work: the agy runner creates .geminiignore
 * before every prompt (see ensureGeminiIgnore), and counting it would push a
 * one-file change past the review loop's floor. The cost is that a task that
 * deliberately edits .geminiignore is not reviewed for it.
 */
export const TASK_DIFF_EXCLUDES = [".geminiignore"];

/**
 * Diff between two snapshot trees.
 * @param {string} cwd
 * @param {string} baseTree
 * @param {string} headTree
 * @param {"patch"|"shortstat"|"name-only"|"name-status"} [mode]
 * @param {{exclude?: string[]}} [opts] - repo-root-relative paths to leave out
 * @returns {Promise<string>}
 */
export async function diffTrees(cwd, baseTree, headTree, mode = "patch", { exclude = [] } = {}) {
  const args = ["diff"];
  if (mode !== "patch") args.push(`--${mode}`);
  args.push(baseTree, headTree);
  if (exclude.length) {
    args.push("--", ":/", ...exclude.map((p) => `:(top,exclude)${p}`));
  }
  const { stdout } = await runCommand("git", args, { cwd });
  return mode === "patch" ? stdout : stdout.trim();
}
