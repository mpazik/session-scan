import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { run, type RunOptions } from "./runner.js";
import { register } from "./parser/index.js";
import type { SessionEvent } from "./session.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(id = "safe-session") {
  const root = await mkdtemp(join(tmpdir(), "session-output-"));
  roots.push(root);
  const input = join(root, "input.jsonl");
  const original = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-01-01T00:00:00Z",
    payload: { id, cwd: "/synthetic", timestamp: "2026-01-01T00:00:00Z" },
  }) + "\n";
  await writeFile(input, original);
  const output = join(root, "out");
  const options: RunOptions = {
    files: files(input), source: "codex", filter: {}, trim: {}, format: "ndjson",
    sink: { kind: "dir", path: output },
  };
  return { root, input, original, output, options };
}

async function* files(...paths: string[]) { yield* paths; }

async function assertUnsafeId(id: string) {
  const w = await workspace(id);
  await expect(run(w.options)).rejects.toThrow("Unsafe session ID");
  expect(await readdir(w.root)).toEqual(["input.jsonl"]);
  expect(await readFile(w.input, "utf8")).toBe(w.original);
}

test("directory output rejects the demonstrated parent traversal", async () => assertUnsafeId("../escaped"));
test("directory output rejects Windows separators on every platform", async () => assertUnsafeId("..\\escaped"));
test("directory output rejects embedded forward separators", async () => assertUnsafeId("nested/session"));
test("directory output rejects absolute session IDs", async () => assertUnsafeId("/escaped"));
test("directory output rejects drive-prefixed IDs", async () => assertUnsafeId("C:escaped"));
test("directory output rejects NUL bytes", async () => assertUnsafeId("bad\u0000id"));
test("directory output rejects dot components", async () => assertUnsafeId(".."));

test("valid IDs produce complete output and accurate stats", async () => {
  const w = await workspace();
  expect(await run(w.options)).toEqual({ sessionsFound: 1, sessionsWritten: 1, eventsWritten: 1 });
  expect(await readdir(w.output)).toEqual(["safe-session.jsonl"]);
  const row = JSON.parse(await readFile(join(w.output, "safe-session.jsonl"), "utf8"));
  expect(row).toMatchObject({ type: "session_start", sid: "safe-session" });
});

test("a repeated session ID refuses to replace the first session", async () => {
  const w = await workspace();
  w.options.files = files(w.input, w.input);
  await expect(run(w.options)).rejects.toMatchObject({ code: "EEXIST" });
  expect((await readFile(join(w.output, "safe-session.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
});

test("single-file output cannot overwrite its input", async () => {
  const w = await workspace();
  await expect(run({ ...w.options, sink: { kind: "file", path: w.input } })).rejects.toThrow("Input/output overlap");
  expect(await readFile(w.input, "utf8")).toBe(w.original);
});

test("directory output cannot overlap an input discovered later", async () => {
  const w = await workspace();
  await mkdir(w.output);
  const later = join(w.output, "later.jsonl");
  await writeFile(later, w.original);
  w.options.files = files(w.input, later);
  await expect(run(w.options)).rejects.toThrow("Input/output overlap");
  expect(await readdir(w.output)).toEqual(["later.jsonl"]);
  expect(await readFile(later, "utf8")).toBe(w.original);
});

test("symlinked output directories cannot hide input overlap", async () => {
  const w = await workspace();
  await symlink(w.root, w.output);
  await expect(run(w.options)).rejects.toThrow("Input/output overlap");
  expect(await readFile(w.input, "utf8")).toBe(w.original);
});

test("a sibling with the same directory prefix is not overlap", async () => {
  const w = await workspace();
  await mkdir(w.output + "-inputs");
  const input = join(w.output + "-inputs", "input.jsonl");
  await writeFile(input, w.original);
  expect(await run({ ...w.options, files: files(input) })).toEqual({ sessionsFound: 1, sessionsWritten: 1, eventsWritten: 1 });
});

test("discovery fails before creating any output and closes its iterator", async () => {
  const w = await workspace();
  let closed = false;
  async function* failingFiles() {
    try { yield w.input; throw new Error("discovery failed"); }
    finally { closed = true; }
  }
  await expect(run({ ...w.options, files: failingFiles() })).rejects.toThrow("discovery failed");
  expect({ closed, entries: await readdir(w.root) }).toEqual({ closed: true, entries: ["input.jsonl"] });
});

let adapterId = 0;
function trackedSource(events: SessionEvent[], failure?: Error) {
  const state = { active: false, closed: false };
  const name = `output-cleanup-${adapterId++}`;
  register({
    name, detect: () => false, storageDir: () => "/unused",
    async *discover() {},
    async *parse() {
      state.active = true;
      try { yield* events; if (failure) throw failure; }
      finally { state.active = false; state.closed = true; }
    },
  });
  return { name, state };
}
const header = {
  type: "session_start", id: "tracked", timestamp: "2026-01-01T00:00:00Z",
  cwd: "/synthetic", agent: "synthetic", formatVersion: 1,
} as const satisfies SessionEvent;
const message = { type: "user_message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01Z", text: "hello" } as const satisfies SessionEvent;

test("an early scanner return closes an upstream iterator it never consumed", async () => {
  const w = await workspace();
  const source = trackedSource([header, message]);
  await run({ ...w.options, source: source.name, scanner: async function* () {} });
  expect(source.state).toEqual({ active: false, closed: true });
});

test("scanner failure closes the source and retains partial output", async () => {
  const w = await workspace();
  const source = trackedSource([header, message]);
  await expect(run({ ...w.options, source: source.name, scanner: async function* (events) {
    for await (const event of events) { yield { ...event }; throw new Error("scanner failed"); }
  } })).rejects.toThrow("scanner failed");
  expect(source.state).toEqual({ active: false, closed: true });
  expect((await readFile(join(w.output, "tracked.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
});

test("a rejected output path closes the already-peeked source", async () => {
  const w = await workspace();
  const source = trackedSource([{ ...header, id: "../escaped" }, message]);
  await expect(run({ ...w.options, source: source.name })).rejects.toThrow("Unsafe session ID");
  expect(source.state).toEqual({ active: false, closed: true });
});

test("sink-open failure closes the already-peeked source", async () => {
  const w = await workspace();
  const source = trackedSource([header, message]);
  await mkdir(w.output);
  await writeFile(join(w.output, "tracked.jsonl"), "keep");
  await expect(run({ ...w.options, source: source.name })).rejects.toMatchObject({ code: "EEXIST" });
  expect(source.state).toEqual({ active: false, closed: true });
  expect(await readFile(join(w.output, "tracked.jsonl"), "utf8")).toBe("keep");
});

test("a malformed initial event closes the skipped source", async () => {
  const w = await workspace();
  const source = trackedSource([message, header]);
  expect(await run({ ...w.options, source: source.name })).toEqual({ sessionsFound: 0, sessionsWritten: 0, eventsWritten: 0 });
  expect(source.state).toEqual({ active: false, closed: true });
});

test("skill selection also closes a malformed initial stream", async () => {
  const w = await workspace();
  const source = trackedSource([message, header]);
  await run({ ...w.options, source: source.name, filter: { skills: ["missing"] } });
  expect(source.state).toEqual({ active: false, closed: true });
});

test("parser failure cleans up the source and retains partial shared output", async () => {
  const w = await workspace();
  const source = trackedSource([header], new Error("parse failed"));
  const path = join(w.root, "shared.jsonl");
  await expect(run({ ...w.options, source: source.name, sink: { kind: "file", path } })).rejects.toThrow("parse failed");
  expect(source.state).toEqual({ active: false, closed: true });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ type: "session_start", sid: "tracked" });
});

test("broken stdout closes the scanner, parser, and discovery iterator", async () => {
  const runnerUrl = pathToFileURL(join(import.meta.dir, "runner.ts")).href;
  const parserUrl = pathToFileURL(join(import.meta.dir, "parser/index.ts")).href;
  const script = `
    import { run } from ${JSON.stringify(runnerUrl)};
    import { register } from ${JSON.stringify(parserUrl)};
    const closed = { parser: false, scanner: false, files: false };
    register({
      name: "output-pipe", detect: () => false, storageDir: () => "/unused",
      async *discover() {},
      async *parse() {
        try {
          yield ${JSON.stringify(header)};
          for (let i = 0; i < 1024; i++) yield { ...${JSON.stringify(message)}, text: "x".repeat(65536) };
        } finally { closed.parser = true; }
      },
    });
    async function* files() { try { yield "synthetic"; } finally { closed.files = true; } }
    async function* scanner(events) {
      try { for await (const event of events) yield { ...event }; }
      finally { closed.scanner = true; }
    }
    let code;
    try {
      await run({ files: files(), source: "output-pipe", scanner, filter: {}, trim: {}, format: "ndjson", sink: { kind: "stdout" } });
    } catch (error) { code = error.code; }
    console.error(JSON.stringify({ code, closed }));
  `;
  const proc = spawn(process.execPath, ["--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(proc, "exit");
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    // Wait for the large body, not the header, so the scanner has started.
    let bytes = 0;
    for await (const chunk of proc.stdout) {
      bytes += chunk.length;
      if (bytes > 1024) break;
    }
    expect(await exited).toEqual([0, null]);
    const result = JSON.parse(stderr);
    expect(["EPIPE", "ENOTCONN"]).toContain(result.code);
    expect(result.closed).toEqual({ parser: true, scanner: true, files: true });
  } finally {
    if (proc.exitCode === null) proc.kill();
    await exited;
  }
}, 15_000);
