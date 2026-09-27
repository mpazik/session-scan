import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "session-scan-package-"));
const consumer = join(temporary, "consumer");
const home = join(temporary, "home");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  npm_config_cache: join(temporary, "cache"),
};
delete env.NODE_PATH;

function run(command: string[], cwd: string): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
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
  const packed = JSON.parse(run([
    "npm", "pack", "--json", "--pack-destination", temporary,
  ], root));
  const archive = join(temporary, packed[0].filename);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "session-scan-package-smoke",
    private: true,
    type: "module",
    dependencies: { "session-scan": `file:${archive}` },
  }));
  // Empty cache, no registry access, lifecycle scripts, or development dependencies.
  run(["npm", "install", "--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], consumer);

  const installed = join(consumer, "node_modules/session-scan");
  const files = await listFiles(installed);
  for (const file of files) {
    assert.ok(
      /^(package\.json|README\.md|LICENSE)$/.test(file)
      || file === "dist/package.json"
      || (/^dist\/(src\/|examples\/adapters\/pi\.)/.test(file)
        && /\.(js|d\.ts)$/.test(file) && !file.includes(".test.")),
      `Unexpected packed file: ${file}`,
    );
  }
  assert.ok(files.includes("dist/examples/adapters/pi.js"), "Bundled Pi adapter is missing");
  assert.ok(files.includes("dist/src/index.js"), "Public API entry point is missing");
  assert.ok(files.includes("dist/src/index.d.ts"), "Public type declarations are missing");
  assert.ok(files.includes("dist/src/cli.js"), "CLI entry point is missing");

  const fixture = join(consumer, "session.jsonl");
  await writeFile(fixture, [
    { type: "session", version: 3, id: "package-smoke", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/synthetic" },
    { type: "message", id: "message-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Packed installation works" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  await writeFile(join(consumer, "consumer.mjs"), `
import { scanSession } from "session-scan";
const events = [];
for await (const event of scanSession(${JSON.stringify(fixture)})) events.push(event);
console.log(JSON.stringify(events));
`);
  await writeFile(join(consumer, "consumer.mts"), `
import { scanSession, type ContextualEvent, type ScanSessionOptions } from "session-scan";
const options: ScanSessionOptions = { filter: { lastTurns: 2 } };
for await (const event of scanSession("session.jsonl", options)) {
  const contextual: ContextualEvent = event;
  if (contextual.type === "user_message") console.log(contextual.text);
}
`);
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, target: "ES2024", module: "NodeNext", types: [],
    },
    files: ["consumer.mts"],
  }));
  run(["node", join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], consumer);
  const apiEvents = JSON.parse(run(["node", "consumer.mjs"], consumer));
  const cli = join(consumer, "node_modules/.bin/session-scan");
  const cliEvents = run([cli, fixture], consumer).trim().split("\n").map((line) => JSON.parse(line));
  const start = {
    type: "session_start", id: "package-smoke", formatVersion: 1, agent: "pi",
    timestamp: "2026-01-01T00:00:00.000Z", cwd: "/synthetic", path: fixture,
  };
  const message = {
    type: "user_message", id: "message-1", parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z", text: "Packed installation works",
  };
  assert.deepEqual(cliEvents, [
    { ...start, sid: "package-smoke" }, { ...message, sid: "package-smoke" },
  ]);
  assert.deepEqual(apiEvents, [
    { ...start, context: { model: "", prevTurn: null, turn: null } },
    { ...message, context: { model: "", prevTurn: null, turn: { userMessage: message, events: [] } } },
  ]);

  // Exercise built-in adapter discovery as well as the separately bundled Pi adapter.
  for (const name of ["claude", "codex", "claude-export"]) {
    const extension = name === "claude-export" ? "txt" : "jsonl";
    const output = run([cli, join(root, `test/fixtures/${name}.${extension}`)], consumer);
    assert.equal(JSON.parse(output.split("\n")[0]!).type, "session_start");
  }
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(run([cli, "--version"], consumer), `${manifest.version}\n`);
  assert.match(run([cli, "--help"], consumer), /^Usage: session-scan/);
  console.log(`Packed installation passed: ${manifest.name}@${manifest.version}, ${files.length} files, ${run(["node", "--version"], consumer).trim()}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
