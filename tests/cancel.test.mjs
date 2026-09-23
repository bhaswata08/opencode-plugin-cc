import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { saveState, loadState } from "../plugins/opencode/scripts/lib/state.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_SCRIPT = path.join(
  TESTS_DIR,
  "..",
  "plugins",
  "opencode",
  "scripts",
  "opencode-companion.mjs",
);

let tmpDir;
let here;
let elsewhere;

beforeEach(() => {
  tmpDir = createTmpDir("cancel-test");
  process.env.OPENCODE_COMPANION_DATA = tmpDir;

  // Two workspaces with state of their own, as the all-workspaces view sees.
  here = path.join(tmpDir, "here");
  elsewhere = path.join(tmpDir, "elsewhere");
  fs.mkdirSync(here, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });

  saveState(here, {
    jobs: [{ id: "job-here", type: "task", status: "running", workspacePath: here }],
  });
  saveState(elsewhere, {
    jobs: [{ id: "job-far", type: "task", status: "running", workspacePath: elsewhere }],
  });
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

function runCancel(args, cwd = here) {
  return spawnSync(process.execPath, [COMPANION_SCRIPT, "cancel", ...args], {
    cwd,
    env: { ...process.env, OPENCODE_COMPANION_DATA: tmpDir, CLAUDE_PLUGIN_DATA: tmpDir },
    encoding: "utf8",
  });
}

describe("cancel --workspace", () => {
  it("cancels a job in another workspace when that workspace is named", () => {
    const res = runCancel(["--workspace", elsewhere, "job-far"]);
    assert.equal(res.status, 0, res.stderr);

    // cancel marks the job failed with an explicit reason rather than
    // inventing a "cancelled" status; what matters here is that the job in the
    // NAMED workspace stopped being active.
    const job = loadState(elsewhere).jobs.find((j) => j.id === "job-far");
    assert.equal(job.status, "failed");
    assert.match(job.errorMessage, /Canceled by user/);
  });

  it("leaves the current workspace's jobs alone when another is named", () => {
    runCancel(["--workspace", elsewhere, "job-far"]);
    assert.equal(loadState(here).jobs.find((j) => j.id === "job-here").status, "running");
  });

  it("without --workspace it still only sees the current workspace", () => {
    const res = runCancel(["job-far"]);
    assert.match(res.stdout + res.stderr, /No active job to cancel/);
    assert.equal(loadState(elsewhere).jobs.find((j) => j.id === "job-far").status, "running");
  });

  it("refuses an empty --workspace rather than falling back to the cwd", () => {
    const res = runCancel(["--workspace", "", "job-far"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--workspace requires a directory path/);
  });

  it("reports a workspace that has no state instead of cancelling nothing quietly", () => {
    const missing = path.join(tmpDir, "no-such-workspace");
    fs.mkdirSync(missing, { recursive: true });
    const res = runCancel(["--workspace", missing, "job-far"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /No companion state found for workspace/);
  });
});
