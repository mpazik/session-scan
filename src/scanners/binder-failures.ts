/**
 * Scanner: binder CLI failures.
 *
 * Collects failed tool results where binder commands errored. Bash runs are
 * just tool results (`normalizedName: "terminal"`) with a non-zero exit, so a
 * single tool_result branch covers shell and structured tools alike. The
 * command that produced a result is recovered from the originating tool call.
 * No LLM needed -- extract just reshapes the candidate metadata.
 */

import type {
  Scanner,
  MessageSlice,
  ContextualEvent,
} from "../scanner.js";
import type { SessionEvent, ToolCall } from "../session.js";

// ---------------------------------------------------------------------------
// Data shape
// ---------------------------------------------------------------------------

export interface BinderFailureData {
  kind: "tool_error" | "bash_error" | "test_failure";
  command?: string;
  toolName?: string;
  errorText: string;
  userPrompt?: string;
  priorErrorsInTurn: number;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const BINDER_KEYWORDS = [
  "binder ",
  "binder\n",
  'binder"',
  "binder'",
  "/binder",
  "@binder/",
];

const BINDER_ERROR_PATTERNS = [
  "workspace-not-found",
  "changeset-input-process-failed",
  "cannot_determine_type",
];

function hasBinder(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.startsWith("binder")) return true;
  for (const kw of BINDER_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  for (const p of BINDER_ERROR_PATTERNS) {
    if (lower.includes(p)) return true;
  }
  return false;
}

function truncate(text: string, maxLen = 300): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

// ---------------------------------------------------------------------------
// Tool-call correlation
// ---------------------------------------------------------------------------

/** Find the tool call that produced a result, within the turn's events. */
function toolCallFor(
  toolCallId: string,
  turnEvents: SessionEvent[],
): ToolCall | undefined {
  for (const e of turnEvents) {
    if (e.type !== "assistant_message") continue;
    for (const call of e.toolCalls) {
      if (call.id === toolCallId) return call;
    }
  }
  return undefined;
}

/** Pull a shell command string out of a tool call's arguments, when present. */
function commandOf(call: ToolCall | undefined): string | undefined {
  if (!call) return undefined;
  const c = call.arguments.command ?? call.arguments.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((x) => typeof x === "string").join(" ") || undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMessages(event: ContextualEvent): MessageSlice[] {
  const slices: MessageSlice[] = [];
  const turn = event.context.turn;
  const turnEvents = turn?.events ?? [];

  if (turn) {
    slices.push({
      role: "user",
      text: truncate(turn.userMessage.text, 500),
      timestamp: turn.userMessage.timestamp,
    });

    for (const e of turn.events) {
      const s = eventToSlice(e, turnEvents);
      if (s) slices.push(s);
    }
  }

  const self = eventToSlice(event, turnEvents);
  if (self) slices.push(self);

  return slices;
}

function eventToSlice(
  e: SessionEvent,
  turnEvents: SessionEvent[],
): MessageSlice | null {
  switch (e.type) {
    case "assistant_message":
      return {
        role: "assistant",
        text: truncate(e.text, 500),
        timestamp: e.timestamp,
        toolCalls: e.toolCalls,
      };
    case "tool_result":
      return {
        role: "tool_result",
        text: truncate(e.content, 500),
        timestamp: e.timestamp,
        isError: e.isError,
        command: commandOf(toolCallFor(e.toolCallId, turnEvents)),
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export const scanner: Scanner<BinderFailureData> = {
  name: "binder-failures",
  description: "Find binder CLI errors in failed tool results",

  async *collect(events) {
    for await (const event of events) {
      if (event.type !== "tool_result" || !event.isError) continue;

      const turnEvents = event.context.turn?.events ?? [];
      const call = toolCallFor(event.toolCallId, turnEvents);
      const command = commandOf(call);

      const commandMatch = command ? hasBinder(command) : false;
      const outputMatch = hasBinder(event.content);
      if (!commandMatch && !outputMatch) continue;

      const isTest =
        command?.includes("bun test") ||
        command?.includes("vitest") ||
        event.content.includes("bun test") ||
        false;
      const isBash =
        call?.normalizedName === "terminal" || event.exitCode != null;
      const kind = isTest ? "test_failure" : isBash ? "bash_error" : "tool_error";

      const priorErrorsInTurn = turnEvents.filter(
        (e) => e.type === "tool_result" && e.isError,
      ).length;

      yield {
        id: `${event.context.sessionPath}:${event.id}`,
        sessionPath: event.context.sessionPath,
        cwd: event.context.cwd,
        timestamp: event.timestamp,
        messages: buildMessages(event),
        meta: {
          entryId: event.id,
          kind,
          command,
          toolName: event.toolName,
          errorText: truncate(event.content),
          userPrompt: event.context.turn?.userMessage.text
            ? truncate(event.context.turn.userMessage.text, 200)
            : undefined,
          priorErrorsInTurn,
          summary: truncate(
            event.content.split("\n").find((l) => l.trim()) ?? "unknown",
            120,
          ),
        },
      };
    }
  },

  async extract(candidate) {
    const m = candidate.meta as unknown as BinderFailureData & {
      entryId: string;
      summary: string;
    };
    return [
      {
        kind: m.kind,
        summary: m.summary,
        entryId: m.entryId,
        timestamp: candidate.timestamp,
        sessionPath: candidate.sessionPath,
        cwd: candidate.cwd,
        data: {
          kind: m.kind,
          command: m.command,
          toolName: m.toolName,
          errorText: m.errorText,
          userPrompt: m.userPrompt,
          priorErrorsInTurn: m.priorErrorsInTurn,
        },
      },
    ];
  },
};
