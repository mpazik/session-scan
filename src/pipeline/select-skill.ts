/**
 * Session selection by canonical skill invocation event.
 *
 * A skill criterion selects the whole session. Events are buffered until a
 * matching `skill_invocation` appears, then replayed in their original order.
 * Harness-specific invocation formats are normalized by adapters.
 */

import type { ContextualEvent, EventContext, Turn } from "../scanner.js";

/** True when this event invokes one of the requested, case-sensitive names. */
export function matchesSkillInvocation(
  event: ContextualEvent,
  names: ReadonlySet<string>,
): boolean {
  return event.type === "skill_invocation" && names.has(event.name);
}

/**
 * Yield a complete session only if its adapter reports one of `names`.
 *
 * Context snapshots keep buffered events observationally equivalent to the
 * original stream. `withContext` uses mutable current-turn arrays, so retaining
 * those references while looking ahead would otherwise expose future events.
 */
export async function* selectBySkillInvocation(
  events: AsyncGenerator<ContextualEvent>,
  names: readonly string[],
): AsyncGenerator<ContextualEvent> {
  const requested = new Set(names);
  if (requested.size === 0) {
    yield* events;
    return;
  }

  const buffered: ContextualEvent[] = [];
  for await (const event of events) {
    if (matchesSkillInvocation(event, requested)) {
      yield* buffered;
      yield event;
      yield* events;
      return;
    }
    buffered.push(snapshotContext(event));
  }
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
