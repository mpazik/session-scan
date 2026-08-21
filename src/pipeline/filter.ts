/**
 * Semantic filter stage. Skill criteria select whole sessions; other criteria
 * drop events without editing payloads. Default (no criteria) keeps everything.
 * `session_start` always passes for a selected session because renderers need it.
 *
 * Criteria combine with AND. Comma-separated values within one criterion use OR.
 */

import type { ContextualEvent } from "../scanner.js";
import { selectBySkillInvocation } from "./select-skill.js";
import { selectLastTurns } from "./select-last-turns.js";

export interface FilterCriteria {
  /** Keep sessions invoking any of these exact skill names (`--skill`). */
  skills?: string[];
  /** Keep only these event types (`--type`). */
  types?: string[];
  /** Keep only these roles (`--role`); maps onto event types. */
  roles?: ("user" | "assistant" | "tool_result")[];
  /** Keep only events involving these normalized tool names (`--tool`). */
  tools?: string[];
  /** Keep only the final N user-started turns (`--last-turns`). */
  lastTurns?: number;
  /** Keep only errored tool results (`--error`). */
  error?: boolean;
  /** Filter tool results without dropping other event types (`--tool-results`). */
  toolResults?: "errors";
}

const ROLE_TO_TYPE: Record<string, string> = {
  user: "user_message",
  assistant: "assistant_message",
  tool_result: "tool_result",
};

/** True when at least one criterion is active. */
export function hasFilters(c: FilterCriteria): boolean {
  return !!(
    c.skills?.length ||
    c.types?.length ||
    c.roles?.length ||
    c.tools?.length ||
    c.lastTurns !== undefined ||
    c.error ||
    c.toolResults
  );
}

export function filter(
  events: AsyncGenerator<ContextualEvent>,
  c: FilterCriteria,
): AsyncGenerator<ContextualEvent> {
  const selected = c.skills?.length
    ? selectBySkillInvocation(events, c.skills)
    : events;
  const windowed =
    c.lastTurns !== undefined
      ? selectLastTurns(selected, c.lastTurns)
      : selected;
  return filterEvents(windowed, c);
}

async function* filterEvents(
  events: AsyncGenerator<ContextualEvent>,
  c: FilterCriteria,
): AsyncGenerator<ContextualEvent> {
  const typeSet = c.types?.length ? new Set(c.types) : null;
  const roleSet = c.roles?.length
    ? new Set(c.roles.map((r) => ROLE_TO_TYPE[r]))
    : null;
  const toolSet = c.tools?.length ? new Set(c.tools) : null;

  for await (const ev of events) {
    if (ev.type === "session_start") {
      yield ev;
      continue;
    }
    if (typeSet && !typeSet.has(ev.type)) continue;
    if (roleSet && !roleSet.has(ev.type)) continue;
    if (c.error && !(ev.type === "tool_result" && ev.isError)) continue;
    if (c.toolResults === "errors" && ev.type === "tool_result" && !ev.isError) {
      continue;
    }
    if (toolSet && !matchTool(ev, toolSet)) continue;
    yield ev;
  }
}

/** Does this event involve one of the requested normalized tools? */
function matchTool(ev: ContextualEvent, tools: Set<string>): boolean {
  if (ev.type === "assistant_message") {
    return ev.toolCalls.some((tc) => tools.has(tc.normalizedName ?? tc.name));
  }
  if (ev.type === "tool_result") {
    const norm = normalizedNameFor(ev);
    return tools.has(norm ?? ev.toolName);
  }
  return false;
}

/** Recover a tool_result's normalized name from the originating call in-turn. */
function normalizedNameFor(
  ev: ContextualEvent & { type: "tool_result" },
): string | undefined {
  const turn = ev.context.turn;
  if (!turn) return undefined;
  for (const e of turn.events) {
    if (e.type !== "assistant_message") continue;
    for (const tc of e.toolCalls) {
      if (tc.id === ev.toolCallId) return tc.normalizedName;
    }
  }
  return undefined;
}
