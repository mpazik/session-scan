import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adapter from "../../src/adapters/claude-export.js";
import type { SessionEvent } from "../../src/session.js";

test("Claude export parses known multi-word tool labels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-scan-claude-export-"));
  const file = join(dir, "export.txt");

  try {
    await writeFile(
      file,
      [
        "Claude Code v2.1.173",
        "Opus 4.8 · Claude Team",
        "~/src/demo",
        "",
        "❯ find current Bun documentation",
        "",
        "⏺ Web Search(Bun package binary)",
        "  ⎿ Found documentation",
        "",
      ].join("\n"),
    );

    const events: SessionEvent[] = [];
    for await (const event of adapter.parse(file)) events.push(event);

    const assistant = events.find(
      (event) =>
        event.type === "assistant_message" &&
        event.toolCalls.some((call) => call.name === "Web Search"),
    );
    expect(assistant?.type).toBe("assistant_message");
    if (assistant?.type !== "assistant_message") return;

    const call = assistant.toolCalls.find((candidate) => candidate.name === "Web Search");
    expect(call?.arguments).toEqual({ query: "Bun package binary" });
    expect(
      events.some(
        (event) =>
          event.type === "tool_result" &&
          event.toolCallId === call?.id &&
          event.content === "Found documentation",
      ),
    ).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
