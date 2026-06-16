/**
 * Scanner (EXAMPLE): binder CLI failures.
 *
 * A scanner is one async generator per session. It consumes the session's
 * contextual event stream and emits `ScanEvent`s — partial events where `type`
 * is the only required field and arbitrary extra fields (findings) are allowed.
 *
 * This one keeps errored tool_results whose command or output mentions binder,
 * annotates each with a `finding`, drops everything else, and emits a trailing
 * per-session summary when the input ends. Bash runs are just tool results with
 * `normalizedName: "terminal"` and a non-zero exit, so one tool_result branch
 * covers shell and structured tools alike. No LLM, no cross-session rollups
 * (that's DuckDB downstream).
 *
 * Loaded by path: `scan --cwd binder --scanner ./examples/scanners/binder-failures.ts`.
 *
 * A published scanner would import these from the "session-scan" package
 * instead of reaching into the repo.
 */

import type {
  Scanner,
  ContextualEvent,
} from "../../src/scanner.js";
import type { SessionEvent, ToolCall } from "../../src/session.js";
import { truncate } from "../../src/lib/string.js";

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
  for (const kw of BINDER_KEYWORDS) if (lower.includes(kw)) return true;
  for (const p of BINDER_ERROR_PATTERNS) if (lower.includes(p)) return true;
  return false;
}

/** Find the tool call that produced a result, within the turn's events. */
function toolCallFor(
  toolCallId: string,
  turnEvents: SessionEvent[],
): ToolCall | undefined {
  for (const e of turnEvents) {
    if (e.type !== "assistant_message") continue;
    for (const call of e.toolCalls) if (call.id === toolCallId) return call;
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

type FailureKind = "tool_error" | "bash_error" | "test_failure";

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const scanner: Scanner = async function* (events, session) {
  const byKind: Record<FailureKind, number> = {
    tool_error: 0,
    bash_error: 0,
    test_failure: 0,
  };
  let findings = 0;

  for await (const ev of events as AsyncGenerator<ContextualEvent>) {
    if (ev.type !== "tool_result" || !ev.isError) continue;

    const turnEvents = ev.context.turn?.events ?? [];
    const call = toolCallFor(ev.toolCallId, turnEvents);
    const command = commandOf(call);

    const commandMatch = command ? hasBinder(command) : false;
    const outputMatch = hasBinder(ev.content);
    if (!commandMatch && !outputMatch) continue;

    const isTest =
      command?.includes("bun test") ||
      command?.includes("vitest") ||
      ev.content.includes("bun test") ||
      false;
    const isBash = call?.normalizedName === "terminal" || ev.exitCode != null;
    const kind: FailureKind = isTest
      ? "test_failure"
      : isBash
        ? "bash_error"
        : "tool_error";

    const priorErrorsInTurn = turnEvents.filter(
      (e) => e.type === "tool_result" && e.isError,
    ).length;

    byKind[kind]++;
    findings++;

    yield {
      ...ev,
      finding: {
        scanner: "binder-failures",
        kind,
        command,
        toolName: ev.toolName,
        errorText: truncate(ev.content),
        userPrompt: ev.context.turn?.userMessage.text
          ? truncate(ev.context.turn.userMessage.text, 200)
          : undefined,
        priorErrorsInTurn,
        summary: truncate(
          ev.content.split("\n").find((l) => l.trim()) ?? "unknown",
          120,
        ),
      },
    };
  }

  // Per-session summary, emitted once the input ends.
  yield {
    type: "custom_message",
    customType: "scan_summary",
    scanner: "binder-failures",
    sessionId: session.id,
    cwd: session.cwd,
    findings,
    byKind,
  };
};

export default scanner;
