/**
 * Turn context enrichment.
 *
 * Wraps a raw SessionEvent stream and yields ContextualEvents with:
 * - Current turn (user message + events since)
 * - Previous turn
 * - Current model and thinking level
 */

import type {
  SessionEvent,
  ContextualEvent,
  EventContext,
  Turn,
  UserMessageEvent,
} from "./types.js";

export async function* withContext(
  events: AsyncGenerator<SessionEvent>,
): AsyncGenerator<ContextualEvent> {
  let sessionPath = "";
  let cwd = "";
  let sessionTimestamp = "";
  let model = "";
  let thinkingLevel = "";

  let turn: Turn | null = null;
  let prevTurn: Turn | null = null;
  // Mutable buffer for current turn's events. Referenced by turn object directly.
  let turnEvents: SessionEvent[] = [];

  for await (const event of events) {
    if (event.type === "session_start") {
      sessionPath = event.path;
      cwd = event.header.cwd;
      sessionTimestamp = event.header.timestamp;
      model = "";
      thinkingLevel = "";
      turn = null;
      prevTurn = null;
      turnEvents = [];

      yield { ...event, context: makeContext() } as ContextualEvent;
      continue;
    }

    if (event.type === "session_end") {
      yield { ...event, context: makeContext() } as ContextualEvent;
      continue;
    }

    // Track model and thinking level
    if (event.type === "model_change") {
      model = event.modelId;
    } else if (event.type === "thinking_level_change") {
      thinkingLevel = event.thinkingLevel;
    } else if (event.type === "assistant_message" && event.model) {
      model = event.model;
    }

    // Turn boundary: user_message starts a new turn
    if (event.type === "user_message") {
      // Freeze previous turn (snapshot the events array)
      if (turn) {
        prevTurn = { userMessage: turn.userMessage, events: turnEvents };
      }

      // Start new turn with fresh buffer
      turnEvents = [];
      turn = { userMessage: event, events: turnEvents };

      yield { ...event, context: makeContext() } as ContextualEvent;
      continue;
    }

    // All other events: yield with current context, then append to buffer.
    // turn.events is the same reference as turnEvents, so scanners see
    // events accumulated *before* the current one (not including it).
    yield { ...event, context: makeContext() } as ContextualEvent;
    turnEvents.push(event);
  }

  function makeContext(): EventContext {
    return {
      turn,
      prevTurn,
      model,
      thinkingLevel,
      sessionPath,
      cwd,
      sessionTimestamp,
    };
  }
}
