// Test helpers for the OpenCode companion tests.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/**
 * Create a temporary directory for test isolation.
 * @param {string} prefix
 * @returns {string}
 */
export function createTmpDir(prefix = "opencode-test") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/**
 * Clean up a temporary directory.
 * @param {string} dir
 */
export function cleanupTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

/**
 * Point the companion state root at a throwaway directory for one test.
 *
 * OPENCODE_COMPANION_DATA is the variable that matters: stateRoot() consults it
 * before anything else, and it is exported in normal shells so the plugin and
 * the oco TUI agree on where state lives. Setting only CLAUDE_PLUGIN_DATA, as
 * this helper used to, isolated nothing — stateRoot() reaches that branch only
 * when OPENCODE_COMPANION_DATA is unset AND the path basename names this
 * plugin, so every test sharing this helper was reading and writing the real
 * state directory instead of its own tmpDir.
 *
 * @param {string} tmpDir
 */
export function setupTestEnv(tmpDir) {
  process.env.OPENCODE_COMPANION_DATA = tmpDir;
  process.env.CLAUDE_PLUGIN_DATA = tmpDir;
  process.env.OPENCODE_COMPANION_SESSION_ID = "test-session-001";
}
