import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildFixPrompt,
  buildVerifyPrompt,
} from "../plugins/opencode/scripts/lib/prompts.mjs";
import {
  SAFETY_HEADER,
  buildTreeContext,
} from "../plugins/opencode/scripts/lib/prompts.mjs";
import fs from "node:fs";
import path from "node:path";
import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import { runCommand } from "../plugins/opencode/scripts/lib/process.mjs";

const findings = [
  {
    severity: "critical",
    title: "null deref on empty input",
    file: "lib/parse.mjs",
    line_start: 12,
    line_end: 14,
    body: "parse() indexes [0] without checking length.",
    recommendation: "Guard the empty case.",
  },
  {
    severity: "high",
    title: "await missing",
    file: "lib/run.mjs",
    line_start: 40,
    line_end: 40,
    body: "The promise is never awaited.",
    recommendation: "Await it.",
  },
];

describe("buildFixPrompt", () => {
  test("names every finding it wants fixed", () => {
    const p = buildFixPrompt(findings);
    assert.match(p, /null deref on empty input/);
    assert.match(p, /await missing/);
    assert.match(p, /lib\/parse\.mjs:12/);
    assert.match(p, /lib\/run\.mjs:40/);
  });

  test("carries each finding's recommendation, not just its title", () => {
    const p = buildFixPrompt(findings);
    assert.match(p, /Guard the empty case\./);
    assert.match(p, /The promise is never awaited\./);
  });

  test("keeps the coder inside the reported findings rather than refactoring on", () => {
    const p = buildFixPrompt(findings);
    assert.match(p, /only|do not.*(refactor|redesign|unrelated)/i);
  });

  test("carries the safety header, so the fix round cannot recurse into delegation", () => {
    assert.ok(buildFixPrompt(findings).includes(SAFETY_HEADER));
  });

  test("an empty finding list is refused rather than sent as a no-op round", () => {
    assert.throws(() => buildFixPrompt([]), /finding/i);
    assert.throws(() => buildFixPrompt(undefined), /finding/i);
  });
});

describe("buildVerifyPrompt", () => {
  test("asks only whether the listed findings were addressed", () => {
    const p = buildVerifyPrompt(findings, "<diff>...</diff>");
    assert.match(p, /null deref on empty input/);
    assert.match(p, /await missing/);
    assert.match(p, /addressed|fixed|resolved/i);
  });

  test("excludes the design it already passed, and style, from the verify pass", () => {
    const p = buildVerifyPrompt(findings, "<diff>...</diff>");
    assert.match(p, /out of scope|do not|don't/i);
    assert.match(p, /design/i);
    assert.match(p, /style/i);
  });

  test("asks about regressions the fix introduced", () => {
    assert.match(
      buildVerifyPrompt(findings, "<diff>...</diff>"),
      /new (finding|issue|problem)s?|introduc/i,
    );
  });

  test("includes the diff context it is verifying against", () => {
    assert.match(buildVerifyPrompt(findings, "<diff>THEDIFF</diff>"), /THEDIFF/);
  });

  test("an empty finding list is refused: there is nothing to verify", () => {
    assert.throws(() => buildVerifyPrompt([], "x"), /finding/i);
  });
});

describe("buildTreeContext", () => {
  let repo;

  test("gathers the working tree's status, file list and diff for a verify pass", async () => {
    repo = createTmpDir("tree-context");
    await runCommand("git", ["init", "-q"], { cwd: repo });
    await runCommand("git", ["config", "user.email", "t@t"], { cwd: repo });
    await runCommand("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.mjs"), "export const a = 1;\n");
    await runCommand("git", ["add", "-A"], { cwd: repo });
    await runCommand("git", ["commit", "-qm", "init"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.mjs"), "export const a = 2;\n");

    const ctx = await buildTreeContext(repo);
    assert.match(ctx, /<git_status>/);
    assert.match(ctx, /<changed_files>/);
    assert.match(ctx, /a\.mjs/);
    assert.match(ctx, /<diff>/);
    assert.match(ctx, /export const a = 2;/);

    cleanupTmpDir(repo);
  });
});
