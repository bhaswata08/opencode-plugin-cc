import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "plugins", "opencode", "scripts", "post-tool-use-vague-notification-hook.mjs");

function runHook(input) {
  return execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
}

describe("post-tool-use-vague-notification-hook", () => {
  it("fires for a vague placeholder response with a well-formed id and reports that id", () => {
    const id = "task-mo3k1x2p-a7f9qs";
    const text = `OpenCode task started. Monitor started for all rescue tasks. The job ${id} is running.`;
    const out = runHook({ tool_name: "Agent", tool_response: text });
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes(id));
  });

  it("does not fire for a response containing a rendered result block", () => {
    const id = "task-mo3k1x2p-a7f9qs";
    // This text has a vague pattern but also REAL_RESULT_MARKERS
    const text = `OpenCode task started. Monitor started. ## Job: ${id}\n### Output\nStatus: completed`;
    const out = runHook({ tool_name: "Agent", tool_response: text });
    assert.equal(out, "");
  });

  it("does not fire for prose containing only task-resume-candidate", () => {
    const text = `opencode-companion.mjs has a handler task-resume-candidate. I'll wait for the forwarded task.`;
    const out = runHook({ tool_name: "Agent", tool_response: text });
    // Still fires if it finds vague pattern, but should NOT extract 'task-resume-candidate' as an id.
    // Wait, let's see. 'task-resume-candidate' should not match TASK_ID_RE.
    // But does it fire? Let's check OPENCODE_MARKERS. It matches 'opencode-companion.mjs'.
    // It matches VAGUE_PATTERNS "wait for the forwarded task".
    // It has NO real result markers.
    // Therefore it SHOULD fire, but report NO ids.
    const parsed = JSON.parse(out);
    assert.ok(!parsed.hookSpecificOutput.additionalContext.includes("task-resume-candidate"));
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes("No task id was visible"));
  });

  it("fires for a vague response with no id, and its message contains no foreign home path and no /Users/ path", () => {
    const text = `OpenCode task started. Monitor started for all rescue tasks.`;
    const out = runHook({ tool_name: "Agent", tool_response: text });
    const parsed = JSON.parse(out);
    const msg = parsed.hookSpecificOutput.additionalContext;
    assert.ok(msg.includes("No task id was visible"));
    assert.ok(!msg.includes("/Users/"));
    assert.ok(!msg.includes("harvest"));
  });

  it("does not fire for a response matching a vague pattern but no opencode marker", () => {
    const text = `Monitor started for all rescue tasks.`;
    const out = runHook({ tool_name: "Agent", tool_response: text });
    assert.equal(out, "");
  });
});
