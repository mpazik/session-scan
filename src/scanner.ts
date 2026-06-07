/**
 * Scanner framework: turn context, candidates, results, and the Scanner
 * contract. These are orchestration types, layered on top of the canonical
 * session model in `session.ts` (which they import). Kept out of `session.ts`
 * so the wire model stays self-contained.
 */

import type { SessionEvent, UserMessageEvent, ToolCall } from "./session.js";

// -- Context-enriched events -------------------------------------------------

/** A turn: a user message plus everything the agent did in response. */
export interface Turn {
  /** The user message that started this turn. */
  userMessage: UserMessageEvent;
  /** All events since that user message (assistant messages, tool results). */
  events: SessionEvent[];
}

export interface EventContext {
  /** Current turn (null before the first user message). */
  turn: Turn | null;
  /** Previous turn (null before the second user message). */
  prevTurn: Turn | null;
  /** Active model, tracked from each assistant message. */
  model: string;
  /** Session path. */
  sessionPath: string;
  /** Session cwd. */
  cwd: string;
  /** Session start timestamp. */
  sessionTimestamp: string;
}

export type ContextualEvent<T extends SessionEvent = SessionEvent> = T & {
  context: EventContext;
};

// -- Use case framework ------------------------------------------------------

/**
 * A message in a candidate's context window. Flattened representation suitable
 * for LLM prompts or pattern matching.
 */
export interface MessageSlice {
  role: "user" | "assistant" | "tool_result" | "system";
  text: string;
  timestamp: string;
  /** For tool_result: was it an error? */
  isError?: boolean;
  /** For tool_result: the command that produced it, when recoverable. */
  command?: string;
  /** For assistant: tool calls made. */
  toolCalls?: ToolCall[];
}

/**
 * A bounded chunk of session context worth analyzing. Produced by a scanner's
 * collect phase, consumed by its extract phase.
 */
export interface Candidate {
  /** Stable id for dedup (e.g. sessionPath:entryId). */
  id: string;
  /** Session file path. */
  sessionPath: string;
  /** Session cwd. */
  cwd: string;
  /** When this candidate was found. */
  timestamp: string;
  /** Bounded context: the messages/events around the point of interest. */
  messages: MessageSlice[];
  /** Use-case-defined metadata passed from collect to extract. */
  meta: Record<string, unknown>;
}

/** A result produced by a scanner. */
export interface ScanResult<T = unknown> {
  /** Use-case-defined category. */
  kind: string;
  /** Human-readable one-liner. */
  summary: string;
  /** Entry id where the finding was made. */
  entryId: string;
  /** When it happened. */
  timestamp: string;
  /** Session path. */
  sessionPath: string;
  /** Session cwd. */
  cwd: string;
  /** Use-case-specific structured data. */
  data: T;
}

/**
 * A scanner definition.
 *
 * collect: fast, streams contextual events, yields candidates with bounded
 * context. extract: slower, analyzes one candidate, may call an LLM, returns
 * results. For pure pattern matching, extract just reshapes candidate.meta.
 *
 * Files:
 *   Built-in:  src/scanners/<name>.ts
 *   User:      ~/.session-scan/scanners/<name>.ts
 */
export interface Scanner<T = unknown> {
  name: string;
  description: string;

  /** Fast. Scan contextual events, yield candidates worth analyzing. */
  collect: (events: AsyncGenerator<ContextualEvent>) => AsyncGenerator<Candidate>;

  /** Analyze one candidate. May call an LLM. Returns zero or more results. */
  extract: (candidate: Candidate) => Promise<ScanResult<T>[]>;
}
