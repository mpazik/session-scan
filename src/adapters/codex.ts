/**
 * Codex adapter. Parses `rollout-*.jsonl`; every line is `{timestamp, type,
 * payload}`. Codex splits one model response across several `response_item`s
 * (a `reasoning`, an assistant `message`, one or more `function_call`s), so the
 * adapter coalesces them into a single `assistant_message` (the session.ts
 * billing unit): thinking + text + toolCalls live on one event. A pending
 * message is flushed when a tool result, user message, or end-of-file arrives.
 *
 * `token_count` event_msgs carry per-response `last_token_usage`; they are
 * collected in order and zipped onto the flushed assistant messages. Codex is
 * linear, so ids are a synthesized counter and parentId is always null.
 */

import { readdir } from "fs/promises";
import { join } from "path";
import type {
  SessionEvent,
  SessionMetadata,
  ToolCall,
  Thinking,
  TokenUsage,
  AssistantMessageEvent,
} from "../session.js";
import { FORMAT_VERSION } from "../session.js";
import type { Adapter } from "../parser/adapter.js";
import { normalizeToolName } from "../parser/tool-names.js";
import { readJsonValues, readFirstJsonValue } from "../parser/read-lines.js";

const SESSIONS_DIR = join(process.env.HOME || "~", ".codex", "sessions");

export default {
  name: "codex",
  storageDir: () => SESSIONS_DIR,

  async *parse(filePath, opts = {}) {
    let counter = 0;
    const nextId = () => `e${counter++}`;
    let ts = "";

    const events: SessionEvent[] = [];
    const assistantMsgs: AssistantMessageEvent[] = [];
    const usages: TokenUsage[] = [];
    const toolNames = new Map<string, string>(); // call_id -> tool name

    // Header fields, accumulated as they appear (session_meta, turn_context).
    let headerSeen = false;
    let header: SessionMetadata = { agent: "codex", id: "", timestamp: "", cwd: "" };

    // The response currently being assembled from split response_items.
    let pending: { id: string; ts: string; texts: string[]; thinking?: Thinking; toolCalls: ToolCall[] } | null = null;
    const ensurePending = () => (pending ??= { id: nextId(), ts, texts: [], toolCalls: [] });
    const flushPending = () => {
      if (!pending) return;
      const msg: AssistantMessageEvent = {
        type: "assistant_message",
        id: pending.id,
        parentId: null,
        timestamp: pending.ts,
        text: pending.texts.join("\n"),
        thinking: pending.thinking,
        toolCalls: pending.toolCalls,
        provider: "openai",
        model: header.model ?? "",
      };
      events.push(msg);
      assistantMsgs.push(msg);
      pending = null;
    };

    for await (const value of readJsonValues(filePath)) {
      const raw = value as { timestamp?: string; type?: string; payload?: Record<string, any> };
      ts = raw.timestamp ?? ts;
      const payload = raw.payload ?? {};

      if (raw.type === "session_meta") {
        const cwd = String(payload.cwd ?? "");
        if (opts.cwdFilter && !cwd.toLowerCase().includes(opts.cwdFilter.toLowerCase())) return;
        if (ts && opts.since && new Date(ts) < opts.since) return;
        if (ts && opts.until && new Date(ts) > opts.until) return;
        const git = payload.git as Record<string, any> | null | undefined;
        header = {
          agent: "codex",
          id: String(payload.id ?? ""),
          timestamp: ts,
          cwd,
          model: payload.model ? String(payload.model) : undefined,
          git: git
            ? {
                branch: git.branch ? String(git.branch) : undefined,
                commit: git.commit_hash ? String(git.commit_hash) : undefined,
                remote: git.repository_url ? String(git.repository_url) : undefined,
              }
            : undefined,
        };
        headerSeen = true;
        continue;
      }

      if (raw.type === "turn_context") {
        if (payload.model) header.model = String(payload.model);
        continue;
      }

      if (raw.type === "compacted") {
        flushPending();
        events.push({ type: "compaction", id: nextId(), parentId: null, timestamp: ts });
        continue;
      }

      if (raw.type === "event_msg") {
        const mt = payload.type as string | undefined;
        if (mt === "turn_aborted") {
          flushPending();
          events.push({ type: "error", id: nextId(), parentId: null, code: "turn_aborted", message: String(payload.reason ?? "interrupted"), retryable: false, timestamp: ts });
        } else if (mt === "context_compacted") {
          flushPending();
          events.push({ type: "compaction", id: nextId(), parentId: null, timestamp: ts });
        } else if (mt === "token_count") {
          const info = payload.info as Record<string, any> | undefined;
          const u = mapUsage(info?.last_token_usage);
          if (u) usages.push(u);
        }
        // task_started / task_complete / agent_message / user_message: mirror
        // response_items, so skip to avoid duplicates.
        continue;
      }

      if (raw.type !== "response_item") continue;
      const it = payload.type as string | undefined;

      if (it === "message") {
        if (payload.role === "developer" || payload.role === "system") continue; // injected instructions
        const text = filterUserText(joinText(payload.content), payload.role);
        if (!text) continue;
        if (payload.role === "user") {
          flushPending();
          events.push({ type: "user_message", id: nextId(), parentId: null, text, timestamp: ts });
        } else if (payload.role === "assistant") {
          ensurePending().texts.push(text);
        }
      } else if (it === "reasoning") {
        const summary = joinReasoningSummary(payload.summary);
        ensurePending().thinking = { summary: summary || undefined, text: null };
      } else if (it === "function_call" || it === "custom_tool_call") {
        const name = String(payload.name ?? "");
        const args = it === "custom_tool_call" ? coerceInput(payload.input) : parseArgs(payload.arguments);
        const callId = String(payload.call_id ?? nextId());
        toolNames.set(callId, name);
        ensurePending().toolCalls.push({ id: callId, name, normalizedName: normalizeToolName(name, "codex", args), arguments: args });
      } else if (it === "web_search_call") {
        const action = payload.action as Record<string, any> | undefined;
        const callId = String(payload.call_id ?? nextId());
        toolNames.set(callId, "web_search");
        ensurePending().toolCalls.push({ id: callId, name: "web_search", normalizedName: normalizeToolName("web_search", "codex", { action }), arguments: action ? { url: action.url } : {} });
      } else if (it === "function_call_output" || it === "custom_tool_call_output") {
        flushPending();
        const callId = String(payload.call_id ?? "");
        const { output, isError, exitCode } = parseToolOutput(payload.output);
        events.push({ type: "tool_result", id: nextId(), parentId: null, toolCallId: callId, toolName: toolNames.get(callId) ?? "", content: output, isError, exitCode, timestamp: ts });
      }
    }

    flushPending();

    if (!headerSeen) return;

    // Zip per-response usage onto the assistant messages in flush order.
    for (let i = 0; i < assistantMsgs.length && i < usages.length; i++) {
      assistantMsgs[i]!.usage = usages[i];
    }
    yield { type: "session_start", formatVersion: FORMAT_VERSION, path: filePath, ...header };
    yield* events;
  },

  async detect(filePath) {
    const first = (await readFirstJsonValue(filePath)) as any;
    if (!first) return false;
    if (first?.type === "session_meta") return true;
    return (
      first?.payload != null &&
      typeof first.payload === "object" &&
      (typeof first.payload.originator === "string" || typeof first.payload.cli_version === "string")
    );
  },

  async *discover(opts = {}) {
    const root = opts.sessionsDir ?? SESSIONS_DIR;
    const sinceStr = opts.since?.toISOString().slice(0, 10);
    const untilStr = opts.until?.toISOString().slice(0, 10);
    const cwdPattern = opts.cwdFilter?.toLowerCase();

    async function* walk(dir: string): AsyncGenerator<string> {
      let entries: import("fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          yield* walk(full);
          continue;
        }
        if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
        // Filename: rollout-2025-09-25T13-42-49-<uuid>.jsonl
        if (sinceStr || untilStr) {
          const dateStr = entry.name.slice(8, 18);
          if (sinceStr && dateStr < sinceStr) continue;
          if (untilStr && dateStr > untilStr) continue;
        }
        if (cwdPattern) {
          const first = (await readFirstJsonValue(full)) as any;
          const cwd = String(first?.payload?.cwd ?? "");
          if (!cwd.toLowerCase().includes(cwdPattern)) continue;
        }
        yield full;
      }
    }

    yield* walk(root);
  },
} satisfies Adapter;

// -- helpers -----------------------------------------------------------------

function joinText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c: any) => typeof c?.text === "string").map((c: any) => c.text).join("\n");
}

/** Drop codex's injected context blocks; keep the human prompt. */
function filterUserText(text: string, role: unknown): string {
  if (role !== "user") return text;
  const t = text.trim();
  if (t.startsWith("<environment_context>")) return "";
  if (t.startsWith("<user_instructions>")) return "";
  if (t.startsWith("# AGENTS.md")) return "";
  return text;
}

function joinReasoningSummary(summary: unknown): string {
  let arr = summary;
  if (typeof summary === "string") {
    try {
      arr = JSON.parse(summary);
    } catch {
      return summary;
    }
  }
  if (!Array.isArray(arr)) return "";
  return arr.map((s: any) => (typeof s?.text === "string" ? s.text : "")).filter(Boolean).join(" ");
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return { raw: args };
    }
  }
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function coerceInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") return { raw: input };
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

/**
 * Codex usage: `input_tokens` INCLUDES `cached_input_tokens`. session.ts wants
 * `inputTokens` to be non-cached only, with cache as a separate bucket, so we
 * subtract the cached portion out.
 */
function mapUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const t = u as Record<string, number>;
  const input = Number(t.input_tokens ?? 0);
  const cached = Number(t.cached_input_tokens ?? 0);
  const usage: TokenUsage = {
    input: Math.max(0, input - cached),
    output: t.output_tokens,
    cacheRead: cached || undefined,
    reasoningOutput: t.reasoning_output_tokens || undefined,
    total: t.total_tokens,
  };
  return usage;
}

/**
 * Codex tool output is either plain text or `{"output":...,"metadata":{...}}`.
 * Both shapes embed `Process exited with code N`; parse it to flag errors.
 */
function parseToolOutput(output: unknown): { output: string; isError: boolean; exitCode?: number } {
  let text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  let exitCode: number | undefined;
  try {
    const p = JSON.parse(text);
    if (p && typeof p === "object") {
      if (typeof p.output === "string") text = p.output;
      if (typeof p.metadata?.exit_code === "number") exitCode = p.metadata.exit_code;
    }
  } catch {
    // not JSON
  }
  if (exitCode == null) {
    const m = text.match(/Process exited with code (\d+)/);
    if (m) exitCode = Number(m[1]);
  }
  return { output: text, isError: exitCode != null && exitCode !== 0, exitCode };
}
