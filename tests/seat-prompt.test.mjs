import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveAgentFilePath,
  readSeatPrompt,
  withSeatPrompt,
} from "../plugins/opencode/scripts/lib/seat-prompt.mjs";

let tmp;
let previousXdg;

function writeAgent(name, contents) {
  const dir = path.join(tmp, "opencode", "agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), contents);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seat-prompt-"));
  previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
});

afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveAgentFilePath", () => {
  test("resolves a seat under $XDG_CONFIG_HOME/opencode/agent", () => {
    assert.equal(
      resolveAgentFilePath("coder"),
      path.join(tmp, "opencode", "agent", "coder.md"),
    );
  });

  test("a seat name that escapes the agent directory is refused", () => {
    assert.equal(resolveAgentFilePath("../../etc/passwd"), null);
    assert.equal(resolveAgentFilePath("a/b"), null);
  });

  test("an empty seat name resolves to nothing", () => {
    assert.equal(resolveAgentFilePath(""), null);
    assert.equal(resolveAgentFilePath(undefined), null);
  });
});

describe("readSeatPrompt", () => {
  test("returns the body of the agent file with the frontmatter stripped", () => {
    writeAgent(
      "coder",
      "---\nmodel: openrouter/x\ntemperature: 0.1\n---\n\nYou are the implementation agent.\nMake the change end to end.\n",
    );
    const body = readSeatPrompt("coder");
    assert.match(body, /You are the implementation agent\./);
    assert.match(body, /Make the change end to end\./);
    assert.doesNotMatch(body, /temperature/);
    assert.doesNotMatch(body, /^---/m);
  });

  test("returns null for a seat with no agent file", () => {
    assert.equal(readSeatPrompt("coder"), null);
  });

  test("returns null when the agent file is only frontmatter", () => {
    writeAgent("reviewer", "---\nmodel: synthetic/x\n---\n\n   \n");
    assert.equal(readSeatPrompt("reviewer"), null);
  });

  test("a file with no frontmatter is returned whole", () => {
    writeAgent("adversary", "Be adversarial.\n");
    assert.equal(readSeatPrompt("adversary"), "Be adversarial.");
  });

  test("a '---' inside the body does not truncate the prompt", () => {
    writeAgent("coder", "---\nmodel: x\n---\n\nFirst.\n\n---\n\nSecond.\n");
    const body = readSeatPrompt("coder");
    assert.match(body, /First\./);
    assert.match(body, /Second\./);
  });
});

describe("withSeatPrompt", () => {
  test("prepends the seat prompt so the task text still reads last", () => {
    writeAgent("coder", "---\nmodel: x\n---\n\nYou are the implementation agent.\n");
    const got = withSeatPrompt("Fix the parser.", "coder");
    assert.match(got, /You are the implementation agent\./);
    assert.ok(
      got.indexOf("You are the implementation agent.") < got.indexOf("Fix the parser."),
      "seat prompt must come before the task text",
    );
  });

  test("returns the prompt unchanged when the seat has no agent file", () => {
    assert.equal(withSeatPrompt("Fix the parser.", "coder"), "Fix the parser.");
  });

  test("returns the prompt unchanged when no seat is named", () => {
    assert.equal(withSeatPrompt("Fix the parser.", undefined), "Fix the parser.");
  });

  test("is idempotent, so a retry does not stack the seat prompt twice", () => {
    writeAgent("coder", "---\nmodel: x\n---\n\nYou are the implementation agent.\n");
    const once = withSeatPrompt("Fix the parser.", "coder");
    assert.equal(withSeatPrompt(once, "coder"), once);
  });

  test("opencode's own built-in seats are left alone, they have no agent file", () => {
    assert.equal(withSeatPrompt("Fix it.", "build"), "Fix it.");
    assert.equal(withSeatPrompt("Look at it.", "plan"), "Look at it.");
  });
});
