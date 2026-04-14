/**
 * Streaming pi session parser.
 *
 * Reads JSONL line by line and yields SessionEvent objects. Never holds the
 * full session in memory. Tool results include the resolved bash command from
 * the originating assistant tool call (tracked via a small internal map).
 *
 * Usage:
 *   for await (const event of streamSession(filePath, opts)) {
 *     if (event.type === "tool_result" && event.isError) { ... }
 *   }
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { readdir } from "fs/promises";
import { join } from "path";
import type {
  SessionHeader,
  SessionEvent,
  ToolCall,
  TextContent,
  RawEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

export interface StreamOptions {
  /** Skip the file if the header timestamp is before this date. */
  since?: Date;
  /** Skip the file if the header timestamp is after this date. */
  until?: Date;
  /** Skip files whose cwd does not contain this substring (case-insensitive). */
  cwdFilter?: string;
}

// ---------------------------------------------------------------------------
// Stream a single session file
// ---------------------------------------------------------------------------

/**
 * Stream events from a pi session JSONL file.
 *
 * Yields a `session_start` event first (with the header), then one event per
 * meaningful entry, and finally a `session_end`. If the file doesn't match
 * filters, yields nothing.
 *
 * The generator tracks assistant tool calls internally so that `tool_result`
 * events include the resolved `command` field.
 */
export async function* streamSession(
  filePath: string,
  opts: StreamOptions = {},
): AsyncGenerator<SessionEvent> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  // Track toolCallId -> bash command for resolving tool results
  const toolCallCommands = new Map<string, string>();
  let headerSeen = false;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let raw: any;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }

      // -- Session header ---------------------------------------------------
      if (raw.type === "session") {
        const header = raw as SessionHeader;

        if (
          opts.cwdFilter &&
          !header.cwd.toLowerCase().includes(opts.cwdFilter.toLowerCase())
        ) {
          return;
        }
        if (opts.since && new Date(header.timestamp) < opts.since) {
          return;
        }
        if (opts.until && new Date(header.timestamp) > opts.until) {
          return;
        }

        headerSeen = true;
        yield { type: "session_start", header, path: filePath };
        continue;
      }

      if (!headerSeen) return; // malformed file

      const entry = raw as RawEntry;

      // -- message entries --------------------------------------------------
      if (entry.type === "message") {
        const msg = (entry as any).message;
        if (!msg) continue;

        switch (msg.role) {
          case "user": {
            const text = extractText(msg.content);
            yield {
              type: "user_message",
              id: entry.id,
              parentId: entry.parentId,
              text,
              timestamp: entry.timestamp,
            };
            break;
          }

          case "assistant": {
            const content = msg.content ?? [];
            const text = extractText(content);
            const toolCalls: ToolCall[] = [];

            for (const block of content) {
              if (block?.type === "toolCall") {
                const tc: ToolCall = {
                  type: "toolCall",
                  id: block.id,
                  name: block.name,
                  arguments: block.arguments ?? {},
                };
                toolCalls.push(tc);

                // Track bash commands for tool result resolution
                if (tc.name === "bash") {
                  const cmd = String(
                    (tc.arguments as { command?: string }).command ?? "",
                  );
                  toolCallCommands.set(tc.id, cmd);
                }
              }
            }

            yield {
              type: "assistant_message",
              id: entry.id,
              parentId: entry.parentId,
              text,
              toolCalls,
              provider: msg.provider ?? "",
              model: msg.model ?? "",
              stopReason: msg.stopReason,
              errorMessage: msg.errorMessage,
              timestamp: entry.timestamp,
            };
            break;
          }

          case "toolResult": {
            const content = extractText(msg.content ?? []);
            const command = toolCallCommands.get(msg.toolCallId);

            yield {
              type: "tool_result",
              id: entry.id,
              parentId: entry.parentId,
              toolCallId: msg.toolCallId ?? "",
              toolName: msg.toolName ?? "",
              content,
              isError: msg.isError === true,
              command,
              timestamp: entry.timestamp,
            };
            break;
          }

          case "bashExecution": {
            yield {
              type: "bash_execution",
              id: entry.id,
              parentId: entry.parentId,
              command: msg.command ?? "",
              output: msg.output ?? "",
              exitCode: msg.exitCode,
              cancelled: msg.cancelled === true,
              timestamp: entry.timestamp,
            };
            break;
          }

          // Skip roles we don't need to expose (compactionSummary, branchSummary, custom)
          // compactionSummary/branchSummary are synthesized by buildSessionContext, not stored
          default:
            break;
        }
        continue;
      }

      // -- Non-message entry types ------------------------------------------
      switch (entry.type) {
        case "compaction":
          yield {
            type: "compaction",
            id: entry.id,
            parentId: entry.parentId,
            summary: String((entry as any).summary ?? ""),
            tokensBefore: Number((entry as any).tokensBefore ?? 0),
            timestamp: entry.timestamp,
          };
          break;

        case "model_change":
          yield {
            type: "model_change",
            id: entry.id,
            parentId: entry.parentId,
            provider: String((entry as any).provider ?? ""),
            modelId: String((entry as any).modelId ?? ""),
            timestamp: entry.timestamp,
          };
          break;

        case "thinking_level_change":
          yield {
            type: "thinking_level_change",
            id: entry.id,
            parentId: entry.parentId,
            thinkingLevel: String((entry as any).thinkingLevel ?? ""),
            timestamp: entry.timestamp,
          };
          break;

        case "custom_message":
          yield {
            type: "custom_message",
            id: entry.id,
            parentId: entry.parentId,
            customType: String((entry as any).customType ?? ""),
            content: extractText((entry as any).content),
            display: (entry as any).display === true,
            timestamp: entry.timestamp,
          };
          break;

        // label, session_info, custom, branch_summary: skip for now
        default:
          break;
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
// Discover session files
// ---------------------------------------------------------------------------

const SESSIONS_DIR = join(
  process.env.HOME || "~",
  ".pi",
  "agent",
  "sessions",
);

export interface DiscoverOptions {
  /** Only yield files from directories matching this cwd substring (case-insensitive). */
  cwdFilter?: string;
  /** Only yield files with timestamps on or after this date. */
  since?: Date;
  /** Only yield files with timestamps on or before this date. */
  until?: Date;
}

/**
 * Find .jsonl session files under the pi sessions directory.
 *
 * Filters by directory name (cwd) and filename timestamp prefix
 * so we never open files that can't match.
 */
export async function* discoverSessionFiles(
  sessionsDir: string = SESSIONS_DIR,
  opts: DiscoverOptions = {},
): AsyncGenerator<string> {
  let dirs: import("fs").Dirent[];
  try {
    dirs = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }

  const cwdPattern = opts.cwdFilter?.toLowerCase();

  // Pre-compute date strings for comparison (ISO dates sort lexicographically)
  const sinceStr = opts.since?.toISOString().slice(0, 10);
  const untilStr = opts.until?.toISOString().slice(0, 10);

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;

    // cwd filter: match on directory name
    if (cwdPattern) {
      const dirLower = entry.name.toLowerCase().replace(/--/g, "/").replace(/-/g, "/");
      if (!dirLower.includes(cwdPattern)) continue;
    }

    const dirPath = join(sessionsDir, entry.name);

    let files: import("fs").Dirent[];
    try {
      files = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;

      // Filename starts with ISO date: 2026-03-13T07-14-20-231Z_...
      // String comparison works because ISO dates sort lexicographically.
      if (sinceStr || untilStr) {
        const dateStr = file.name.slice(0, 10);
        if (sinceStr && dateStr < sinceStr) continue;
        if (untilStr && dateStr > untilStr) continue;
      }

      yield join(dirPath, file.name);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c: any) => c?.type === "text" && typeof c.text === "string",
    )
    .map((c: any) => c.text)
    .join("\n");
}
