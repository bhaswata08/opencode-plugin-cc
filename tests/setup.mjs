// Test isolation for the companion's state root.
//
// stateRoot() honours OPENCODE_COMPANION_DATA above everything else, and that
// variable is exported in normal shells so the plugin and the oco TUI agree on
// where state lives. A test run therefore inherits the REAL data directory
// unless something overrides it.
//
// Some test files already override it per-test. The ones that do not were
// reading and writing the user's live state: fixture jobs named j1, a1, stale,
// fresh, b1 and /tmp/opencode-test-* workspaces accumulated there, showed up in
// the TUI as running jobs, and counted against the machine-wide coding
// concurrency cap, so a real dispatch could be refused because of a unit test.
//
// Loaded via `node --import ./tests/setup.mjs`, which runs before any test
// module and before the runner spawns its children, so every test file is
// covered whether or not it remembers to override the variable itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(os.tmpdir(), "opencode-companion-tests", String(process.pid));
fs.mkdirSync(root, { recursive: true });

process.env.OPENCODE_COMPANION_DATA = root;

// CLAUDE_PLUGIN_DATA is the next fallback stateRoot() consults. Clear it so a
// test that deletes OPENCODE_COMPANION_DATA on purpose cannot land on a real
// directory either.
delete process.env.CLAUDE_PLUGIN_DATA;

process.on("exit", () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover directory under the OS temp dir is harmless.
  }
});
