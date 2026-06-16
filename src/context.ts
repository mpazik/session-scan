/**
 * Turn context enrichment.
 *
 * Wraps a raw SessionEvent stream and yields ContextualEvents with:
 * - Current turn (user message + events since)
 * - Previous turn
 * - Current model
 */

import type { SessionEvent } from "./session.js";
import type { ContextualEvent, EventContext, Turn } from "./scanner.js";

export async function* withContext(
  events: AsyncGenerator<SessionEvent>,
): AsyncGenerator<ContextualEvent> {
  let model = "";

  let turn: Turn | null = null;
  let prevTurn: Turn | null = null;
  // Mutable buffer for current turn's events. Referenced by turn object directly.
  let turnEvents: SessionEvent[] = [];

  for await (const event of events) {
    if (event.type === "session_start") {
      // Session-invariant identity is NOT stamped here; it lives on
      // SessionMetadata (the scanner's second arg). withContext only resets
      // turn state and tracks the active model.
      model = event.model ?? "";
      turn = null;
      prevTurn = null;
      turnEvents = [];

      yield { ...event, context: makeContext() } as ContextualEvent;
      continue;
    }

    // Track the active model from each assistant response.
    if (event.type === "assistant_message" && event.model) {
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
    return { turn, prevTurn, model };
  }
}
