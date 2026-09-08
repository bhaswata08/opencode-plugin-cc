import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, extractTaskText } from "../plugins/opencode/scripts/lib/args.mjs";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_SCRIPT = path.join(TESTS_DIR, "..", "plugins", "opencode", "scripts", "opencode-companion.mjs");

describe("parseArgs", () => {
  it("parses value options", () => {
    const { options } = parseArgs(["--base", "main", "--scope", "branch"], {
      valueOptions: ["base", "scope"],
    });
    assert.equal(options.base, "main");
    assert.equal(options.scope, "branch");
  });

  it("parses boolean options", () => {
    const { options } = parseArgs(["--wait", "--write"], {
      booleanOptions: ["wait", "write"],
    });
    assert.equal(options.wait, true);
    assert.equal(options.write, true);
  });

  it("collects positional arguments", () => {
    const { positional } = parseArgs(["hello", "--wait", "world"], {
      booleanOptions: ["wait"],
    });
    assert.deepEqual(positional, ["hello", "world"]);
  });

  it("handles mixed args", () => {
    const { options, positional } = parseArgs(
      ["fix", "--model", "claude-sonnet", "--write", "the", "bug"],
      { valueOptions: ["model"], booleanOptions: ["write"] }
    );
    assert.equal(options.model, "claude-sonnet");
    assert.equal(options.write, true);
    assert.deepEqual(positional, ["fix", "the", "bug"]);
  });

  it("handles bare double dash separator", () => {
    const { options, positional } = parseArgs(
      ["--model", "gpt", "--", "fix", "--not-a-flag"],
      { valueOptions: ["model"] }
    );
    assert.equal(options.model, "gpt");
    assert.deepEqual(positional, ["fix", "--not-a-flag"]);
  });

  it("parses --key=value options", () => {
    const { options, positional } = parseArgs(
      ["--base=main", "--scope=branch", "do", "work"],
      { valueOptions: ["base", "scope"] }
    );
    assert.equal(options.base, "main");
    assert.equal(options.scope, "branch");
    assert.deepEqual(positional, ["do", "work"]);
  });

  it("preserves legitimate double dash inside positional arguments", () => {
    const { options, positional } = parseArgs(
      ["--agent", "coder", "Fix", "the", "bug", "--", "it", "happens", "on", "linux"],
      { valueOptions: ["agent"], rejectUnknown: true }
    );
    assert.equal(options.agent, "coder");
    assert.deepEqual(positional, [
      "Fix", "the", "bug", "--", "it", "happens", "on", "linux",
    ]);
    assert.equal(
      positional.join(" "),
      "Fix the bug -- it happens on linux"
    );
  });

  it("rejects unknown options when rejectUnknown is true", () => {
    assert.throws(
      () => parseArgs(["--bogus", "val"], { valueOptions: ["model"], rejectUnknown: true }),
      (err) => {
        assert.ok(err.message.includes("Unknown option: --bogus"));
        assert.ok(err.message.includes("Accepted options: --model"));
        return true;
      }
    );
  });
});

describe("extractTaskText", () => {
  it("strips flags and returns text", () => {
    const text = extractTaskText(
      ["fix", "--model", "claude", "--write", "the", "bug"],
      ["model"],
      ["write"]
    );
    assert.equal(text, "fix the bug");
  });

  it("returns empty for flags-only input", () => {
    const text = extractTaskText(["--wait", "--model", "gpt"], ["model"], ["wait"]);
    assert.equal(text, "");
  });

  it("preserves text after bare double dash separator", () => {
    const text = extractTaskText(
      ["--model", "gpt", "--", "fix", "--not-a-flag"],
      ["model"],
      []
    );
    assert.equal(text, "fix --not-a-flag");
  });

  it("preserves legitimate double dash inside text", () => {
    const text = extractTaskText(
      ["fix", "the", "bug", "--", "more", "details"],
      [],
      []
    );
    assert.equal(text, "fix the bug -- more details");
  });

  it("handles --key=value options", () => {
    const text = extractTaskText(
      ["--model=claude", "fix", "the", "bug"],
      ["model"],
      []
    );
    assert.equal(text, "fix the bug");
  });
});

describe("task subcommand integration", () => {
  let tmpDir;
  let workDir;
  let fakeBin;
  let fakeHome;
  let dataDir;

  beforeEach(() => {
    tmpDir = createTmpDir("task-test");
    workDir = path.join(tmpDir, "workspace");
    dataDir = path.join(tmpDir, "opencode-companion-data");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    fakeHome = path.join(tmpDir, "home");
    fs.mkdirSync(path.join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      "token",
      "utf8"
    );
    fs.writeFileSync(
      path.join(fakeHome, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ permissions: { allow: ["command(ls)"], deny: ["command(sudo)"] } }),
      "utf8"
    );

    fakeBin = path.join(tmpDir, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "agy"),
      "#!/usr/bin/env bash\nif [[ \"$1\" == \"models\" ]]; then printf \"model-a\\tModel A\\n\"; exit 0; fi\necho '{\"conversation_id\":\"conv-123\",\"status\":\"SUCCESS\",\"response\":\"OK\"}'\nexit 0\n",
      { mode: 0o755 }
    );

    process.env.OPENCODE_COMPANION_DATA = dataDir;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  function runTask(args, options = {}) {
    return spawnSync(
      process.execPath,
      [COMPANION_SCRIPT, "task", ...args],
      {
        cwd: options.cwd || workDir,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          HOME: fakeHome,
          OPENCODE_BACKEND: "agy",
          OPENCODE_COMPANION_DATA: dataDir,
          CLAUDE_PLUGIN_DATA: dataDir,
          ...(options.env || {}),
        },
        encoding: "utf8",
        timeout: 5000,
      }
    );
  }

  it("task with an unknown --flag exits non-zero and names the flag", () => {
    const res = runTask(["--agent", "coder", "--bogus-flag", "x"]);
    assert.notEqual(res.status, 0);
    assert.ok(
      res.stderr.includes("--bogus-flag"),
      `stderr should name the offending flag: ${res.stderr}`
    );
    assert.ok(
      res.stderr.includes("Accepted options:") || res.stderr.includes("Available options:"),
      `stderr should list accepted options: ${res.stderr}`
    );
  });

  it("--task-file produces the same task text as the positional form at the parsing level", () => {
    const filePath = path.join(tmpDir, "brief.txt");
    const taskContent = "say the single word OK and stop\n";
    fs.writeFileSync(filePath, taskContent, "utf8");

    const fileParsed = parseArgs(["--agent", "coder", "--task-file", filePath], {
      valueOptions: ["model", "agent", "task-file"],
      booleanOptions: ["write", "background", "wait", "resume-last", "fresh"],
      rejectUnknown: true,
    });
    assert.equal(fileParsed.options["task-file"], filePath);
    const fileTaskText = fs.readFileSync(fileParsed.options["task-file"], "utf8");
    assert.equal(fileTaskText, taskContent);

    // Also compare inline string without trailing newline vs positional form
    const inlinePath = path.join(tmpDir, "inline.txt");
    fs.writeFileSync(inlinePath, "do the work", "utf8");
    const inlineFileParsed = parseArgs(["--agent", "coder", "--task-file", inlinePath], {
      valueOptions: ["model", "agent", "task-file"],
      booleanOptions: ["write", "background", "wait", "resume-last", "fresh"],
      rejectUnknown: true,
    });
    const posParsed = parseArgs(["--agent", "coder", "do", "the", "work"], {
      valueOptions: ["model", "agent", "task-file"],
      booleanOptions: ["write", "background", "wait", "resume-last", "fresh"],
      rejectUnknown: true,
    });
    const inlineFileTaskText = fs.readFileSync(inlineFileParsed.options["task-file"], "utf8");
    const posTaskText = posParsed.positional.join(" ").trim();
    assert.equal(inlineFileTaskText, posTaskText);
  });

  it("--task-file together with positional text is an error", () => {
    const filePath = path.join(tmpDir, "brief.txt");
    fs.writeFileSync(filePath, "task from file", "utf8");

    const res = runTask([
      "--agent", "coder",
      "--task-file", filePath,
      "positional", "task", "text",
    ]);
    assert.notEqual(res.status, 0);
    assert.ok(
      res.stderr.includes("Cannot combine --task-file with positional task text"),
      `stderr should mention conflict: ${res.stderr}`
    );
  });

  it("--task-file pointing at a missing file, and at an empty file, are errors", () => {
    const missingPath = path.join(tmpDir, "nonexistent-brief.txt");
    const resMissing = runTask([
      "--agent", "coder",
      "--task-file", missingPath,
    ]);
    assert.notEqual(resMissing.status, 0);
    assert.ok(
      resMissing.stderr.includes("nonexistent-brief.txt"),
      `stderr should name the missing path: ${resMissing.stderr}`
    );

    const emptyPath = path.join(tmpDir, "empty-brief.txt");
    fs.writeFileSync(emptyPath, "   \n\t  \n", "utf8");
    const resEmpty = runTask([
      "--agent", "coder",
      "--task-file", emptyPath,
    ]);
    assert.notEqual(resEmpty.status, 0);
    assert.ok(
      resEmpty.stderr.includes("empty"),
      `stderr should state that file is empty: ${resEmpty.stderr}`
    );
  });

  it("--task-file resolves relative path against current working directory when validating file", () => {
    const relativeName = "nonexistent-relative.txt";
    const res = runTask([
      "--agent", "coder",
      "--task-file", relativeName,
    ]);
    assert.notEqual(res.status, 0);
    assert.ok(
      res.stderr.includes(path.join(workDir, relativeName)),
      `stderr should show path resolved against cwd: ${res.stderr}`
    );
  });
});
