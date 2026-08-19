/**
 * The canonical session model: what every adapter produces and every analyzer
 * consumes, regardless of which coding harness recorded the session. Native
 * on-disk formats are parsed into this shape.
 *
 * SESSION
 *   One agent run: a user working with one agent in a given directory.
 *   A timeline of events. Sessions can be resumed; `parentSession` links the fork.
 *
 * EVENT
 *   One entry in that timeline. `SessionEvent` is a discriminated union keyed by
 *   `type`: the user message, the model response, a tool result, an error, etc.
 *   Timeline events extend `EventBase`: id, `parentId`, and an ISO 8601 timestamp.
 *
 * The vocabulary is small and universal on purpose. Anything harness-specific
 * collapses into `custom_message`.
 *
 * Tool calls and thinking live INSIDE assistant_message.
 *
 * One assistant_message is one model response: the adapter coalesces a
 * response's streamed fragments or split items into a single message. A
 * response is one billing unit, so `usage` sits on the message:
 *
 *   assistant_message  usage{ output ⊇ thinking + text + toolCall args }
 *     thinking, toolCalls[]    ← fields, no usage of their own
 *   tool_result                ← own event; runs locally (0 tokens), its cost
 *                                 lands as INPUT on the next response
 *
 * tool_result is paired by `toolCallId`; a tool-only response has `text: ""`.
 * Matches the OpenAI/Anthropic message shape, so exporting a session to an LLM
 * is near-identity; flat call/result iteration is a derived view.
 */

/** Current session-format version. Writers stamp this on `session_start`. */
export const FORMAT_VERSION = 1;


export type NormalizedToolName =
    | "terminal"
    | "file_read"
    | "file_edit"
    | "file_write"
    | "file_search"
    | "content_search"
    | "web_search"
    | "web_fetch"
    | "sub_agent"
    | (string & {});

/**
 * A tool call the model emitted as part of an assistant response. Embedded in
 * `assistant_message.toolCalls`; its arg tokens are billed in that response's
 * output. Paired to its result by `id` === `tool_result.toolCallId`.
 */
export interface ToolCall {
  id: string;
  /** Native tool name as the harness recorded it. */
  name: string;
  /**
   * Canonical name, stamped by the framework from the adapter's `toolNames`
   * mapping (unmapped names pass through). Adapters leave this unset. Match
   * on this to stay portable across agents for standard tools.
   */
  normalizedName?: NormalizedToolName;
  arguments: Record<string, unknown>;
}

/**
 * Reasoning the model emitted as part of an assistant response. Embedded in
 * `assistant_message.thinking`; billed in that response's output.
 */
export interface Thinking {
  /** Short summary, when the harness provides one. */
  summary?: string;
  /** Full reasoning text, or null when only a summary exists. */
  text: string | null;
}

/**
 * Token usage for one model response. Lives on `assistant_message` because the
 * response is the billing unit.
 *
 * Convention, so adapters agree: `input` is NON-cached input only. `cacheRead`
 * and `cacheWrite` are separate, additive buckets (read is cheap, write/creation
 * is expensive — never collapse them, or cost is wrong). Some harnesses report
 * cached input as a subset of total input; those adapters subtract it out before
 * filling `input`.
 */
export interface TokenUsage {
  /** Non-cached input tokens. */
  input?: number;
  /** Generated output: text + thinking + tool-call args of this response. */
  output?: number;
  /** Input served from cache (cheap). Additive to `input`. */
  cacheRead?: number;
  /** Cache creation/write (expensive). Additive to `input`. */
  cacheWrite?: number;
  /** Reasoning tokens, when reported separately. */
  reasoningOutput?: number;
  /** Harness-reported total, when present. */
  total?: number;
  /** USD cost, when the harness precomputes it or you derive it. */
  costUsd?: number;
}

/**
 * Session-level identity and config. Doubles as the standalone unit for session
 * discovery/listing (read this without parsing the timeline) and as the base of
 * `session_start`.
 */
export interface SessionMetadata {
  /** Uuid or any stable identifier. */
  id: string;
  /** ISO 8601 session start. */
  timestamp: string;
  /** Absolute path the agent ran in. */
  cwd: string;
  /** Producing harness */
  agent?: string;
  /** Active model at session start, when the harness reports it. */
  model?: string;
  /** Git context at session start, when available. */
  git?: { branch?: string; commit?: string; remote?: string };
  /** Session this one was resumed from. */
  parentSession?: string;
}

interface SessionEventBase {
  id: string;
  /** Parent in the session tree, or null for the root user message. */
  parentId: string | null;
  /** ISO 8601. */
  timestamp: string;
}

export type SessionEvent =
  | SessionStartEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | SkillInvocationEvent
  | ToolResultEvent
  | CompactionEvent
  | ErrorEvent
  | CustomMessageEvent;

/** First event. A session's metadata plus format version and file location. */
export interface SessionStartEvent extends SessionMetadata {
  type: "session_start";
  formatVersion: number;
  /** Absolute path to the session file */
  path?: string;
}

export interface UserMessageEvent extends SessionEventBase {
  type: "user_message";
  text: string;
}

/**
 * A skill invocation explicitly recorded by the producing harness. Adapters
 * emit this immediately after the canonical user/assistant event containing
 * the native invocation and link back to it with `sourceEventId`.
 */
export interface SkillInvocationEvent extends SessionEventBase {
  type: "skill_invocation";
  /** Exact, case-sensitive skill identifier. */
  name: string;
  /** Path to SKILL.md when the harness records it. */
  path?: string;
  /** Invocation arguments other than name/path, when available. */
  arguments?: Record<string, unknown>;
  /** Canonical event containing the native invocation. */
  sourceEventId?: string;
}

/**
 * One model response. Holds its text, its reasoning, its tool calls, and the
 * usage for the whole response.
 */
export interface AssistantMessageEvent extends SessionEventBase {
  type: "assistant_message";
  /** Response text. "" for a tool-call-only response. */
  text: string;
  /** Reasoning emitted in this response, if any. */
  thinking?: Thinking;
  /** Tool calls emitted in this response. [] if none. */
  toolCalls: ToolCall[];
  provider: string;
  model: string;
  /** API stop reason: "end_turn" | "tool_use" | "max_tokens" | ... */
  stopReason?: string;
  /** Token usage for the whole response. */
  usage?: TokenUsage;
}

/**
 * Result of a tool call. Its own event, not part of the assistant_message:
 * your code produces it (the model didn't), and it reaches the model as INPUT
 * on the next request. Carries no usage. Paired to its call by `toolCallId`;
 * `parentId` points at the assistant_message that issued it.
 */
export interface ToolResultEvent extends SessionEventBase {
  type: "tool_result";
  /** Matches the `ToolCall.id` that produced this. */
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  /** Process exit code for shell-shaped tools, when known. */
  exitCode?: number;
}

/** Context compaction. Universal agentic operation; fields kept generic. */
export interface CompactionEvent extends SessionEventBase {
  type: "compaction";
  summary?: string;
  tokensBefore?: number;
}

/** Harness/API-level error (mid-stream). Turn-level success is implicit. */
export interface ErrorEvent extends SessionEventBase {
  type: "error";
  code?: string;
  message: string;
  retryable?: boolean;
  retryAttempt?: number;
  maxRetries?: number;
}

/**
 * Escape hatch for harness-specific entries that don't map onto the universal
 * vocabulary (a model-change marker, a side-channel command, a custom UI
 * marker). `customType` discriminates.
 */
export interface CustomMessageEvent extends SessionEventBase {
  type: "custom_message";
  customType: string;
  content: unknown;
}
