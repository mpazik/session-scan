import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const fixture = resolve(import.meta.dir, "../fixtures/pi.jsonl");
const cli = resolve(import.meta.dir, "../../src/cli.ts");

describe("CLI turn and tool-result filtering", () => {
  test("combines head selection, final turns, thinking trim, and failed results", async () => {
    const result = await runCli([
      fixture,
      "--head",
      "f3c5b1d0",
      "--last-turns",
      "2",
      "--no-thinking",
      "--tool-results",
      "errors",
    ]);

    expect(result.exitCode).toBe(0);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events.map((event) => event.id)).toEqual([
      "019ea093-2c42-77a2-8922-98391c5be402",
      "a1f4c2d8",
      "b3e5d1f9",
      "c4f6e2a1",
      "d5a7f3b2",
      "f7c9b5d4",
      "c0f2e8a7",
      "e2b4a0c9",
      "f3c5b1d0",
    ]);
    expect(events.some((event) => event.id === "30054be3")).toBe(false);
    expect(events.some((event) => event.id === "e6b8a4c3")).toBe(false);
    expect(events.find((event) => event.id === "c4f6e2a1")).toMatchObject({
      type: "tool_result",
      isError: true,
    });
    expect(events.every((event) => event.thinking === undefined)).toBe(true);
  });

  test("validates filter values", async () => {
    const zeroTurns = await runCli([fixture, "--last-turns", "0"]);
    expect(zeroTurns.exitCode).not.toBe(0);
    expect(zeroTurns.stderr).toContain(
      "--last-turns requires a positive integer",
    );

    const unknownResults = await runCli([
      fixture,
      "--tool-results",
      "failed",
    ]);
    expect(unknownResults.exitCode).not.toBe(0);
    expect(unknownResults.stderr).toContain(
      '--tool-results must be "all" or "errors"',
    );
  });
});

async function runCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
