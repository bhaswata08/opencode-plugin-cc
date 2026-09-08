---
name: opencode-runtime
description: Internal helper contract for calling the opencode-companion runtime from Claude Code
user-invocable: false
---

# OpenCode Runtime

Use this skill only inside the `opencode:opencode-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task "<raw arguments>"`

Default dispatch pattern — **dispatch-and-poll loop**:

1. `task --background --write "<prompt>"` → capture task-id (grep from stdout).
2. Multiple `status <task-id> --json` polls (each a short Bash call, `sleep 30 && node ... status`).
3. Once `status` is terminal (`completed` / `failed` / `cancelled`), final `result <task-id>` → return that stdout unchanged.

Do not use `tail -f` on the companion log file as a substitute for polling. The Bash tool caps at 10 minutes per call and the tail approach produces a vague fallback string when the task runs longer. The status-poll loop uses multiple short Bash calls that each fit well under the cap.

Execution rules:

- The rescue subagent is a forwarder, not an orchestrator. Its only work is the dispatch-and-poll loop plus returning the final `result` stdout.
- Prefer the helper over hand-rolled `git`, direct OpenCode CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `cancel`, or `clear` from the subagent. `status` and `result` are permitted only as part of the poll loop.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `opencode-prompting` skill to rewrite the user's request into a tighter OpenCode prompt before the `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--agent` unset unless the user explicitly requests a specific agent (build or plan).
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.

Command selection:

- Use exactly one `task` invocation per rescue handoff. Follow it with status polls and one final `result` call.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`. The dispatch-and-poll loop always uses `--background` at the companion level internally.
- If the forwarded request includes `--model`, pass it through to `task`.
- If the forwarded request includes `--agent`, pass it through to `task`.
- If the forwarded request includes `--backend`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.

Flag handling (since 1.10.0-agy):

- `task` rejects any `--flag` it does not declare, printing the offending flag
  and the accepted list, and exits non-zero. It used to fold an unrecognised flag
  into the prompt and run anyway, so a stripping mistake became the task text and
  spent quota on nothing. That mistake is now a loud failure instead of a silent
  one. The accepted flags are `--agent`, `--backend`, `--background`, `--fresh`,
  `--model`, `--resume-last`, `--task-file`, `--wait`, `--write`.
- Because of that, put `--` between the flags and the prompt whenever the prompt
  might begin with a dash. A prompt like `"--verbose should be added"` is a single
  argument that starts with `--`, so without the separator it is read as an unknown
  flag and the dispatch fails. Everything after `--` is prompt text.
- For a prompt long enough to be awkward as a shell argument, write it to a file
  and pass `--task-file <path>`. The companion reads it as UTF-8 and treats it
  exactly as typed text. It cannot be combined with positional prompt text, and it
  errors on a missing, unreadable or empty file.

Safety rules:

- Default to write-capable OpenCode work in `opencode:opencode-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, fetch results outside the dispatch-and-poll loop, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the final `result` command exactly as-is.
- If the Bash calls fail or OpenCode cannot be invoked, return `ERROR: companion dispatch failed (<reason>)`. Never return placeholder strings like "Monitor started" or "Waiting for completion" — they are failure modes, not results.
