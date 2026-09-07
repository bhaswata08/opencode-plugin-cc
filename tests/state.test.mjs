import fs from "node:fs";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";
import { loadState, saveState, updateState, generateJobId, upsertJob, stateRoot } from "../plugins/opencode/scripts/lib/state.mjs";
import { runTrackedJob, createProgressReporter } from "../plugins/opencode/scripts/lib/tracked-jobs.mjs";

let tmpDir;
const workspace = "/test/workspace";

beforeEach(() => {
  tmpDir = createTmpDir();
  setupTestEnv(tmpDir);
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("state", () => {
  it("loadState returns default when no file exists", () => {
    const state = loadState(workspace);
    assert.deepEqual(state, { config: {}, jobs: [] });
  });

  it("saveState and loadState roundtrip", () => {
    const data = { config: { reviewGate: true }, jobs: [{ id: "test-1" }] };
    saveState(workspace, data);
    const loaded = loadState(workspace);
    assert.deepEqual(loaded, data);
  });

  it("updateState applies mutator", () => {
    const result = updateState(workspace, (state) => {
      state.config.reviewGate = true;
    });
    assert.equal(result.config.reviewGate, true);
  });

  it("generateJobId creates unique IDs with prefix", () => {
    const id1 = generateJobId("review");
    const id2 = generateJobId("review");
    assert.ok(id1.startsWith("review-"));
    assert.notEqual(id1, id2);
  });

  it("upsertJob inserts new job", () => {
    upsertJob(workspace, { id: "job-1", status: "running" });
    const state = loadState(workspace);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].id, "job-1");
    assert.ok(state.jobs[0].createdAt);
  });

  it("upsertJob updates existing job", () => {
    upsertJob(workspace, { id: "job-1", status: "running" });
    upsertJob(workspace, { id: "job-1", status: "completed" });
    const state = loadState(workspace);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].status, "completed");
  });

  it("stateRoot is deterministic for same workspace", () => {
    const root1 = stateRoot(workspace);
    const root2 = stateRoot(workspace);
    assert.equal(root1, root2);
  });

  it("stateRoot differs for different workspaces", () => {
    const root1 = stateRoot("/workspace/a");
    const root2 = stateRoot("/workspace/b");
    assert.notEqual(root1, root2);
  });

  it("runTrackedJob writes each report line to the log file exactly once", async () => {
    const job = { id: "job-dedup-1" };
    await runTrackedJob(tmpDir, job, async ({ report, log }) => {
      report("investigating", "Checking repository status");
      log("Found 2 modified files");
      return { summary: "ok" };
    });

    const state = loadState(tmpDir);
    const completedJob = state.jobs.find((j) => j.id === "job-dedup-1");
    assert.equal(completedJob.status, "completed");

    const logPath = path.join(stateRoot(tmpDir), "jobs", "job-dedup-1.log");
    const content = fs.readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");

    const startingLines = lines.filter((l) => l.includes("[starting] Job job-dedup-1 started"));
    assert.equal(startingLines.length, 1, "starting line must appear exactly once");

    const investigatingLines = lines.filter((l) => l.includes("[investigating] Checking repository status"));
    assert.equal(investigatingLines.length, 1, "investigating line must appear exactly once");

    const completedLines = lines.filter((l) => l.includes("[completed] Job job-dedup-1 completed"));
    assert.equal(completedLines.length, 1, "completed line must appear exactly once");
  });

  it("runTrackedJob report closure does not duplicate lines to stderr", async () => {
    const originalStderrWrite = process.stderr.write;
    const written = [];
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };

    try {
      const job = { id: "job-no-stderr-1" };
      await runTrackedJob(tmpDir, job, async ({ report }) => {
        report("running", "Executing task step");
        return { summary: "done" };
      });
      const reportStderr = written.filter((c) => c.includes("Executing task step"));
      assert.equal(reportStderr.length, 0, "report line must not be written to stderr");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });

  it("createProgressReporter writes each report line once and does not write to stderr", () => {
    const originalStderrWrite = process.stderr.write;
    const written = [];
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };

    try {
      const reporter = createProgressReporter(tmpDir, "job-prog-1");
      reporter.report("syncing", "Syncing state");
      reporter.log("Progress details");

      const reportStderr = written.filter((c) => c.includes("Syncing state"));
      assert.equal(reportStderr.length, 0, "reporter must not write to stderr");

      const logPath = path.join(stateRoot(tmpDir), "jobs", "job-prog-1.log");
      const content = fs.readFileSync(logPath, "utf8");
      const syncLines = content.trim().split("\n").filter((l) => l.includes("[syncing] Syncing state"));
      assert.equal(syncLines.length, 1, "syncing line must appear exactly once in log");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });
});
