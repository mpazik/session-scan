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
  // Buffer events before the first user message
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
      // Finalize current turn's events before yielding
      if (turn) turn = { ...turn, events: [...turnEvents] };
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

    // Turn boundary: user_message
    if (event.type === "user_message") {
      // Finalize current turn and shift to previous
      if (turn) {
        prevTurn = { ...turn, events: [...turnEvents] };
      }

      // Start new turn
      turn = { userMessage: event, events: [] };
      turnEvents = [];

      yield { ...event, context: makeContext() } as ContextualEvent;
      continue;
    }

    // All other events: yield with current context (excluding this event),
    // then add to turn buffer
    if (turn) turn = { ...turn, events: [...turnEvents] };
    const ctx = makeContext();
    yield { ...event, context: ctx } as ContextualEvent;
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
