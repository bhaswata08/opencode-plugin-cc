import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractTaskIds } from "../plugins/opencode/scripts/post-tool-use-monitor-hook.mjs";
import { generateJobId } from "../plugins/opencode/scripts/lib/state.mjs";
import { renderResult, renderStatus } from "../plugins/opencode/scripts/lib/render.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "plugins", "opencode", "scripts", "post-tool-use-monitor-hook.mjs");
const COMPANION = path.join(HERE, "..", "plugins", "opencode", "scripts", "opencode-companion.mjs");

// Run the hook the way Claude Code does: hook input JSON on fd 0, hook
// output JSON on stdout. Returns stdout verbatim ("" when silent).
function runHook(input) {
  return execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
}

// A chunk of the companion's own source of the kind that caused the real
// false positive: the filename plus the "task-resume-candidate" handler key.
function sourceChunk() {
  const lines = fs.readFileSync(COMPANION, "utf8").split("\n");
  const handlerLine = lines.findIndex((l) => l.includes("task-resume-candidate"));
  assert.ok(handlerLine >= 0, "companion source must contain the task-resume-candidate key");
  return [
    "    12513     481    4096 opencode-companion.mjs",
    ...lines.slice(handlerLine - 5, handlerLine + 6),
  ].join("\n");
}

describe("post-tool-use-monitor-hook", () => {
  it("ignores a read of the plugin source containing task-resume-candidate", () => {
    const chunk = sourceChunk();
    assert.ok(chunk.includes("opencode-companion.mjs"));
    assert.ok(chunk.includes("task-resume-candidate"));
    // The old loose pattern DID match this text — the regression reproduces.
    const loose = chunk.match(/\btask-[a-z0-9]{6,}-[a-z0-9]{4,}\b/g) || [];
    assert.ok(loose.includes("task-resume-candidate"), "old pattern must match (bug reproduces)");
    // The anchored extractor must not.
    assert.deepEqual(extractTaskIds(chunk), []);
    // End to end: the hook emits nothing on stdout.
    assert.equal(runHook({ tool_name: "Bash", tool_response: chunk }), "");
  });

  it("ignores the entire companion source file as tool output", () => {
    const src = fs.readFileSync(COMPANION, "utf8");
    assert.deepEqual(extractTaskIds(src), []);
    assert.equal(runHook({ tool_name: "Bash", tool_response: src }), "");
  });

  it("ignores prose mentioning a well-formed id with no anchor lines (Agent path)", () => {
    // Mirrors the real misfire: a dispatch prompt quoting both the handler
    // key and a well-formed example id, echoed back in the Agent payload.
    const prose = [
      "Dispatch an opencode rescue task for the request below.",
      'The companion\'s handler table contains a "task-resume-candidate" key;',
      "that is a subcommand name, not a dispatched job.",
      "Real ids look like task-mo3k1x2p-a7f9qs: `task-`, 8 base-36 chars,",
      "a dash, then 6 more. Summarize what the rescue task did.",
    ].join("\n");
    // A quantifier-only fix still fires here: the example id is well-formed.
    assert.match(prose, /task-[a-z0-9]{8,9}-[a-z0-9]{1,6}/);
    assert.deepEqual(extractTaskIds(prose), []);
    // String response shape …
    assert.equal(runHook({ tool_name: "Agent", tool_response: prose }), "");
    // … and an unrecognized object shape via the JSON.stringify fallback.
    assert.equal(
      runHook({ tool_name: "Agent", tool_response: { agentResult: prose, exitCode: 0 } }),
      ""
    );
    // Orchestrator-authored input is never scanned, only the response.
    assert.equal(
      runHook({ tool_name: "Agent", tool_input: { prompt: prose }, tool_response: "done" }),
      ""
    );
  });

  it("extracts a genuine background dispatch line (Bash path)", () => {
    const id = "task-mo3k1x2p-a7f9qs";
    const text = `OpenCode task started in background: ${id}\nCheck \`/opencode:status\` for progress.`;
    assert.deepEqual(extractTaskIds(text), [id]);
    const out = runHook({ tool_name: "Bash", tool_response: text });
    const parsed = JSON.parse(out);
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes(id));
  });

  it("extracts a rendered result block header (Agent path)", () => {
    const id = generateJobId("task");
    const block = renderResult(
      { id, type: "task", status: "running", elapsed: "3s" },
      { rendered: "partial output" }
    );
    assert.ok(block.startsWith(`## Job: ${id}`));
    assert.deepEqual(extractTaskIds(block), [id]);
    const out = runHook({ tool_name: "Agent", tool_response: block });
    const parsed = JSON.parse(out);
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes(id));
  });

  it("extracts every id produced by the real generateJobId", () => {
    for (let i = 0; i < 3000; i++) {
      const id = generateJobId("task");
      // Guard against future generator changes silently breaking the hook.
      assert.match(id, /^task-[a-z0-9]{8,9}-[a-z0-9]{1,6}$/, `unexpected id shape: ${id}`);
      assert.deepEqual(extractTaskIds(`OpenCode task started in background: ${id}`), [id]);
      // Bare header with no status line must fail open, never drop the id.
      assert.deepEqual(extractTaskIds(`## Job: ${id}`), [id]);
    }
  });

  it("dedupes multiple distinct ids, preserving first-seen order", () => {
    const a = generateJobId("task");
    const b = generateJobId("task");
    assert.notEqual(a, b);
    const text = [
      `OpenCode task started in background: ${a}`,
      `OpenCode task started in background: ${b}`,
      `OpenCode task started in background: ${a}`,
      `## Job: ${b}`,
      `## Job: ${a}`,
    ].join("\n");
    assert.deepEqual(extractTaskIds(text), [a, b]);
  });

  it("skips result blocks whose own status line is terminal", () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      const block = renderResult(
        { id: generateJobId("task"), type: "task", status, elapsed: "5m" },
        { rendered: "all done" }
      );
      assert.ok(block.includes(`- **Status**: ${status}`));
      assert.deepEqual(extractTaskIds(block), [], `terminal block (${status}) must not re-arm`);
    }
  });

  it("keeps result blocks for non-terminal jobs", () => {
    const id = generateJobId("task");
    const block = renderResult(
      { id, type: "task", status: "running", elapsed: "1m" },
      { rendered: "still going" }
    );
    assert.deepEqual(extractTaskIds(block), [id]);
  });

  it("ignores status output, whose ids sit in bullets rather than anchors", () => {
    const id = generateJobId("task");
    const text = renderStatus({
      running: [{ id, type: "task", phase: "investigating", elapsed: "2m 30s" }],
      latestFinished: null,
      recent: [],
    });
    assert.ok(text.includes(id), "status output really does carry the id");
    assert.deepEqual(extractTaskIds(text), []);
  });

  it("ignores other tools and empty responses", () => {
    const id = generateJobId("task");
    const text = `OpenCode task started in background: ${id}`;
    assert.equal(runHook({ tool_name: "Read", tool_response: text }), "");
    assert.equal(runHook({ tool_name: "Bash", tool_response: "" }), "");
    assert.equal(runHook({}), "");
  });
});
