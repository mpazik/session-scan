/**
 * Claude Code adapter. Parses `~/.claude/projects/<slug>/<id>.jsonl`. No header
 * line, so the session_start is synthesized from the first entry carrying a
 * cwd. An assistant entry's content array already holds thinking + text +
 * tool_use blocks, so it maps onto one `assistant_message` directly (no
 * cross-entry coalescing needed). Tool results arrive inside the *next* user
 * entry as `tool_result` blocks keyed by tool_use_id. Machinery lines
 * (attachments, modes, snapshots, sidechains, meta) are dropped.
 */

import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { SessionEvent, SessionMetadata, ToolCall, Thinking, TokenUsage } from "../session.js";
import { FORMAT_VERSION } from "../session.js";
import type { Adapter } from "../parser/adapter.js";
import { normalizeToolName } from "../parser/tool-names.js";
import { readJsonValues, readFirstJsonValue } from "../parser/read-lines.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export default {
  name: "claude-code",
  storageDir: (opts) =>
    opts?.cwd ? join(PROJECTS_DIR, opts.cwd.replace(/\//g, "-")) : PROJECTS_DIR,

  async *parse(filePath, opts = {}) {
    const toolNames = new Map<string, string>(); // tool_use_id -> tool name
    let headerSeen = false;
    let counter = 0;
    let lastTs = "";

    for await (const value of readJsonValues(filePath)) {
      const raw = value as any;
      if (raw.isSidechain === true) continue;

      const ts: string = raw.timestamp ?? "";
      if (ts) lastTs = ts;
      const id: string = raw.uuid ?? `e${counter++}`;
      const parentId: string | null = raw.parentUuid ?? null;

      // Header: first line carrying a cwd (early machinery lines lack it).
      if (!headerSeen && typeof raw.cwd === "string" && raw.cwd) {
        const cwd = raw.cwd;
        if (opts.cwdFilter && !cwd.toLowerCase().includes(opts.cwdFilter.toLowerCase())) return;
        if (ts && opts.since && new Date(ts) < opts.since) return;
        if (ts && opts.until && new Date(ts) > opts.until) return;
        const header: SessionMetadata = {
          agent: "claude-code",
          id: raw.sessionId ?? "",
          timestamp: ts,
          cwd,
          model: raw.message?.model && raw.message.model !== "<synthetic>" ? String(raw.message.model) : undefined,
          git: raw.gitBranch ? { branch: raw.gitBranch } : undefined,
        };
        headerSeen = true;
        yield { type: "session_start", formatVersion: FORMAT_VERSION, path: filePath, ...header };
      }

      if (raw.type === "system") {
        if (raw.subtype === "compact_boundary") {
          yield { type: "compaction", id, parentId, timestamp: ts };
        } else if (raw.subtype === "api_error") {
          const err = raw.error ?? {};
          yield {
            type: "error",
            id,
            parentId,
            code: err.error?.error?.type ?? (err.status != null ? String(err.status) : undefined),
            message: String(err.formatted ?? err.message ?? `API error ${err.status ?? ""}`),
            retryable: true,
            retryAttempt: typeof raw.retryAttempt === "number" ? raw.retryAttempt : undefined,
            maxRetries: typeof raw.maxRetries === "number" ? raw.maxRetries : undefined,
            timestamp: ts,
          };
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
              yield { type: "tool_result", id: `${id}:${callId}`, parentId, toolCallId: callId, toolName: toolNames.get(callId) ?? "", content: blockText(b.content), isError: b.is_error === true, timestamp: ts };
            }
          }
          const text = arrayText(content);
          if (text && !isNoise(text)) yield { type: "user_message", id, parentId, text, timestamp: ts };
        } else if (typeof content === "string" && content && !isNoise(content)) {
          yield { type: "user_message", id, parentId, text: content, timestamp: ts };
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
            toolNames.set(callId, name);
            toolCalls.push({ id: callId, name, normalizedName: normalizeToolName(name, "claude-code", args), arguments: args });
          }
        }
        const text = textParts.join("\n");
        if (text || toolCalls.length > 0 || thinkingParts.length > 0) {
          const thinking: Thinking | undefined = thinkingParts.length ? { text: thinkingParts.join("\n") } : undefined;
          yield {
            type: "assistant_message",
            id,
            parentId,
            text,
            thinking,
            toolCalls,
            provider: "anthropic",
            model: raw.message?.model ? String(raw.message.model) : "",
            stopReason: raw.message?.stop_reason ?? undefined,
            usage: extractUsage(raw.message?.usage),
            timestamp: ts,
          };
        }
        continue;
      }

      if (raw.type === "attachment") {
        const att = raw.attachment;
        if (att?.type === "queued_command" && typeof att.prompt === "string" && att.prompt && !isNoise(att.prompt)) {
          yield { type: "user_message", id, parentId, text: att.prompt, timestamp: ts };
        }
      }
      // ai-title, mode, permission-mode, file-history-snapshot, turn_duration: skip.
    }

  },

  async detect(filePath) {
    // No header line; a `sessionId` on the first parseable value is reliable
    // (pi has none; codex wraps everything in a `payload`).
    const first = (await readFirstJsonValue(filePath)) as any;
    return typeof first?.sessionId === "string" && typeof first?.type === "string";
  },

  async *discover(opts = {}) {
    const root = opts.sessionsDir ?? PROJECTS_DIR;
    const cwdPattern = opts.cwdFilter?.toLowerCase();

    let dirs: import("fs").Dirent[];
    try {
      dirs = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      let files: import("fs").Dirent[];
      try {
        files = await readdir(join(root, dir.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.isDirectory() || !file.name.endsWith(".jsonl")) continue; // skip subagents/ dir
        const full = join(root, dir.name, file.name);

        // Date filter via mtime (claude filenames carry no timestamp).
        if (opts.since || opts.until) {
          try {
            const st = await stat(full);
            if (opts.since && st.mtime < opts.since) continue;
            if (opts.until && st.mtime > opts.until) continue;
          } catch {
            continue;
          }
        }
        if (cwdPattern) {
          const first = (await readFirstJsonValue(full)) as any;
          const cwd = String(first?.cwd ?? "");
          if (!(cwd || dir.name).toLowerCase().includes(cwdPattern)) continue;
        }
        yield full;
      }
    }
  },
} satisfies Adapter;

// -- helpers -----------------------------------------------------------------

function arrayText(content: any[]): string {
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
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
