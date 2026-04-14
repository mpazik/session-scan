/**
 * agentlog - session mining for pi coding agent
 *
 * Writing a scanner:
 *
 *   // ~/.agentlog/scanners/my-scanner.ts
 *   import type { Scanner } from "agentlog";
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

// Parser
export { streamSession, discoverSessionFiles } from "./parser.js";
export type { StreamOptions, DiscoverOptions } from "./parser.js";

// Context enrichment
export { withContext } from "./context.js";

// Utilities
export { frustrationScore, truncate, truncLine, stripAnsi } from "./utils.js";

// Scanner registry
export { discover, register, get, list } from "./scanners/index.js";

// Types
export type {
  // Events
  SessionEvent,
  SessionStartEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolResultEvent,
  BashExecutionEvent,
  CompactionEvent,
  ModelChangeEvent,
  ThinkingLevelChangeEvent,
  CustomMessageEvent,
  SessionEndEvent,
  // Context
  Turn,
  EventContext,
  ContextualEvent,
  // Scanner framework
  Scanner,
  Candidate,
  MessageSlice,
  ScanResult,
  // Low-level
  SessionHeader,
  ToolCall,
  TextContent,
  ContentBlock,
} from "./types.js";
