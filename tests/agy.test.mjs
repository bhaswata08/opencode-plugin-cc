// Tests for the agy (`antigravity CLI`) transport and backend selection.
// Style mirrors tests/process.test.mjs and tests/state.test.mjs:
// node:test + assert/strict, no external deps. Live `agy` calls are NOT
// made here; integration tests run against a fake `agy` shell script on
// PATH plus a fake HOME (auth token + settings).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  agentToMode,
  msToGoDuration,
  buildPrintArgs,
  parseModelsOutput,
  parsePrintResult,
  withAgyPolicy,
  workspacePolicy,
  denyListPreflight,
  AGY_TOOL_POLICY,
  AGY_SCOPED_ALLOWLIST,
  AGY_ALLOWLIST_DOC,
  createClient,
  getCapability,
  isServerRunning,
  ensureServer,
  connect,
  readAgySettings,
  DEFAULT_GEMINIIGNORE,
  ensureWorkspaceGeminiignore,
  __test,
} from "../plugins/opencode/scripts/lib/agy-runner.mjs";
import {
  resolveBackendName,
  effectiveSessionId,
  createClient as backendCreateClient,
} from "../plugins/opencode/scripts/lib/backend.mjs";
import { createClient as opencodeCreateClient } from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { autoHealAgyJob } from "../plugins/opencode/scripts/lib/auto-heal.mjs";
import { loadState, upsertJob } from "../plugins/opencode/scripts/lib/state.mjs";
import { createTmpDir, cleanupTmpDir, setupTestEnv } from "./helpers.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_SCRIPT = path.join(TESTS_DIR, "..", "plugins", "opencode", "scripts", "opencode-companion.mjs");

// ---------------------------------------------------------------------------
// env save/restore
// ---------------------------------------------------------------------------

let savedEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
});

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ---------------------------------------------------------------------------
// pure units
// ---------------------------------------------------------------------------

describe("agy agentToMode", () => {
  it("maps plan to plan (read-only reviews)", () => {
    assert.equal(agentToMode("plan"), "plan");
  });

  it("maps build to accept-edits", () => {
    assert.equal(agentToMode("build"), "accept-edits");
  });

  it("omits the flag for missing or unknown agents", () => {
    assert.equal(agentToMode(undefined), undefined);
    assert.equal(agentToMode("rescue"), undefined);
  });
});

describe("agy msToGoDuration", () => {
  it("converts ms to whole seconds", () => {
    assert.equal(msToGoDuration(61000), "61s");
    assert.equal(msToGoDuration(14_400_000), "14400s");
  });

  it("rounds up and floors at 1s", () => {
    assert.equal(msToGoDuration(1500), "2s");
    assert.equal(msToGoDuration(0), "1s");
  });
});

describe("agy buildPrintArgs", () => {
  it("places --print last with the prompt attached (flag-swallowing footgun)", () => {
    const args = buildPrintArgs("hello", { timeoutMs: 60000 });
    const printIdx = args.lastIndexOf("--print");
    assert.equal(printIdx, args.length - 2);
    assert.equal(args[args.length - 1], "hello");
  });

  it("puts --model and --output-format before --print", () => {
    const args = buildPrintArgs("hello", { model: "m-1", timeoutMs: 60000 });
    const printIdx = args.indexOf("--print");
    assert.ok(args.indexOf("--model") !== -1 && args.indexOf("--model") < printIdx);
    assert.ok(args.indexOf("--output-format") !== -1 && args.indexOf("--output-format") < printIdx);
  });

  it("maps agent plan to --mode plan", () => {
    const args = buildPrintArgs("hi", { agent: "plan", timeoutMs: 60000 });
    const i = args.indexOf("--mode");
    assert.ok(i !== -1);
    assert.equal(args[i + 1], "plan");
  });

  it("omits --conversation for fresh sessions, adds it on resume", () => {
    const fresh = buildPrintArgs("hi", { timeoutMs: 60000 });
    assert.equal(fresh.includes("--conversation"), false);
    const resume = buildPrintArgs("hi", { conversationId: "conv-1", timeoutMs: 60000 });
    const i = resume.indexOf("--conversation");
    assert.ok(i !== -1 && i < resume.indexOf("--print"));
    assert.equal(resume[i + 1], "conv-1");
  });

  it("passes --json-schema and --effort through", () => {
    const args = buildPrintArgs("hi", {
      jsonSchema: '{"type":"object"}',
      effort: "low",
      timeoutMs: 60000,
    });
    assert.equal(args[args.indexOf("--json-schema") + 1], '{"type":"object"}');
    assert.equal(args[args.indexOf("--effort") + 1], "low");
  });

  it("honours AGY_PRINT_TIMEOUT_MS", () => {
    setEnv({ AGY_PRINT_TIMEOUT_MS: "61000", OPENCODE_PROMPT_TIMEOUT_MS: undefined });
    const args = buildPrintArgs("hi", {});
    assert.equal(args[args.indexOf("--print-timeout") + 1], "61s");
  });

  it("honours AGY_MODEL as the default model", () => {
    setEnv({ AGY_MODEL: "env-model" });
    const args = buildPrintArgs("hi", { timeoutMs: 60000 });
    assert.equal(args[args.indexOf("--model") + 1], "env-model");
  });
});

describe("agy parseModelsOutput", () => {
  it("parses tab-separated id/name rows", () => {
    const models = parseModelsOutput("model-a\tModel A\nmodel-b\tModel B\n");
    assert.deepEqual(models, [
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    ]);
  });

  it("skips blanks and non-model lines", () => {
    const models = parseModelsOutput("\nFetching available models...\nmodel-a\tModel A\n");
    assert.deepEqual(models, [{ id: "model-a", name: "Model A" }]);
  });
});

describe("agy parsePrintResult", () => {
  it("parses a SUCCESS payload", () => {
    const data = parsePrintResult(
      '{"conversation_id":"c1","status":"SUCCESS","response":"hi\\n","duration_seconds":1.5,"num_turns":1,"usage":{}}',
    );
    assert.equal(data.conversation_id, "c1");
    assert.equal(data.status, "SUCCESS");
    assert.equal(data.response, "hi\n");
  });

  it("throws on empty, non-JSON, or status-less output", () => {
    assert.throws(() => parsePrintResult(""), /no output/);
    assert.throws(() => parsePrintResult("not json"), /not JSON/);
    assert.throws(() => parsePrintResult('{"response":"x"}'), /status/);
  });

  it("parses stream-json NDJSON payload extracting the terminal result event", () => {
    const ndjson = [
      '{"event":"init","conversation_id":"c-stream-1","init":{"cwd":"/workspace"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c-stream-1","step_index":0,"state":"DONE","step_type":"user_input"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c-stream-1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"hello"}}',
      '{"event":"result","result":{"conversation_id":"c-stream-1","status":"SUCCESS","response":"hello\\n","duration_seconds":2.5,"num_turns":1,"usage":{"input_tokens":100,"output_tokens":20}}}',
    ].join("\n");
    const data = parsePrintResult(ndjson);
    assert.equal(data.conversation_id, "c-stream-1");
    assert.equal(data.status, "SUCCESS");
    assert.equal(data.response, "hello\n");
    assert.equal(data.duration_seconds, 2.5);
    assert.equal(data.usage?.input_tokens, 100);
  });
});

describe("agy policy and allow-list docs", () => {
  it("appends a one-command, no-chaining policy", () => {
    const full = withAgyPolicy("Do the thing.");
    assert.ok(full.startsWith("Do the thing."));
    assert.ok(full.includes("ONE shell command"));
    assert.ok(full.includes("&&"));
  });

  it("steers searches toward scoped rg rather than repo-wide Grep", () => {
    // agy's built-in Grep tool does not filter ignored folders like .venv.
    // Repo-wide searches hit internal deadlines and fail the whole session.
    // The policy directs models toward rg with a scoped path or glob instead.
    const full = withAgyPolicy("Find the bug.");
    assert.ok(full.includes("prefer the rg shell command over the Grep tool"));
    assert.ok(full.includes("never repo-wide"));
  });

  it("is idempotent", () => {
    assert.equal(withAgyPolicy(withAgyPolicy("x")), withAgyPolicy("x"));
  });

  it("workspacePolicy is empty with no directory, and idempotent with one", () => {
    assert.equal(workspacePolicy(undefined), "");
    assert.equal(withAgyPolicy("x"), `x\n\n${AGY_TOOL_POLICY}`);
    const withDir = withAgyPolicy("x", "/work/repo");
    assert.equal(withAgyPolicy(withDir, "/work/repo"), withDir);
  });

  it("P0: the workspace policy states the absolute directory and never says \"current working directory\"", () => {
    const full = withAgyPolicy("Do the thing.", "/work/repo");
    // The absolute path must be given explicitly, since relative paths in
    // file operations silently land in agy's scratch dir instead (P0 bug,
    // verified against the real binary).
    assert.ok(full.includes("/work/repo"));
    assert.match(full, /absolute path/i);
    // Verified: a prompt containing this exact phrase makes agy shell out to
    // pwd/readlink/ps to locate itself, all denied by the allow-list, which
    // fails the run. The policy text must never contain it.
    assert.ok(!full.toLowerCase().includes("current working directory"));
    assert.ok(!/\bpwd\b/.test(full));
  });

  it("the workspace policy also pins the working directory for shell commands", () => {
    // Verified against agy 1.1.19: `pwd` run from a prompt that does not name
    // the workspace returns the HOME directory, not the directory the runner
    // spawned agy in. Naming it in the prompt fixes it. Without this the file
    // writes land correctly while `npm test` runs in the wrong repository.
    const full = withAgyPolicy("Do the thing.", "/work/repo");
    assert.match(full, /shell command must also run/i);
    assert.match(full, /working directory/i);
    // The instruction is useless unless it carries the path.
    const afterCwdMention = full.slice(full.search(/shell command must also run/i));
    assert.ok(afterCwdMention.includes("/work/repo"));
  });

  it("ships a scoped allow-list and documents that deny is the floor", () => {
    assert.ok(AGY_SCOPED_ALLOWLIST.length > 0);
    for (const rule of AGY_SCOPED_ALLOWLIST) {
      assert.ok(rule.startsWith("command("), rule);
    }
    assert.ok(!AGY_SCOPED_ALLOWLIST.includes("--dangerously-skip-permissions"));
    assert.match(AGY_ALLOWLIST_DOC, /permissions\.deny is the only floor/);
    assert.ok(AGY_TOOL_POLICY.length > 0);
  });

  it("passes --dangerously-skip-permissions but never --sandbox", () => {
    const args = buildPrintArgs("do it");
    assert.ok(args.includes("--dangerously-skip-permissions"));
    // With the skip flag set, a sandbox that fails to start is auto-approved
    // as a bypass and the command runs unsandboxed. Without the flag agy
    // fails closed. Verified against agy 1.1.19, where the sandbox server does
    // not start at all on this machine. The two must not ship together until
    // a startup check can gate them.
    assert.ok(!args.includes("--sandbox"));
    // --print must stay last: it swallows the next token as its prompt.
    assert.equal(args[args.length - 2], "--print");
  });

  it("denyListPreflight refuses to launch without a floor", () => {
    // No settings at all.
    assert.match(
      denyListPreflight({ exists: false, deny: [], path: "/nowhere/settings.json" }) ?? "",
      /Refusing to run/,
    );
    // Settings present but no deny rules: the dangerous case, because the
    // skip-permissions flag then permits everything.
    const empty = denyListPreflight({ exists: true, deny: [], path: "/s.json" });
    assert.match(empty ?? "", /no permissions\.deny rules/);
    // A real deny list is the only thing that makes launching safe.
    assert.equal(denyListPreflight({ exists: true, deny: ["command(sudo)"], path: "/s.json" }), null);
  });

});

describe("workspace .geminiignore management", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTmpDir("agy-geminiignore");
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it("creates .geminiignore with default set when absent", () => {
    // Heavy directories like .venv cause agy Grep to hit deadline timeouts.
    // The runner ensures a root .geminiignore exists before executing prompts.
    const target = path.join(tmpDir, ".geminiignore");
    assert.equal(fs.existsSync(target), false);
    const created = ensureWorkspaceGeminiignore(tmpDir);
    assert.equal(created, true);
    assert.equal(fs.existsSync(target), true);
    const content = fs.readFileSync(target, "utf8");
    assert.equal(content, `${DEFAULT_GEMINIIGNORE.join("\n")}\n`);
  });

  it("leaves an existing .geminiignore untouched", () => {
    // User configuration must win over defaults. Modifying or merging user
    // ignore rules can corrupt custom setups, which is worse than the bug.
    const target = path.join(tmpDir, ".geminiignore");
    const userRules = ".custom-env/\nbuild-output/\n";
    fs.writeFileSync(target, userRules, "utf8");
    const created = ensureWorkspaceGeminiignore(tmpDir);
    assert.equal(created, false);
    assert.equal(fs.readFileSync(target, "utf8"), userRules);
  });

  it("ships a default set containing .venv/, node_modules/, and .git/", () => {
    // These heavy trees represent common paths that Grep should avoid walking.
    assert.ok(DEFAULT_GEMINIIGNORE.includes(".venv/"));
    assert.ok(DEFAULT_GEMINIIGNORE.includes("node_modules/"));
    assert.ok(DEFAULT_GEMINIIGNORE.includes(".git/"));
  });

  it("gracefully handles invalid or missing workspace directory paths", () => {
    assert.equal(ensureWorkspaceGeminiignore(undefined), false);
    assert.equal(ensureWorkspaceGeminiignore(""), false);
    assert.equal(ensureWorkspaceGeminiignore(path.join(tmpDir, "does-not-exist")), false);
  });

  it("createSession ensures .geminiignore is created when absent", async () => {
    const target = path.join(tmpDir, ".geminiignore");
    assert.equal(fs.existsSync(target), false);
    const client = createClient({ directory: tmpDir });
    await client.createSession({ title: "Session title" });
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.readFileSync(target, "utf8"), `${DEFAULT_GEMINIIGNORE.join("\n")}\n`);
  });

  it("createSession leaves existing .geminiignore untouched", async () => {
    const target = path.join(tmpDir, ".geminiignore");
    const userRules = "dist/\n";
    fs.writeFileSync(target, userRules, "utf8");
    const client = createClient({ directory: tmpDir });
    await client.createSession({ title: "Session title" });
    assert.equal(fs.readFileSync(target, "utf8"), userRules);
  });
});

describe("backend selection", () => {
  it("defaults to opencode", () => {
    setEnv({ OPENCODE_BACKEND: undefined });
    assert.equal(resolveBackendName(), "opencode");
  });

  it("selects agy, case-insensitively", () => {
    setEnv({ OPENCODE_BACKEND: "agy" });
    assert.equal(resolveBackendName(), "agy");
    setEnv({ OPENCODE_BACKEND: "AGY" });
    assert.equal(resolveBackendName(), "agy");
  });

  it("throws on unknown values", () => {
    setEnv({ OPENCODE_BACKEND: "codex" });
    assert.throws(() => resolveBackendName(), /Unknown OPENCODE_BACKEND/);
  });

  it("dispatches createClient per backend", async () => {
    setEnv({ OPENCODE_BACKEND: "agy" });
    const agyClient = backendCreateClient({ directory: "/tmp" });
    assert.equal(agyClient.backend, "agy");
    setEnv({ OPENCODE_BACKEND: "opencode" });
    const ocClient = backendCreateClient("http://127.0.0.1:4096");
    assert.equal(typeof ocClient.sendPrompt, "function");
    assert.equal(ocClient.backend, undefined);
  });
});

describe("effectiveSessionId", () => {
  let tmpDir;
  const workspace = "/test/agy-workspace";

  beforeEach(() => {
    tmpDir = createTmpDir();
    setupTestEnv(tmpDir);
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it("is a no-op for opencode-shaped responses", () => {
    upsertJob(workspace, { id: "j1", status: "running", opencodeSessionId: "sess-1" });
    const out = effectiveSessionId(workspace, "j1", "sess-1", { info: {}, parts: [] });
    assert.equal(out, "sess-1");
    assert.equal(loadState(workspace).jobs[0].opencodeSessionId, "sess-1");
  });

  it("persists a newly learned agy conversation_id", () => {
    upsertJob(workspace, { id: "j2", status: "running", opencodeSessionId: null });
    const out = effectiveSessionId(workspace, "j2", null, { agy: { conversation_id: "conv-9" } });
    assert.equal(out, "conv-9");
    assert.equal(loadState(workspace).jobs[0].opencodeSessionId, "conv-9");
  });

  it("keeps a known id unchanged", () => {
    const out = effectiveSessionId(workspace, "j3", "conv-9", { agy: { conversation_id: "conv-9" } });
    assert.equal(out, "conv-9");
  });
});

describe("autoHealAgyJob", () => {
  let tmpDir;
  const workspace = "/test/agy-heal";

  beforeEach(() => {
    tmpDir = createTmpDir();
    setupTestEnv(tmpDir);
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it("skips when the worker is still alive", async () => {
    const job = { id: "alive-1", backend: "agy", status: "running", pid: process.pid };
    const r = await autoHealAgyJob(workspace, job);
    assert.equal(r.action, "skip");
  });

  it("fails a dead worker with a stale timestamp", async () => {
    const job = {
      id: "dead-1",
      backend: "agy",
      status: "running",
      pid: 2_000_000_001,
      updatedAt: new Date(Date.now() - 600_000).toISOString(),
    };
    upsertJob(workspace, { ...job });
    const r = await autoHealAgyJob(workspace, job);
    assert.equal(r.action, "healed-failed");
    assert.match(r.details.errorMessage, /agy backend/);
    assert.equal(loadState(workspace).jobs[0].status, "failed");
  });

  it("dry-run reports without writing", async () => {
    const job = {
      id: "dead-2",
      backend: "agy",
      status: "running",
      pid: 2_000_000_001,
      updatedAt: new Date(Date.now() - 600_000).toISOString(),
    };
    const r = await autoHealAgyJob(workspace, job, { dryRun: true });
    assert.equal(r.action, "would-fail");
    assert.equal(loadState(workspace).jobs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// fake-agy integration
// ---------------------------------------------------------------------------

const FAKE_SCRIPT = `#!/usr/bin/env bash
trap "exit 143" TERM
echo "$@" >> "$AGY_FAKE_LOG"
ALL_ARGS=" $* "
has_flag() { [[ "$ALL_ARGS" == *" $1 "* ]]; }
if has_flag "--version"; then echo "9.9.9-test"; exit 0; fi
if [[ "$1" == "models" ]]; then printf 'model-a\\tModel A\\nmodel-b\\tModel B\\n'; exit 0; fi
CONV=""; PROMPT=""; PREV=""
for a in "$@"; do
  if [[ "$PREV" == "--conversation" ]]; then CONV="$a"; fi
  if [[ "$PREV" == "--print" ]]; then PROMPT="$a"; fi
  PREV="$a"
done
CID="\${CONV:-fresh-conv-123}"
if has_flag "stream-json"; then
  if [[ "$PROMPT" == *"MAKE-ERROR"* ]]; then
    echo "{\\"event\\":\\"init\\",\\"conversation_id\\":\\"conv-err-1\\",\\"init\\":{}}"
    echo "{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"conv-err-1\\",\\"status\\":\\"ERROR\\",\\"response\\":\\"\\",\\"error\\":\\"boom\\"}}"; exit 0
  fi
  if [[ "$PROMPT" == *"MAKE-CANCELED"* ]]; then
    echo "{\\"event\\":\\"init\\",\\"conversation_id\\":\\"conv-can-1\\",\\"init\\":{}}"
    echo "{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"conv-can-1\\",\\"status\\":\\"CANCELED\\",\\"response\\":\\"\\"}}"; exit 0
  fi
  if [[ "$PROMPT" == *"MAKE-NONZERO-JSON"* ]]; then
    # Non-zero exit but a valid JSON body still on stdout - must NOT be
    # treated as "exited with no output"; the status field decides.
    echo "{\\"event\\":\\"init\\",\\"conversation_id\\":\\"conv-nz-1\\",\\"init\\":{}}"
    echo "{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"conv-nz-1\\",\\"status\\":\\"ERROR\\",\\"response\\":\\"\\",\\"error\\":\\"boom-nz\\"}}"; exit 3
  fi
  if [[ "$PROMPT" == *"MAKE-RECORDED-PAYLOAD"* ]]; then
    echo '{"event":"init","conversation_id":"b1b8bb65-394f-47ab-8ba2-9d6953511132","init":{}}'
    echo '{"event":"result","result":{"conversation_id":"b1b8bb65-394f-47ab-8ba2-9d6953511132","status":"ERROR","response":"### A) ... Result: Success ...\\n### C) ... Result: Error ...","error":"declaring permissions: cortex tool write_to_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) ./probe_c_delete_me.py must be an absolute path: path is not absolute","duration_seconds":14.45,"num_turns":1}}'; exit 0
  fi
  if [[ "$PROMPT" == *"MAKE-TOOL"* ]]; then
    echo "{\\"event\\":\\"init\\",\\"conversation_id\\":\\"$CID\\",\\"init\\":{\\"cwd\\":\\"/workspace\\"}}"
    echo "{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"conversation_id\\":\\"$CID\\",\\"step_index\\":1,\\"state\\":\\"ACTIVE\\",\\"step_type\\":\\"tool\\",\\"tool_name\\":\\"run_command\\",\\"tool_info\\":{\\"name\\":\\"run_command\\",\\"parameters\\":{\\"CommandLine\\":\\"git status\\"}}}}"
    echo "{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"conversation_id\\":\\"$CID\\",\\"step_index\\":1,\\"state\\":\\"DONE\\",\\"step_type\\":\\"tool\\",\\"tool_name\\":\\"run_command\\",\\"duration_seconds\\":0.05,\\"tool_info\\":{\\"name\\":\\"run_command\\",\\"parameters\\":{\\"CommandLine\\":\\"git status\\"},\\"output\\":\\"clean\\"}}}"
    echo "{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"conversation_id\\":\\"$CID\\",\\"step_index\\":2,\\"state\\":\\"ACTIVE\\",\\"step_type\\":\\"agent_response\\",\\"text_delta\\":\\"FAKE-TOOL-RESPONSE\\"}}"
    echo "{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"$CID\\",\\"status\\":\\"SUCCESS\\",\\"response\\":\\"FAKE-TOOL-RESPONSE\\",\\"duration_seconds\\":0.1,\\"num_turns\\":1,\\"usage\\":{}}}"
    exit 0
  fi
  if [[ "$PROMPT" == *"MAKE-SLEEP"* ]]; then
    if [[ -n "$AGY_FAKE_PIDFILE" ]]; then echo $$ > "$AGY_FAKE_PIDFILE"; fi
    # exec so SIGTERM lands directly on sleep (a trapped bash would wait it out).
    exec sleep 30
  fi
  echo "{\\"event\\":\\"init\\",\\"conversation_id\\":\\"$CID\\",\\"init\\":{\\"cwd\\":\\"/workspace\\"}}"
  echo "{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"conversation_id\\":\\"$CID\\",\\"step_index\\":0,\\"state\\":\\"DONE\\",\\"step_type\\":\\"user_input\\"}}"
  echo "{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"conversation_id\\":\\"$CID\\",\\"step_index\\":1,\\"state\\":\\"ACTIVE\\",\\"step_type\\":\\"agent_response\\",\\"text_delta\\":\\"FAKE-RESPONSE\\"}}"
  echo "{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"$CID\\",\\"status\\":\\"SUCCESS\\",\\"response\\":\\"FAKE-RESPONSE\\",\\"duration_seconds\\":0.1,\\"num_turns\\":1,\\"usage\\":{}}}"
  exit 0
fi
if [[ "$PROMPT" == *"MAKE-ERROR"* ]]; then
  echo '{"conversation_id":"conv-err-1","status":"ERROR","response":"","error":"boom"}'; exit 0
fi
if [[ "$PROMPT" == *"MAKE-CANCELED"* ]]; then
  echo '{"conversation_id":"conv-can-1","status":"CANCELED","response":""}'; exit 0
fi
if [[ "$PROMPT" == *"MAKE-NONZERO-JSON"* ]]; then
  # Non-zero exit but a valid JSON body still on stdout - must NOT be
  # treated as "exited with no output"; the status field decides.
  echo '{"conversation_id":"conv-nz-1","status":"ERROR","response":"","error":"boom-nz"}'; exit 3
fi
if [[ "$PROMPT" == *"MAKE-RECORDED-PAYLOAD"* ]]; then
  echo '{"conversation_id":"b1b8bb65-394f-47ab-8ba2-9d6953511132","status":"ERROR","response":"### A) ... Result: Success ...\\n### C) ... Result: Error ...","error":"declaring permissions: cortex tool write_to_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) ./probe_c_delete_me.py must be an absolute path: path is not absolute","duration_seconds":14.45,"num_turns":1}'; exit 0
fi
if [[ "$PROMPT" == *"MAKE-SLEEP"* ]]; then
  if [[ -n "$AGY_FAKE_PIDFILE" ]]; then echo $$ > "$AGY_FAKE_PIDFILE"; fi
  # exec so SIGTERM lands directly on sleep (a trapped bash would wait it out).
  exec sleep 30
fi
echo "{\\"conversation_id\\":\\"$CID\\",\\"status\\":\\"SUCCESS\\",\\"response\\":\\"FAKE-RESPONSE\\",\\"duration_seconds\\":0.1,\\"num_turns\\":1,\\"usage\\":{}}"
exit 0
`;

describe("agy client against fake binary", () => {
  let tmpDir;
  let fakeHome;
  let fakeBin;
  let fakeLog;
  let fakePidFile;

  beforeEach(() => {
    tmpDir = createTmpDir("agy-fake");
    setupTestEnv(tmpDir);
    fakeHome = path.join(tmpDir, "home");
    fakeBin = path.join(tmpDir, "bin");
    fs.mkdirSync(path.join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      "fake-token",
      "utf8",
    );
    // sendPrompt refuses to launch without a deny list, since it passes
    // --dangerously-skip-permissions. Give the fake home a minimal one so the
    // transport tests exercise the transport rather than the preflight; the
    // preflight has its own tests below.
    fs.writeFileSync(
      path.join(fakeHome, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ permissions: { allow: ["command(ls)"], deny: ["command(sudo)"] } }),
      "utf8",
    );
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "agy"), FAKE_SCRIPT, { mode: 0o755 });
    fakeLog = path.join(tmpDir, "agy-args.log");
    fakePidFile = path.join(tmpDir, "agy-sleep.pid");
    setEnv({
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      HOME: fakeHome,
      AGY_FAKE_LOG: fakeLog,
      AGY_FAKE_PIDFILE: fakePidFile,
      AGY_PRINT_TIMEOUT_MS: undefined,
      OPENCODE_PROMPT_TIMEOUT_MS: undefined,
      AGY_MODEL: undefined,
      AGY_EFFORT: undefined,
    });
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  const loggedArgs = () => fs.readFileSync(fakeLog, "utf8");

  it("capability check passes with fake binary + token", async () => {
    const cap = await getCapability();
    assert.equal(cap.ok, true);
    assert.equal(cap.version, "9.9.9-test");
    assert.equal(cap.authPresent, true);
    assert.equal(await isServerRunning(), true);
  });

  it("capability fails without a token", async () => {
    fs.rmSync(path.join(fakeHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"));
    const cap = await getCapability();
    assert.equal(cap.ok, false);
    assert.equal(cap.authPresent, false);
    assert.equal(await isServerRunning(), false);
    await assert.rejects(() => ensureServer(), /auth token/);
  });

  it("ensureServer/connect return the cli pseudo-url", async () => {
    const s = await ensureServer();
    assert.equal(s.url, "agy:cli");
    const c = await connect({ cwd: "/tmp" });
    assert.equal(c.serverInfo.url, "agy:cli");
    assert.equal(c.backend, "agy");
  });

  it("createSession is a no-op returning null id", async () => {
    const client = createClient({ directory: "/tmp" });
    const sess = await client.createSession({ title: "x" });
    assert.equal(sess.id, null);
  });

  it("sendPrompt returns opencode-shaped text plus agy metadata", async () => {
    const client = createClient({ directory: "/tmp" });
    const res = await client.sendPrompt(null, "hello-dire", {});
    assert.equal(res.parts[0].type, "text");
    assert.equal(res.parts[0].text, "FAKE-RESPONSE");
    assert.equal(res.info.role, "assistant");
    assert.equal(res.agy.conversation_id, "fresh-conv-123");
    assert.equal(res.agy.status, "SUCCESS");
  });

  it("sendPrompt forwards stream-json events to onProgress", async () => {
    const client = createClient({ directory: "/tmp" });
    const events = [];
    const res = await client.sendPrompt(null, "MAKE-TOOL please", {
      onProgress: (line) => events.push(line),
    });
    assert.equal(res.agy.status, "SUCCESS");
    assert.equal(res.parts[0].text, "FAKE-TOOL-RESPONSE");
    assert.ok(events.length >= 3);
    assert.ok(events.some((e) => e.includes("session started")));
    assert.ok(events.some((e) => e.includes("tool: run_command (git status)")));
    assert.ok(events.some((e) => e.includes("tool: run_command completed (0.05s)")));
    assert.ok(events.some((e) => e.includes("agent responding")));
  });

  it("sendPrompt resumes via --conversation when a session id is given", async () => {
    const client = createClient({ directory: "/tmp" });
    const res = await client.sendPrompt("conv-resume-7", "again", {});
    assert.equal(res.agy.conversation_id, "conv-resume-7");
    assert.ok(loggedArgs().includes("--conversation"));
    assert.ok(loggedArgs().includes("conv-resume-7"));
  });

  it("sendPrompt throws an actionable error on ERROR status", async () => {
    const client = createClient({ directory: "/tmp" });
    const err = await client.sendPrompt(null, "MAKE-ERROR please", {}).then(
      () => { throw new Error("should have thrown"); },
      (e) => e,
    );
    assert.match(err.message, /ERROR/);
    assert.match(err.message, /boom/);
    assert.match(err.message, /conv-err-1/);
  });

  it("sendPrompt treats a non-zero exit WITH a valid JSON body as a parseable result, not \"no output\"", async () => {
    // The fake binary always exits 0 on print runs elsewhere in this file, so
    // the `exitCode !== 0 && !stdout.trim()` branch never runs the "has
    // stdout" side. Real agy can exit non-zero while still printing a JSON
    // body (e.g. status ERROR); that must fall through to parsePrintResult
    // and toFailure, not be swallowed as an opaque "exited N with no output".
    const client = createClient({ directory: "/tmp" });
    const err = await client.sendPrompt(null, "MAKE-NONZERO-JSON please", {}).then(
      () => { throw new Error("should have thrown"); },
      (e) => e,
    );
    assert.match(err.message, /ERROR/);
    assert.match(err.message, /boom-nz/);
    assert.equal(err.conversationId, "conv-nz-1");
    assert.notEqual(err.agyStatus, "EXIT_NONZERO");
  });

  it("sendPrompt treats status ERROR with non-empty response as completed with warning", async () => {
    const client = createClient({ directory: "/tmp" });
    const res = await client.sendPrompt(null, "MAKE-RECORDED-PAYLOAD please", {});
    assert.equal(res.agy.status, "ERROR");
    assert.equal(res.agy.conversation_id, "b1b8bb65-394f-47ab-8ba2-9d6953511132");
    assert.match(res.parts[0].text, /Result: Success/);
    assert.match(res.parts[0].text, /Result: Error/);
    assert.match(res.warning, /must be an absolute path: path is not absolute/);
    assert.equal(res.agy.warning, res.warning);
  });

  it("sendPrompt flags CANCELED as a likely permission denial", async () => {
    const client = createClient({ directory: "/tmp" });
    const err = await client.sendPrompt(null, "MAKE-CANCELED please", {}).then(
      () => { throw new Error("should have thrown"); },
      (e) => e,
    );
    assert.equal(err.deniedLikely, true);
    assert.match(err.message, /permissions\.allow/);
  });

  it("client-side timeout kills a hung child", async () => {
    const client = createClient({ directory: "/tmp" });
    const err = await client.sendPrompt(null, "MAKE-SLEEP please", { timeoutMs: 400 }).then(
      () => { throw new Error("should have thrown"); },
      (e) => e,
    );
    assert.match(err.message, /no output|UNKNOWN/);
  });

  it("abortSession kills an in-flight prompt", async () => {
    const client = createClient({ directory: "/tmp" });
    const pending = client.sendPrompt(null, "MAKE-SLEEP please", { timeoutMs: 60_000 });
    // Give the fake time to spawn before aborting.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await client.abortSession(null), true);
    await assert.rejects(() => pending);
    assert.equal(await client.abortSession("no-such-conv"), false);
  });

  it("F1: aborting a resumed conversation kills the LIVE process, not a stale dead entry", async () => {
    const client = createClient({ directory: "/tmp" });

    // 1. Complete a run so a conversation id is learned (fake mints
    // "fresh-conv-123" for a fresh conversation).
    const first = await client.sendPrompt(null, "hello", {});
    const convId = first.agy.conversation_id;
    assert.equal(convId, "fresh-conv-123");

    // 2. Resume that same conversation with a long-running prompt.
    const pending = client.sendPrompt(convId, "MAKE-SLEEP please", { timeoutMs: 60_000 });
    // Give the fake time to spawn and record its pid before aborting.
    await new Promise((r) => setTimeout(r, 500));
    const pid = Number(fs.readFileSync(fakePidFile, "utf8").trim());
    assert.ok(pid > 0);
    // Confirm it's actually alive before we touch it.
    assert.doesNotThrow(() => process.kill(pid, 0));

    // 3. Abort by conversation id, exactly as backend.mjs/handleCancel do.
    const aborted = await client.abortSession(convId);
    assert.equal(aborted, true);
    await assert.rejects(() => pending);

    // The bug (F1): the old code re-indexed the FIRST run's already-dead
    // entry under conv:<id> and never removed it, so findEntry("conv:<id>")
    // returned that stale dead entry ahead of the live one under
    // req:<id> and abortSession killed nothing real. Assert the real,
    // live sleep process is actually gone.
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  it("listProviders shapes agy models like opencode /provider", async () => {
    const client = createClient({ directory: "/tmp" });
    const providers = await client.listProviders();
    assert.deepEqual(providers.connected, ["model-a", "model-b"]);
    assert.equal(providers.all[0].name, "Model A");
  });

  it("getSessionDiff reuses git and returns {files:[{path}]}, including untracked new files (F4)", async () => {
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "one\nmodified\n", "utf8");
    // b.txt is a brand-new file, never `git add`ed — `git diff --name-only`
    // alone would never report it (that was the bug: a task that only
    // creates files showed as an empty diff). getSessionDiff must include it.
    fs.writeFileSync(path.join(repo, "b.txt"), "two\n", "utf8");
    const client = createClient({ directory: repo });
    const diff = await client.getSessionDiff("ignored");
    const paths = diff.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["a.txt", "b.txt"]);
  });

  it("readAgySettings parses the allow and deny lists", async () => {
    const settingsPath = path.join(fakeHome, ".gemini", "antigravity-cli", "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ["command(ls)", "command(cat)"], deny: ["command(sudo)", 7] },
      }),
      "utf8",
    );
    const s = readAgySettings();
    assert.equal(s.exists, true);
    assert.deepEqual(s.allow, ["command(ls)", "command(cat)"]);
    // Non-string entries are dropped rather than trusted as rules. The deny
    // list is the floor under --dangerously-skip-permissions, so a malformed
    // entry must not be counted as one.
    assert.deepEqual(s.deny, ["command(sudo)"]);
  });

  it("__test exposes the resolved print timeout", () => {
    setEnv({ AGY_PRINT_TIMEOUT_MS: "12345" });
    assert.equal(__test.printTimeoutMs(), 12345);
    assert.ok(__test.settingsDir().endsWith(path.join(".gemini", "antigravity-cli")));
  });

  it("__test.needsWindowsShell: only true on win32 for .cmd/.bat/.ps1 binaries", () => {
    // process.platform can't be reassigned directly; needsWindowsShell
    // already short-circuits to false off win32, so this only exercises
    // the non-win32 branch when tests run on Linux/macOS (the CI/dev
    // platform here). The extension check itself is platform-independent.
    assert.equal(__test.needsWindowsShell("agy"), false);
    if (process.platform !== "win32") {
      assert.equal(__test.needsWindowsShell("agy.cmd"), false);
    }
  });

  it("sendPrompt ensures .geminiignore exists before sending prompt", async () => {
    // Resumed sessions skip createSession entirely, so sendPrompt must
    // guarantee .geminiignore exists before the child process is spawned.
    const repoDir = path.join(tmpDir, "work-sendprompt-absent");
    fs.mkdirSync(repoDir, { recursive: true });
    const target = path.join(repoDir, ".geminiignore");
    assert.equal(fs.existsSync(target), false);
    const client = createClient({ directory: repoDir });
    await client.sendPrompt(null, "run task", {});
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.readFileSync(target, "utf8"), `${DEFAULT_GEMINIIGNORE.join("\n")}\n`);
  });

  it("sendPrompt leaves existing .geminiignore untouched", async () => {
    const repoDir = path.join(tmpDir, "work-sendprompt-present");
    fs.mkdirSync(repoDir, { recursive: true });
    const target = path.join(repoDir, ".geminiignore");
    const customContent = "my-vendor/\n";
    fs.writeFileSync(target, customContent, "utf8");
    const client = createClient({ directory: repoDir });
    await client.sendPrompt(null, "run task", {});
    assert.equal(fs.readFileSync(target, "utf8"), customContent);
  });
});

// ---------------------------------------------------------------------------
// F5: opencode `model` field invariant (review's "single most valuable
// missing test"). opencode-companion.mjs now passes `model: options.model`
// into sendPrompt for both the foreground and worker task paths, and
// opencode-server.mjs's sendPrompt does `if (opts.model) body.model =
// opts.model;`. Pin both directions directly against the request body so
// deleting/breaking that plumbing fails a test, not just a manual check.
// ---------------------------------------------------------------------------

describe("opencode sendPrompt model field (F5 invariant)", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function installFetchCapture(capture) {
    global.fetch = async (url, init) => {
      if (init?.method === "POST" && String(url).endsWith("/message")) {
        capture.body = JSON.parse(init.body);
        return {
          ok: true,
          headers: { get: () => "application/json" },
          json: async () => ({
            info: { id: "msg-1", role: "assistant", time: { completed: Date.now() }, finish: "stop" },
            parts: [{ type: "text", text: "hi" }],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    };
  }

  it("omits the model key from the request body when --model is absent", async () => {
    const capture = {};
    installFetchCapture(capture);
    const client = opencodeCreateClient("http://127.0.0.1:4096");
    await client.sendPrompt("sess-1", "hi", {});
    assert.ok(capture.body, "expected sendPrompt to POST a body");
    assert.equal("model" in capture.body, false);
  });

  it("includes the given model in the request body when --model is supplied", async () => {
    const capture = {};
    installFetchCapture(capture);
    const client = opencodeCreateClient("http://127.0.0.1:4096");
    await client.sendPrompt("sess-1", "hi", { model: "claude-x" });
    assert.equal(capture.body.model, "claude-x");
  });
});

// ---------------------------------------------------------------------------
// Handler-level effectiveSessionId coverage: the unit tests above cover
// effectiveSessionId() in isolation, but nothing exercised the actual call
// site inside opencode-companion.mjs's handleTask - deleting that call site
// would still leave every other test green. Drive the real CLI entry point
// as a subprocess (as an end user would) against the fake agy binary and
// assert the learned conversation id actually lands in the job's persisted
// state.
// ---------------------------------------------------------------------------

describe("handler-level: agy task persists the learned session id", () => {
  let tmpDir;
  let workDir;
  let dataDir;
  let fakeHome;
  let fakeBin;

  beforeEach(() => {
    // stateRoot() (lib/state.mjs) only trusts CLAUDE_PLUGIN_DATA when its
    // basename matches /opencode/i (to avoid leaking state into an
    // unrelated plugin's data dir); the data dir name must contain
    // "opencode" for that check to pass when running from repo source.
    tmpDir = createTmpDir("agy-handler");
    workDir = path.join(tmpDir, "work");
    dataDir = path.join(tmpDir, "opencode-companion-data");
    fs.mkdirSync(workDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    fakeHome = path.join(tmpDir, "home");
    fs.mkdirSync(path.join(fakeHome, ".gemini", "antigravity-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      "fake-token",
      "utf8",
    );
    // sendPrompt's deny-list preflight refuses to launch without one.
    fs.writeFileSync(
      path.join(fakeHome, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ permissions: { allow: ["command(ls)"], deny: ["command(sudo)"] } }),
      "utf8",
    );

    fakeBin = path.join(tmpDir, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "agy"), FAKE_SCRIPT, { mode: 0o755 });
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it("handleTask's foreground path persists response.agy.conversation_id via effectiveSessionId", () => {
    execFileSync(
      process.execPath,
      [COMPANION_SCRIPT, "task", "--write", "do something simple"],
      {
        cwd: workDir,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          HOME: fakeHome,
          OPENCODE_BACKEND: "agy",
          CLAUDE_PLUGIN_DATA: dataDir,
          OPENCODE_COMPANION_SESSION_ID: "handler-test-session",
          AGY_FAKE_LOG: path.join(tmpDir, "agy-args.log"),
        },
        encoding: "utf8",
      },
    );

    // loadState() resolves the state root from *this* process's env, not
    // the subprocess's — mirror the CLAUDE_PLUGIN_DATA we gave the
    // subprocess so we read back the same state dir it wrote to (restored
    // by the file-level env-save/restore beforeEach/afterEach).
    setEnv({ CLAUDE_PLUGIN_DATA: dataDir });
    const state = loadState(workDir);
    assert.equal(state.jobs.length, 1);
    const job = state.jobs[0];
    assert.equal(job.status, "completed");
    // This is the field effectiveSessionId() writes; the fake binary mints
    // "fresh-conv-123" for a brand-new conversation. If the call site in
    // handleTask were deleted, this would stay null (createSession's agy
    // no-op) and only this test would catch it.
    assert.equal(job.opencodeSessionId, "fresh-conv-123");
  });
});
