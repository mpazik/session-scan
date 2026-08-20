#!/usr/bin/env bun

/**
 * scan - one command over the canonical session event stream.
 *
 * Default behavior is faithful normalization: every reduction is opt-in. Pass a
 * file to normalize it; pass discovery flags to mine many sessions. LLM calls
 * and aggregation are out of scope — pipe the output downstream (DuckDB over the
 * ndjson; `--format md | your-llm`).
 *
 *   scan <input>                         normalize one file (replaces normalize.ts)
 *   scan --cwd binder --format md ...    readable transcripts of recent sessions
 *
 * Pipeline (per session):
 *   locate → adapter parse/head selection → withContext → filter
 *     → [scanner] → trim → render → sink
 *
 * Flags:
 *   locate    <input> | --cwd --since --until --source --include-subagents --adapter <path>...
 *   parse     --head <entry-id>              (requires one positional input)
 *   filter    --skill a,b  --type a,b  --tool a,b  --error  --role user|assistant|tool_result
 *   scanner   --scanner ./file.ts            (runs after filter, replaces trim)
 *   trim      --tool-lines N  --no-thinking  (default path only)
 *   render    --format md                    (ndjson default)
 *   sink      --out <file>  --out-dir <dir>  (stdout default)
 *
 * Examples:
 *   scan test/fixtures/pi.jsonl
 *   scan ~/.pi/agent/sessions/.../session.jsonl --head a1b2c3d4 --format md
 *   scan --cwd binder --format md --tool-lines 1 --no-thinking
 *   session-scan --cwd journal --skill recruiter-replay --format md
 *   scan --cwd binder --format md --out-dir tmp/transcripts
 *   scan --cwd all --error --type tool_result --out tmp/errors.jsonl
 *   scan --cwd binder --scanner ./examples/scanners/binder-failures.ts
 */

import { parseArgs } from "util";
import { basename, resolve } from "path";
import {
  discoverSessions,
  discover as discoverAdapters,
} from "./parser/index.js";
import { loadScanner } from "./pipeline/index.js";
import { run, type SinkConfig } from "./runner.js";
import type { FilterCriteria } from "./pipeline/index.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    // locate
    cwd: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    source: { type: "string" },
    adapter: { type: "string", multiple: true },
    "include-subagents": { type: "boolean", default: false },
    // parse
    head: { type: "string" },
    // filter
    type: { type: "string" },
    tool: { type: "string" },
    skill: { type: "string" },
    error: { type: "boolean", default: false },
    role: { type: "string" },
    // scanner
    scanner: { type: "string" },
    // trim
    "tool-lines": { type: "string" },
    "no-thinking": { type: "boolean", default: false },
    // render
    format: { type: "string" },
    // sink
    out: { type: "string" },
    "out-dir": { type: "string" },
  },
  strict: true,
});

const input = positionals[0];
const head = values.head?.trim();
if (values.head !== undefined) {
  if (positionals.length !== 1) {
    throw new Error("--head requires a positional session file");
  }
  if (!head || head === "null") {
    throw new Error("--head requires a non-empty, non-null entry ID");
  }
}

// Load adapters: built-in + user + --adapter, plus the bundled pi reference
// adapter so its files auto-detect (pi is not built in).
const piRef = resolve(import.meta.dir, "../examples/adapters/pi.ts");
await discoverAdapters({ extra: [piRef, ...(values.adapter ?? [])] });

// -- locate ------------------------------------------------------------------

async function* single(file: string): AsyncGenerator<string> {
  yield file;
}

function defaultCwd(): string | undefined {
  if (values.cwd === "all") return undefined;
  if (values.cwd) return values.cwd;
  const cwd = process.cwd();
  const m = cwd.match(/\/src\/([^/]+)/);
  return m ? m[1] : basename(cwd);
}

function defaultSince(): Date | undefined {
  if (values.since) return new Date(values.since);
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d;
}

const files: AsyncIterable<string> = input
  ? single(input)
  : discoverSessions({
      cwdFilter: defaultCwd(),
      since: defaultSince(),
      until: values.until ? new Date(values.until) : undefined,
      source: values.source,
      includeSubagents: values["include-subagents"],
    });

// -- filter ------------------------------------------------------------------

const ROLES = new Set(["user", "assistant", "tool_result"]);
const roles = values.role
  ?.split(",")
  .map((r) => r.trim())
  .filter((r) => ROLES.has(r)) as FilterCriteria["roles"];

const filter: FilterCriteria = {
  skills: values.skill?.split(",").map((s) => s.trim()).filter(Boolean),
  types: values.type?.split(",").map((s) => s.trim()),
  tools: values.tool?.split(",").map((s) => s.trim()),
  error: values.error,
  roles,
};

// -- scanner -----------------------------------------------------------------

const scanner = values.scanner ? await loadScanner(values.scanner) : undefined;

// -- trim --------------------------------------------------------------------

const trim = {
  toolLines:
    values["tool-lines"] !== undefined
      ? parseInt(values["tool-lines"], 10)
      : undefined,
  noThinking: values["no-thinking"],
};

// -- render + sink -----------------------------------------------------------

const format = values.format === "md" ? "md" : "ndjson";

const sink: SinkConfig = values["out-dir"]
  ? { kind: "dir", path: values["out-dir"] }
  : values.out
    ? { kind: "file", path: values.out }
    : { kind: "stdout" };

// -- run ---------------------------------------------------------------------

const t0 = performance.now();
const stats = await run({
  files,
  source: values.source,
  head,
  filter,
  scanner,
  trim,
  format,
  sink,
});
const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

console.error(
  `scanned ${stats.sessionsFound} sessions, wrote ${stats.sessionsWritten} (${stats.eventsWritten} events) in ${elapsed}s`,
);
