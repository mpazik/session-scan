#!/usr/bin/env bun

/**
 * normalize - convert a native harness session file into canonical session.ts
 * events (one JSON object per line).
 *
 * The harness is auto-detected; you do NOT pass its name. Each adapter's
 * detect() identifies its own format. claude-code and codex are built in; the
 * pi reference adapter (examples/adapters/pi.ts) is auto-loaded here so pi
 * files work too. Load any extra adapters with --adapter <path>.
 *
 * Usage:
 *   bun scripts/normalize.ts <input> [--out <file>] [--adapter <path>]... [--source <name>]
 *
 * Default output: <input-dir>/<input-name>-normalized.jsonl
 * Pass --out - to write to stdout.
 *
 * Examples:
 *   bun scripts/normalize.ts data/claude.jsonl
 *   bun scripts/normalize.ts data/claude.jsonl --out data/claude-normalized.jsonl
 *   bun scripts/normalize.ts data/codex.jsonl
 *   bun scripts/normalize.ts data/pi.jsonl
 */

import { parseArgs } from "util";
import { dirname, join, basename, extname, resolve } from "path";
import { streamSession, discover } from "../src/parser/index.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    adapter: { type: "string", multiple: true },
    source: { type: "string", short: "s" },
  },
});

const input = positionals[0];
if (!input) {
  console.error("usage: bun scripts/normalize.ts <input> [--out <file>] [--adapter <path>]... [--source <name>]");
  process.exit(1);
}

// Default output sits next to the input: foo.jsonl -> foo-normalized.jsonl
const defaultOut = join(
  dirname(input),
  `${basename(input, extname(input))}-normalized.jsonl`,
);
const out = values.out ?? defaultOut;
const toStdout = out === "-";

// pi is not built in; load the reference adapter so its files auto-detect too.
const extra = [resolve(import.meta.dir, "../examples/adapters/pi.ts"), ...(values.adapter ?? [])];
await discover({ extra });

let count = 0;
const lines: string[] = [];
for await (const ev of streamSession(input, { source: values.source })) {
  lines.push(JSON.stringify(ev));
  count++;
}
const text = lines.join("\n") + "\n";

if (toStdout) {
  process.stdout.write(text);
} else {
  await Bun.write(out, text);
  console.error(`wrote ${count} events to ${out}`);
}
