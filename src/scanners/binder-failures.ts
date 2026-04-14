/**
 * Scanner: binder CLI failures.
 *
 * Collects tool results and bash executions where binder commands failed.
 * No LLM needed -- extract just reshapes the candidate metadata.
 */

import type {
  Scanner,
  Candidate,
  ScanResult,
  MessageSlice,
  ContextualEvent,
  SessionEvent,
} from "../types.js";

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
// Helpers
// ---------------------------------------------------------------------------

function buildMessages(event: ContextualEvent): MessageSlice[] {
  const slices: MessageSlice[] = [];
  const turn = event.context.turn;

  if (turn) {
    slices.push({
      role: "user",
      text: truncate(turn.userMessage.text, 500),
      timestamp: turn.userMessage.timestamp,
    });

    for (const e of turn.events) {
      const s = eventToSlice(e);
      if (s) slices.push(s);
    }
  }

  const self = eventToSlice(event);
  if (self) slices.push(self);

  return slices;
}

function eventToSlice(e: SessionEvent): MessageSlice | null {
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
        command: e.command,
      };
    case "bash_execution":
      return {
        role: "bash",
        text: truncate(e.output, 500),
        timestamp: e.timestamp,
        command: e.command,
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
  description: "Find binder CLI errors in tool results and bash executions",

  async *collect(events) {
    for await (const event of events) {
      // Tool result errors
      if (event.type === "tool_result" && event.isError) {
        const commandMatch = event.command ? hasBinder(event.command) : false;
        const outputMatch = hasBinder(event.content);
        if (!commandMatch && !outputMatch) continue;

        const isTest =
          (event.command?.includes("bun test") ||
            event.command?.includes("vitest") ||
            event.content.includes("bun test")) ??
          false;

        const turnEvents = event.context.turn?.events ?? [];
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
            kind: isTest ? "test_failure" : "tool_error",
            command: event.command,
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
        continue;
      }

      // Bash execution errors
      if (event.type === "bash_execution") {
        if (event.exitCode === 0 || event.exitCode === undefined) continue;
        if (!hasBinder(event.command) && !hasBinder(event.output)) continue;

        const turnEvents2 = event.context.turn?.events ?? [];
        const priorErrorsInTurn = turnEvents2.filter(
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
            kind: "bash_error",
            command: event.command,
            errorText: truncate(event.output),
            userPrompt: event.context.turn?.userMessage.text
              ? truncate(event.context.turn.userMessage.text, 200)
              : undefined,
            priorErrorsInTurn,
            summary: truncate(
              event.output.split("\n").find((l) => l.trim()) ?? "unknown",
              120,
            ),
          },
        };
      }
    }
  },

  async extract(candidate) {
    const m = candidate.meta as BinderFailureData & {
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
