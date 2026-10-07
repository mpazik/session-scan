/**
 * Pi adapter (EXAMPLE).
 *
 * Reference implementation of the `Adapter` contract, emitting the canonical
 * session.ts model. Pi is not built in; this shows everything a custom
 * adapter needs: implement the interface, export it as default, then drop the
 * file into ~/.session-scan/adapters/ or pass `--adapter <path>`.
 *
 * The contract is mostly declarative; the framework does the generic work.
 * `toolNames` maps native tool names onto canonical ones (the framework
 * stamps `toolCall.normalizedName`), `parse` maps Pi's skill envelope to a
 * canonical `skill_invocation`, `discover` describes the storage layout (the
 * framework walks it and applies cwd/date filters), and `detect` checks the
 * first JSON value (the framework reads it).
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

import { join } from "path";
import type {
  SessionEvent,
  SessionStartEvent,
  SessionMetadata,
  SkillInvocationEvent,
  ToolCall,
  TokenUsage,
} from "../../src/session.js";
import { FORMAT_VERSION } from "../../src/session.js";
import type { Adapter } from "../../src/parser/adapter.js";
import { readJsonValues } from "../../src/parser/read-lines.js";
import { joinTextBlocks } from "../../src/parser/content.js";
import { selectHeadPath, type NativeTreeEntry } from "../../src/parser/select-head.js";

const SESSIONS_DIR = join(process.env.HOME || "~", ".pi", "agent", "sessions");

export default {
  name: "pi",
  storageDir: () => SESSIONS_DIR,

  toolNames: {
    bash: "terminal",
    read: "file_read",
    edit: "file_edit",
    write: "file_write",
    find: "file_search",
    glob: "file_search",
    ls: "file_search",
    grep: "content_search",
  },

  async *parse(filePath, headId?: string) {
    let headerSeen = false;
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

    const values = headId
      ? readPiHeadValues(filePath, headId)
      : readJsonValues(filePath);
    for await (const value of values) {
      const raw = value as any;

      if (raw.type === "session") {
        const header: SessionMetadata = {
          agent: "pi",
          id: String(raw.id ?? ""),
          timestamp: String(raw.timestamp ?? ""),
          cwd: String(raw.cwd ?? ""),
          parentSession: raw.parentSession ? String(raw.parentSession) : undefined,
        };
        headerSeen = true;
        start = { type: "session_start", formatVersion: FORMAT_VERSION, path: filePath, ...header };
        continue;
      }
      if (!headerSeen) return; // malformed file

      const id: string = raw.id ?? "";
      const parentId: string | null = raw.parentId ?? null;
      const timestamp: string = raw.timestamp ?? "";

      if (raw.type === "message") {
        const msg = raw.message;
        if (!msg) continue;

        if (msg.role === "system") {
          // System messages patch prompt sections by name; only a patch that
          // sets or removes project_context changes the instruction files.
          const sections = msg.sections;
          if (sections && typeof sections === "object" && "project_context" in sections) {
            yield* hold(instructionFilesEvent(id, parentId, timestamp, sections.project_context));
          }
        } else if (msg.role === "user") {
          const text = joinTextBlocks(msg.content);
          yield* out({ type: "user_message", id, parentId, text, timestamp });
          const skill = parsePiSkillInvocation(text);
          if (skill) {
            yield* out({
              type: "skill_invocation",
              id: `${id}:skill`,
              parentId: id,
              timestamp,
              sourceEventId: id,
              ...skill,
            });
          }
        } else if (msg.role === "assistant") {
          const content = msg.content ?? [];
          const toolCalls: ToolCall[] = [];
          for (const b of content) {
            if (b?.type !== "toolCall") continue;
            const args = b.arguments ?? {};
            toolCalls.push({ id: b.id, name: b.name, arguments: args });
          }
          yield* out({
            type: "assistant_message",
            id,
            parentId,
            text: joinTextBlocks(content),
            toolCalls,
            provider: msg.provider ?? "",
            model: msg.model ?? "",
            stopReason: msg.stopReason,
            usage: extractUsage(msg.usage),
            timestamp,
          });
          for (let i = 0; i < toolCalls.length; i++) {
            const call = toolCalls[i]!;
            const skill = skillInvocationFromPiTool(call);
            if (!skill) continue;
            yield* out({
              type: "skill_invocation",
              id: `${id}:skill:${call.id || i}`,
              parentId: id,
              timestamp,
              sourceEventId: id,
              ...skill,
            });
          }
        } else if (msg.role === "toolResult") {
          yield* out({ type: "tool_result", id, parentId, toolCallId: msg.toolCallId ?? "", toolName: msg.toolName ?? "", content: joinTextBlocks(msg.content ?? []), isError: msg.isError === true, timestamp });
        } else if (msg.role === "bashExecution") {
          const exit = msg.exitCode != null ? ` (exit ${msg.exitCode})` : "";
          yield* out({ type: "custom_message", id, parentId, customType: "bash_execution", content: `$ ${msg.command ?? ""}${exit}\n${msg.output ?? ""}`, timestamp });
        }
        // compactionSummary / branchSummary / custom roles: skip.
        continue;
      }

      if (raw.type === "compaction") {
        yield* out({ type: "compaction", id, parentId, summary: String(raw.summary ?? "") || undefined, tokensBefore: Number(raw.tokensBefore ?? 0) || undefined, timestamp });
        // The checkpoint replaces the whole prompt, so an absent section means none.
        const sections = raw.systemMessage?.sections;
        if (sections && typeof sections === "object") {
          yield* out(instructionFilesEvent(`${id}:instructions`, id, timestamp, sections.project_context));
        }
      } else if (raw.type === "model_change") {
        if (start && !start.model && raw.modelId) start.model = String(raw.modelId);
        yield* hold({ type: "custom_message", id, parentId, customType: "model_change", content: `${raw.provider ?? ""}/${raw.modelId ?? ""}`, timestamp });
      } else if (raw.type === "thinking_level_change") {
        yield* hold({ type: "custom_message", id, parentId, customType: "thinking_level_change", content: String(raw.thinkingLevel ?? ""), timestamp });
      } else if (raw.type === "custom_message") {
        yield* hold({ type: "custom_message", id, parentId, customType: String(raw.customType ?? ""), content: joinTextBlocks(raw.content), timestamp });
      }
      // label, session_info, branch_summary: skip.
    }

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
    const f = first as any;
    return f?.type === "session" && typeof f.id === "string" && typeof f.cwd === "string" && f.payload == null;
  },

  // Layout: <sessions>/<slugged-cwd>/2026-03-13T07-14-20-231Z_<id>.jsonl.
  // The dir slug is lossy ("-" is both "/" and a literal hyphen), so the cwd
  // comes from the session header in the file's first JSON value.
  discover: {
    match: (name) => name.endsWith(".jsonl"),
    dateOf: (name) => name.slice(0, 10),
    cwdOf: (first) => String((first as any)?.cwd ?? ""),
  },
} satisfies Adapter;

// -- helpers -----------------------------------------------------------------

type PiTreeEntry = NativeTreeEntry & Record<string, unknown>;

/** Pi head IDs are stable native entry `id` values, including skipped entries. */
async function* readPiHeadValues(
  filePath: string,
  headId: string,
): AsyncGenerator<unknown> {
  const headers: unknown[] = [];
  const entries: PiTreeEntry[] = [];
  let found = false;

  for await (const value of readJsonValues(filePath)) {
    const raw = value as Record<string, unknown>;
    if (raw.type === "session") {
      headers.push(value);
      continue;
    }
    if (typeof raw.id !== "string") continue;
    entries.push({
      ...raw,
      id: raw.id,
      parentId: typeof raw.parentId === "string" ? raw.parentId : null,
    });
    if (raw.id === headId) {
      found = true;
      break;
    }
  }

  if (!found) {
    throw new Error(`head "${headId}" was not found in ${filePath}`);
  }
  for (const header of headers) yield header;
  yield* selectHeadPath(entries, headId);
}

/**
 * Instruction files loaded into the prompt, from Pi's `project_context`
 * section. Content is the complete list in effect from this event onward.
 */
function instructionFilesEvent(
  id: string,
  parentId: string | null,
  timestamp: string,
  projectContext: unknown,
): SessionEvent {
  const paths = typeof projectContext === "string"
    ? [...projectContext.matchAll(/<project_instructions path="([^"]*)">/g)].map((m) => m[1]!)
    : [];
  return { type: "custom_message", id, parentId, customType: "instruction_files", content: paths, timestamp };
}

function skillInvocationFromPiTool(
  call: ToolCall,
): Pick<SkillInvocationEvent, "name" | "arguments"> | null {
  if (call.name !== "Skill") return null;
  if (
    !call.arguments ||
    typeof call.arguments !== "object" ||
    Array.isArray(call.arguments)
  ) return null;
  const { name, ...args } = call.arguments;
  if (typeof name !== "string" || !name) return null;
  return {
    name,
    ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
  };
}

/** Pi injects invoked skill content as a leading XML-like user envelope. */
export function parsePiSkillInvocation(
  text: string,
): Pick<SkillInvocationEvent, "name" | "path"> | null {
  const attrs = parseOpeningSkillElement(text);
  if (!attrs) return null;

  const name = attrs.get("name");
  const path = attrs.get("location");
  if (name === undefined || path === undefined) return null;
  if (!/(?:^|[\\/])SKILL\.md$/.test(path)) return null;
  return { name, path };
}

function parseOpeningSkillElement(text: string): Map<string, string> | null {
  let pos = 0;
  while (pos < text.length && isXmlWhitespace(text[pos]!)) pos++;
  if (!text.startsWith("<skill", pos)) return null;
  pos += "<skill".length;

  const tagBoundary = text[pos];
  if (
    tagBoundary !== ">" &&
    tagBoundary !== "/" &&
    !isXmlWhitespace(tagBoundary)
  ) {
    return null;
  }

  const attrs = new Map<string, string>();
  while (pos < text.length) {
    const boundaryStart = pos;
    while (pos < text.length && isXmlWhitespace(text[pos]!)) pos++;

    if (text[pos] === ">") return attrs;
    if (text[pos] === "/" && text[pos + 1] === ">") return attrs;
    if (pos === boundaryStart) return null;

    const nameStart = pos;
    if (!isXmlNameStart(text[pos])) return null;
    pos++;
    while (pos < text.length && isXmlNameChar(text[pos]!)) pos++;
    const attrName = text.slice(nameStart, pos);

    while (pos < text.length && isXmlWhitespace(text[pos]!)) pos++;
    if (text[pos] !== "=") return null;
    pos++;
    while (pos < text.length && isXmlWhitespace(text[pos]!)) pos++;

    const quote = text[pos];
    if (quote !== '"' && quote !== "'") return null;
    pos++;
    const valueStart = pos;
    while (pos < text.length && text[pos] !== quote) pos++;
    if (pos >= text.length) return null;
    const value = text.slice(valueStart, pos);
    pos++;

    if (attrs.has(attrName)) return null;
    attrs.set(attrName, value);
  }

  return null;
}

function isXmlWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function isXmlNameStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_:]/.test(char);
}

function isXmlNameChar(char: string): boolean {
  return /[A-Za-z0-9_.:-]/.test(char);
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
