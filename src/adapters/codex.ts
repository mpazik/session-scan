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
 * linear, so native ids are synthesized and parentId is normally null.
 */

import { join } from "path";
import type {
  SessionEvent,
  SessionMetadata,
  ToolCall,
  Thinking,
  TokenUsage,
  AssistantMessageEvent,
  SkillInvocationEvent,
  NormalizedToolName,
} from "../session.js";
import { FORMAT_VERSION } from "../session.js";
import type { Adapter } from "../parser/adapter.js";
import { readJsonValues } from "../parser/read-lines.js";
import { joinTextBlocks } from "../parser/content.js";

const SESSIONS_DIR = join(process.env.HOME || "~", ".codex", "sessions");

export default {
  name: "codex",
  storageDir: () => SESSIONS_DIR,

  toolNames: classifyTool,

  async *parse(filePath) {
    let counter = 0;
    const nextId = () => `e${counter++}`;
    let ts = "";

    const events: SessionEvent[] = [];
    const assistantMsgs: AssistantMessageEvent[] = [];
    const usages: TokenUsage[] = [];
    const callNames = new Map<string, string>(); // call_id -> tool name

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
      for (const call of msg.toolCalls) {
        const skill = skillInvocationFromCodexTool(call);
        if (!skill) continue;
        events.push({
          type: "skill_invocation",
          id: nextId(),
          parentId: msg.id,
          timestamp: msg.timestamp,
          sourceEventId: msg.id,
          ...skill,
        });
      }
      pending = null;
    };

    for await (const value of readJsonValues(filePath)) {
      const raw = value as { timestamp?: string; type?: string; payload?: Record<string, any> };
      ts = raw.timestamp ?? ts;
      const payload = raw.payload ?? {};

      if (raw.type === "session_meta") {
        const git = payload.git as Record<string, any> | null | undefined;
        header = {
          agent: "codex",
          id: String(payload.id ?? ""),
          timestamp: ts,
          cwd: String(payload.cwd ?? ""),
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
        const text = filterUserText(joinTextBlocks(payload.content, { typed: false }), payload.role);
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
        callNames.set(callId, name);
        ensurePending().toolCalls.push({ id: callId, name, arguments: args });
      } else if (it === "web_search_call") {
        // arguments = the action object ({type, query?/url?}); classifyTool
        // reads its `type` to split web_search from web_fetch (open_page).
        const action = payload.action as Record<string, unknown> | undefined;
        const callId = String(payload.call_id ?? nextId());
        callNames.set(callId, "web_search");
        ensurePending().toolCalls.push({ id: callId, name: "web_search", arguments: action ?? {} });
      } else if (it === "function_call_output" || it === "custom_tool_call_output") {
        flushPending();
        const callId = String(payload.call_id ?? "");
        const { output, isError, exitCode } = parseToolOutput(payload.output);
        events.push({ type: "tool_result", id: nextId(), parentId: null, toolCallId: callId, toolName: callNames.get(callId) ?? "", content: output, isError, exitCode, timestamp: ts });
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

  detect(first) {
    const f = first as any;
    if (!f) return false;
    if (f?.type === "session_meta") return true;
    return (
      f?.payload != null &&
      typeof f.payload === "object" &&
      (typeof f.payload.originator === "string" || typeof f.payload.cli_version === "string")
    );
  },

  // Layout: <sessions>/yyyy/mm/dd/rollout-2025-09-25T13-42-49-<uuid>.jsonl.
  discover: {
    recursive: true,
    match: (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
    dateOf: (name) => name.slice(8, 18),
    cwdOf: (first) => String((first as any)?.payload?.cwd ?? ""),
  },
} satisfies Adapter;

// -- helpers -----------------------------------------------------------------

/** Recognize a dedicated skill tool when the Codex host records one. */
export function skillInvocationFromCodexTool(
  call: ToolCall,
): Pick<SkillInvocationEvent, "name" | "path" | "arguments"> | null {
  if (call.name !== "Skill") return null;
  const { skill, name, path, location, ...args } = call.arguments;
  const invokedName = skill ?? name;
  if (typeof invokedName !== "string" || !invokedName) return null;
  const recordedPath =
    typeof path === "string"
      ? path
      : typeof location === "string"
        ? location
        : undefined;
  return {
    name: invokedName,
    ...(recordedPath ? { path: recordedPath } : {}),
    ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
  };
}

/**
 * Codex tool names -> harness-neutral canonical names. Codex routes everything
 * through a few generic tools, so the classifiers inspect the arguments:
 * `exec_command`/`shell` by shell command, `apply_patch` by patch header,
 * `web_search` by action type.
 */
function classifyTool(tool: string, input: Record<string, unknown>): NormalizedToolName {
  if (tool === "exec_command" || tool === "shell") {
    const cmd =
      typeof input.cmd === "string"
        ? input.cmd
        : typeof input.command === "string"
          ? input.command
          : Array.isArray(input.command)
            ? (input.command as unknown[]).join(" ")
            : "";
    return classifyExecCommand(cmd);
  }
  if (tool === "apply_patch") {
    // function_call carries {input: patch}; custom_tool_call coerces to {raw: patch}.
    const patch =
      typeof input.input === "string" ? input.input : typeof input.raw === "string" ? input.raw : "";
    return patch.includes("*** Add File:") ? "file_write" : "file_edit";
  }
  if (tool === "web_search") {
    return input.type === "open_page" ? "web_fetch" : "web_search";
  }
  return tool;
}

/** Classify an `exec_command` by inspecting the shell command string. */
function classifyExecCommand(cmd: string): NormalizedToolName {
  const c = cmd.trim();
  if (/^(cat|head|tail|less|more|nl)\s/.test(c)) return "file_read";
  if (/^rg\s.*--files/.test(c)) return "file_search";
  if (/^(find|fd|ls)\s/.test(c)) return "file_search";
  if (/^(rg|grep|ag|ack)\s/.test(c)) return "content_search";
  return "terminal";
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
