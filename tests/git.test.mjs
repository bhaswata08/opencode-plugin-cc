import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";
import { getGitRoot, getCurrentBranch, getStatus, parseShortstat, snapshotWorktree, diffTrees } from "../plugins/opencode/scripts/lib/git.mjs";

let tmpDir;

beforeEach(async () => {
  tmpDir = createTmpDir("git-test");
  // Initialize a git repo
  await runCommand("git", ["init"], { cwd: tmpDir });
  await runCommand("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: tmpDir });
  // Create initial commit
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test\n");
  await runCommand("git", ["add", "."], { cwd: tmpDir });
  await runCommand("git", ["commit", "-m", "init"], { cwd: tmpDir });
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

describe("git", () => {
  it("getGitRoot returns the repo root", async () => {
    const root = await getGitRoot(tmpDir);
    assert.ok(root);
    assert.ok(root.length > 0);
  });

  it("getCurrentBranch returns branch name", async () => {
    const branch = await getCurrentBranch(tmpDir);
    assert.ok(branch === "main" || branch === "master");
  });

  it("getStatus returns empty for clean repo", async () => {
    const status = await getStatus(tmpDir);
    assert.equal(status, "");
  });

  it("getStatus shows untracked files", async () => {
    fs.writeFileSync(path.join(tmpDir, "new-file.txt"), "hello\n");
    const status = await getStatus(tmpDir);
    assert.ok(status.includes("new-file.txt"));
  });
});

// ------------------------------------------------------------------
// Diff size, for the review loop's trigger floor
// ------------------------------------------------------------------

describe("parseShortstat", () => {
  it("counts insertions and deletions together", () => {
    const got = parseShortstat(" 3 files changed, 40 insertions(+), 2 deletions(-)");
    assert.deepEqual(got, { files: 3, lines: 42 });
  });

  it("handles a stat with insertions only", () => {
    assert.deepEqual(parseShortstat(" 1 file changed, 12 insertions(+)"), {
      files: 1,
      lines: 12,
    });
  });

  it("handles a stat with deletions only", () => {
    assert.deepEqual(parseShortstat(" 2 files changed, 7 deletions(-)"), {
      files: 2,
      lines: 7,
    });
  });

  it("reports zero for an empty stat, which is what git prints for no diff", () => {
    assert.deepEqual(parseShortstat(""), { files: 0, lines: 0 });
    assert.deepEqual(parseShortstat(undefined), { files: 0, lines: 0 });
  });

  it("reports zero for text that is not a shortstat", () => {
    assert.deepEqual(parseShortstat("fatal: bad revision"), { files: 0, lines: 0 });
  });
});

describe("snapshotWorktree / diffTrees", () => {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, rel), text);
  };
  const git = (...args) => runCommand("git", args, { cwd: tmpDir });

  it("counts only what changed after the baseline, not pre-existing dirt", async () => {
    // Uncommitted work that predates the task: a tracked edit and a new file.
    write("README.md", "# Test\nedited by someone else\n");
    write("theirs.js", "export const a = 1;\n");
    const base = await snapshotWorktree(tmpDir);
    assert.match(base, /^[0-9a-f]{40,64}$/);

    // The task's own change.
    write("src/mine.js", "export const b = 2;\n");
    const head = await snapshotWorktree(tmpDir);

    assert.deepEqual((await diffTrees(tmpDir, base, head, "name-only")).split("\n"), ["src/mine.js"]);
    assert.deepEqual(parseShortstat(await diffTrees(tmpDir, base, head, "shortstat")), { files: 1, lines: 1 });
    assert.match(await diffTrees(tmpDir, base, head, "patch"), /\+export const b = 2;/);
  });

  it("sees a further edit to a file that was already dirty", async () => {
    write("README.md", "# Test\nline A\n");
    const base = await snapshotWorktree(tmpDir);
    write("README.md", "# Test\nline A\nline B\n");
    const head = await snapshotWorktree(tmpDir);
    const patch = await diffTrees(tmpDir, base, head, "patch");
    assert.match(patch, /\+line B/);
    assert.doesNotMatch(patch, /\+line A/);
  });

  it("leaves the real index and status untouched", async () => {
    write("README.md", "# Test\nedited\n");
    write("new.txt", "x\n");
    const before = (await git("status", "--porcelain")).stdout;
    await snapshotWorktree(tmpDir);
    assert.equal((await git("status", "--porcelain")).stdout, before);
    assert.equal((await git("diff", "--cached", "--name-only")).stdout, "");
  });

  it("skips ignored files", async () => {
    write(".gitignore", "node_modules/\n");
    const base = await snapshotWorktree(tmpDir);
    write("node_modules/dep/index.js", "x\n");
    const head = await snapshotWorktree(tmpDir);
    assert.equal(base, head);
  });

  it("works from a subdirectory and covers the whole repo", async () => {
    write("sub/a.txt", "a\n");
    const base = await snapshotWorktree(path.join(tmpDir, "sub"));
    write("top.txt", "t\n");
    const head = await snapshotWorktree(path.join(tmpDir, "sub"));
    assert.equal(await diffTrees(tmpDir, base, head, "name-only"), "top.txt");
  });

  it("returns null outside a git repo", async () => {
    const outside = createTmpDir("not-git");
    try {
      assert.equal(await snapshotWorktree(outside), null);
    } finally {
      cleanupTmpDir(outside);
    }
  });
});

describe("diffTrees exclude", () => {
  it("drops runner artifacts such as .geminiignore", async () => {
    const base = await snapshotWorktree(tmpDir);
    fs.writeFileSync(path.join(tmpDir, ".geminiignore"), "node_modules/\n");
    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "hello\n");
    const head = await snapshotWorktree(tmpDir);
    const opts = { exclude: [".geminiignore"] };
    assert.equal(await diffTrees(tmpDir, base, head, "name-only", opts), "hello.txt");
    assert.deepEqual(parseShortstat(await diffTrees(tmpDir, base, head, "shortstat", opts)), { files: 1, lines: 1 });
    // Without the exclusion both files count.
    assert.equal((await diffTrees(tmpDir, base, head, "name-only")).split("\n").length, 2);
  });
});
