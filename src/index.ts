/**
 * session-scan - session mining for pi coding agent
 *
 * Writing a scanner:
 *
 *   // ./my-scanner.ts  (loaded via --scanner ./my-scanner.ts)
 *   import type { ContextualEvent, ScanEvent } from "session-scan";
 *
 *   export default async function* (
 *     events: AsyncGenerator<ContextualEvent>,
 *   ): AsyncGenerator<ScanEvent> {
 *     let errors = 0;
 *     for await (const ev of events) {
 *       if (ev.type === "tool_result" && ev.isError) {
 *         errors++;
 *         yield { ...ev, finding: { kind: "error" } };
 *       }
 *     }
 *     // per-session summary when the input ends
 *     yield { type: "custom_message", customType: "scan_summary", errors };
 *   }
 */

// Parser framework + pluggable adapters
export {
  streamSession,
  discoverSessions,
  detectSource,
  register as registerAdapter,
  get as getAdapter,
  list as listAdapters,
  discover as discoverAdapters,
  loadAdapterFile,
  joinTextBlocks,
} from "./parser/index.js";
export type {
  Adapter,
  StreamOptions,
  DiscoverOptions,
  DiscoverSpec,
} from "./parser/index.js";

// High-level API
export { scanSession } from "./api.js";
export type { ScanSessionOptions } from "./api.js";

// Context enrichment
export { withContext } from "./context.js";

// Pipeline stages
export { filter, selectLastTurns, trim } from "./pipeline/index.js";
export type { FilterCriteria, TrimOptions } from "./pipeline/index.js";

// Utilities
export { truncate, truncLine, stripAnsi } from "./lib/string.js";
export { frustrationScore } from "./lib/sentiment.js";
export type { FrustrationResult } from "./lib/sentiment.js";

// Session model
export type {
  SessionEvent,
  SessionStartEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  SkillInvocationEvent,
  ToolResultEvent,
  CompactionEvent,
  ErrorEvent,
  CustomMessageEvent,
  Thinking,
  ToolCall,
  TokenUsage,
  SessionMetadata,
  NormalizedToolName,
} from "./session.js";

// Event context + scanner contract
export type {
  Turn,
  EventContext,
  ContextualEvent,
  Scanner,
  ScanEvent,
} from "./scanner.js";
