/**
 * Event-context types and the scanner contract.
 *
 * These layer on top of the canonical session model in `session.ts`. They are
 * kept out of `session.ts` so the wire model stays self-contained.
 *
 * - `Turn` / `EventContext` / `ContextualEvent`: turn correlation attached to
 *   every event by `withContext` (see context.ts). The whole pipeline runs over
 *   `ContextualEvent`s.
 * - `Scanner` / `ScanEvent`: the one user-extensible unit. A scanner is a single
 *   async generator over one session's contextual events; it emits partial
 *   events (`ScanEvent`) and may emit a trailing per-session summary. Loaded by
 *   path (`--scanner ./file.ts`), never registered.
 */

import type {
  SessionEvent,
  SessionMetadata,
  UserMessageEvent,
} from "./session.js";


/** A turn: a user message plus everything the agent did in response. */
export interface Turn {
  /** The user message that started this turn. */
  userMessage: UserMessageEvent;
  /** All events since that user message (assistant messages, tool results). */
  events: SessionEvent[];
}

/**
 * Per-event context: only what varies as you walk the stream. Session-invariant
 * identity (cwd, path, timestamp, ...) is NOT here — it lives on `SessionMetadata`,
 * passed once to the scanner. Stamping it on every event would be pure redundancy.
 */
export interface EventContext {
  /** Current turn (null before the first user message). */
  turn: Turn | null;
  /** Previous turn (null before the second user message). */
  prevTurn: Turn | null;
  /** Active model, tracked from each assistant message (can change mid-session). */
  model: string;
}

export type ContextualEvent<T extends SessionEvent = SessionEvent> = T & {
  context: EventContext;
};

// -- Scanner contract --------------------------------------------------------

/**
 * A scanner's output unit: a partial event. `type` is the only required field;
 * everything else from `SessionEvent` is optional, and arbitrary extra fields
 * (findings, annotations) are allowed.
 */
export type ScanEvent = Pick<SessionEvent, "type"> &
  Partial<SessionEvent> &
  Record<string, unknown>;

/**
 * A scanner: one async generator per session. State is local to the generator
 * and resets per session. Annotate input events (`{ ...ev, finding }`) or emit
 * synthetic `custom_message`s; emit any per-session summary when the input ends,
 * then return. Must not compute cross-session rollups — that's downstream.
 *
 * `events` is the spine: the session's contextual event stream. `session` is the
 * invariant identity (cwd, path, timestamp, ...), passed once up front.
 *
 * Loaded by path via `--scanner ./file.ts` as the module's default export.
 */
export type Scanner = (
  events: AsyncGenerator<ContextualEvent>,
  session: SessionMetadata,
) => AsyncGenerator<ScanEvent>;
