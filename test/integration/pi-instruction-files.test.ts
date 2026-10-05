import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piAdapter from "../../examples/adapters/pi.js";
import type { SessionEvent } from "../../src/session.js";

const T = "2026-08-20T10:00:00.000Z";

function line(value: object): string {
  return JSON.stringify(value);
}

async function parse(entries: object[]): Promise<SessionEvent[]> {
  const dir = await mkdtemp(join(tmpdir(), "session-scan-pi-context-"));
  try {
    const file = join(dir, "session.jsonl");
    await writeFile(file, [
      line({ type: "session", version: 3, id: "s1", timestamp: T, cwd: "/work" }),
      ...entries.map(line),
    ].join("\n") + "\n");
    const events: SessionEvent[] = [];
    for await (const event of piAdapter.parse(file)) events.push(event);
    return events;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const system = (id: string, parentId: string | null, sections: Record<string, unknown>) => ({
  type: "message", id, parentId, timestamp: T,
  message: { role: "system", content: "", sections, timestamp: 0 },
});

test("system messages that set or remove project context emit instruction files", async () => {
  const events = await parse([
    system("p1", null, {
      preamble: "You are pi.",
      project_context: '<project_instructions path="/work/AGENTS.md">\nx\n</project_instructions>\n\n<project_instructions path="/work/a&amp;b/AGENTS.md">\ny\n</project_instructions>',
    }),
    system("p2", "p1", { skills: "<skills></skills>" }),
    system("p3", "p2", { project_context: null }),
    { type: "message", id: "u1", parentId: "p3", timestamp: T, message: { role: "user", content: "hi" } },
  ]);

  expect(events.filter((e) => e.type === "custom_message")).toEqual([
    { type: "custom_message", id: "p1", parentId: null, customType: "instruction_files", content: ["/work/AGENTS.md", "/work/a&amp;b/AGENTS.md"], timestamp: T },
    { type: "custom_message", id: "p3", parentId: "p2", customType: "instruction_files", content: [], timestamp: T },
  ]);
});

test("compaction checkpoints restate instruction files", async () => {
  const events = await parse([
    { type: "message", id: "u1", parentId: null, timestamp: T, message: { role: "user", content: "hi" } },
    {
      type: "compaction", id: "c1", parentId: "u1", timestamp: T, summary: "s", firstKeptEntryId: "u1", tokensBefore: 10,
      systemMessage: { role: "system", content: "", sections: { preamble: "p" }, timestamp: 0 },
    },
  ]);

  expect(events.at(-1)).toEqual({
    type: "custom_message", id: "c1:instructions", parentId: "c1", customType: "instruction_files", content: [], timestamp: T,
  });
});
