/**
 * Pi adapter (EXAMPLE).
 *
 * Reference implementation of the `SessionSource` contract, emitting the
 * canonical session.ts model. Pi is not built in; this shows everything a
 * custom adapter needs: implement the interface, export it as default, then
 * drop the file into ~/.session-scan/adapters/ or pass `--adapter <path>`.
 *
 * Pi's on-disk shape is already close to the canonical model: assistant
 * entries embed `toolCall`/`text` blocks, so they map onto one
 * `assistant_message` directly. Harness-specific entries (model_change,
 * thinking_level_change, bashExecution) collapse into `custom_message`; the
 * leading model_change also seeds session_start.model, so the start event is
 * held until that model is known.
 *
 * A published adapter would import these from the "session-scan" package
 * instead of reaching into the repo.
 */

import { readdir } from "fs/promises";
import { join } from "path";
import type { SessionEvent, SessionStartEvent, SessionMetadata, ToolCall, TokenUsage } from "../../src/session.js";
import { FORMAT_VERSION } from "../../src/session.js";
import type { Adapter } from "../../src/parser/adapter.js";
import { normalizeToolName } from "../../src/parser/tool-names.js";
import { readJsonValues, readFirstJsonValue } from "../../src/parser/read-lines.js";

const SESSIONS_DIR = join(process.env.HOME || "~", ".pi", "agent", "sessions");

export default {
  name: "pi",
  storageDir: () => SESSIONS_DIR,

  async *parse(filePath, opts = {}) {
    let headerSeen = false;
    let lastTs = "";
    // Hold session_start until the model is known (pi's leading model_change)
    // or the first message arrives. Preamble events buffer in `held`.
    let start: SessionStartEvent | null = null;
    const held: SessionEvent[] = [];
    function* flushStart(): Generator<SessionEvent> {
      if (!start) return;
      const s = start;
      start = null;
      yield s;
      while (held.length) yield held.shift()!;
    }
    function* hold(ev: SessionEvent): Generator<SessionEvent> {
      if (start) held.push(ev);
      else yield ev;
    }
    function* out(ev: SessionEvent): Generator<SessionEvent> {
      yield* flushStart();
      yield ev;
    }

    for await (const value of readJsonValues(filePath)) {
      const raw = value as any;

      if (raw.type === "session") {
        const cwd = String(raw.cwd ?? "");
        if (opts.cwdFilter && !cwd.toLowerCase().includes(opts.cwdFilter.toLowerCase())) return;
        if (raw.timestamp && opts.since && new Date(raw.timestamp) < opts.since) return;
        if (raw.timestamp && opts.until && new Date(raw.timestamp) > opts.until) return;
        const header: SessionMetadata = {
          agent: "pi",
          id: String(raw.id ?? ""),
          timestamp: String(raw.timestamp ?? ""),
          cwd,
          parentSession: raw.parentSession ? String(raw.parentSession) : undefined,
        };
        headerSeen = true;
        lastTs = header.timestamp;
        start = { type: "session_start", formatVersion: FORMAT_VERSION, path: filePath, ...header };
        continue;
      }
      if (!headerSeen) return; // malformed file

      const id: string = raw.id ?? "";
      const parentId: string | null = raw.parentId ?? null;
      const timestamp: string = raw.timestamp ?? "";
      if (timestamp) lastTs = timestamp;

      if (raw.type === "message") {
        const msg = raw.message;
        if (!msg) continue;

        if (msg.role === "user") {
          yield* out({ type: "user_message", id, parentId, text: extractText(msg.content), timestamp });
        } else if (msg.role === "assistant") {
          const content = msg.content ?? [];
          const toolCalls: ToolCall[] = [];
          for (const b of content) {
            if (b?.type !== "toolCall") continue;
            const args = b.arguments ?? {};
            toolCalls.push({ id: b.id, name: b.name, normalizedName: normalizeToolName(b.name, "pi", args), arguments: args });
          }
          yield* out({
            type: "assistant_message",
            id,
            parentId,
            text: extractText(content),
            toolCalls,
            provider: msg.provider ?? "",
            model: msg.model ?? "",
            stopReason: msg.stopReason,
            usage: extractUsage(msg.usage),
            timestamp,
          });
        } else if (msg.role === "toolResult") {
          yield* out({ type: "tool_result", id, parentId, toolCallId: msg.toolCallId ?? "", toolName: msg.toolName ?? "", content: extractText(msg.content ?? []), isError: msg.isError === true, timestamp });
        } else if (msg.role === "bashExecution") {
          const exit = msg.exitCode != null ? ` (exit ${msg.exitCode})` : "";
          yield* out({ type: "custom_message", id, parentId, customType: "bash_execution", content: `$ ${msg.command ?? ""}${exit}\n${msg.output ?? ""}`, timestamp });
        }
        // compactionSummary / branchSummary / custom roles: skip.
        continue;
      }

      if (raw.type === "compaction") {
        yield* out({ type: "compaction", id, parentId, summary: String(raw.summary ?? "") || undefined, tokensBefore: Number(raw.tokensBefore ?? 0) || undefined, timestamp });
      } else if (raw.type === "model_change") {
        if (start && !start.model && raw.modelId) start.model = String(raw.modelId);
        yield* hold({ type: "custom_message", id, parentId, customType: "model_change", content: `${raw.provider ?? ""}/${raw.modelId ?? ""}`, timestamp });
      } else if (raw.type === "thinking_level_change") {
        yield* hold({ type: "custom_message", id, parentId, customType: "thinking_level_change", content: String(raw.thinkingLevel ?? ""), timestamp });
      } else if (raw.type === "custom_message") {
        yield* hold({ type: "custom_message", id, parentId, customType: String(raw.customType ?? ""), content: extractText(raw.content), timestamp });
      }
      // label, session_info, branch_summary: skip.
    }

    yield* flushStart();
  },

  async detect(filePath) {
    const first = (await readFirstJsonValue(filePath)) as any;
    return first?.type === "session" && typeof first.id === "string" && typeof first.cwd === "string" && first.payload == null;
  },

  async *discover(opts = {}) {
    const sessionsDir = opts.sessionsDir ?? SESSIONS_DIR;
    const cwdPattern = opts.cwdFilter?.toLowerCase();
    const sinceStr = opts.since?.toISOString().slice(0, 10);
    const untilStr = opts.until?.toISOString().slice(0, 10);

    let dirs: import("fs").Dirent[];
    try {
      dirs = await readdir(sessionsDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      if (cwdPattern && !entry.name.toLowerCase().replace(/--/g, "/").replace(/-/g, "/").includes(cwdPattern)) continue;

      const dirPath = join(sessionsDir, entry.name);
      let files: import("fs").Dirent[];
      try {
        files = await readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        // Filename starts with an ISO date: 2026-03-13T07-14-20-231Z_...
        if (sinceStr || untilStr) {
          const dateStr = file.name.slice(0, 10);
          if (sinceStr && dateStr < sinceStr) continue;
          if (untilStr && dateStr > untilStr) continue;
        }
        yield join(dirPath, file.name);
      }
    }
  },
} satisfies Adapter;

// -- helpers -----------------------------------------------------------------

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
}

/** Pi usage: cache buckets are already separate; `cost.total` is precomputed. */
function extractUsage(usage: any): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    input: typeof usage.input === "number" ? usage.input : undefined,
    output: typeof usage.output === "number" ? usage.output : undefined,
    cacheRead: usage.cacheRead || undefined,
    cacheWrite: usage.cacheWrite || undefined,
    total: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
    costUsd: typeof usage.cost?.total === "number" ? usage.cost.total : undefined,
  };
}
