#!/usr/bin/env node

// PostToolUse hook: watches for rescue-task dispatch in tool responses and
// injects a reminder that tells Claude to (a) start/refresh a Monitor
// covering the new task id(s), and (b) fetch + summarize the companion
// `result` payload when Monitor reports a terminal state.
//
// Why in a hook: the main Claude thread has no built-in way to observe
// background codex/opencode tasks. Without this, dispatching a rescue is
// fire-and-forget — the user has to ask for progress manually. The hook
// makes every rescue dispatch automatically get monitored and reported
// on, matching the UX of in-process subagents.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Companion task ids come from generateJobId in lib/state.mjs:
//   `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
// so a genuine id is `task-` + timestamp part + random part, e.g.
// `task-mo3k1x2p-a7f9qs`. This was once matched with open-ended quantifiers
// (`{6,}`/`{4,}`), which also matched ordinary words — e.g. the companion's
// own `"task-resume-candidate"` subcommand key (`resume` + `candidate`)
// false-positived on a plain read of the plugin source. The quantifiers
// below are pinned to the generator's real output:
// - timestamp: Date.now().toString(36) is 8 chars from 1972-06-25 (36^7 ms)
//   until 2059-05-25 (36^8 ms), then 9 chars. {8,9} keeps matching across
//   that rollover.
// - random: slice(2, 8) of a base-36 float is 6 chars in practice, but a
//   short exact expansion (e.g. (0.5).toString(36) === "0.i") can yield
//   fewer, so {1,6} tolerates a freak short id instead of silently dropping
//   a real job.
const TASK_ID = "task-[a-z0-9]{8,9}-[a-z0-9]{1,6}";

// Ids are extracted ONLY from the two lines the companion actually emits to
// announce/report a job — never from free text. This anchoring (not the id
// shape above) is the primary guard: a well-formed id mentioned in prose —
// e.g. an example id quoted in a dispatch prompt — is indistinguishable from
// one that was really dispatched, so no shape check alone can reject it. The
// tight quantifiers are defence in depth; the anchors do the real work:
// - background dispatch (Bash path: the orchestrator calls the companion
//   directly), from opencode-companion.mjs:
//     `OpenCode task started in background: <id>`
// - rendered result header (Agent path: the dispatch happens inside the
//   opencode-rescue subagent's own Bash calls, which the main thread never
//   sees — the subagent's returned text carries the `## Job: <id>` header
//   from renderResult in lib/render.mjs). Both anchors are required; the
//   dispatch line alone would break the Agent matcher entirely.
// NOTE: renderStatus (`companion status`) emits neither line — its ids sit
// in `- **<id>**` bullets — so status output can never re-arm a Monitor.
// The old OPENCODE_MARKERS pre-check (substring markers like the companion
// filename) is gone: both anchors above are line-pinned to
// companion-emitted formats, and the markers proved unable to distinguish
// "reading the plugin" from "using the plugin", so they were dead weight.
const DISPATCH_RE = new RegExp(`^.*OpenCode task started in background:\\s*(${TASK_ID})\\s*$`, "gm");
const JOB_HEADER_RE = new RegExp(`^## Job:\\s*(${TASK_ID})\\s*$`, "gm");

// Terminal states mirror both the monitor loop's `case` in
// buildMonitorScript below and handleWaitAndResult's terminalStatuses in
// opencode-companion.mjs.
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export function extractTaskIds(text) {
  if (!text) return [];
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  // Fresh dispatches are always worth monitoring.
  for (const m of text.matchAll(DISPATCH_RE)) add(m[1]);
  // Rendered result blocks: skip blocks whose own `- **Status**:` line says
  // the job is already terminal — re-arming a Monitor there would only
  // re-report a result the thread already holds (the first poll would see
  // the terminal state and exit). Fail open when no status line is
  // parseable, so the Agent path can never silently stop monitoring a live
  // job.
  for (const m of text.matchAll(JOB_HEADER_RE)) {
    const id = m[1];
    if (seen.has(id)) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 500);
    const st = after.match(/^[ \t]*-[ \t]*\*\*Status\*\*:[ \t]*([A-Za-z]+)/m);
    if (st && TERMINAL_STATES.has(st[1].toLowerCase())) continue;
    add(id);
  }
  return ids;
}

function extractResponseText(response) {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (typeof response === "object") {
    if (typeof response.result === "string") return response.result;
    if (typeof response.content === "string") return response.content;
    return JSON.stringify(response);
  }
  return String(response);
}

function resolveCompanionPath() {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), "opencode-companion.mjs");
}

function buildMonitorScript(ids, companionPath) {
  const quoted = ids.map((id) => `"${id}"`).join(" ");
  // The poll loop runs inside a Monitor child process:
  //  - polls companion status JSON per id every 30s
  //  - emits an event when status/phase OR the latest progressPreview log
  //    line changes, so long-running tasks surface intermediate activity
  //  - emits a heartbeat every HEARTBEAT_POLLS ticks (default 10 = ~5min)
  //    so the user sees signs of life even when nothing has changed
  //  - on terminal state, fetches `companion result <id>`, truncates, and
  //    prints a multi-line summary so the main thread gets a single batched
  //    event carrying the full report
  //  - exits when every tracked id is terminal
  return [
    "set -u",
    `COMP=${JSON.stringify(companionPath)}`,
    `IDS=(${quoted})`,
    "RESULT_MAX_CHARS=${OPENCODE_MONITOR_RESULT_CHARS:-1500}",
    "HEARTBEAT_POLLS=${OPENCODE_MONITOR_HEARTBEAT_POLLS:-10}",
    "MAX_POLLS=${OPENCODE_MONITOR_MAX_POLLS:-120}",
    "declare -A prev",
    "declare -A hb",
    "declare -A terminal",
    "declare -A last_st",
    "declare -A last_phase",
    "polls=0",
    'for id in "${IDS[@]}"; do prev[$id]=""; hb[$id]=0; terminal[$id]=0; last_st[$id]="unknown"; last_phase[$id]=""; done',
    "while true; do",
    "  polls=$((polls + 1))",
    "  all_done=1",
    '  for id in "${IDS[@]}"; do',
    '    json=$(node "$COMP" status "$id" --json 2>/dev/null || printf "{}")',
    "    fields=$(printf '%s' \"$json\" | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{try{const j=JSON.parse(s);const jb=j.job||{};const prog=String(jb.progressPreview||\"\").split(\"\\n\").filter(Boolean);const last=(prog[prog.length-1]||\"\").replace(/[|\\r\\n]/g,\" \").slice(0,200);process.stdout.write([jb.status||\"unknown\",jb.phase||\"\",jb.elapsed||\"\",last].join(\"|\"))}catch(e){process.stdout.write(\"parse-err|||\")}})')",
    "    IFS='|' read -r st phase elapsed last <<< \"$fields\"",
    '    last_st[$id]="$st"',
    '    last_phase[$id]="$phase"',
    '    sig="${st}/${phase}|${last}"',
    '    if [ "$sig" != "${prev[$id]}" ]; then',
    '      ts=$(date +%H:%M:%S)',
    '      if [ -n "$last" ]; then',
    '        echo "[$ts] opencode $id: $st/$phase (elapsed $elapsed) — $last"',
    "      else",
    '        echo "[$ts] opencode $id: $st/$phase (elapsed $elapsed)"',
    "      fi",
    '      prev[$id]="$sig"',
    "      hb[$id]=0",
    "    else",
    '      hb[$id]=$(( ${hb[$id]} + 1 ))',
    '      if [ "${hb[$id]}" -ge "$HEARTBEAT_POLLS" ]; then',
    '        ts=$(date +%H:%M:%S)',
    '        echo "[$ts] opencode $id: heartbeat — still $st/$phase (elapsed $elapsed)"',
    "        hb[$id]=0",
    "      fi",
    "    fi",
    '    case "$st" in',
    "      completed|failed|cancelled)",
    '        if [ "${terminal[$id]}" -eq 0 ]; then',
    '          result=$(node "$COMP" result "$id" 2>/dev/null || true)',
    "          # Truncate defensively so Monitor output stays bounded.",
    '          summary=$(printf "%s" "$result" | head -c "$RESULT_MAX_CHARS")',
    '          ts=$(date +%H:%M:%S)',
    '          echo "[$ts] opencode $id TERMINAL=$st — result summary:"',
    '          echo "--- result-begin $id ---"',
    '          printf "%s" "$summary"',
    '          echo ""',
    '          echo "--- result-end $id ---"',
    "          terminal[$id]=1",
    "        fi",
    "        ;;",
    '      *) all_done=0 ;;',
    "    esac",
    "  done",
    "  if [ $all_done -eq 1 ]; then",
    "    echo \"[$(date +%H:%M:%S)] opencode: all tracked tasks terminal — exiting monitor\"",
    "    break",
    "  fi",
    '  if [ "$polls" -ge "$MAX_POLLS" ]; then',
    '    for id in "${IDS[@]}"; do',
    '      if [ "${terminal[$id]}" -eq 0 ]; then',
    '        st="${last_st[$id]}"',
    '        phase="${last_phase[$id]}"',
    '        ts=$(date +%H:%M:%S)',
    '        echo "[$ts] opencode $id TERMINAL=timeout — monitor gave up after $polls polls (last status: $st/$phase). Run companion status/result manually."',
    "        terminal[$id]=1",
    "      fi",
    "    done",
    "    break",
    "  fi",
    "  sleep 30",
    "done",
  ].join("\n");
}

function buildReminder(ids, script) {
  const idList = ids.join(", ");
  return [
    "<opencode-rescue-auto-monitor>",
    `You just dispatched ${ids.length} opencode rescue task(s): ${idList}.`,
    "",
    "Before you respond to the user, start a persistent Monitor so this session can observe task completion automatically. Use the `Monitor` tool:",
    "",
    '- description: "opencode rescue task state"',
    "- persistent: true",
    "- timeout_ms: 3600000",
    "- command: the shell loop below, verbatim",
    "",
    "```bash",
    script,
    "```",
    "",
    "Behavior contract — follow this without being asked:",
    "1. If a Monitor is already running in this session covering other task ids, stop it (`TaskStop`) and start a new one whose IDS array is the union of all currently-running rescue task ids. One Monitor per session.",
    "2. The Monitor script above already fetches `companion result <id>` and emits the summary inline on terminal state — each terminal event carries the full result block between `--- result-begin ---` and `--- result-end ---` markers. You do NOT need to run a follow-up Bash call to get the result; just read the Monitor event and surface a short summary of what the rescue task did (or failed at) to the user.",
    "3. If the user explicitly asked you to skip monitoring, do nothing here.",
    "</opencode-rescue-auto-monitor>",
  ].join("\n");
}

function main() {
  const input = readHookInput();
  const toolName = input.tool_name || "";
  // Rescue dispatch happens through the Agent tool wrapper; main thread may
  // also call companion directly via Bash. Ignore other tools.
  if (toolName !== "Agent" && toolName !== "Bash") return;

  const response = extractResponseText(input.tool_response);
  if (!response) return;

  const ids = extractTaskIds(response);
  if (ids.length === 0) return;

  const companionPath = resolveCompanionPath();
  const script = buildMonitorScript(ids, companionPath);
  const additionalContext = buildReminder(ids, script);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext,
      },
    }),
  );
}

try {
  main();
} catch {
  // Best-effort — never block tool use on hook failure.
  process.exit(0);
}
