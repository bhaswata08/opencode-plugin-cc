// Shared progress-line formatters for both transports (opencode HTTP and agy
// CLI). Both backends' jobs render in one `oco-tui` table and share the
// `progressPreview` tail, so the line formats must match:
//
//   tool: <name> (<detail>)            — tool started / running
//   tool: <name> completed (<detail>)  — tool finished (detail kept: opencode
//                                        exposes no duration to show instead)
//   tool: <name> failed: <detail>      — tool errored
//   patch: <detail> / patch applied    — file-change patch part
//
// Every emitted line is a single line (newlines collapsed) truncated to
// MAX_DETAIL chars, because `progressPreview` splits on newlines and the
// auto-monitor's shell loop strips `|` and newlines. Logs live in /tmp with
// no rotation, so verbosity is tool activity only: `text` and `reasoning`
// parts (the transcript) never produce lines.

export const MAX_DETAIL = 120;

/**
 * Collapse a value to a single trimmed line, truncated to `max` chars.
 * Only newlines are folded (to a space); other whitespace is left alone so
 * agy details that already ship single-line render byte-identically.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string} "" when there is nothing printable
 */
export function singleLine(value, max = MAX_DETAIL) {
  if (value === null || value === undefined) return "";
  const t = String(value).replace(/[\r\n]+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/**
 * Format a tool call parameter summary into a readable string.
 * @param {string} toolName
 * @param {object} [params]
 * @returns {string}
 */
export function formatToolDetail(toolName, params) {
  if (!params || typeof params !== "object") return "";
  const raw = params.CommandLine
    || params.TargetFile
    || params.AbsolutePath
    || params.DirectoryPath
    || params.Pattern
    || params.Query
    || params.query
    || params.Url
    || params.Prompt
    || params.Action
    // opencode tool inputs use lowercase keys (e.g. bash { command }).
    // Checked after the agy PascalCase keys, so agy output is unchanged:
    // agy parameters only ever use the PascalCase shapes above.
    || params.command
    || params.filePath
    || params.file
    || params.path
    || params.pattern
    || params.url
    || params.prompt
    || params.action
    || params.input
    || params.text
    || params.content
    || (typeof Object.values(params)[0] === "string" ? Object.values(params)[0] : "");
  return singleLine(raw);
}

/**
 * Format an NDJSON stream event from agy into a human-readable log line.
 * Returns null for uninteresting or redundant events (such as intermediate deltas).
 *
 * @param {object} evt - parsed NDJSON event object
 * @param {Set<number>} [seenSteps] - track step indices to avoid duplicate lines
 * @returns {string|null}
 */
export function formatProgressEvent(evt, seenSteps = new Set()) {
  if (!evt || typeof evt !== "object") return null;

  if (evt.event === "init") {
    const cid = evt.conversation_id || evt.init?.conversation_id;
    return cid ? `session started (${cid})` : "session started";
  }

  if (evt.event === "step_update" && evt.step_update) {
    const su = evt.step_update;
    const stepType = su.step_type;
    const state = su.state;
    const stepIndex = su.step_index;

    if (stepType === "tool") {
      const toolName = su.tool_name || su.tool_info?.name || "tool";
      if (state === "ACTIVE") {
        const detail = formatToolDetail(toolName, su.tool_info?.parameters);
        return detail ? `tool: ${toolName} (${detail})` : `tool: ${toolName}`;
      }
      if (state === "DONE") {
        const dur = typeof su.duration_seconds === "number"
          ? ` (${su.duration_seconds.toFixed(2)}s)`
          : "";
        return `tool: ${toolName} completed${dur}`;
      }
      if (state === "ERROR") {
        const errMsg = su.tool_info?.error?.message || "unknown error";
        return `tool: ${toolName} failed: ${errMsg}`;
      }
    }

    if (stepType === "agent_response") {
      if (state === "ACTIVE") {
        if (!seenSteps.has(stepIndex)) {
          seenSteps.add(stepIndex);
          return "agent responding";
        }
      } else if (state === "DONE") {
        if (!seenSteps.has(stepIndex)) {
          seenSteps.add(stepIndex);
          const dur = typeof su.duration_seconds === "number"
            ? ` (${su.duration_seconds.toFixed(2)}s)`
            : "";
          return `agent thinking completed${dur}`;
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// opencode message parts (GET /session/:id/message)
// ---------------------------------------------------------------------------

/**
 * Classify an opencode tool state.status into the dedup/format bucket.
 * Unknown and missing statuses count as active: a part first seen without a
 * status still describes work in flight.
 *
 * @param {unknown} status
 * @returns {"done"|"failed"|"active"}
 */
function statusClass(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "completed") return "done";
  if (s === "error" || s === "failed") return "failed";
  return "active";
}

/**
 * Pick the one-line detail for an opencode tool part. The server's
 * `state.title` is a human summary (often of the input itself), so it wins
 * when present; otherwise the raw input is formatted the same way agy
 * parameters are.
 *
 * @param {string} tool
 * @param {object} state
 * @returns {string}
 */
function opencodeToolDetail(tool, state) {
  const title = singleLine(state.title);
  if (title && title.toLowerCase() !== String(tool).toLowerCase()) return title;
  return formatToolDetail(tool, state.input);
}

/**
 * Format one opencode `tool` part. Returns null only for a missing part;
 * a tool with no usable detail still yields `tool: <name>`.
 *
 * @param {object} part
 * @returns {string|null}
 */
function formatOpencodeToolPart(part) {
  const rawTool = part.tool;
  const tool = singleLine(typeof rawTool === "string" && rawTool ? rawTool : "tool");
  const state = part.state && typeof part.state === "object" ? part.state : {};
  const detail = opencodeToolDetail(tool, state);
  const cls = statusClass(state.status);
  if (cls === "done") return detail ? `tool: ${tool} completed (${detail})` : `tool: ${tool} completed`;
  if (cls === "failed") return detail ? `tool: ${tool} failed: ${detail}` : `tool: ${tool} failed`;
  return detail ? `tool: ${tool} (${detail})` : `tool: ${tool}`;
}

/**
 * Basename of a path (never truncates mid-path itself; length is handled by
 * list-level elision instead).
 *
 * @param {string} p
 * @returns {string} "" when nothing usable remains
 */
function patchBasename(p) {
  const s = String(p ?? "").replace(/[\r\n]+/g, " ").trim().replace(/[/\\]+$/, "");
  if (!s) return "";
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

/**
 * Shorten one patch file path so a file list survives the line cap.
 * Absolute paths under the workspace root render relative (keeping directory
 * context); already-relative entries pass through; anything else falls back
 * to its basename. Never truncates mid-path — length is handled by
 * list-level degrade/elision instead.
 *
 * @param {string} p
 * @param {string|null} [root] - workspace root for relativizing
 * @returns {string} "" when nothing usable remains
 */
function shortenPatchPath(p, root = null) {
  const t = String(p ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!t) return "";
  const s = t.replace(/[/\\]+$/, "");
  if (!s) return "";
  const isAbsolute = s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\");
  // Already workspace-relative form (e.g. "src/a.js"): keep it as-is.
  if (!isAbsolute) return s;
  if (typeof root === "string" && root) {
    const r = root.replace(/[/\\]+$/, "");
    if (r && (s === r || s.startsWith(`${r}/`))) {
      return s === r ? "." : s.slice(r.length + 1);
    }
  }
  // Absolute path with no known root (or outside it): basename keeps it
  // short and truncation-proof. Collisions (same basename, different dirs)
  // are kept as duplicates rather than merged, so the count stays honest.
  return patchBasename(s);
}

/**
 * Join a name list as a full `patch: ...` line, or null when it overflows
 * the cap. Never truncates: overlong lists are the caller's cue to degrade
 * to shorter names or elide.
 *
 * @param {string[]} names - non-empty display names
 * @returns {string|null}
 */
function joinPatchNames(names) {
  if (names.length === 0) return null;
  const line = `patch: ${names.join(", ")}`;
  return line.length <= MAX_DETAIL ? line : null;
}

/**
 * Render a file-name list as `patch: a, b, +N more`, cutting only at name
 * boundaries so a path is never sliced in half. Greedily shows as many short
 * names as fit in the cap; when not even one fits, reports the count.
 *
 * @param {string[]} names - shortened, non-empty display names
 * @returns {string}
 */
function formatPatchFileList(names) {
  const prefix = "patch: ";
  const budget = MAX_DETAIL - prefix.length;
  const shown = [];
  let used = 0;
  for (let i = 0; i < names.length; i++) {
    const add = names[i].length + (shown.length === 0 ? 0 : 2);
    const remaining = names.length - i - 1;
    const suffix = remaining > 0 ? `, +${remaining} more` : "";
    if (used + add + suffix.length <= budget) {
      shown.push(names[i]);
      used += add;
    } else {
      break;
    }
  }
  if (shown.length === 0) {
    return `patch: ${names.length} file${names.length === 1 ? "" : "s"} changed`;
  }
  const rest = names.length - shown.length;
  return `patch: ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

/**
 * Format one opencode `patch` part. The live shape beyond `type: "patch"`
 * was captured only as a file list, so this is best-effort: title first,
 * then a truncation-proof file list, then a bare fallback that still marks
 * activity. Pass `{ root }` (workspace root) so absolute paths render
 * relative; without it, basenames are used.
 *
 * Degrade cascade for the file list: relative paths stay preferred whenever
 * they all fit (they disambiguate same-named files). Otherwise the whole
 * list retries as basenames so every file is still named; only when even
 * basenames overflow does `+N more` elision kick in, with the count-only
 * fallback as the last resort.
 *
 * @param {object} part
 * @param {{ root?: string }} [opts]
 * @returns {string}
 */
function formatOpencodePatchPart(part, opts = {}) {
  const title = singleLine(part.title);
  if (title) return `patch: ${title}`;
  const files = Array.isArray(part.files) ? part.files : [];
  const raw = [];
  for (const f of files) {
    const p = typeof f === "string" ? f : f?.path ?? f?.name;
    const s = String(p ?? "").replace(/[\r\n]+/g, " ").trim();
    if (s && !raw.includes(s)) raw.push(s);
  }
  if (raw.length > 0) {
    const root = typeof opts.root === "string" && opts.root ? opts.root : null;
    const items = raw
      .map((p) => ({ rel: shortenPatchPath(p, root), base: patchBasename(p) }))
      .filter((it) => it.rel || it.base);
    if (items.length > 0) {
      const relNames = items.map((it) => it.rel || it.base);
      const fullRel = joinPatchNames(relNames);
      if (fullRel) return fullRel;
      // Degrade to basenames so every file is still named — except files
      // whose basename collides with another changed file, which stay
      // relative: that is exactly where the directory context earns its
      // length, and collapsing them would silently merge two genuinely
      // different files into one entry.
      const baseCounts = new Map();
      for (const it of items) baseCounts.set(it.base, (baseCounts.get(it.base) ?? 0) + 1);
      const degraded = items.map((it) =>
        (baseCounts.get(it.base) ?? 0) > 1 ? (it.rel || it.base) : it.base,
      );
      const fullDegraded = joinPatchNames(degraded);
      if (fullDegraded) return fullDegraded;
      return formatPatchFileList(items.map((it) => it.base));
    }
  }
  if (typeof part.hash === "string" && part.hash.trim()) {
    return `patch: ${singleLine(part.hash.trim().slice(0, 12))}`;
  }
  return "patch applied";
}

/**
 * Format one opencode message part into a log line. Only `tool` and `patch`
 * parts produce lines; `text`, `reasoning`, `step-start`, `step-finish` and
 * anything unknown return null (the web UI is for the transcript; this log
 * answers "is it alive and what is it doing"). `opts.root` (workspace root)
 * lets patch file lists render workspace-relative.
 *
 * @param {object} part
 * @param {{ root?: string }} [opts]
 * @returns {string|null}
 */
export function formatOpencodePart(part, opts = {}) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "tool") return formatOpencodeToolPart(part);
  if (part.type === "patch") return formatOpencodePatchPart(part, opts);
  return null;
}

/**
 * Dedup key for an opencode part. Part `id` (prt_...) is stable across
 * polls; the status class AND the formatted line are folded in, so a
 * running-to-completed transition emits the completion line, and a later
 * more informative sighting (e.g. input populated after `pending`) is never
 * blocked by an earlier bare one. Unchanged parts re-poll silently.
 * Parts without any id (never seen live) fall back to their formatted line.
 *
 * @param {object} part
 * @param {{ root?: string }} [opts] - must match the opts used for formatting
 * @returns {string|null}
 */
export function progressKey(part, opts = {}) {
  if (!part || typeof part !== "object") return null;
  const line = formatOpencodePart(part, opts);
  if (!line) return null;
  const state = part.state && typeof part.state === "object" ? part.state : {};
  const cls = statusClass(state.status);
  const id = part.id ?? part.callID;
  if (id !== null && id !== undefined && String(id) !== "") {
    return `${String(id)}\0${cls}\0${line}`;
  }
  return `line:${cls}:${line}`;
}

/**
 * Create a stateful emitter that forwards formatted opencode parts to
 * `onProgress`, emitting each distinct part once. The transport feeds every
 * poll's parts through this; the seen-set does the rest. `opts.root` is the
 * workspace root used for patch path shortening.
 *
 * @param {(line: string, part: object) => void} [onProgress]
 * @param {{ root?: string }} [opts]
 * @returns {{ seen: Set<string>, emitPart: (part: object) => string|null, emitParts: (parts: object[]) => string[] }}
 */
export function createProgressEmitter(onProgress, opts = {}) {
  const seen = new Set();
  const emitPart = (part) => {
    if (typeof onProgress !== "function") return null;
    // Format BEFORE consulting the seen-set: the key folds in the formatted
    // line, so a bare early sighting must not block a later detailed one.
    const line = formatOpencodePart(part, opts);
    if (!line) return null;
    const key = progressKey(part, opts);
    if (key !== null) {
      if (seen.has(key)) return null;
      seen.add(key);
    }
    try {
      onProgress(line, part);
    } catch {
      // ignore logging failures — progress must never break the watcher
    }
    return line;
  };
  const emitParts = (parts) => {
    if (!Array.isArray(parts) || typeof onProgress !== "function") return [];
    const out = [];
    for (const part of parts) {
      const line = emitPart(part);
      if (line) out.push(line);
    }
    return out;
  };
  return { seen, emitPart, emitParts };
}
