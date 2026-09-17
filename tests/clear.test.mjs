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

function initGitRepo(dir) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
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

  it("scopes clear to the specified --workspace without touching current workspace", () => {
    const otherWorkDir = path.join(tmpDir, "other-workspace");
    fs.mkdirSync(otherWorkDir, { recursive: true });

    // Seed state in both workspaces
    saveState(workDir, {
      jobs: [
        { id: "cwd-term", status: "completed", updatedAt: "2026-01-01T10:00:00Z" },
        { id: "cwd-live", status: "running", updatedAt: "2026-01-01T11:00:00Z" },
      ],
    });
    saveState(otherWorkDir, {
      jobs: [
        { id: "other-term", status: "completed", updatedAt: "2026-01-01T10:00:00Z" },
        { id: "other-live", status: "running", updatedAt: "2026-01-01T11:00:00Z" },
      ],
    });

    const output = runCompanion(["clear", "--workspace", otherWorkDir, "--json"]);
    const result = JSON.parse(output.trim());

    assert.equal(result.workspaceRoot, otherWorkDir);
    assert.deepEqual(result.cleared, ["other-term"]);

    // otherWorkDir has only live job left
    const otherState = loadState(otherWorkDir);
    assert.equal(otherState.jobs.length, 1);
    assert.equal(otherState.jobs[0].id, "other-live");

    // workDir (current workspace) was completely untouched
    const cwdState = loadState(workDir);
    assert.equal(cwdState.jobs.length, 2);
    assert.ok(cwdState.jobs.some((j) => j.id === "cwd-term"));
    assert.ok(cwdState.jobs.some((j) => j.id === "cwd-live"));
  });

  it("rejects --workspace for a path that has no companion state", () => {
    const uninitialisedDir = path.join(tmpDir, "never-used-workspace");
    fs.mkdirSync(uninitialisedDir, { recursive: true });

    const run = runCompanionExpectingFailure(["clear", "--workspace", uninitialisedDir]);
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes("No companion state found for workspace:"));
    assert.ok(run.stderr.includes(uninitialisedDir));
  });

  it("validates --workspace argument format", () => {
    const missingValue = runCompanionExpectingFailure(["clear", "--workspace"]);
    assert.equal(missingValue.status, 1);
    assert.ok(missingValue.stderr.includes("--workspace requires a directory path."));
  });

  it("supports --workspace with --dry-run and --keep", () => {
    const otherWorkDir = path.join(tmpDir, "preview-workspace");
    fs.mkdirSync(otherWorkDir, { recursive: true });

    saveState(otherWorkDir, {
      jobs: [
        { id: "preview-old", status: "completed", updatedAt: "2026-01-01T08:00:00Z" },
        { id: "preview-new", status: "completed", updatedAt: "2026-01-01T09:00:00Z" },
      ],
    });

    const output = runCompanion(["clear", "--workspace", otherWorkDir, "--keep", "1", "--dry-run", "--json"]);
    const result = JSON.parse(output.trim());

    assert.equal(result.workspaceRoot, otherWorkDir);
    assert.equal(result.dryRun, true);
    assert.equal(result.kept, 1);
    assert.deepEqual(result.cleared, ["preview-old"]);

    // State on disk is untouched
    const state = loadState(otherWorkDir);
    assert.equal(state.jobs.length, 2);
  });

  it("clears literal workspace state and leaves git root state untouched when explicit --workspace has state", () => {
    const repoDir = path.join(tmpDir, "repo-literal-and-root");
    fs.mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);

    const subDir = path.join(repoDir, "sub");
    fs.mkdirSync(subDir, { recursive: true });

    // Seed state for both the git root and the literal subdirectory
    saveState(repoDir, {
      jobs: [
        { id: "root-job", status: "completed", updatedAt: "2026-01-01T10:00:00Z" },
      ],
    });
    saveState(subDir, {
      jobs: [
        { id: "literal-sub-job", status: "completed", updatedAt: "2026-01-01T10:00:00Z" },
      ],
    });

    const output = runCompanion(["clear", "--workspace", subDir, "--json"]);
    const result = JSON.parse(output.trim());

    assert.equal(result.workspaceRoot, subDir);
    assert.deepEqual(result.cleared, ["literal-sub-job"]);

    // Literal workspace is cleared
    const subState = loadState(subDir);
    assert.equal(subState.jobs.length, 0);

    // Git root state is left alone
    const rootState = loadState(repoDir);
    assert.equal(rootState.jobs.length, 1);
    assert.equal(rootState.jobs[0].id, "root-job");
  });

  it("clears git root state as fallback when explicit --workspace has no state of its own", () => {
    const repoDir = path.join(tmpDir, "repo-fallback");
    fs.mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);

    const subDir = path.join(repoDir, "sub");
    fs.mkdirSync(subDir, { recursive: true });

    // Seed state only at the git root, not the subdirectory
    saveState(repoDir, {
      jobs: [
        { id: "root-fallback-job", status: "completed", updatedAt: "2026-01-01T10:00:00Z" },
      ],
    });

    const output = runCompanion(["clear", "--workspace", subDir, "--json"]);
    const result = JSON.parse(output.trim());

    assert.equal(result.workspaceRoot, repoDir);
    assert.deepEqual(result.cleared, ["root-fallback-job"]);

    // Git root is cleared
    const rootState = loadState(repoDir);
    assert.equal(rootState.jobs.length, 0);
  });

  it("exits 1 with existing message when neither explicit --workspace nor its git root has state", () => {
    const repoDir = path.join(tmpDir, "repo-empty");
    fs.mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);

    const subDir = path.join(repoDir, "sub");
    fs.mkdirSync(subDir, { recursive: true });

    // Neither subDir nor repoDir has companion state
    const run = runCompanionExpectingFailure(["clear", "--workspace", subDir]);
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes("No companion state found for workspace:"));
    assert.ok(run.stderr.includes(repoDir));
  });

  it("preserves existing cwd behavior when --workspace is absent", () => {
    const repoDir = path.join(tmpDir, "repo-cwd");
    fs.mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);

    const subDir = path.join(repoDir, "sub");
    fs.mkdirSync(subDir, { recursive: true });

    saveState(repoDir, {
      jobs: [
        { id: "cwd-job", status: "completed", updatedAt: "2026-01-01T10:00:00Z" },
      ],
    });

    // Running clear with cwd=subDir resolves to git root repoDir and clears it
    const output = runCompanion(["clear", "--json"], { cwd: subDir });
    const result = JSON.parse(output.trim());

    assert.equal(result.workspaceRoot, repoDir);
    assert.deepEqual(result.cleared, ["cwd-job"]);

    const rootState = loadState(repoDir);
    assert.equal(rootState.jobs.length, 0);

    // Empty/uninitialised cwd does not error with code 1; reports no terminal jobs
    const emptyOutput = runCompanion(["clear"], { cwd: subDir });
    assert.equal(emptyOutput.trim(), "No terminal jobs to clear.");
  });

  it("supports clear --help", () => {
    const output = runCompanion(["clear", "--help"]);
    assert.ok(output.includes("Usage: opencode-companion.mjs clear"));
    assert.ok(output.includes("--workspace"));
  });
});
