import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { loadState, saveState, jobLogPath, jobDataPath } from "../plugins/opencode/scripts/lib/state.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_SCRIPT = path.join(TESTS_DIR, "..", "plugins", "opencode", "scripts", "opencode-companion.mjs");

let tmpDir;
let workDir;

beforeEach(() => {
  tmpDir = createTmpDir("clear-test");
  workDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workDir, { recursive: true });
  process.env.OPENCODE_COMPANION_DATA = tmpDir;
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

function runCompanion(args, options = {}) {
  return execFileSync(
    process.execPath,
    [COMPANION_SCRIPT, ...args],
    {
      cwd: options.cwd || workDir,
      env: {
        ...process.env,
        OPENCODE_COMPANION_DATA: tmpDir,
        CLAUDE_PLUGIN_DATA: tmpDir,
        ...(options.env || {}),
      },
      encoding: "utf8",
    }
  );
}

function runCompanionExpectingFailure(args, options = {}) {
  return spawnSync(
    process.execPath,
    [COMPANION_SCRIPT, ...args],
    {
      cwd: options.cwd || workDir,
      env: {
        ...process.env,
        OPENCODE_COMPANION_DATA: tmpDir,
        CLAUDE_PLUGIN_DATA: tmpDir,
        ...(options.env || {}),
      },
      encoding: "utf8",
    }
  );
}

describe("clear subcommand", () => {
  it("clears only terminal jobs and preserves all live jobs", () => {
    // Only terminal statuses (completed, failed, cancelled) should be purged.
    // In-flight work in any live phase must remain untouched in state.
    saveState(workDir, {
      jobs: [
        { id: "term-completed", status: "completed", updatedAt: "2026-01-01T10:00:00Z" },
        { id: "term-failed", status: "failed", updatedAt: "2026-01-01T11:00:00Z" },
        { id: "term-cancelled", status: "cancelled", updatedAt: "2026-01-01T12:00:00Z" },
        { id: "live-running", status: "running", updatedAt: "2026-01-01T13:00:00Z" },
        { id: "live-queued", status: "queued", updatedAt: "2026-01-01T14:00:00Z" },
        { id: "live-investigating", status: "investigating", updatedAt: "2026-01-01T15:00:00Z" },
        { id: "live-finalizing", status: "finalizing", updatedAt: "2026-01-01T16:00:00Z" },
        { id: "live-starting", status: "starting", updatedAt: "2026-01-01T17:00:00Z" },
      ],
    });

    const output = runCompanion(["clear", "--json"]);
    const result = JSON.parse(output.trim());

    assert.equal(result.workspaceRoot, workDir);
    assert.equal(result.kept, 0);
    assert.equal(result.dryRun, false);
    assert.deepEqual(result.cleared.sort(), ["term-cancelled", "term-completed", "term-failed"]);

    const remainingState = loadState(workDir);
    const remainingIds = remainingState.jobs.map((j) => j.id);
    assert.equal(remainingIds.length, 5);
    assert.ok(remainingIds.includes("live-running"));
    assert.ok(remainingIds.includes("live-queued"));
    assert.ok(remainingIds.includes("live-investigating"));
    assert.ok(remainingIds.includes("live-finalizing"));
    assert.ok(remainingIds.includes("live-starting"));
  });

  it("respects --keep 2 and retains newest terminal jobs without counting live jobs", () => {
    // Sorting by updatedAt ensures the newest terminal records stay while older
    // records are purged. Live jobs must not decrement the keep quota.
    saveState(workDir, {
      jobs: [
        { id: "term-oldest", status: "completed", updatedAt: "2026-01-01T08:00:00Z" },
        { id: "term-mid", status: "failed", updatedAt: "2026-01-01T09:00:00Z" },
        { id: "term-newest", status: "cancelled", updatedAt: "2026-01-01T10:00:00Z" },
        { id: "live-job", status: "running", updatedAt: "2026-01-01T11:00:00Z" },
      ],
    });

    const output = runCompanion(["clear", "--keep", "2", "--json"]);
    const result = JSON.parse(output.trim());

    assert.equal(result.kept, 2);
    assert.deepEqual(result.cleared, ["term-oldest"]);

    const remaining = loadState(workDir).jobs;
    const remainingIds = remaining.map((j) => j.id);
    assert.equal(remaining.length, 3);
    assert.ok(remainingIds.includes("term-newest"));
    assert.ok(remainingIds.includes("term-mid"));
    assert.ok(remainingIds.includes("live-job"));
    assert.ok(!remainingIds.includes("term-oldest"));
  });

  it("dry-run reports actions without mutating state or deleting files", () => {
    // Dry run provides preview output for safety without modifying state or disk.
    saveState(workDir, {
      jobs: [
        { id: "term-dry", status: "completed", updatedAt: "2026-01-01T10:00:00Z" },
      ],
    });

    const logPath = jobLogPath(workDir, "term-dry");
    const dataPath = jobDataPath(workDir, "term-dry");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "job log content", "utf8");
    fs.writeFileSync(dataPath, JSON.stringify({ result: "done" }), "utf8");

    const output = runCompanion(["clear", "--dry-run", "--json"]);
    const result = JSON.parse(output.trim());

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.cleared, ["term-dry"]);
    assert.equal(result.kept, 0);

    const state = loadState(workDir);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].id, "term-dry");
    assert.equal(fs.existsSync(logPath), true);
    assert.equal(fs.existsSync(dataPath), true);

    const textOutput = runCompanion(["clear", "--dry-run"]);
    assert.ok(textOutput.includes("## Clear Jobs (dry-run)"));
    assert.ok(textOutput.includes("- **Cleared**: 1"));
    assert.ok(textOutput.includes("- term-dry"));
  });

  it("unlinks .log and .json files for cleared jobs and ignores missing files", () => {
    // Disk reclamation removes orphan logs and result payloads.
    // Missing files must not cause an error since jobs can exit prematurely.
    saveState(workDir, {
      jobs: [
        { id: "term-with-files", status: "completed", updatedAt: "2026-01-01T10:00:00Z" },
        { id: "term-missing-files", status: "failed", updatedAt: "2026-01-01T11:00:00Z" },
        { id: "live-retained", status: "running", updatedAt: "2026-01-01T12:00:00Z" },
      ],
    });

    const termLog = jobLogPath(workDir, "term-with-files");
    const termData = jobDataPath(workDir, "term-with-files");
    const liveLog = jobLogPath(workDir, "live-retained");
    const liveData = jobDataPath(workDir, "live-retained");

    fs.mkdirSync(path.dirname(termLog), { recursive: true });
    fs.writeFileSync(termLog, "terminal log", "utf8");
    fs.writeFileSync(termData, JSON.stringify({ ok: true }), "utf8");
    fs.writeFileSync(liveLog, "live log", "utf8");
    fs.writeFileSync(liveData, JSON.stringify({ inFlight: true }), "utf8");

    runCompanion(["clear"]);

    assert.equal(fs.existsSync(termLog), false);
    assert.equal(fs.existsSync(termData), false);
    assert.equal(fs.existsSync(liveLog), true);
    assert.equal(fs.existsSync(liveData), true);

    const remaining = loadState(workDir).jobs;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "live-retained");
  });

  it("handles empty state and returns a plain message with exit code 0", () => {
    // No-op behavior when no jobs need clearing.
    const emptyOutput = runCompanion(["clear"]);
    assert.equal(emptyOutput.trim(), "No terminal jobs to clear.");

    const jsonEmpty = JSON.parse(runCompanion(["clear", "--json"]).trim());
    assert.deepEqual(jsonEmpty.cleared, []);
    assert.equal(jsonEmpty.kept, 0);
    assert.equal(jsonEmpty.dryRun, false);

    saveState(workDir, {
      jobs: [
        { id: "live-only", status: "running", updatedAt: "2026-01-01T10:00:00Z" },
      ],
    });

    const liveOnlyOutput = runCompanion(["clear"]);
    assert.equal(liveOnlyOutput.trim(), "No terminal jobs to clear.");
  });

  it("lists clear in Available subcommands when an unknown subcommand is passed", () => {
    // Subcommand dispatch table must register clear so help lists it.
    const run = runCompanionExpectingFailure(["unknown-subcommand-name"]);
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes("Unknown subcommand: unknown-subcommand-name"));
    assert.ok(run.stderr.includes("Available:"));
    assert.ok(run.stderr.includes("clear"));
  });

  it("validates --keep argument format", () => {
    const missingValue = runCompanionExpectingFailure(["clear", "--keep"]);
    assert.equal(missingValue.status, 1);
    assert.ok(missingValue.stderr.includes("--keep requires a numeric argument."));

    const negativeValue = runCompanionExpectingFailure(["clear", "--keep", "-1"]);
    assert.equal(negativeValue.status, 1);
    assert.ok(negativeValue.stderr.includes("--keep must be a non-negative integer."));

    const invalidValue = runCompanionExpectingFailure(["clear", "--keep", "abc"]);
    assert.equal(invalidValue.status, 1);
    assert.ok(invalidValue.stderr.includes("--keep must be a non-negative integer."));
  });
});
