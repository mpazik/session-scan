/**
 * Claude Code `/export` adapter (LOW FIDELITY).
 *
 * Parses the plain-text transcript Claude Code's `/export` command writes — the
 * rendered terminal UI, not the on-disk JSONL. Use it when you only have a
 * teammate's exported `.txt` and cannot get the original
 * `~/.claude/projects/<slug>/<id>.jsonl` (which the `claude-code` adapter parses
 * losslessly). Prefer the JSONL whenever it is available.
 *
 * This is a best-effort reconstruction of a display artifact, so it is lossy by
 * construction. The TUI never prints several things the canonical model carries:
 *   - usage / token counts        → always absent
 *   - thinking blocks             → hidden in the TUI, unrecoverable
 *   - real tool-call ids          → synthesized; pairing is positional
 *   - full tool args / results    → truncated ("(ctrl+o to expand)", "+N lines")
 *   - timestamps                  → only the session start, from the filename
 *   - exit codes                  → not shown
 * Text is also hard-wrapped at the terminal width; paragraphs are un-wrapped
 * heuristically (a near-full line is treated as a soft wrap), so original hard
 * newlines inside prose are approximate.
 *
 * Mapping of TUI markers onto canonical events:
 *   banner               → session_start (model, cwd) + an export_fidelity note
 *   `❯ …`                → user_message
 *   `⏺ <prose>`          → assistant_message (text)
 *   `⏺ Name(args)`       → assistant_message + one toolCall, then its `⎿` result
 *   `⏺ N … agents …`     → assistant_message with sub_agent toolCalls
 *   `⏺ User answered …`  → custom_message "user_answers"
 *   `  ⎿ …`              → tool_result (paired to the preceding tool call)
 *   plan box `╭─…╰─`     → custom_message "plan"
 *   collapsed tool line  → custom_message "collapsed_tools"
 *   `※ recap:`           → custom_message "recap"
 *   `✻ Brewed for …`     → dropped (timing only)
 */

import { join } from "path";
import { homedir } from "os";
import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { basename } from "path";
import type {
  SessionEvent,
  SessionMetadata,
  ToolCall,
  NormalizedToolName,
} from "../session.js";
import { FORMAT_VERSION } from "../session.js";
import type { Adapter } from "../parser/adapter.js";

const EXPORTS_DIR = join(homedir(), ".session-scan", "claude-exports");

export default {
  name: "claude-export",
  storageDir: () => EXPORTS_DIR,

  toolNames(name) {
    const n = name.trim().toLowerCase();
    if (n === "bash") return "terminal";
    if (n === "read") return "file_read";
    if (n === "update" || n === "edit" || n === "multiedit") return "file_edit";
    if (n === "write") return "file_write";
    if (n === "grep") return "content_search";
    if (n === "glob" || n === "search" || n.startsWith("search")) return "file_search";
    if (n === "fetch" || n === "webfetch") return "web_fetch";
    if (n === "websearch" || n === "web search") return "web_search";
    if (n === "task" || n === "agent" || n.includes("agent")) return "sub_agent";
    return name as NormalizedToolName;
  },

  async *parse(filePath) {
    const text = await readFile(filePath, "utf8");
    // The TUI separates glyphs from content with a non-breaking space and pads
    // with them; treat every NBSP as ordinary whitespace.
    const lines = text.replace(/\u00a0/g, " ").split("\n");

    // Body starts at the first top-level marker; everything before is the banner.
    let bodyStart = lines.findIndex((l) => /^(❯|⏺|✻|※)/.test(l));
    if (bodyStart < 0) bodyStart = 0;
    const banner = parseBanner(lines.slice(0, bodyStart));
    const meta = parseFilename(basename(filePath));

    let counter = 0;
    let tcCounter = 0;
    const nextId = () => `e${++counter}`;
    let parentId: string | null = null;
    const model = banner.model ?? "";

    function* emit(ev: SessionEvent): Generator<SessionEvent> {
      parentId = ev.id;
      yield ev;
    }

    const start: SessionEvent = {
      type: "session_start",
      formatVersion: FORMAT_VERSION,
      path: filePath,
      agent: "claude-code",
      id: meta.id,
      timestamp: meta.timestamp,
      cwd: banner.cwd ?? "",
      model: model || undefined,
    } satisfies SessionMetadata & {
      type: "session_start";
      formatVersion: number;
      path?: string;
    };
    yield* emit(start);
    yield* emit({
      type: "custom_message",
      id: nextId(),
      parentId,
      customType: "export_fidelity",
      content:
        "Parsed from a Claude Code /export transcript (display text). Lossy: " +
        "no token usage, no thinking, no real tool-call ids, tool payloads " +
        "may be truncated, prose newlines are approximate.",
      timestamp: meta.timestamp,
    });

    // Group lines into blocks (a leader line plus its continuation), then map.
    const blocks = toBlocks(lines.slice(bodyStart));

    // pendingTool tracks the most recent `⏺` so a following `⎿` can pair to it.
    let pending: { kind: "tool"; toolCallId: string } | { kind: "answers" } | { kind: "prose" } | null = null;

    for (const block of blocks) {
      if (block.kind === "user") {
        const t = unwrap(stripLeader(block.lines, /^❯ ?/));
        if (t) yield* emit({ type: "user_message", id: nextId(), parentId, text: t, timestamp: "" });
        pending = null;
        continue;
      }

      if (block.kind === "recap") {
        const t = unwrap(stripLeader(block.lines, /^※ ?/)).replace(/^recap:\s*/, "");
        yield* emit({ type: "custom_message", id: nextId(), parentId, customType: "recap", content: t, timestamp: "" });
        pending = null;
        continue;
      }

      if (block.kind === "brewed") {
        pending = null;
        continue; // timing only
      }

      if (block.kind === "collapsed") {
        const t = stripTruncation(block.lines.join(" ").trim());
        yield* emit({ type: "custom_message", id: nextId(), parentId, customType: "collapsed_tools", content: t, timestamp: "" });
        pending = null;
        continue;
      }

      if (block.kind === "assistant") {
        const head = (block.lines[0] ?? "").replace(/^⏺ ?/, "");

        // Sub-agent fan-out: "N <kind> agents finished" + a ├/└ tree.
        const agents = /^\d+\s+.*\bagents?\b.*\bfinished/i.test(head);
        if (agents) {
          const { calls, results } = parseAgents(block.lines.slice(1), () => `t${++tcCounter}`);
          yield* emit({ type: "assistant_message", id: nextId(), parentId, text: "", toolCalls: calls, provider: "anthropic", model, timestamp: "" });
          for (const r of results) yield* emit({ ...r, id: nextId(), parentId, timestamp: "" });
          pending = null;
          continue;
        }

        // User decisions surfaced via AskUserQuestion; the answers are the
        // following `⎿` block. Defer to it.
        if (/^User (answered|declined)/i.test(head)) {
          pending = { kind: "answers" };
          continue;
        }

        // Tool call: `Name(args…)`, args may span continuation lines.
        const call = parseToolCall(block.lines, () => `t${++tcCounter}`);
        if (call) {
          yield* emit({ type: "assistant_message", id: nextId(), parentId, text: "", toolCalls: [call], provider: "anthropic", model, timestamp: "" });
          pending = { kind: "tool", toolCallId: call.id };
          continue;
        }

        // Plain assistant prose.
        const t = unwrap(stripLeader(block.lines, /^⏺ ?/));
        yield* emit({ type: "assistant_message", id: nextId(), parentId, text: t, toolCalls: [], provider: "anthropic", model, timestamp: "" });
        pending = { kind: "prose" };
        continue;
      }

      if (block.kind === "result") {
        const raw = stripLeader(block.lines, /^ {0,2}⎿ {0,2}/);
        const joined = raw.join("\n");

        // Plan preview box.
        if (/Claude's plan/.test(joined) || joined.includes("\u256d") /* ╭ */) {
          // The verdict (rejected/approved) is the first line of the box content.
          yield* emit({ type: "custom_message", id: nextId(), parentId, customType: "plan", content: stripBox(joined), timestamp: "" });
          pending = null;
          continue;
        }

        if (pending?.kind === "answers") {
          yield* emit({ type: "custom_message", id: nextId(), parentId, customType: "user_answers", content: stripTruncation(joinBullets(raw)), timestamp: "" });
          pending = null;
          continue;
        }

        const content = stripTruncation(dedentDiff(raw).join("\n").trim());
        if (pending?.kind === "tool") {
          yield* emit({ type: "tool_result", id: nextId(), parentId, toolCallId: pending.toolCallId, toolName: "", content, isError: looksLikeError(content), timestamp: "" });
        } else {
          yield* emit({ type: "custom_message", id: nextId(), parentId, customType: "output", content, timestamp: "" });
        }
        pending = null;
        continue;
      }
    }
  },

  detect(first, filePath) {
    if (first != null) return false; // a JSON harness owns this file
    if (!filePath) return false;
    try {
      const head = readFileSync(filePath, "utf8").slice(0, 4000);
      if (/Claude Code v\d/.test(head)) return true;
      return head.includes("⏺") && head.includes("❯");
    } catch {
      return false;
    }
  },

  // No canonical on-disk location for exports; default to a drop folder. The
  // common path is passing the .txt file directly.
  discover: {
    match: (name) => name.endsWith(".txt"),
    dateOf: (name) => {
      const m = name.match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
    },
  },
} satisfies Adapter;

// -- block tokenizer ---------------------------------------------------------

type BlockKind = "user" | "assistant" | "result" | "recap" | "brewed" | "collapsed";
interface Block {
  kind: BlockKind;
  lines: string[]; // leader line first, continuation after
}

const COLLAPSED_RE =
  /^ {2}(Read|Searched|Listed|Wrote|Recalled|Fetch|Fetched|Updated|Created|Found|Crafted|Search)\b.*\(ctrl\+o to expand\)\s*$/;

/** Identify the marker that starts a new block, or null for a continuation. */
function leaderOf(line: string): BlockKind | null {
  if (/^❯/.test(line)) return "user";
  if (/^⏺/.test(line)) return "assistant";
  if (/^✻ /.test(line)) return "brewed";
  if (/^※ /.test(line)) return "recap";
  if (/^ {2}⎿/.test(line)) return "result";
  if (COLLAPSED_RE.test(line)) return "collapsed";
  return null;
}

function toBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const line of lines) {
    const kind = leaderOf(line);
    if (kind) {
      cur = { kind, lines: [line] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
    // lines before the first leader (none, banner already stripped) are dropped
  }
  return blocks;
}

// -- text helpers ------------------------------------------------------------

/** Drop the leader glyph from line 0 and the 2-space indent from the rest. */
function stripLeader(lines: string[], leader: RegExp): string[] {
  return lines.map((l, i) => (i === 0 ? l.replace(leader, "") : l.replace(/^ {0,2}/, "")));
}

/** Un-wrap terminal-wrapped prose. Near-full lines are joined as soft wraps. */
function unwrap(lines: string[]): string {
  const WRAP = 68;
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line === "") {
      flush();
      out.push("");
      continue;
    }
    const isList = /^([-*·•]|\d+\.)\s/.test(line);
    if (cur === "" || isList) {
      flush();
      cur = line;
    } else if (cur.length >= WRAP) {
      cur += " " + line;
    } else {
      flush();
      cur = line;
    }
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** One line per `·` bullet (the AskUserQuestion render). */
function joinBullets(lines: string[]): string {
  const text = lines.map((l) => l.replace(/\s+$/, "")).join(" ").replace(/\s+/g, " ");
  return text
    .split(/\s·\s/)
    .map((s) => s.trim().replace(/^[·•]\s*/, ""))
    .filter(Boolean)
    .map((s) => "· " + s)
    .join("\n");
}

/** Strip the line-number gutter the TUI prints on diffs/file views. */
function dedentDiff(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^\s*\d+\s([+\- ])/, "$1"));
}

/** Remove the box-drawing border around a plan preview. */
function stripBox(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^[\s│╭╮╰╯─]*$/.test(l) || /\S/.test(l.replace(/[\s│╭╮╰╯─]/g, "")))
    .map((l) => l.replace(/^\s*│\s?/, "").replace(/\s*│\s*$/, "").replace(/\s+$/, ""))
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

/** Drop the TUI's truncation affordances and flag that output was clipped. */
function stripTruncation(text: string): string {
  let t = text
    .replace(/\s*\(ctrl\+o to expand\)\s*/g, " ")
    .replace(/…\s*\+\d+ lines.*$/gm, "")
    .replace(/\s+$/gm, "");
  const clipped = /\(ctrl\+o to expand\)|…\s*\+\d+ lines|…$/.test(text);
  t = t.trim();
  return clipped ? t + "\n…[truncated]" : t;
}

function looksLikeError(content: string): boolean {
  const first = content.split("\n", 1)[0] ?? "";
  return /\b(error|fail(ed|ure|s)?|forbidden|not found|denied|exit code [1-9])\b/i.test(first);
}

// -- tool-call parsing -------------------------------------------------------

/** Parse `⏺ Name(args…)`, joining args that wrapped onto continuation lines. */
// Known Claude Code tool-call labels (and a permissive single-token fallback).
// The label must sit flush against `(` with no space, which keeps prose that
// merely contains parentheses ("varchar(191)", "passed (12 tests)") out.
const TOOL_LABEL = new Set([
  "bash", "read", "write", "edit", "update", "multiedit", "glob", "grep",
  "search", "task", "fetch", "webfetch", "websearch", "web search", "agent",
  "notebookedit", "todowrite", "bashoutput", "killshell",
]);

function parseToolCall(lines: string[], nextId: () => string): ToolCall | null {
  const head = (lines[0] ?? "").replace(/^⏺ ?/, "");
  const m = head.match(/^([A-Z][A-Za-z0-9]*(?: [A-Z][A-Za-z0-9]*)*)\((.*)$/);
  if (!m) return null;
  const name = (m[1] ?? "").trim();
  // Unknown labels must be a single PascalCase token. Multi-word labels are
  // accepted only when explicitly listed above.
  if (!TOOL_LABEL.has(name.toLowerCase()) && !/^[A-Z][a-z]+([A-Z][a-z]+)*$/.test(name)) return null;
  // Join continuation lines (commands/paths wrap mid-token).
  const rest = [m[2], ...lines.slice(1).map((l) => l.trim())].join(" ");
  let argRaw = rest.replace(/\)\s*$/, "").replace(/…\s*$/, "").trim();
  argRaw = stripTruncation(argRaw).replace(/\n…\[truncated\]$/, "");

  const n = name.toLowerCase();
  let args: Record<string, unknown>;
  if (n === "bash") args = { command: argRaw };
  else if (n === "read" || n === "update" || n === "edit" || n === "write") args = { file_path: argRaw };
  else if (n === "fetch" || n === "webfetch") args = { url: argRaw };
  else if (n === "websearch" || n === "web search") args = { query: argRaw };
  else args = { input: argRaw };

  return { id: nextId(), name, arguments: args };
}

/** Parse the ├/└ sub-agent tree into one toolCall + one tool_result each. */
function parseAgents(
  lines: string[],
  nextId: () => string,
): { calls: ToolCall[]; results: Omit<Extract<SessionEvent, { type: "tool_result" }>, "id" | "parentId" | "timestamp">[] } {
  const calls: ToolCall[] = [];
  const results: Omit<Extract<SessionEvent, { type: "tool_result" }>, "id" | "parentId" | "timestamp">[] = [];
  let cur: ToolCall | null = null;
  for (const raw of lines) {
    const l = raw.trim();
    const entry = l.match(/^[├└]\s*(.+?)(?:\s+·\s+(.*))?$/);
    if (entry) {
      const desc = (entry[1] ?? "").trim();
      cur = { id: nextId(), name: "Task", arguments: { description: desc, meta: entry[2]?.trim() } };
      calls.push(cur);
      continue;
    }
    const status = l.match(/⎿\s*(.*)$/);
    if (status && cur) {
      const s = (status[1] ?? "").trim();
      results.push({ type: "tool_result", toolCallId: cur.id, toolName: "Task", content: s, isError: looksLikeError(s) });
      cur = null;
    }
  }
  return { calls, results };
}

// -- header parsing ----------------------------------------------------------

/** Pull model and cwd out of the ASCII-art banner. */
function parseBanner(lines: string[]): { model?: string; cwd?: string } {
  const out: { model?: string; cwd?: string } = {};
  for (const raw of lines) {
    const l = raw.replace(/^[\s▐▛▜▝▘▎█]+/, "").trim();
    if (!l) continue;
    if (!out.model && /Claude Code v/.test(raw)) continue; // version line
    if (!out.model && / · /.test(l)) out.model = (l.split(" · ")[0] ?? "").trim();
    const path = l.match(/(~?\/[^\s]+)/);
    if (!out.cwd && path) out.cwd = path[1];
  }
  return out;
}

/** Filename like `2026-06-12-115439-read-the-jira-ticket.txt`. */
function parseFilename(name: string): { id: string; timestamp: string } {
  const base = name.replace(/\.txt$/, "");
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)$/);
  if (!m) return { id: base, timestamp: "" };
  const [, y, mo, d, h, mi, s] = m;
  return { id: base, timestamp: `${y}-${mo}-${d}T${h}:${mi}:${s}` };
}
