import { describe, expect, test } from "bun:test";
import { withContext } from "../context.js";
import type { ContextualEvent } from "../scanner.js";
import type { SessionEvent } from "../session.js";
import { selectLastTurns } from "./select-last-turns.js";

const timestamp = "2026-08-21T10:00:00.000Z";

describe("selectLastTurns", () => {
  test("keeps the session header and final complete turns", async () => {
    const events: SessionEvent[] = [
      start(),
      custom("preamble"),
      user("u1", "first"),
      assistant("a1", "first answer"),
      user("u2", "second"),
      assistant("a2", "second answer"),
      toolResult("r2", false),
      user("u3", "third"),
      assistant("a3", "third answer"),
      toolResult("r3", true),
    ];

    const selected = await collect(
      selectLastTurns(withContext(from(events)), 2),
    );

    expect(selected.map((event) => event.id)).toEqual([
      "session",
      "u2",
      "a2",
      "r2",
      "u3",
      "a3",
      "r3",
    ]);
    expect(selected.some((event) => event.id === "preamble")).toBe(false);
  });

  test("snapshots context at each buffered event", async () => {
    const events: SessionEvent[] = [
      start(),
      user("u1", "first"),
      assistant("a1", "first answer"),
      user("u2", "second"),
      assistant("a2", "second answer"),
      toolResult("r2", false),
    ];

    const selected = await collect(
      selectLastTurns(withContext(from(events)), 1),
    );
    const assistantEvent = selected.find((event) => event.id === "a2")!;
    const resultEvent = selected.find((event) => event.id === "r2")!;

    expect(assistantEvent.context.turn?.userMessage.id).toBe("u2");
    expect(assistantEvent.context.turn?.events).toEqual([]);
    expect(resultEvent.context.turn?.events.map((event) => event.id)).toEqual([
      "a2",
    ]);
    expect(resultEvent.context.prevTurn?.events.map((event) => event.id)).toEqual([
      "a1",
    ]);
  });

  test("rejects invalid counts", async () => {
    await expect(
      collect(selectLastTurns(withContext(from([start()])), 0)),
    ).rejects.toThrow("last-turn count must be a positive integer");
  });
});

function start(): SessionEvent {
  return {
    type: "session_start",
    formatVersion: 1,
    id: "session",
    timestamp,
    cwd: "/tmp/project",
  };
}

function user(id: string, text: string): SessionEvent {
  return { type: "user_message", id, parentId: null, timestamp, text };
}

function assistant(id: string, text: string): SessionEvent {
  return {
    type: "assistant_message",
    id,
    parentId: null,
    timestamp,
    text,
    toolCalls: [],
    provider: "test",
    model: "test-model",
  };
}

function toolResult(id: string, isError: boolean): SessionEvent {
  return {
    type: "tool_result",
    id,
    parentId: null,
    timestamp,
    toolCallId: `${id}-call`,
    toolName: "bash",
    content: isError ? "failed" : "ok",
    isError,
  };
}

function custom(id: string): SessionEvent {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp,
    customType: "test",
    content: id,
  };
}

async function* from(events: SessionEvent[]): AsyncGenerator<SessionEvent> {
  yield* events;
}

async function collect(
  events: AsyncGenerator<ContextualEvent>,
): Promise<ContextualEvent[]> {
  const result: ContextualEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
