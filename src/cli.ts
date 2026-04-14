#!/usr/bin/env bun

/**
 * agentlog - mine pi sessions with pluggable scanners
 *
 * Usage:
 *   bun src/cli.ts <scanner> [options]
 *   bun src/cli.ts list
 *
 * Options:
 *   --cwd <pattern>     Filter sessions by cwd substring (default: repo from cwd, "all" for everything)
 *   --since <date>      Only sessions after this date (default: 7 days ago)
 *   --until <date>      Only sessions before this date
 *   --limit <n>         Max results to display (default: all)
 *   --json              Output as JSON
 *   --stats             Show summary stats only
 *   --sessions-dir <p>  Override sessions directory
 *
 * Scanners:
 *   Built-in:  src/scanners/*.ts
 *   User:      ~/.agentlog/scanners/*.ts  (export { scanner } or default)
 *
 * Examples:
 *   bun src/cli.ts binder-failures --stats           # current repo, last 7 days
 *   bun src/cli.ts binder-failures --cwd binder      # all binder sessions, last 7 days
 *   bun src/cli.ts binder-failures --cwd all --since 2026-01-01
 *   bun src/cli.ts list
 */

import { parseArgs } from "util";
import { join, basename } from "path";
import { discoverSessionFiles, streamSession } from "./parser.js";
import { withContext } from "./context.js";
import * as registry from "./scanners/index.js";
import type { ScanResult } from "./types.js";

// ---------------------------------------------------------------------------
// Discover scanners (built-in + user-defined)
// ---------------------------------------------------------------------------

await registry.discover();

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const scannerName = args.find((a) => !a.startsWith("-"));

if (!scannerName || scannerName === "list") {
  const all = registry.list();
  console.log("Available scanners:\n");
  for (const s of all) {
    console.log(`  ${s.name.padEnd(24)} ${s.description}`);
  }
  console.log();
  console.log("User scanners: ~/.agentlog/scanners/*.ts");
  process.exit(0);
}

const scanner = registry.get(scannerName);
if (!scanner) {
  console.error(`Unknown scanner: ${scannerName}`);
  console.error(`Run "bun src/cli.ts list" to see available scanners.`);
  process.exit(1);
}

const flagArgs = args.filter((a) => a !== scannerName);

const { values } = parseArgs({
  args: flagArgs,
  options: {
    cwd: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "string" },
    json: { type: "boolean", default: false },
    stats: { type: "boolean", default: false },
    "sessions-dir": { type: "string" },
  },
  strict: true,
});

const sessionsDir =
  values["sessions-dir"] ??
  join(process.env.HOME || "~", ".pi", "agent", "sessions");

// Default --cwd: derive repo name from current directory
function defaultCwd(): string | undefined {
  if (values.cwd === "all") return undefined;
  if (values.cwd) return values.cwd;
  const cwd = process.cwd();
  const srcMatch = cwd.match(/\/src\/([^/]+)/);
  if (srcMatch) return srcMatch[1];
  return basename(cwd);
}

// Default --since: 7 days ago
function defaultSince(): Date | undefined {
  if (values.since) return new Date(values.since);
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d;
}

const opts = {
  cwdFilter: defaultCwd(),
  since: defaultSince(),
  until: values.until ? new Date(values.until) : undefined,
};

const limit = values.limit ? parseInt(values.limit, 10) : Infinity;

// ---------------------------------------------------------------------------
// Run: collect + extract
// ---------------------------------------------------------------------------

const allResults: ScanResult[] = [];
let filesScanned = 0;
let filesMatched = 0;
let candidatesCollected = 0;
const sessionsWithResults = new Set<string>();

const t0 = performance.now();

for await (const filePath of discoverSessionFiles(sessionsDir)) {
  filesScanned++;

  let matched = false;

  for await (const candidate of scanner.collect(
    withContext(streamSession(filePath, opts)),
  )) {
    if (!matched) {
      matched = true;
      filesMatched++;
    }
    candidatesCollected++;

    const results = await scanner.extract(candidate);
    for (const r of results) {
      allResults.push(r);
      sessionsWithResults.add(filePath);
    }
  }

  if (!matched) {
    for await (const event of streamSession(filePath, opts)) {
      if (event.type === "session_start") {
        filesMatched++;
      }
      break;
    }
  }
}

const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (values.json) {
  const output = {
    scanner: scanner.name,
    stats: {
      filesScanned,
      filesMatched,
      candidatesCollected,
      sessionsWithResults: sessionsWithResults.size,
      totalResults: allResults.length,
      elapsed: `${elapsed}s`,
    },
    results: allResults.slice(0, limit),
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

console.log(
  `${scanner.name}: scanned ${filesScanned} files, ${filesMatched} matched, ${elapsed}s`,
);
console.log(
  `Collected ${candidatesCollected} candidates, produced ${allResults.length} results from ${sessionsWithResults.size} sessions`,
);
console.log();

if (values.stats) {
  const byKind = new Map<string, number>();
  for (const r of allResults) {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  }
  for (const [kind, count] of [...byKind.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${kind}: ${count}`);
  }

  console.log();
  const byCwd = new Map<string, number>();
  for (const r of allResults) {
    byCwd.set(r.cwd, (byCwd.get(r.cwd) ?? 0) + 1);
  }
  console.log("By working directory:");
  for (const [cwd, count] of [...byCwd.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)) {
    console.log(`  ${count.toString().padStart(4)}  ${cwd}`);
  }

  console.log();
  const bySummary = new Map<string, number>();
  for (const r of allResults) {
    const key = r.summary.slice(0, 80);
    bySummary.set(key, (bySummary.get(key) ?? 0) + 1);
  }
  console.log("Top patterns:");
  for (const [pattern, count] of [...bySummary.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)) {
    console.log(`  ${count.toString().padStart(4)}  ${pattern}`);
  }

  process.exit(0);
}

// Detailed output
const displayed = allResults.slice(0, limit);
for (const r of displayed) {
  const date = new Date(r.timestamp).toLocaleString();
  const cwdShort = r.cwd.replace(/.*\/src\//, "");

  console.log(
    `${dim(date)}  ${yellow(r.kind.padEnd(14))}  ${cyan(cwdShort)}`,
  );
  console.log(`  ${r.summary}`);

  const data = r.data as Record<string, unknown>;
  if (data?.command) {
    console.log(`  cmd: ${dim(truncLine(String(data.command), 120))}`);
  }
  if (data?.userPrompt) {
    console.log(`  ask: ${dim(truncLine(String(data.userPrompt), 120))}`);
  }
  if (
    typeof data?.priorErrorsInTurn === "number" &&
    data.priorErrorsInTurn > 0
  ) {
    console.log(
      `  ${dim(`(${data.priorErrorsInTurn} prior error(s) in this turn)`)}`,
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}
function yellow(s: string) {
  return `\x1b[33m${s}\x1b[0m`;
}
function cyan(s: string) {
  return `\x1b[36m${s}\x1b[0m`;
}

function truncLine(s: string, max: number): string {
  const line = s.replace(/\n/g, " ").trim();
  if (line.length <= max) return line;
  return line.slice(0, max) + "...";
}
