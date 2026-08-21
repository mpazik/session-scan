/**
 * Keep the final N user-started turns from one contextual session stream.
 *
 * A turn starts at a `user_message` and includes every following event until the
 * next `user_message`. `session_start` is always retained; events before the
 * first user message are outside a turn and are dropped when this selector is
 * active.
 */

import type { ContextualEvent, EventContext, Turn } from "../scanner.js";

export async function* selectLastTurns(
  events: AsyncGenerator<ContextualEvent>,
  count: number,
): AsyncGenerator<ContextualEvent> {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError("last-turn count must be a positive integer");
  }

  let start: ContextualEvent | null = null;
  const turns: ContextualEvent[][] = [];
  let current: ContextualEvent[] | null = null;

  for await (const event of events) {
    const snapshot = snapshotContext(event);
    if (event.type === "session_start") {
      start = snapshot;
      continue;
    }
    if (event.type === "user_message") {
      current = [];
      turns.push(current);
      if (turns.length > count) turns.shift();
    }
    if (current) current.push(snapshot);
  }

  if (start) yield start;
  for (const turn of turns) yield* turn;
}

function snapshotContext(event: ContextualEvent): ContextualEvent {
  return {
    ...event,
    context: snapshotEventContext(event.context),
  } as ContextualEvent;
}

function snapshotEventContext(context: EventContext): EventContext {
  return {
    model: context.model,
    turn: snapshotTurn(context.turn),
    prevTurn: snapshotTurn(context.prevTurn),
  };
}

function snapshotTurn(turn: Turn | null): Turn | null {
  if (!turn) return null;
  return {
    userMessage: turn.userMessage,
    events: [...turn.events],
  };
}
