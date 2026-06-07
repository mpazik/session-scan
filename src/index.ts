/**
 * session-scan - session mining for pi coding agent
 *
 * Writing a scanner:
 *
 *   // ~/.session-scan/scanners/my-scanner.ts
 *   import type { Scanner } from "session-scan";
 *
 *   export const scanner: Scanner = {
 *     name: "my-scanner",
 *     description: "Finds something interesting",
 *
 *     async *collect(events) {
 *       for await (const event of events) {
 *         if (event.type === "tool_result" && event.isError) {
 *           yield {
 *             id: `${event.context.sessionPath}:${event.id}`,
 *             sessionPath: event.context.sessionPath,
 *             cwd: event.context.cwd,
 *             timestamp: event.timestamp,
 *             messages: [{ role: "tool_result", text: event.content, timestamp: event.timestamp }],
 *             meta: { error: event.content },
 *           };
 *         }
 *       }
 *     },
 *
 *     async extract(candidate) {
 *       return [{
 *         kind: "error",
 *         summary: candidate.meta.error as string,
 *         entryId: candidate.id,
 *         timestamp: candidate.timestamp,
 *         sessionPath: candidate.sessionPath,
 *         cwd: candidate.cwd,
 *         data: candidate.meta,
 *       }];
 *     },
 *   };
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
  normalizeToolName,
} from "./parser/index.js";
export type {
  SessionSource,
  StreamOptions,
  DiscoverOptions,
  FindSessionContext,
} from "./parser/index.js";

// Context enrichment
export { withContext } from "./context.js";

// Utilities
export { frustrationScore, truncate, truncLine, stripAnsi } from "./utils.js";

// Scanner registry
export { discover, register, get, list } from "./scanners/index.js";

// Session model
export type {
  SessionEvent,
  SessionStartEvent,
  UserMessageEvent,
  AssistantMessageEvent,
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

// Scanner framework
export type {
  Turn,
  EventContext,
  ContextualEvent,
  Scanner,
  Candidate,
  MessageSlice,
  ScanResult,
} from "./scanner.js";
