import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "session-scan-package-"));
const consumer = join(temporary, "consumer");
const home = join(temporary, "home");
const archive = join(temporary, "session-scan.tgz");
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  BUN_INSTALL_CACHE_DIR: join(temporary, "cache"),
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
};
delete env.NODE_PATH;

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  assert.equal(result.exitCode, 0, `${command.join(" ")}\n${stdout}\n${stderr}`);
  return stdout;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(join(directory, entry.name), `${relative}/`));
    } else {
      files.push(relative);
    }
  }
  return files;
}

try {
  await mkdir(consumer);
  await mkdir(home);
  run([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], root);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "session-scan-package-smoke",
    private: true,
    type: "module",
    dependencies: { "session-scan": `file:${archive}` },
  }));
  // No registry access, lifecycle scripts, or ambient development dependencies.
  run([process.execPath, "install", "--offline", "--ignore-scripts", "--production", "--omit=peer"], consumer);

  const installed = join(consumer, "node_modules/session-scan");
  const files = await listFiles(installed);
  for (const file of files) {
    assert.ok(
      /^(package\.json|README\.md|LICENSE)$/.test(file)
      || (file.startsWith("src/") && file.endsWith(".ts") && !file.endsWith(".test.ts"))
      || file === "examples/adapters/pi.ts",
      `Unexpected packed file: ${file}`,
    );
  }
  assert.ok(files.includes("examples/adapters/pi.ts"), "Bundled Pi adapter is missing");
  assert.ok(files.includes("src/index.ts"), "Public API entry point is missing");
  assert.ok(files.includes("src/cli.ts"), "CLI entry point is missing");

  const fixture = join(consumer, "session.jsonl");
  await writeFile(fixture, [
    { type: "session", version: 3, id: "package-smoke", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/synthetic" },
    { type: "message", id: "message-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Packed installation works" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  await writeFile(join(consumer, "consumer.ts"), `
import { scanSession } from "session-scan";
const events = [];
for await (const event of scanSession(${JSON.stringify(fixture)})) events.push(event);
console.log(JSON.stringify(events));
`);
  const apiEvents = JSON.parse(run([process.execPath, "consumer.ts"], consumer));
  const cliEvents = run([join(consumer, "node_modules/.bin/session-scan"), fixture], consumer)
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(cliEvents, apiEvents);
  assert.deepEqual(apiEvents.map((event: { type: string; text?: string }) => ({
    type: event.type,
    ...(event.text === undefined ? {} : { text: event.text }),
  })), [
    { type: "session_start" },
    { type: "user_message", text: "Packed installation works" },
  ]);

  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  console.log(`Packed installation passed: ${manifest.name}@${manifest.version}, ${files.length} files, Bun ${Bun.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
