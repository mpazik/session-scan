/**
 * Presentation trim stage. Shortens payloads within kept events; never drops an
 * event. Default path only — the runner skips trim when a scanner is present
 * (scanners own their own trimming).
 *
 * Events are shallow-cloned, never mutated in place: the same event objects are
 * referenced by `context.turn.events`, so mutating would corrupt turn
 * correlation for later events.
 */

import type { ContextualEvent } from "../scanner.js";

export interface TrimOptions {
  /** Keep first N lines of tool_result content; 0 drops the body (`--tool-lines`). */
  toolLines?: number;
  /** Drop assistant thinking blocks (`--no-thinking`). */
  noThinking?: boolean;
}

/** True when at least one trim is active. */
export function hasTrim(o: TrimOptions): boolean {
  return o.toolLines !== undefined || !!o.noThinking;
}

export async function* trim(
  events: AsyncGenerator<ContextualEvent>,
  o: TrimOptions,
): AsyncGenerator<ContextualEvent> {
  for await (const ev of events) {
    if (ev.type === "tool_result" && o.toolLines !== undefined) {
      const body =
        o.toolLines <= 0
          ? ""
          : ev.content.split("\n").slice(0, o.toolLines).join("\n");
      yield { ...ev, content: body };
      continue;
    }
    if (
      ev.type === "custom_message" &&
      o.toolLines !== undefined &&
      typeof ev.content === "string"
    ) {
      const body =
        o.toolLines <= 0
          ? ""
          : ev.content.split("\n").slice(0, o.toolLines).join("\n");
      yield { ...ev, content: body };
      continue;
    }
    if (ev.type === "assistant_message" && o.noThinking && ev.thinking) {
      const { thinking, ...rest } = ev;
      yield rest as ContextualEvent;
      continue;
    }
    yield ev;
  }
}
