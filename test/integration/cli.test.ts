import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { version } from "../../package.json";

const cli = resolve(import.meta.dir, "../../src/cli.ts");
const fixture = resolve(import.meta.dir, "../fixtures/pi.jsonl");

async function workspace<T>(action: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "session-scan-cli-"));
  try { return await action(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function invoke(dir: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: dir, env: { ...process.env, HOME: dir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

async function assertInvalid(args: string[], message: string) {
  await workspace(async (dir) => {
    const result = await invoke(dir, [...args, "--out", "output/result.jsonl"]);
    expect(result).toEqual({ stdout: "", stderr: expect.stringContaining(message), code: 2 });
    expect(result.stderr).not.toContain("\n    at ");
    expect(await readdir(dir)).toEqual([]);
  });
}

test("help succeeds without loading adapters or opening output", async () => {
  await workspace(async (dir) => {
    const result = await invoke(dir, ["--help", "--adapter", "absent.ts", "--out", "result"]);
    expect(result).toEqual({ code: 0, stderr: "", stdout: expect.stringContaining("Usage: session-scan") });
    expect(await readdir(dir)).toEqual([]);
  });
});

test("short help is reserved for usage", async () => {
  await workspace(async (dir) => {
    const result = await invoke(dir, ["-h"]);
    expect(result).toEqual({ code: 0, stderr: "", stdout: expect.stringContaining("Usage: session-scan") });
  });
});

test("version prints only the package version", async () => {
  await workspace(async (dir) => {
    expect(await invoke(dir, ["--version"])).toEqual({ code: 0, stderr: "", stdout: `${version}\n` });
  });
});

test("unknown options are usage errors", () => assertInvalid(["--wat"], "Unknown option"));
test("missing option values are usage errors", () => assertInvalid(["--format"], "--format"));
test("unknown format fails before a missing input is opened", () => assertInvalid(["missing.jsonl", "--format", "json"], "--format"));
test("extra positional files are not silently ignored", () => assertInvalid(["one", "two"], "at most one"));
test("mixed valid and invalid roles are rejected", () => assertInvalid(["--role", "user,typo"], "--role"));
test("empty roles do not disable filtering", () => assertInvalid(["--role", ""], "--role"));
test("unknown event types are rejected", () => assertInvalid(["--type", "user_message,typo"], "--type"));
test("empty event list entries are rejected", () => assertInvalid(["--type", "error,"], "--type"));
test("an empty positional path cannot silently enable discovery", () => assertInvalid([""], "non-empty path"));
test("empty skill lists cannot silently disable session selection", () => assertInvalid(["--skill", " , "], "--skill"));
test("empty tool list entries are rejected", () => assertInvalid(["--tool", "terminal,"], "--tool"));
test("empty project filters do not silently use the default project", () => assertInvalid(["--cwd", ""], "--cwd"));
test("fractional tool line limits are rejected", () => assertInvalid(["--tool-lines", "1.5"], "non-negative integer"));
test("negative tool line limits are rejected", () => assertInvalid(["--tool-lines=-1"], "non-negative integer"));
test("numeric prefixes are not accepted as tool line limits", () => assertInvalid(["--tool-lines", "2abc"], "non-negative integer"));
test("unsafe tool line integers are rejected", () => assertInvalid(["--tool-lines", "9007199254740992"], "non-negative integer"));
test("zero last-turn counts are rejected", () => assertInvalid(["--last-turns", "0"], "positive integer"));
test("unsafe last-turn integers are rejected", () => assertInvalid(["--last-turns", "9007199254740992"], "positive integer"));
test("fractional last-turn counts are rejected", () => assertInvalid(["--last-turns", "1.2"], "positive integer"));
test("invalid since dates fail before discovery", () => assertInvalid(["--since", "yesterday-ish"], "--since"));
test("invalid until dates fail even for positional input", () => assertInvalid([fixture, "--until", "never"], "--until"));
test("overflowing calendar days are rejected", () => assertInvalid(["--since", "2025-02-29"], "valid date"));
test("reversed explicit date bounds are rejected", () => assertInvalid(["--since", "2025-02-02", "--until", "2025-02-01"], "must not be after"));
test("conflicting output modes fail before creating directories", () => assertInvalid(["--out-dir", "transcripts"], "cannot be used together"));
test("unknown discovery source is not a successful empty scan", () => assertInvalid(["--source", "absent-source"], "unknown --source"));
test("unknown explicit source fails before reading a positional input", () => assertInvalid(["missing", "--source", "absent-source"], "unknown --source"));
test("missing explicit adapters cannot silently fall back", () => assertInvalid(["--adapter", "missing.ts"], "--adapter failed to load"));
test("unsupported tool-result modes are rejected", () => assertInvalid(["--tool-results", "none"], "--tool-results"));
test("head selection requires positional input", () => assertInvalid(["--head", "entry"], "requires a positional"));
test("null heads are rejected before reading input", () => assertInvalid(["missing", "--head", "null"], "non-empty, non-null"));

test("invalid adapter exports fail without creating output", async () => {
  await workspace(async (dir) => {
    await writeFile(join(dir, "bad.ts"), "export default {};\n");
    const result = await invoke(dir, ["--adapter", "bad.ts", "--out", "output/result"]);
    expect(result).toEqual({ code: 2, stdout: "", stderr: expect.stringContaining("--adapter failed to load") });
    expect(await readdir(dir)).toEqual(["bad.ts"]);
  });
});

test("missing input is an operational failure with concise stderr", async () => {
  await workspace(async (dir) => {
    const result = await invoke(dir, ["missing.jsonl"]);
    expect(result).toEqual({ code: 1, stdout: "", stderr: expect.stringContaining("session-scan:") });
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
  });
});

test("valid filters preserve pure ndjson and zero tool-line semantics", async () => {
  await workspace(async (dir) => {
    const result = await invoke(dir, [fixture, "--format", "ndjson", "--role", "tool_result", "--type", "tool_result", "--tool-lines", "0", "--tool-results", "all", "--since", "2024-02-29"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/^scanned 1 sessions, wrote 1 /);
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0].type).toBe("session_start");
    expect(events.slice(1).map((event) => ({ type: event.type, content: event.content }))).toEqual([
      { type: "tool_result", content: "" },
      { type: "tool_result", content: "" },
    ]);
  });
});

const customAdapter = `export default {
  name: "custom-cli-test", detect: () => true,
  async *discover() {},
  async *parse() {
    yield { type: "session_start", id: "custom", formatVersion: 1, timestamp: "2024-01-01T00:00:00Z", cwd: "/project" };
    yield { type: "assistant_message", id: "a", parentId: null, timestamp: "2024-01-01T00:00:01Z", text: "", provider: "test", model: "test", toolCalls: [{ id: "t", name: "native", arguments: {} }] };
  },
  toolNames: { native: "my_custom.tool" }
};`;

test("explicit adapters and arbitrary normalized tool names remain supported", async () => {
  await workspace(async (dir) => {
    await writeFile(join(dir, "adapter.ts"), customAdapter);
    const result = await invoke(dir, ["virtual", "--adapter", "adapter.ts", "--source", "custom-cli-test", "--tool", "my_custom.tool"]);
    expect(result.code).toBe(0);
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["session_start", "assistant_message"]);
    expect(events[1].toolCalls).toEqual([{ id: "t", name: "native", arguments: {}, normalizedName: "my_custom.tool" }]);
  });
});

test("scanner errors named EPIPE are not mistaken for stdout closure", async () => {
  await workspace(async (dir) => {
    await writeFile(join(dir, "scanner.ts"), 'export default async function* () { throw Object.assign(new Error("scanner failed"), {code: "EPIPE"}); }');
    const result = await invoke(dir, [fixture, "--scanner", "scanner.ts"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("session-scan: scanner failed\n");
  });
});

test("closing the downstream pipe is a quiet successful CLI termination", async () => {
  await workspace(async (dir) => {
    await writeFile(join(dir, "scanner.ts"), 'export default async function* () { for (let i = 0; i < 10000; i++) yield {type: "custom_message", customType: "bulk", content: "x".repeat(8192)}; }');
    const child = spawn(process.execPath, [cli, fixture, "--scanner", "scanner.ts"], {
      cwd: dir, env: { ...process.env, HOME: dir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.once("data", () => child.stdout.destroy());
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    } finally { clearTimeout(timer); }
  });
});
