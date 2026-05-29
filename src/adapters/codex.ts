/**
 * Codex session source.
 *
 * Parses codex `rollout-*.jsonl` files. Every line is `{ timestamp, type,
 * payload }`. Codex is linear (no id tree), so entry ids are synthesized from a
 * counter and parentId is always null.
 *
 * Differences from pi handled here:
 * - Tool calls are standalone `function_call` response_items, not embedded in
 *   an assistant message. Each becomes a synthetic empty-text assistant_message
 *   hosting one toolCall (keeps pi's embedded-toolCalls model).
 * - `function_call_output` wraps its real output and exit code in a JSON string
 *   ({output, metadata.exit_code}); we parse it ourselves to flag errors, since
 *   the field has no native isError.
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { readdir } from "fs/promises";
import { join } from "path";
import type { SessionEvent, SessionHeader, ToolCall } from "../types.js";
import type {
  SessionSource,
  StreamOptions,
  DiscoverOptions,
} from "../parser/source.js";
import { normalizeToolName } from "../parser/tool-names.js";
import { readFirstLine } from "../parser/read-lines.js";

const SESSIONS_DIR = join(process.env.HOME || "~", ".codex", "sessions");

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

async function* parse(
  filePath: string,
  opts: StreamOptions = {},
): AsyncGenerator<SessionEvent> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let counter = 0;
  const nextId = () => `e${counter++}`;
  let sessionTs = "";
  // call_id -> resolved command string, for tool_result.command
  const callCommands = new Map<string, string>();
  let headerSeen = false;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let raw: CodexLine;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = raw.timestamp ?? sessionTs;
      const payload = raw.payload ?? {};

      // -- session_meta -----------------------------------------------------
      if (raw.type === "session_meta") {
        const cwd = String(payload.cwd ?? "");
        sessionTs = raw.timestamp ?? "";

        if (
          opts.cwdFilter &&
          !cwd.toLowerCase().includes(opts.cwdFilter.toLowerCase())
        ) {
          return;
        }
        if (sessionTs) {
          if (opts.since && new Date(sessionTs) < opts.since) return;
          if (opts.until && new Date(sessionTs) > opts.until) return;
        }

        const git = payload.git as Record<string, any> | null | undefined;
        const header: SessionHeader = {
          type: "session",
          agent: "codex",
          id: String(payload.id ?? ""),
          timestamp: sessionTs,
          cwd,
          model: payload.model ? String(payload.model) : undefined,
          git: git
            ? {
                branch: git.branch ? String(git.branch) : undefined,
                commit: git.commit_hash ? String(git.commit_hash) : undefined,
                remote: git.repository_url
                  ? String(git.repository_url)
                  : undefined,
              }
            : undefined,
        };

        headerSeen = true;
        yield { type: "session_start", header, path: filePath };
        continue;
      }

      if (!headerSeen) {
        // Some rollouts may omit session_meta; synthesize a minimal header.
        sessionTs = ts;
        headerSeen = true;
        yield {
          type: "session_start",
          header: {
            type: "session",
            agent: "codex",
            id: "",
            timestamp: ts,
            cwd: "",
          },
          path: filePath,
        };
      }

      // -- top-level compaction ---------------------------------------------
      if (raw.type === "compacted") {
        yield {
          type: "compaction",
          id: nextId(),
          parentId: null,
          summary: "",
          tokensBefore: 0,
          timestamp: ts,
        };
        continue;
      }

      // -- event_msg --------------------------------------------------------
      if (raw.type === "event_msg") {
        const mt = payload.type as string | undefined;
        if (mt === "turn_aborted") {
          yield {
            type: "error",
            id: nextId(),
            parentId: null,
            code: "turn_aborted",
            message: String(payload.reason ?? "interrupted"),
            timestamp: ts,
          };
        } else if (mt === "context_compacted") {
          yield {
            type: "compaction",
            id: nextId(),
            parentId: null,
            summary: "",
            tokensBefore: 0,
            timestamp: ts,
          };
        }
        // token_count, agent_message, user_message, agent_reasoning mirror
        // response_items -> skip.
        continue;
      }

      // -- response_item ----------------------------------------------------
      if (raw.type === "response_item") {
        const it = payload.type as string | undefined;

        if (it === "message") {
          const role = payload.role as string | undefined;
          const text = joinTextContent(payload.content);
          if (role === "user" && text) {
            yield {
              type: "user_message",
              id: nextId(),
              parentId: null,
              text,
              timestamp: ts,
            };
          } else if (role === "assistant" && text) {
            yield {
              type: "assistant_message",
              id: nextId(),
              parentId: null,
              text,
              toolCalls: [],
              provider: "openai",
              model: "",
              timestamp: ts,
            };
          }
          continue;
        }

        if (it === "function_call" || it === "custom_tool_call") {
          const name = String(payload.name ?? "");
          const args =
            it === "custom_tool_call"
              ? coerceInput(payload.input)
              : parseArgs(payload.arguments);
          const callId = String(payload.call_id ?? nextId());

          const cmd = extractCommand(args);
          if (cmd) callCommands.set(callId, cmd);

          const tc: ToolCall = {
            type: "toolCall",
            id: callId,
            name,
            normalizedName: normalizeToolName(name, "codex", args),
            arguments: args,
          };
          yield {
            type: "assistant_message",
            id: nextId(),
            parentId: null,
            text: "",
            toolCalls: [tc],
            provider: "openai",
            model: "",
            timestamp: ts,
          };
          continue;
        }

        if (it === "function_call_output" || it === "custom_tool_call_output") {
          const callId = String(payload.call_id ?? "");
          const { output, isError } = parseToolOutput(payload.output);
          yield {
            type: "tool_result",
            id: nextId(),
            parentId: null,
            toolCallId: callId,
            toolName: "",
            content: output,
            isError,
            command: callCommands.get(callId),
            timestamp: ts,
          };
          continue;
        }

        if (it === "reasoning") {
          const summary = joinReasoningSummary(payload.summary);
          yield {
            type: "thinking",
            id: nextId(),
            parentId: null,
            summary: summary || "(thinking)",
            text: null,
            timestamp: ts,
          };
          continue;
        }

        if (it === "web_search_call") {
          const action = payload.action as Record<string, any> | undefined;
          const tc: ToolCall = {
            type: "toolCall",
            id: String(payload.call_id ?? nextId()),
            name: "web_search",
            normalizedName: normalizeToolName("web_search", "codex", {
              action,
            }),
            arguments: action ? { url: action.url } : {},
          };
          yield {
            type: "assistant_message",
            id: nextId(),
            parentId: null,
            text: "",
            toolCalls: [tc],
            provider: "openai",
            model: "",
            timestamp: ts,
          };
          continue;
        }

        // turn_context and other response_item types: skip.
        continue;
      }
    }
  } finally {
    rl.close();
  }

  if (headerSeen) {
    yield { type: "session_end" };
  }
}

// ---------------------------------------------------------------------------
// Detect
// ---------------------------------------------------------------------------

async function detect(filePath: string): Promise<boolean> {
  const first = await readFirstLine(filePath);
  if (!first) return false;
  try {
    const obj = JSON.parse(first);
    if (obj?.type === "session_meta") return true;
    // Fallback: {type, payload} envelope with a codex originator.
    return (
      obj?.payload != null &&
      typeof obj.payload === "object" &&
      (typeof obj.payload.originator === "string" ||
        typeof obj.payload.cli_version === "string")
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

async function* discover(opts: DiscoverOptions = {}): AsyncGenerator<string> {
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
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      // Filename: rollout-2025-09-25T13-42-49-<uuid>.jsonl
      if (sinceStr || untilStr) {
        const dateStr = entry.name.slice("rollout-".length, "rollout-".length + 10);
        if (sinceStr && dateStr < sinceStr) continue;
        if (untilStr && dateStr > untilStr) continue;
      }
      if (cwdPattern) {
        const first = await readFirstLine(full);
        let cwd = "";
        try {
          cwd = String(JSON.parse(first ?? "{}")?.payload?.cwd ?? "");
        } catch {
          // ignore
        }
        if (!cwd.toLowerCase().includes(cwdPattern)) continue;
      }
      yield full;
    }
  }

  yield* walk(root);
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export const source: SessionSource = {
  name: "codex",
  storageDir: () => SESSIONS_DIR,
  parse,
  detect,
  discover,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joinTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => typeof c?.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

function joinReasoningSummary(summary: unknown): string {
  if (typeof summary === "string") {
    // Sometimes serialized as a JSON string of summary blocks.
    try {
      const parsed = JSON.parse(summary);
      if (Array.isArray(parsed)) {
        return parsed
          .map((s: any) => (typeof s?.text === "string" ? s.text : ""))
          .filter(Boolean)
          .join(" ");
      }
    } catch {
      return summary;
    }
    return summary;
  }
  if (Array.isArray(summary)) {
    return summary
      .map((s: any) => (typeof s?.text === "string" ? s.text : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return { raw: args };
    }
  }
  if (args && typeof args === "object") return args as Record<string, unknown>;
  return {};
}

function coerceInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") return { raw: input };
  if (input && typeof input === "object") return input as Record<string, unknown>;
  return {};
}

/** Extract a human-readable command string from codex shell-style arguments. */
function extractCommand(args: Record<string, unknown>): string {
  const cmd = args.command ?? args.cmd;
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd)) {
    // ["bash", "-lc", "<script>"] -> the script; otherwise join.
    const flagIdx = cmd.findIndex((c) => c === "-lc" || c === "-c");
    if (flagIdx >= 0 && typeof cmd[flagIdx + 1] === "string") {
      return cmd[flagIdx + 1] as string;
    }
    return cmd.map((c) => String(c)).join(" ");
  }
  return "";
}

/**
 * Codex tool output is a JSON string like
 * `{"output":"...","metadata":{"exit_code":1,...}}`. Unwrap it and flag errors
 * from a non-zero exit code. Falls back to the raw string when not JSON.
 */
function parseToolOutput(output: unknown): { output: string; isError: boolean } {
  const raw = typeof output === "string" ? output : JSON.stringify(output ?? "");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const text =
        typeof parsed.output === "string" ? parsed.output : raw;
      const exit = parsed.metadata?.exit_code;
      const isError = typeof exit === "number" && exit !== 0;
      return { output: text, isError };
    }
  } catch {
    // not JSON
  }
  return { output: raw, isError: false };
}
