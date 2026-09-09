// Progress lines for the opencode transport (shared formatters + dedup +
// sendPrompt onProgress behaviour).
//
// Style mirrors tests/agy.test.mjs: node:test + assert/strict, no external
// deps. The transport tests stub global.fetch the way tests/fallback.test.mjs
// does (hanging POST + scripted GET polls), so they exercise the real poll
// loop instead of snapshotting source. Nothing here touches live job state.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  MAX_DETAIL,
  singleLine,
  formatToolDetail,
  formatProgressEvent,
  formatOpencodePart,
  progressKey,
  createProgressEmitter,
} from "../plugins/opencode/scripts/lib/progress.mjs";
import {
  formatToolDetail as agyFormatToolDetail,
  formatProgressEvent as agyFormatProgressEvent,
} from "../plugins/opencode/scripts/lib/agy-runner.mjs";
import { createClient as opencodeCreateClient } from "../plugins/opencode/scripts/lib/opencode-server.mjs";

// ---------------------------------------------------------------------------
// env + fetch save/restore
// ---------------------------------------------------------------------------

let savedEnv;
let savedFetch;

beforeEach(() => {
  savedEnv = { ...process.env };
  savedFetch = global.fetch;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
  global.fetch = savedFetch;
});

// ---------------------------------------------------------------------------
// fixtures: real-shaped opencode parts (see GET /session/:id/message)
// ---------------------------------------------------------------------------

function toolPart(overrides = {}, stateOverrides = {}) {
  return {
    id: "prt_080f64188001Q1KSf3eeoC6pb2",
    sessionID: "ses_progress1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "bash",
    state: {
      status: "running",
      input: { command: "npm test" },
      output: "",
      title: "Run npm test",
      metadata: {},
      time: {},
      ...stateOverrides,
    },
    ...overrides,
  };
}

function message(parts, { created, completed, finish } = {}) {
  const now = Date.now();
  return {
    info: {
      id: "msg_1",
      sessionID: "ses_progress1",
      role: "assistant",
      time: {
        created: created ?? now,
        ...(completed !== undefined ? { completed } : {}),
      },
      ...(finish ? { finish } : {}),
      agent: "build",
      model: "test-model",
    },
    parts,
  };
}

// ---------------------------------------------------------------------------
// shared formatter: opencode parts
// ---------------------------------------------------------------------------

describe("formatOpencodePart", () => {
  it("formats a running bash tool part with its title", () => {
    assert.equal(formatOpencodePart(toolPart()), "tool: bash (Run npm test)");
  });

  it("falls back to raw input when no title is present", () => {
    const part = toolPart({}, { title: "", input: { command: "ls -la /tmp" } });
    assert.equal(formatOpencodePart(part), "tool: bash (ls -la /tmp)");
  });

  it("formats a completed tool part, keeping the detail", () => {
    const part = toolPart({}, { status: "completed" });
    assert.equal(formatOpencodePart(part), "tool: bash completed (Run npm test)");
  });

  it("formats a failed tool part", () => {
    const part = toolPart({}, { status: "error" });
    assert.equal(formatOpencodePart(part), "tool: bash failed: Run npm test");
  });

  it("truncates a long command and keeps the line to one line", () => {
    const command = `echo ${"x".repeat(200)}`;
    const part = toolPart({}, { title: "", input: { command } });
    const line = formatOpencodePart(part);
    const expectedDetail = `echo ${"x".repeat(112)}...`;
    assert.equal(line, `tool: bash (${expectedDetail})`);
    assert.ok(!line.includes("\n"), "progress line must be a single line");
    assert.ok(line.length <= `tool: bash (`.length + MAX_DETAIL + 1);
  });

  it("collapses embedded newlines out of the detail", () => {
    const part = toolPart({}, { title: "", input: { command: "echo alpha\necho beta" } });
    assert.equal(formatOpencodePart(part), "tool: bash (echo alpha echo beta)");
  });

  it("formats a patch part from its title", () => {
    const part = {
      id: "prt_patch1",
      sessionID: "ses_progress1",
      messageID: "msg_1",
      type: "patch",
      title: "Update src/foo.js",
    };
    assert.equal(formatOpencodePart(part), "patch: Update src/foo.js");
  });

  it("formats a patch part from its file list when title is absent", () => {
    const part = {
      id: "prt_patch2",
      sessionID: "ses_progress1",
      messageID: "msg_1",
      type: "patch",
      files: [{ path: "src/a.js" }, { path: "src/b.js" }],
    };
    assert.equal(formatOpencodePart(part), "patch: src/a.js, src/b.js");
  });

  it("renders long absolute patch paths as short names with elision, never cut mid-path", () => {
    // Real-server shape: absolute paths that die mid-path under the cap.
    const root = "/home/bhaswata/work/projects/llmhosting/syntheticdatagen";
    const part = {
      id: "prt_patchlong",
      sessionID: "ses_progress1",
      messageID: "msg_1",
      type: "patch",
      files: [
        `${root}/src/generate.py`,
        `${root}/src/evaluate.py`,
        `${root}/src/datasets/loader.py`,
        `${root}/src/datasets/splitter.py`,
        `${root}/src/export/writer.py`,
        `${root}/src/export/uploader.py`,
        `${root}/tests/test_generate.py`,
        `${root}/tests/test_evaluate.py`,
        `${root}/src/datasets/cleaner.py`,
        `${root}/src/export/downloader.py`,
        `${root}/tests/test_splitter.py`,
        `${root}/tests/test_writer.py`,
      ],
    };
    // Basename fallback (no workspace root known): identifiable file names,
    // elision count instead of a mid-path cut.
    const short = formatOpencodePart(part);
    assert.ok(short.includes("generate.py"), `expected a file name in: ${short}`);
    assert.ok(short.includes("evaluate.py"), `expected a file name in: ${short}`);
    assert.ok(short.includes("+5 more"), `expected an accurate elision count in: ${short}`);
    assert.ok(!short.includes("..."), `must not cut a path in half: ${short}`);
    assert.ok(!short.includes("/home/bhaswata"), `must not leak long prefixes: ${short}`);
    assert.ok(!short.includes("\n"), "progress line must be a single line");
    assert.ok(short.length <= MAX_DETAIL, `over cap (${short.length}): ${short}`);
    // Workspace root known but the relative form overflows: degrades to
    // basenames first, so this renders exactly like the no-root form (with
    // its accurate elision count) rather than naming fewer files.
    const rel = formatOpencodePart(part, { root });
    assert.equal(rel, short);
    assert.ok(!rel.includes("/home/bhaswata"), `must not leak long prefixes: ${rel}`);
    assert.ok(!rel.includes("..."), `must not cut a path in half: ${rel}`);
    assert.ok(!rel.includes("\n"), "progress line must be a single line");
    assert.ok(rel.length <= MAX_DETAIL, `over cap (${rel.length}): ${rel}`);
  });

  it("degrades an overflowing relative patch list to basenames before eliding", () => {
    // The review's inversion: with a root the relative form named FEWER
    // files (two plus a count) than the rootless basename form (all three).
    const root = "/work/proj";
    const files = [
      `${root}/lib/services/data-quality/citation-renumber.js`,
      `${root}/lib/services/data-quality/grounding-gate.js`,
      `${root}/lib/services/data-quality/renumber-citations.mjs`,
    ];
    const part = {
      id: "prt_patchdegrade",
      sessionID: "ses_progress1",
      messageID: "msg_1",
      type: "patch",
      files,
    };
    // Relative form is 147 chars (over cap); basename form fits and must
    // name every file with no `+N more`.
    const degraded = formatOpencodePart(part, { root });
    assert.equal(
      degraded,
      "patch: citation-renumber.js, grounding-gate.js, renumber-citations.mjs",
    );
    assert.ok(!degraded.includes("+"), `must not elide when basenames fit: ${degraded}`);
    // Same list with no root renders identically.
    assert.equal(formatOpencodePart({ ...part, id: "prt_patchdegrade2" }), degraded);
  });

  it("keeps colliding basenames relative when the patch list degrades", () => {
    // Two changed files share a basename: degrading both to "index.js"
    // would silently merge two genuinely different files into one entry,
    // so the colliding pair stays relative while the rest shortens.
    const root = "/work/proj";
    const part = {
      id: "prt_patchcollide",
      sessionID: "ses_progress1",
      messageID: "msg_1",
      type: "patch",
      files: [
        `${root}/lib/services/data-quality/src/handlers/index.js`,
        `${root}/lib/services/data-quality/lib/workers/index.js`,
        `${root}/lib/services/data-quality/foo.js`,
      ],
    };
    assert.equal(
      formatOpencodePart(part, { root }),
      "patch: lib/services/data-quality/src/handlers/index.js, " +
        "lib/services/data-quality/lib/workers/index.js, foo.js",
    );
  });

  it("produces nothing for text, reasoning and step boundary parts", () => {
    const base = { id: "prt_x", sessionID: "s", messageID: "m" };
    assert.equal(formatOpencodePart({ ...base, type: "text", text: "hello" }), null);
    assert.equal(formatOpencodePart({ ...base, type: "reasoning", text: "hmm" }), null);
    assert.equal(formatOpencodePart({ ...base, type: "step-start" }), null);
    assert.equal(formatOpencodePart({ ...base, type: "step-finish" }), null);
    assert.equal(formatOpencodePart(null), null);
    assert.equal(formatOpencodePart({}), null);
  });
});

describe("formatToolDetail (shared)", () => {
  it("keeps agy PascalCase shapes byte-identical", () => {
    assert.equal(formatToolDetail("run_command", { CommandLine: "git status" }), "git status");
    assert.equal(formatToolDetail("t", { TargetFile: "/a/b.js" }), "/a/b.js");
  });

  it("reads opencode lowercase inputs (bash { command })", () => {
    assert.equal(formatToolDetail("bash", { command: "ls -la /tmp" }), "ls -la /tmp");
    assert.equal(formatToolDetail("read", { filePath: "/a/b.js" }), "/a/b.js");
  });

  it("is single-line and truncated", () => {
    const detail = formatToolDetail("bash", { command: `a\nb${"y".repeat(200)}` });
    assert.ok(!detail.includes("\n"));
    assert.ok(detail.length <= MAX_DETAIL);
  });

  it("singleLine truncates with an ellipsis at the cap", () => {
    assert.equal(singleLine("x".repeat(200)), `${"x".repeat(117)}...`);
    assert.equal(singleLine("  ok  "), "ok");
    assert.equal(singleLine(null), "");
  });
});

// ---------------------------------------------------------------------------
// dedup across polls
// ---------------------------------------------------------------------------

describe("createProgressEmitter dedup", () => {
  it("emits the same part once across repeated polls", () => {
    const lines = [];
    const progress = createProgressEmitter((line) => lines.push(line));
    const part = toolPart();
    assert.equal(progress.emitPart(part), "tool: bash (Run npm test)");
    assert.equal(progress.emitPart({ ...part }), null);
    assert.equal(progress.emitPart({ ...part }), null);
    assert.deepEqual(lines, ["tool: bash (Run npm test)"]);
  });

  it("emits a second line on the running-to-completed transition only", () => {
    const lines = [];
    const progress = createProgressEmitter((line) => lines.push(line));
    const running = toolPart();
    const completed = toolPart({}, { status: "completed" });
    assert.equal(progress.emitPart(running), "tool: bash (Run npm test)");
    assert.equal(progress.emitPart(completed), "tool: bash completed (Run npm test)");
    assert.equal(progress.emitPart({ ...completed }), null);
    assert.deepEqual(lines, [
      "tool: bash (Run npm test)",
      "tool: bash completed (Run npm test)",
    ]);
  });

  it("keys dedup on part.id plus status class", () => {
    const running = toolPart();
    const completed = toolPart({}, { status: "completed" });
    assert.notEqual(progressKey(running), progressKey(completed));
    assert.equal(progressKey(running), progressKey({ ...running }));
  });

  it("does not let a detail-less pending sighting suppress the later command line", () => {
    // Real poll order: the watcher can catch a tool in `pending` before its
    // input is populated. The bare "tool: bash" must not claim the dedup key
    // forever; the line carrying the actual command has to get out.
    const lines = [];
    const progress = createProgressEmitter((line) => lines.push(line));
    const id = "prt_pending0001";
    const pending = toolPart({ id }, { status: "pending", input: {}, title: "" });
    const running = toolPart({ id }, { status: "running", input: { command: "npm test" }, title: "" });
    const completed = toolPart({ id }, { status: "completed", input: { command: "npm test" }, title: "" });
    assert.equal(progress.emitPart(pending), "tool: bash");
    assert.equal(progress.emitPart(running), "tool: bash (npm test)");
    assert.equal(progress.emitPart(completed), "tool: bash completed (npm test)");
    assert.deepEqual(lines, [
      "tool: bash",
      "tool: bash (npm test)",
      "tool: bash completed (npm test)",
    ]);
  });

  it("never forwards text parts and tolerates a throwing callback", () => {
    const lines = [];
    const progress = createProgressEmitter((line) => lines.push(line));
    assert.equal(progress.emitPart({ id: "p1", type: "text", text: "hi" }), null);
    assert.deepEqual(lines, []);

    const throwing = createProgressEmitter(() => { throw new Error("log down"); });
    assert.equal(throwing.emitPart(toolPart()), "tool: bash (Run npm test)");
  });

  it("is inert without an onProgress callback", () => {
    const progress = createProgressEmitter(undefined);
    assert.deepEqual(progress.emitParts([toolPart()]), []);
  });
});

// ---------------------------------------------------------------------------
// agy re-exports: observable output unchanged
// ---------------------------------------------------------------------------

describe("agy-runner formatter re-exports", () => {
  it("re-exports the shared formatters by reference", () => {
    assert.equal(agyFormatToolDetail, formatToolDetail);
    assert.equal(agyFormatProgressEvent, formatProgressEvent);
  });

  it("keeps agy's line shapes (init / tool active+done / agent responding)", () => {
    assert.equal(
      agyFormatProgressEvent({ event: "init", conversation_id: "c1" }),
      "session started (c1)",
    );
    assert.equal(
      agyFormatProgressEvent({
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { CommandLine: "git status" } },
        },
      }),
      "tool: run_command (git status)",
    );
    assert.equal(
      agyFormatProgressEvent({
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "DONE",
          tool_name: "run_command",
          duration_seconds: 0.05,
        },
      }),
      "tool: run_command completed (0.05s)",
    );
    assert.equal(
      agyFormatProgressEvent({
        event: "step_update",
        step_update: { step_type: "agent_response", state: "ACTIVE", step_index: 3 },
      }),
      "agent responding",
    );
  });
});

// ---------------------------------------------------------------------------
// transport behaviour against a stub HTTP server
// ---------------------------------------------------------------------------

function installStub({ onPost, polls }) {
  let gets = 0;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === "POST" && u.endsWith("/message")) {
      return onPost(init);
    }
    if (u.includes("/message?limit=1")) {
      const entry = polls[Math.min(gets++, polls.length - 1)];
      const msg = typeof entry === "function" ? entry() : entry;
      return { ok: true, json: async () => [msg] };
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${u}`);
  };
}

function hangingPost(init) {
  return new Promise((_, reject) => {
    if (init?.signal?.aborted) {
      reject(init.signal.reason ?? new Error("aborted"));
      return;
    }
    init?.signal?.addEventListener("abort", () => {
      reject(init.signal.reason ?? new Error("aborted"));
    });
  });
}

function progressEnv() {
  process.env.OPENCODE_MIN_POLL_DELAY_MS = "10";
  process.env.OPENCODE_COMPLETION_POLL_MS = "10";
  // Never touch a real server log (or a live companion state dir): a missing
  // path resolves to "no error" immediately.
  process.env.OPENCODE_LOG_PATH = path.join(
    os.tmpdir(),
    `opencode-progress-test-${process.pid}-missing.log`,
  );
}

describe("opencode sendPrompt onProgress", () => {
  it("emits running then completed lines from the poll loop, skipping stale pre-prompt parts", async () => {
    progressEnv();
    const stale = message(
      [toolPart({ id: "prt_stale0001" }, { status: "completed", input: { command: "echo STALE-MARKER-OLD" }, title: "Old stale command" })],
      { created: Date.now() - 60_000, completed: Date.now() - 59_000, finish: "stop" },
    );
    installStub({
      onPost: hangingPost,
      polls: [
        stale,
        () => message([toolPart()]),
        () => message([toolPart({}, { status: "completed" })], { completed: Date.now(), finish: "stop" }),
      ],
    });

    const client = opencodeCreateClient("http://127.0.0.1:4096");
    const lines = [];
    const res = await client.sendPrompt("sess_progress_1", "do the thing", {
      onProgress: (line) => lines.push(line),
    });

    assert.equal(res.info.role, "assistant");
    assert.deepEqual(lines, [
      "tool: bash (Run npm test)",
      "tool: bash completed (Run npm test)",
    ]);
    for (const line of lines) {
      assert.ok(!line.includes("\n"), "progress line must be a single line");
    }
  });

  it("emits tool lines on the fast path when the POST wins the race", async () => {
    progressEnv();
    installStub({
      onPost: async () => ({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => {
          const now = Date.now();
          return message(
            [toolPart({ id: "prt_fast0001" }, { status: "completed", input: { command: "npm run build" }, title: "Run build" })],
            { created: now, completed: now, finish: "stop" },
          );
        },
      }),
      polls: [() => message([], {})],
    });

    const client = opencodeCreateClient("http://127.0.0.1:4096");
    const lines = [];
    await client.sendPrompt("sess_progress_fast", "quick", {
      onProgress: (line) => lines.push(line),
    });
    assert.deepEqual(lines, ["tool: bash completed (Run build)"]);
  });

  it("stays silent with no onProgress and no tool parts", async () => {
    progressEnv();
    installStub({
      onPost: hangingPost,
      polls: [
        () => message([{ id: "prt_t1", type: "text", text: "thinking out loud" }]),
        () => message(
          [{ id: "prt_t1", type: "text", text: "thinking out loud" }],
          { completed: Date.now(), finish: "stop" },
        ),
      ],
    });

    const client = opencodeCreateClient("http://127.0.0.1:4096");
    // No onProgress at all: must resolve without throwing.
    const res = await client.sendPrompt("sess_progress_quiet", "quiet task", {});
    assert.equal(res.info.role, "assistant");
  });
});
