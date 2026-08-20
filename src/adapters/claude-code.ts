/**
 * Claude Code adapter. Parses `~/.claude/projects/<slug>/<id>.jsonl`. No header
 * line, so the session_start is synthesized from the first entry carrying a
 * cwd; that entry has no model, so session_start.model is backfilled from the
 * first assistant. An assistant entry's content array already holds thinking +
 * text + tool_use blocks, so it maps onto one `assistant_message` directly (no
 * cross-entry coalescing needed). Tool results arrive inside the *next* user
 * entry as `tool_result` blocks keyed by tool_use_id. Machinery lines
 * (attachments, modes, snapshots, meta) are dropped.
 *
 * Sidechain handling is keyed off the file's first line. A normal main-thread
 * file has no sidechain lines (or treats any as machinery), so they are
 * dropped. A sub-agent transcript is sidechain-only: its first line is a
 * `type:"user"` entry with `isSidechain:true` and an `agentId`. When the first
 * line is a sidechain we keep every line and synthesize the session id from
 * `agentId` (sub-agents of one session all share the same `sessionId`), and
 * link the sub-agent to its parent via `parentSession = sessionId` so callers
 * can group every sub-agent under the main thread that spawned it.
 */

import { join } from "path";
import { homedir } from "os";
import type {
  SessionEvent,
  SessionStartEvent,
  SessionMetadata,
  SkillInvocationEvent,
  ToolCall,
  Thinking,
  TokenUsage,
} from "../session.js";
import { FORMAT_VERSION } from "../session.js";
import type { Adapter } from "../parser/adapter.js";
import { readJsonValues } from "../parser/read-lines.js";
import { joinTextBlocks } from "../parser/content.js";
import { selectHeadPath, type NativeTreeEntry } from "../parser/select-head.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export default {
  name: "claude-code",
  storageDir: (opts) =>
    opts?.cwd ? join(PROJECTS_DIR, opts.cwd.replace(/\//g, "-")) : PROJECTS_DIR,

  toolNames: {
    Bash: "terminal",
    Read: "file_read",
    Edit: "file_edit",
    Write: "file_write",
    Glob: "file_search",
    Grep: "content_search",
    WebSearch: "web_search",
    WebFetch: "web_fetch",
    Agent: "sub_agent",
    Task: "sub_agent",
  },

  async *parse(filePath, headId?: string) {
    const callNames = new Map<string, string>(); // tool_use_id -> tool name
    let headerSeen = false;
    let counter = 0;
    // session_start must be yielded first, but claude records the model only on
    // assistant entries, so start (and any preamble before the first assistant)
    // is held until the model is known. Only the preamble buffers, never the
    // whole session.
    let start: SessionStartEvent | null = null;
    const held: SessionEvent[] = [];
    // Decided from the first line: a sidechain-only file is a sub-agent
    // transcript (keep every line); otherwise sidechain lines are machinery.
    let keepSidechain = false;
    let sniffed = false;
    function* flushStart(): Generator<SessionEvent> {
      if (!start) return;
      const s = start;
      start = null;
      yield s;
      while (held.length) yield held.shift()!;
    }
    // Buffer while start is still pending (or before the header appears);
    // stream directly once start has flushed.
    function* emit(ev: SessionEvent): Generator<SessionEvent> {
      if (!headerSeen || start) held.push(ev);
      else yield ev;
    }

    const values = headId
      ? readClaudeHeadValues(filePath, headId)
      : readJsonValues(filePath);
    for await (const value of values) {
      const raw = value as any;
      if (!sniffed) {
        keepSidechain = raw.isSidechain === true;
        sniffed = true;
      }
      if (!keepSidechain && raw.isSidechain === true) continue;

      const ts: string = raw.timestamp ?? "";
      const id: string = raw.uuid ?? `e${counter++}`;
      const parentId: string | null = raw.parentUuid ?? null;

      // Header: first line carrying a cwd (early machinery lines lack it).
      if (!headerSeen && typeof raw.cwd === "string" && raw.cwd) {
        const header: SessionMetadata = {
          agent: "claude-code",
          // Sub-agents share one sessionId; agentId disambiguates them, and the
          // shared sessionId becomes the parent link for grouping.
          id: raw.agentId ?? raw.sessionId ?? "",
          timestamp: ts,
          cwd: raw.cwd,
          model: raw.message?.model && raw.message.model !== "<synthetic>" ? String(raw.message.model) : undefined,
          git: raw.gitBranch ? { branch: raw.gitBranch } : undefined,
          parentSession: raw.agentId && raw.sessionId ? String(raw.sessionId) : undefined,
        };
        headerSeen = true;
        start = { type: "session_start", formatVersion: FORMAT_VERSION, path: filePath, ...header };
        if (start.model) yield* flushStart(); // model already known: nothing to wait for
      }

      if (raw.type === "system") {
        if (raw.subtype === "compact_boundary") {
          yield* emit({ type: "compaction", id, parentId, timestamp: ts });
        } else if (raw.subtype === "api_error") {
          const err = raw.error ?? {};
          yield* emit({
            type: "error",
            id,
            parentId,
            code: err.error?.error?.type ?? (err.status != null ? String(err.status) : undefined),
            message: String(err.formatted ?? err.message ?? `API error ${err.status ?? ""}`),
            retryable: true,
            retryAttempt: typeof raw.retryAttempt === "number" ? raw.retryAttempt : undefined,
            maxRetries: typeof raw.maxRetries === "number" ? raw.maxRetries : undefined,
            timestamp: ts,
          });
        }
        continue;
      }

      if (raw.type === "user") {
        if (raw.isMeta === true) continue;
        const content = raw.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === "tool_result") {
              const callId = String(b.tool_use_id ?? "");
              yield* emit({ type: "tool_result", id: `${id}:${callId}`, parentId, toolCallId: callId, toolName: callNames.get(callId) ?? "", content: blockText(b.content), isError: b.is_error === true, timestamp: ts });
            }
          }
          const text = joinTextBlocks(content);
          if (text && !isNoise(text)) yield* emit({ type: "user_message", id, parentId, text, timestamp: ts });
        } else if (typeof content === "string" && content && !isNoise(content)) {
          yield* emit({ type: "user_message", id, parentId, text: content, timestamp: ts });
        }
        continue;
      }

      if (raw.type === "assistant") {
        const content = raw.message?.content;
        if (!Array.isArray(content)) continue;
        const toolCalls: ToolCall[] = [];
        const textParts: string[] = [];
        const thinkingParts: string[] = [];
        for (const b of content) {
          if (b?.type === "thinking") {
            if (typeof b.thinking === "string" && b.thinking) thinkingParts.push(b.thinking);
          } else if (b?.type === "text" && typeof b.text === "string") {
            textParts.push(b.text);
          } else if (b?.type === "tool_use") {
            const name = String(b.name ?? "");
            const args = (b.input as Record<string, unknown>) ?? {};
            const callId = String(b.id ?? "");
            callNames.set(callId, name);
            toolCalls.push({ id: callId, name, arguments: args });
          }
        }
        const text = textParts.join("\n");
        if (text || toolCalls.length > 0 || thinkingParts.length > 0) {
          const thinking: Thinking | undefined = thinkingParts.length ? { text: thinkingParts.join("\n") } : undefined;
          const model = raw.message?.model ? String(raw.message.model) : "";
          // First assistant settles the model; backfill start, then flush.
          if (start && !start.model && model) start.model = model;
          yield* flushStart();
          yield {
            type: "assistant_message",
            id,
            parentId,
            text,
            thinking,
            toolCalls,
            provider: "anthropic",
            model,
            stopReason: raw.message?.stop_reason ?? undefined,
            usage: extractUsage(raw.message?.usage),
            timestamp: ts,
          };
          for (let i = 0; i < toolCalls.length; i++) {
            const call = toolCalls[i]!;
            const skill = skillInvocationFromClaudeTool(call);
            if (!skill) continue;
            yield {
              type: "skill_invocation",
              id: `${id}:skill:${call.id || i}`,
              parentId: id,
              timestamp: ts,
              sourceEventId: id,
              ...skill,
            };
          }
        }
        continue;
      }

      if (raw.type === "attachment") {
        const att = raw.attachment;
        if (att?.type === "queued_command" && typeof att.prompt === "string" && att.prompt && !isNoise(att.prompt)) {
          yield* emit({ type: "user_message", id, parentId, text: att.prompt, timestamp: ts });
        }
      }
      // ai-title, mode, permission-mode, file-history-snapshot, turn_duration: skip.
    }

    // No assistant message ever settled the model: flush start (model unset)
    // plus any held preamble. No-op when there was no header.
    yield* flushStart();
  },

  async *parseHead(filePath, headId) {
    if (!headId.trim()) throw new Error("head ID must not be empty");
    yield* (this.parse as (
      path: string,
      selectedHead?: string,
    ) => AsyncGenerator<SessionEvent>)(filePath, headId);
  },

  detect(first) {
    // No header line; a `sessionId` on the first parseable value is reliable
    // (pi has none; codex wraps everything in a `payload`).
    const f = first as any;
    return typeof f?.sessionId === "string" && typeof f?.type === "string";
  },

  // Layout: <projects>/<cwd-slug>/<uuid>.jsonl. Filenames carry no timestamp
  // (framework falls back to mtime); cwd lives in the file, with the dir slug
  // as fallback. Non-recursive by default, so <slug>/subagents/ subdirs are
  // skipped unless DiscoverOptions.includeSubagents is set (the framework's
  // walker descends into `subagents/` then).
  discover: {
    match: (name) => name.endsWith(".jsonl"),
    cwdOf: (first, dirName) => String((first as any)?.cwd ?? "") || dirName,
  },
} satisfies Adapter;

// -- helpers -----------------------------------------------------------------

type ClaudeTreeEntry = NativeTreeEntry & Record<string, unknown>;

/** Claude Code head IDs are stable native `uuid` values. */
async function* readClaudeHeadValues(
  filePath: string,
  headId: string,
): AsyncGenerator<unknown> {
  const entries: ClaudeTreeEntry[] = [];
  let found = false;

  for await (const value of readJsonValues(filePath)) {
    const raw = value as Record<string, unknown>;
    if (typeof raw.uuid !== "string") continue;
    entries.push({
      ...raw,
      id: raw.uuid,
      parentId: typeof raw.parentUuid === "string" ? raw.parentUuid : null,
    });
    if (raw.uuid === headId) {
      found = true;
      break;
    }
  }

  if (!found) {
    throw new Error(`head "${headId}" was not found in ${filePath}`);
  }
  yield* selectHeadPath(entries, headId);
}

/** Claude Code records explicit skill use as an assistant `Skill` tool call. */
export function skillInvocationFromClaudeTool(
  call: ToolCall,
): Pick<SkillInvocationEvent, "name" | "path" | "arguments"> | null {
  if (call.name !== "Skill") return null;
  const { skill, path, location, ...args } = call.arguments;
  if (typeof skill !== "string" || !skill) return null;
  const recordedPath =
    typeof path === "string"
      ? path
      : typeof location === "string"
        ? location
        : undefined;
  return {
    name: skill,
    ...(recordedPath ? { path: recordedPath } : {}),
    ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
  };
}

/** tool_result content: string or array of {type:text,text}. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p?.text === "string" ? p.text : JSON.stringify(p))).join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

function extractUsage(usage: any): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  if (!input && !output && !read && !write) return undefined;
  return {
    input: typeof input === "number" ? input : undefined,
    output: typeof output === "number" ? output : undefined,
    cacheRead: read || undefined,
    cacheWrite: write || undefined,
  };
}

const NOISE_PREFIXES = [
  "[Request interrupted by user",
  "<task-notification>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "Caveat: The messages below were generated by the user",
];
const NOISE_SUBSTRINGS = [
  "being continued from a previous conversation",
  "base directory for this skill:",
  "<command-name>/compact",
];

/** Is a user message machinery rather than real input? */
function isNoise(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  for (const p of NOISE_PREFIXES) if (t.startsWith(p)) return true;
  for (const s of NOISE_SUBSTRINGS) if (t.includes(s)) return true;
  if (t.startsWith("<command-") || t.startsWith("<command-message>")) {
    if (t.replace(/<[^>]+>/g, "").trim().length < 30) return true;
  }
  return false;
}
