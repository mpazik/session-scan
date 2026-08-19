import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withContext } from "../context.js";
import type { ContextualEvent } from "../scanner.js";
import type { SessionEvent, ToolCall } from "../session.js";
import { skillInvocationFromClaudeTool } from "../adapters/claude-code.js";
import { skillInvocationFromCodexTool } from "../adapters/codex.js";
import { parsePiSkillInvocation } from "../../examples/adapters/pi.js";
import { selectBySkillInvocation } from "./select-skill.js";

const envelope = (name: string, location = `/skills/${name}/SKILL.md`) =>
  `<skill name="${name}" location="${location}">\nSkill instructions`;

describe("adapter skill invocation normalization", () => {
  test("Pi parses a leading skill envelope", () => {
    expect(parsePiSkillInvocation(envelope("recruiter-replay"))).toEqual({
      name: "recruiter-replay",
      path: "/skills/recruiter-replay/SKILL.md",
    });
  });

  test("Pi accepts reordered attributes, single quotes, and extra whitespace", () => {
    expect(
      parsePiSkillInvocation(
        "  <skill\n location = '/tmp/copywriting/SKILL.md'  extra = \"yes\" name = 'copywriting' >",
      ),
    ).toEqual({
      name: "copywriting",
      path: "/tmp/copywriting/SKILL.md",
    });
  });

  test("Pi requires location to name SKILL.md", () => {
    expect(
      parsePiSkillInvocation(
        '<skill name="copywriting" location="/tmp/copywriting/README.md">',
      ),
    ).toBeNull();
    expect(
      parsePiSkillInvocation(
        '<skill name="copywriting" location="/tmp/copywriting/NOT-SKILL.md">',
      ),
    ).toBeNull();
  });

  test("Pi ignores ordinary prose and malformed opening elements", () => {
    expect(
      parsePiSkillInvocation("Please use recruiter-replay for this task"),
    ).toBeNull();
    expect(
      parsePiSkillInvocation(
        'The payload is <skill name="recruiter-replay" location="/x/SKILL.md">',
      ),
    ).toBeNull();
    expect(
      parsePiSkillInvocation(
        '<skill name="recruiter-replay"location="/x/SKILL.md">',
      ),
    ).toBeNull();
  });

  test("Claude and Codex normalize explicit Skill tool calls", () => {
    expect(
      skillInvocationFromClaudeTool({
        id: "s1",
        name: "Skill",
        arguments: {
          skill: "copywriting",
          path: "/skills/copywriting/SKILL.md",
          args: "make it concise",
        },
      }),
    ).toEqual({
      name: "copywriting",
      path: "/skills/copywriting/SKILL.md",
      arguments: { args: "make it concise" },
    });
    expect(
      skillInvocationFromCodexTool({
        id: "s2",
        name: "Skill",
        arguments: { name: "review-skill" },
      }),
    ).toEqual({ name: "review-skill" });
  });
});

describe("selectBySkillInvocation", () => {
  test("keeps the complete matching session", async () => {
    const events = sessionEvents(envelope("recruiter-replay"));
    const selected = await collect(
      selectBySkillInvocation(withContext(from(events)), ["recruiter-replay"]),
    );

    expect(selected.map((event) => event.type)).toEqual(
      events.map((event) => event.type),
    );
    expect((selected[1] as { text: string }).text).toBe("before invocation");
    expect(selected[2]!.context.turn?.events).toEqual([]);
    expect((selected.at(-1) as { text: string }).text).toBe("after invocation");
  });

  test("does not parse harness-specific invocation text in the core", async () => {
    const events = sessionEvents(envelope("recruiter-replay")).filter(
      (event) => event.type !== "skill_invocation",
    );
    const selected = await collect(
      selectBySkillInvocation(withContext(from(events)), ["recruiter-replay"]),
    );
    expect(selected).toEqual([]);
  });

  test("drops a session with a non-matching, case-sensitive name", async () => {
    const events = sessionEvents(envelope("Recruiter-Replay"));
    const selected = await collect(
      selectBySkillInvocation(withContext(from(events)), ["recruiter-replay"]),
    );
    expect(selected).toEqual([]);
  });

  test("uses OR semantics for comma-separated names parsed by the CLI", async () => {
    const events = sessionEvents(envelope("copywriting"));
    const selected = await collect(
      selectBySkillInvocation(
        withContext(from(events)),
        ["recruiter-replay", "copywriting"],
      ),
    );
    expect(selected).toHaveLength(events.length);
  });

  test("passes through unchanged when no skill names are active", async () => {
    const events = sessionEvents("ordinary user prose");
    const selected = await collect(
      selectBySkillInvocation(withContext(from(events)), []),
    );
    expect(selected.map(stripContext)).toEqual(events);
  });
});

test("CLI selects before filtering events and does not write non-matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-scan-skill-"));
  const file = join(dir, "session.jsonl");
  try {
    await writeFile(file, piSession(envelope("recruiter-replay")));

    const matching = await runCli([
      file,
      "--skill",
      "other,recruiter-replay",
      "--type",
      "assistant_message",
      "--format",
      "md",
    ]);
    expect(matching.exitCode).toBe(0);
    expect(matching.stdout).toContain("# session skill-test");
    expect(matching.stdout).toContain("## assistant");
    expect(matching.stdout).toContain("I can help");
    expect(matching.stdout).not.toContain("Skill instructions");
    expect(matching.stderr).toContain("scanned 1 sessions, wrote 1");

    const invocations = await runCli([file, "--type", "skill_invocation"]);
    expect(invocations.exitCode).toBe(0);
    const invocationEvents = invocations.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(invocationEvents.at(-1)).toMatchObject({
      type: "skill_invocation",
      name: "recruiter-replay",
      path: "/skills/recruiter-replay/SKILL.md",
      sourceEventId: "u1",
    });

    const missing = await runCli([file, "--skill", "copywriting"]);
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("scanned 1 sessions, wrote 0");

    const withoutSkill = await runCli([
      file,
      "--type",
      "assistant_message",
      "--format",
      "md",
    ]);
    expect(withoutSkill.exitCode).toBe(0);
    expect(withoutSkill.stdout).toBe(matching.stdout);
    expect(withoutSkill.stderr).toContain("scanned 1 sessions, wrote 1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function sessionEvents(skillText: string): SessionEvent[] {
  const events: SessionEvent[] = [
    {
      type: "session_start",
      formatVersion: 1,
      id: "session-1",
      timestamp: "2026-08-19T10:00:00.000Z",
      cwd: "/tmp/project",
    },
    user("u1", "before invocation"),
    assistant("a1", "before response"),
    user("u2", skillText),
  ];
  const skill = parsePiSkillInvocation(skillText);
  if (skill) {
    events.push({
      type: "skill_invocation",
      id: "u2:skill",
      parentId: "u2",
      timestamp: "2026-08-19T10:00:01.000Z",
      sourceEventId: "u2",
      ...skill,
    });
  }
  events.push(assistant("a2", "after invocation"));
  return events;
}

function user(id: string, text: string): SessionEvent {
  return {
    type: "user_message",
    id,
    parentId: null,
    timestamp: "2026-08-19T10:00:01.000Z",
    text,
  };
}

function assistant(id: string, text: string): SessionEvent {
  return assistantWithTools([], id, text);
}

function assistantWithTools(
  toolCalls: ToolCall[],
  id = "assistant",
  text = "",
): SessionEvent {
  return {
    type: "assistant_message",
    id,
    parentId: null,
    timestamp: "2026-08-19T10:00:02.000Z",
    text,
    toolCalls,
    provider: "test",
    model: "test-model",
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

function stripContext(event: ContextualEvent): SessionEvent {
  const { context, ...raw } = event;
  return raw as SessionEvent;
}

function piSession(skillText: string): string {
  const values = [
    {
      type: "session",
      version: 3,
      id: "skill-test",
      timestamp: "2026-08-19T10:00:00.000Z",
      cwd: "/tmp/project",
    },
    {
      type: "model_change",
      id: "m1",
      parentId: null,
      timestamp: "2026-08-19T10:00:00.100Z",
      provider: "test",
      modelId: "test-model",
    },
    {
      type: "message",
      id: "u1",
      parentId: "m1",
      timestamp: "2026-08-19T10:00:01.000Z",
      message: { role: "user", content: skillText },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-08-19T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I can help" }],
        provider: "test",
        model: "test-model",
      },
    },
  ];
  return values.map((value) => JSON.stringify(value)).join("\n") + "\n";
}

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../cli.ts"), ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout: await stdout, stderr: await stderr, exitCode };
}
