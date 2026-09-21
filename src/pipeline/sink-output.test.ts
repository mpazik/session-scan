import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { openFileSink } from "./sink.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "sink-output-"));
  roots.push(root);
  return root;
}

test("file sinks preserve complete Unicode chunks and close idempotently", async () => {
  const path = join(await workspace(), "nested", "out.jsonl");
  const sink = await openFileSink(path);
  try {
    await sink.write("hello \u{1f600}\n");
    await sink.write("next\n");
  } finally { await sink.close(); }
  await sink.close();
  expect(await readFile(path, "utf8")).toBe("hello \u{1f600}\nnext\n");
  await expect(sink.write("late")).rejects.toThrow("Sink is closed");
});

test("existing regular files remain unchanged", async () => {
  const path = join(await workspace(), "existing");
  await writeFile(path, "keep me");
  await expect(openFileSink(path)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(path, "utf8")).toBe("keep me");
});

test("existing symlinks cannot overwrite their targets", async () => {
  const root = await workspace();
  const target = join(root, "target");
  const output = join(root, "link");
  await writeFile(target, "keep target");
  await symlink(target, output);
  await expect(openFileSink(output)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(target, "utf8")).toBe("keep target");
});

test("dangling output symlinks cannot create their targets", async () => {
  const root = await workspace();
  const target = join(root, "missing");
  const output = join(root, "link");
  await symlink(target, output);
  await expect(openFileSink(output)).rejects.toMatchObject({ code: "EEXIST" });
  await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
});

test("concurrent opens have exactly one exclusive winner", async () => {
  const path = join(await workspace(), "output");
  const outcomes = await Promise.allSettled([openFileSink(path), openFileSink(path)]);
  const winners = outcomes.filter((result) => result.status === "fulfilled");
  try {
    expect(winners).toHaveLength(1);
    expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "EEXIST" } });
    await winners[0]!.value.write("winner");
  } finally {
    await Promise.all(winners.map((winner) => winner.value.close()));
  }
  expect(await readFile(path, "utf8")).toBe("winner");
});

const sinkUrl = pathToFileURL(join(import.meta.dir, "sink.ts")).href;
function child(script: string) {
  return spawn(process.execPath, ["--eval", `import { stdoutSink } from ${JSON.stringify(sinkUrl)}; ${script}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("stdout waits for a paused consumer and delivers every byte once resumed", async () => {
  const proc = child(`
    const baseline = process.stdout.listenerCount("error");
    const sink = stdoutSink();
    let settled = false;
    const writing = sink.write("x".repeat(8 * 1024 * 1024)).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    console.error(settled ? "premature" : "pending");
    await writing;
    await sink.close();
    console.error(process.stdout.listenerCount("error") === baseline ? "clean" : "leaked");
  `);
  const exited = once(proc, "exit");
  try {
    const [first] = await once(proc.stderr, "data");
    expect(String(first)).toBe("pending\n");
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    let bytes = 0;
    for await (const chunk of proc.stdout) {
      expect(chunk.equals(Buffer.alloc(chunk.length, "x"))).toBe(true);
      bytes += chunk.length;
    }
    expect(await exited).toEqual([0, null]);
    expect({ bytes, stderr }).toEqual({ bytes: 8 * 1024 * 1024, stderr: "clean\n" });
  } finally {
    if (proc.exitCode === null) proc.kill();
    await exited;
  }
}, 15_000);

test("broken stdout pipes reject without unhandled stream errors", async () => {
  const proc = child(`
    const baseline = process.stdout.listenerCount("error");
    const sink = stdoutSink();
    let code;
    try {
      for (let i = 0; i < 1024; i++) await sink.write("x".repeat(65536));
    } catch (error) { code = error.code; }
    try { await sink.close(); } catch (error) { code ??= error.code; }
    console.error(JSON.stringify({ code, clean: process.stdout.listenerCount("error") === baseline }));
  `);
  const exited = once(proc, "exit");
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await once(proc.stdout, "data");
    proc.stdout.destroy();
    expect(await exited).toEqual([0, null]);
    // Bun's socket-backed subprocess pipes may report ENOTCONN on macOS.
    const result = JSON.parse(stderr);
    expect(["EPIPE", "ENOTCONN"]).toContain(result.code);
    expect(result).toEqual({ code: result.code, clean: true });
  } finally {
    if (proc.exitCode === null) proc.kill();
    await exited;
  }
}, 15_000);
