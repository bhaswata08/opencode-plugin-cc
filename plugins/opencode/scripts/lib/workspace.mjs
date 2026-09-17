// Workspace detection for the OpenCode companion.

import path from "node:path";
import { getGitRoot } from "./git.mjs";

/**
 * Resolve the workspace root directory.
 * Prefers git root, falls back to cwd.
 *
 * Relative paths or trailing slashes would produce divergent SHA-256 state-root
 * hashes if left uncanonicalised, because state roots are keyed on the raw
 * string path. Resolving against process.cwd ensures callers passing '.' or
 * relative paths map to the same state directory as cwd-based callers.
 * @param {string} [cwd]
 * @returns {Promise<string>}
 */
export async function resolveWorkspace(cwd) {
  const dir = cwd ? path.resolve(cwd) : process.cwd();
  const gitRoot = await getGitRoot(dir);
  return gitRoot || dir;
}
