import { expect, test } from "bun:test";
import { withContext } from "../context.js";
import type { ContextualEvent } from "../scanner.js";
import type { SessionEvent } from "../session.js";
import { filter } from "./filter.js";

const timestamp = "2026-08-21T10:00:00.000Z";

test("tool-results errors keeps non-tool events and failed results", async () => {
  const events: SessionEvent[] = [
    {
      type: "session_start",
      formatVersion: 1,
      id: "session",
      timestamp,
      cwd: "/tmp/project",
    },
    {
      type: "user_message",
      id: "user",
      parentId: null,
      timestamp,
      text: "run it",
    },
    {
      type: "assistant_message",
      id: "assistant",
      parentId: "user",
      timestamp,
      text: "running",
      toolCalls: [],
      provider: "test",
      model: "test-model",
    },
    toolResult("success", false),
    toolResult("failure", true),
    {
      type: "error",
      id: "api-error",
      parentId: "failure",
      timestamp,
      message: "provider retry",
    },
  ];

  const selected = await collect(
    filter(withContext(from(events)), { toolResults: "errors" }),
  );

  expect(selected.map((event) => event.id)).toEqual([
    "session",
    "user",
    "assistant",
    "failure",
    "api-error",
  ]);
});

function toolResult(id: string, isError: boolean): SessionEvent {
  return {
    type: "tool_result",
    id,
    parentId: "assistant",
    timestamp,
    toolCallId: `${id}-call`,
    toolName: "bash",
    content: isError ? "failed" : "ok",
    isError,
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
