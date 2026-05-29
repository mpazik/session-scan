/**
 * Pi session JSONL types and scanner framework.
 *
 * Mirrors the format defined in packages/coding-agent/src/core/session-manager.ts
 * but kept standalone so session-scan has no dependency on pi-mono.
 */

// -- Harness identity --------------------------------------------------------

export type AgentType = "pi" | "claude-code" | "codex";

/** Canonical tool names, harness-neutral. Falls back to the native name. */
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

// -- Content blocks ----------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: unknown;
}

export type ContentBlock = TextContent | ImageContent;

// -- Tool call (inside assistant message content) ----------------------------

export interface ToolCall {
  type: "toolCall";
  id: string;
  /** Native tool name (pi: "bash", claude: "Bash", codex: "exec_command"). */
  name: string;
  /** Harness-neutral name. Scanners can match on this to stay agnostic. */
  normalizedName: NormalizedToolName;
  arguments: Record<string, unknown>;
}

// -- Raw JSONL entry types (internal, not exposed to consumers) ---------------

export interface SessionHeader {
  type: "session";
  /** Which harness produced this session. */
  agent: AgentType;
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  /** Active model at session start (claude/codex carry it on init). */
  model?: string;
  /** Git context at session start (claude/codex expose this). */
  git?: { branch?: string; commit?: string; remote?: string };
  parentSession?: string;
}

export interface RawEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

// -- Session events (public API) ---------------------------------------------

export type SessionEvent =
  | SessionStartEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ThinkingEvent
  | ToolResultEvent
  | BashExecutionEvent
  | CompactionEvent
  | ModelChangeEvent
  | ThinkingLevelChangeEvent
  | CustomMessageEvent
  | ErrorEvent
  | SessionEndEvent;

export interface SessionStartEvent {
  type: "session_start";
  header: SessionHeader;
  path: string;
}

export interface UserMessageEvent {
  type: "user_message";
  id: string;
  parentId: string | null;
  text: string;
  timestamp: string;
}

export interface AssistantMessageEvent {
  type: "assistant_message";
  id: string;
  parentId: string | null;
  text: string;
  toolCalls: ToolCall[];
  provider: string;
  model: string;
  stopReason?: string;
  errorMessage?: string;
  /** Token usage, when the harness reports it (claude/codex). Pi leaves undefined. */
  usage?: TokenUsage;
  timestamp: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** Reasoning/thinking block (claude `thinking`, codex `reasoning`). Pi: none. */
export interface ThinkingEvent {
  type: "thinking";
  id: string;
  parentId: string | null;
  summary: string;
  text: string | null;
  timestamp: string;
}

/** Harness-level error (claude api_error, codex turn_aborted). */
export interface ErrorEvent {
  type: "error";
  id: string;
  parentId: string | null;
  code?: string;
  message: string;
  timestamp: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  id: string;
  parentId: string | null;
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  command?: string;
  timestamp: string;
}

export interface BashExecutionEvent {
  type: "bash_execution";
  id: string;
  parentId: string | null;
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  timestamp: string;
}

export interface CompactionEvent {
  type: "compaction";
  id: string;
  parentId: string | null;
  summary: string;
  tokensBefore: number;
  timestamp: string;
}

export interface ModelChangeEvent {
  type: "model_change";
  id: string;
  parentId: string | null;
  provider: string;
  modelId: string;
  timestamp: string;
}

export interface ThinkingLevelChangeEvent {
  type: "thinking_level_change";
  id: string;
  parentId: string | null;
  thinkingLevel: string;
  timestamp: string;
}

export interface CustomMessageEvent {
  type: "custom_message";
  id: string;
  parentId: string | null;
  customType: string;
  content: string;
  display: boolean;
  timestamp: string;
}

export interface SessionEndEvent {
  type: "session_end";
}

// -- Context-enriched events -------------------------------------------------

/** A turn: user message + everything the agent did in response. */
export interface Turn {
  /** The user message that started this turn */
  userMessage: UserMessageEvent;
  /** All events since that user message (assistant messages, tool results, etc.) */
  events: SessionEvent[];
}

export interface EventContext {
  /** Current turn (null before first user message) */
  turn: Turn | null;
  /** Previous turn (null before second user message) */
  prevTurn: Turn | null;
  /** Current model */
  model: string;
  /** Current thinking level */
  thinkingLevel: string;
  /** Session path */
  sessionPath: string;
  /** Session cwd */
  cwd: string;
  /** Session start timestamp */
  sessionTimestamp: string;
}

export type ContextualEvent<T extends SessionEvent = SessionEvent> = T & {
  context: EventContext;
};

// -- Use case framework ------------------------------------------------------

/**
 * A message in a candidate's context window.
 * Flattened representation suitable for LLM prompts or pattern matching.
 */
export interface MessageSlice {
  role: "user" | "assistant" | "tool_result" | "bash" | "system";
  text: string;
  timestamp: string;
  /** For tool_result: was it an error? */
  isError?: boolean;
  /** For tool_result/bash: the command that was run */
  command?: string;
  /** For assistant: tool calls made */
  toolCalls?: ToolCall[];
}

/**
 * A bounded chunk of session context worth analyzing.
 * Produced by a scanner's collect phase. Consumed by its extract phase.
 */
export interface Candidate {
  /** Stable id for dedup (e.g. sessionPath:entryId) */
  id: string;
  /** Session file path */
  sessionPath: string;
  /** Session cwd */
  cwd: string;
  /** When this candidate was found */
  timestamp: string;
  /** Bounded context: the messages/events around the point of interest */
  messages: MessageSlice[];
  /** Use-case-defined metadata passed from collect to extract */
  meta: Record<string, unknown>;
}

/**
 * A result produced by a scanner.
 */
export interface ScanResult<T = unknown> {
  /** Use-case-defined category */
  kind: string;
  /** Human-readable one-liner */
  summary: string;
  /** Entry id where the finding was made */
  entryId: string;
  /** When it happened */
  timestamp: string;
  /** Session path */
  sessionPath: string;
  /** Session cwd */
  cwd: string;
  /** Use-case-specific structured data */
  data: T;
}

/**
 * A scanner definition.
 *
 * collect: fast, streams events, yields candidates with bounded context.
 * extract: slow, analyzes one candidate, may call LLM, returns results.
 *
 * For pure pattern matching, extract just reshapes candidate.meta into results.
 * For LLM analysis, extract sends candidate.messages to an LLM with a prompt.
 *
 * Files:
 *   Built-in:  src/scanners/<name>.ts
 *   User:      ~/.session-scan/scanners/<name>.ts
 */
export interface Scanner<T = unknown> {
  name: string;
  description: string;

  /** Fast. Scan contextual events, yield candidates worth analyzing. */
  collect: (
    events: AsyncGenerator<ContextualEvent>,
  ) => AsyncGenerator<Candidate>;

  /** Analyze one candidate. May call LLM. Returns zero or more results. */
  extract: (candidate: Candidate) => Promise<ScanResult<T>[]>;
}
