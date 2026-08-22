import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { scanSession } from "../../src/index.js";

test("scanSession exposes the single-session pipeline programmatically", async () => {
  const file = resolve(import.meta.dir, "../fixtures/pi.jsonl");
  const events = [];
  for await (const event of scanSession(file, {
    head: "f3c5b1d0",
    filter: { lastTurns: 2, toolResults: "errors" },
    trim: { noThinking: true },
  })) {
    events.push(event);
  }

  expect(events.filter((event) => event.type === "user_message")).toHaveLength(2);
  expect(events.some((event) => event.type === "tool_result" && !event.isError)).toBe(false);
  expect(events.some((event) => event.type === "tool_result" && event.isError)).toBe(true);
  expect(events.every((event) => event.type !== "assistant_message" || event.thinking === undefined)).toBe(true);
});
