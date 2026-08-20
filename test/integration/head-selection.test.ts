import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import piAdapter from "../../examples/adapters/pi.js";
import claudeAdapter from "../../src/adapters/claude-code.js";
import type { SessionEvent } from "../../src/session.js";

async function collect(
  events: AsyncGenerator<SessionEvent>,
): Promise<SessionEvent[]> {
  const result: SessionEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function withTempSession(
  records: unknown[],
  fn: (file: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "session-scan-head-"));
  const file = join(dir, "session.jsonl");
  try {
    await writeFile(
      file,
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("adapter head selection", () => {
  test("Pi selects native ancestry and keeps derived events", async () => {
    await withTempSession(piRecords(), async (file) => {
      const events = await collect(piAdapter.parseHead!(file, "selected"));
      expect(events.map((event) => event.id)).toEqual([
        "pi-head-test",
        "model",
        "skill-user",
        "skill-user:skill",
        "selected",
      ]);
      expect(events.map((event) => event.type)).toEqual([
        "session_start",
        "custom_message",
        "user_message",
        "skill_invocation",
        "assistant_message",
      ]);
      expect(events.some((event) => event.id === "sibling")).toBe(false);
      expect(events.some((event) => event.id === "later")).toBe(false);
    });
  });

  test("Pi can select a skipped bookkeeping entry", async () => {
    await withTempSession(piRecords(), async (file) => {
      const events = await collect(piAdapter.parseHead!(file, "bookkeeping"));
      expect(events.map((event) => event.id)).toEqual([
        "pi-head-test",
        "model",
      ]);
    });
  });

  test("Claude Code selects by native uuid before dropping machinery", async () => {
    await withTempSession(claudeRecords(), async (file) => {
      const events = await collect(claudeAdapter.parseHead!(file, "selected"));
      expect(events.map((event) => event.id)).toEqual([
        "claude-head-test",
        "root",
        "selected",
        "selected:skill:skill-call",
      ]);
      expect(events.some((event) => event.id === "sibling")).toBe(false);
      expect(events.some((event) => event.id === "later")).toBe(false);
    });
  });

  test("adapters reject an unknown native head", async () => {
    await withTempSession(piRecords(), async (file) => {
      await expect(collect(piAdapter.parseHead!(file, "missing"))).rejects.toThrow(
        `head "missing" was not found in ${file}`,
      );
    });
  });
});

test("CLI requires one non-null head and emits the selected Pi branch", async () => {
  await withTempSession(piRecords(), async (file) => {
    const selected = await runCli([file, "--head", "selected"]);
    expect(selected.exitCode).toBe(0);
    expect(selected.stdout).toContain('"id":"selected"');
    expect(selected.stdout).not.toContain('"id":"sibling"');
    expect(selected.stdout).not.toContain('"id":"later"');

    const selectedSkill = await runCli([
      file,
      "--head",
      "selected",
      "--skill",
      "copywriting",
      "--format",
      "md",
    ]);
    expect(selectedSkill.exitCode).toBe(0);
    expect(selectedSkill.stdout).toContain("selected answer");
    expect(selectedSkill.stdout).not.toContain("abandoned");
    expect(selectedSkill.stdout).not.toContain("appended later");

    const excludedSkill = await runCli([
      file,
      "--head",
      "bookkeeping",
      "--skill",
      "copywriting",
    ]);
    expect(excludedSkill.exitCode).toBe(0);
    expect(excludedSkill.stdout).toBe("");

    const noInput = await runCli(["--head", "selected"]);
    expect(noInput.exitCode).not.toBe(0);
    expect(noInput.stderr).toContain("--head requires a positional session file");

    const nullHead = await runCli([file, "--head", "null"]);
    expect(nullHead.exitCode).not.toBe(0);
    expect(nullHead.stderr).toContain("--head requires a non-empty, non-null entry ID");

    const codex = await runCli([
      resolve(import.meta.dir, "../fixtures/codex.jsonl"),
      "--head",
      "e1",
    ]);
    expect(codex.exitCode).not.toBe(0);
    expect(codex.stderr).toContain(
      'adapter "codex" does not support head selection',
    );
  });
});

function piRecords(): unknown[] {
  const ts = "2026-08-20T10:00:00.000Z";
  return [
    {
      type: "session",
      version: 3,
      id: "pi-head-test",
      timestamp: ts,
      cwd: "/tmp/project",
    },
    {
      type: "model_change",
      id: "model",
      parentId: null,
      timestamp: ts,
      provider: "openai",
      modelId: "gpt-5",
    },
    {
      type: "custom",
      id: "bookkeeping",
      parentId: "model",
      timestamp: ts,
      customType: "state",
      data: {},
    },
    {
      type: "message",
      id: "skill-user",
      parentId: "bookkeeping",
      timestamp: ts,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: '<skill name="copywriting" location="/skills/copywriting/SKILL.md">\nInstructions',
          },
        ],
      },
    },
    {
      type: "message",
      id: "sibling",
      parentId: "bookkeeping",
      timestamp: ts,
      message: {
        role: "user",
        content: [{ type: "text", text: "abandoned" }],
      },
    },
    {
      type: "message",
      id: "selected",
      parentId: "skill-user",
      timestamp: ts,
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5",
        content: [{ type: "text", text: "selected answer" }],
      },
    },
    {
      type: "message",
      id: "later",
      parentId: "selected",
      timestamp: ts,
      message: {
        role: "user",
        content: [{ type: "text", text: "appended later" }],
      },
    },
  ];
}

function claudeRecords(): unknown[] {
  const base = {
    sessionId: "claude-head-test",
    cwd: "/tmp/project",
    timestamp: "2026-08-20T10:00:00.000Z",
  };
  return [
    {
      ...base,
      type: "user",
      uuid: "root",
      parentUuid: null,
      message: { role: "user", content: "root prompt" },
    },
    {
      ...base,
      type: "user",
      uuid: "sibling",
      parentUuid: "root",
      message: { role: "user", content: "abandoned" },
    },
    {
      ...base,
      type: "assistant",
      uuid: "selected",
      parentUuid: "root",
      message: {
        role: "assistant",
        model: "claude-sonnet-4",
        content: [
          {
            type: "tool_use",
            id: "skill-call",
            name: "Skill",
            input: { skill: "copywriting" },
          },
        ],
      },
    },
    {
      ...base,
      type: "user",
      uuid: "later",
      parentUuid: "selected",
      message: { role: "user", content: "appended later" },
    },
  ];
}

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
