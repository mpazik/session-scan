#!/usr/bin/env node

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
 *   filter    --skill a,b  --last-turns N  --type a,b  --tool a,b  --error
 *             --tool-results errors  --role user|assistant|tool_result
 *   scanner   --scanner ./file.ts            (runs after filter, replaces trim)
 *   trim      --tool-lines N  --no-thinking  (default path only)
 *   render    --format md                    (ndjson default)
 *   sink      --out <file>  --out-dir <dir>  (stdout default)
 *
 * Examples:
 *   scan test/fixtures/pi.jsonl
 *   scan ~/.pi/agent/sessions/.../session.jsonl --head a1b2c3d4 --format md
 *   scan --cwd binder --format md --last-turns 2 --tool-results errors --no-thinking
 *   session-scan --cwd journal --skill recruiter-replay --format md
 *   scan --cwd binder --format md --out-dir tmp/transcripts
 *   scan --cwd all --error --type tool_result --out tmp/errors.jsonl
 *   scan --cwd binder --scanner ./examples/scanners/binder-failures.ts
 */

import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import {
  discoverSessions,
  discover as discoverAdapters,
  get as getAdapter,
  loadAdapterFile,
} from "./parser/index.js";
import { loadScanner } from "./pipeline/index.js";
import { run, type SinkConfig } from "./runner.js";
import type { FilterCriteria } from "./pipeline/index.js";
import manifest from "../package.json" with { type: "json" };
import { isStdoutFailure } from "./pipeline/sink.js";

const HELP = `Usage: session-scan [input] [options]

Normalize one session file, or discover sessions when input is omitted.
Output is ndjson on stdout by default; status and errors go to stderr.

Locate:
  --cwd <substring|all>  Filter discovery (default: current project)
  --since <date>         Discovery start (default: seven days ago)
  --until <date>         Discovery end
  --source <name>        Select a registered adapter
  --adapter <path>       Load an adapter (repeatable)
  --include-subagents   Include discovered subagent sessions
  --head <entry-id>      Select a branch head (requires one input)
Filter:
  --skill <a,b>          Select sessions by skill
  --last-turns <N>       Keep final N turns (positive integer)
  --type <a,b>           Canonical event types
  --role <a,b>           user, assistant, tool_result
  --tool <a,b>           Normalized tool names, including custom names
  --error               Keep errored tool results
  --tool-results <mode> all or errors
Transform:
  --scanner <path>       Custom scanner, replaces trimming
  --tool-lines <N>       Keep N tool-result lines (0 drops the body)
  --no-thinking         Remove thinking
Output:
  --format <format>     ndjson (default) or md
  --out <file>          Create one file; refuses overwrites
  --out-dir <dir>       Create session files outside the inputs; no overwrites
                       Cannot be combined with --out
  -h, --help            Show this help
  --version             Show version

Example: session-scan session.jsonl --format md --last-turns 2
`;

class UsageError extends Error {}

let stdoutError: NodeJS.ErrnoException | undefined;
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  stdoutError = error;
  if (!isClosedPipe(error)) reportError(error);
});

try {
  await main();
} catch (error) {
  // Only a broken pipe observed on stdout is a normal downstream close.
  // An adapter/scanner/file error with the same code must still fail.
  if (!(isStdoutFailure(error) && isClosedPipe(error)) &&
      !(error === stdoutError && stdoutError && isClosedPipe(stdoutError))) {
    reportError(error);
  }
}

function isClosedPipe(error: NodeJS.ErrnoException): boolean {
  // Bun can use sockets for subprocess stdout and report ENOTCONN on close.
  return error.code === "EPIPE" || error.code === "ENOTCONN";
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`session-scan: ${message.replace(/\s+/g, " ").trim()}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

function parseCliArgs() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
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
        "last-turns": { type: "string" },
        type: { type: "string" },
        tool: { type: "string" },
        skill: { type: "string" },
        error: { type: "boolean", default: false },
        "tool-results": { type: "string" },
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
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseCliArgs();
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${manifest.version}\n`);
    return;
  }

  const input = positionals[0];
  if (positionals.length > 1) throw new UsageError("expected at most one positional session file");
  if (input !== undefined && !input.trim()) throw new UsageError("input requires a non-empty path");
  if (values.out !== undefined && values["out-dir"] !== undefined) {
    throw new UsageError("--out and --out-dir cannot be used together");
  }
  if (values.format !== undefined && values.format !== "md" && values.format !== "ndjson") {
    throw new UsageError('--format must be "md" or "ndjson"');
  }
  const roles = parseChoices(values.role, "--role", ["user", "assistant", "tool_result"] as const);
  const types = parseChoices(values.type, "--type", [
    "session_start", "user_message", "assistant_message", "skill_invocation",
    "tool_result", "compaction", "error", "custom_message",
  ]);
  const tools = parseList(values.tool, "--tool");
  const skills = parseList(values.skill, "--skill");
  const toolLines = parseNonnegativeInteger(values["tool-lines"], "--tool-lines");
  const since = parseDate(values.since, "--since");
  const until = parseDate(values.until, "--until");
  if (since && until && since > until) {
    throw new UsageError("--since must not be after --until");
  }
  for (const flag of ["cwd", "out", "out-dir", "adapter", "scanner", "source"] as const) {
    const value = values[flag];
    const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
    if (entries.some((entry) => !entry.trim())) throw new UsageError(`--${flag} requires a non-empty value`);
  }

  const head = values.head?.trim();
  if (values.head !== undefined) {
    if (positionals.length !== 1) {
      throw new UsageError("--head requires a positional session file");
    }
    if (!head || head === "null") {
      throw new UsageError("--head requires a non-empty, non-null entry ID");
    }
  }

  const lastTurns = parsePositiveInteger(values["last-turns"], "--last-turns");
  const toolResults = values["tool-results"];
  if (
    toolResults !== undefined &&
    toolResults !== "errors" &&
    toolResults !== "all"
  ) {
    throw new UsageError('--tool-results must be "all" or "errors"');
  }

  // Load adapters: built-in + user + --adapter, plus the bundled pi reference
  // adapter so its files auto-detect (pi is not built in).
  const piRef = resolve(import.meta.dirname, `../examples/adapters/pi.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`);
  await discoverAdapters({ extra: [piRef] });
  for (const path of values.adapter ?? []) {
    if (!(await loadAdapterFile(path))) {
      throw new UsageError(`--adapter failed to load: ${path}`);
    }
  }
  if (values.source !== undefined && !getAdapter(values.source)) {
    throw new UsageError(`unknown --source: ${values.source}`);
  }

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
    if (since) return since;
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d;
  }

  const files: AsyncIterable<string> = input
    ? single(input)
    : discoverSessions({
        cwdFilter: defaultCwd(),
        since: defaultSince(),
        until,
        source: values.source,
        includeSubagents: values["include-subagents"],
      });

  // -- filter ------------------------------------------------------------------

  const filter: FilterCriteria = {
    skills,
    lastTurns,
    types,
    tools,
    error: values.error,
    toolResults: toolResults === "errors" ? "errors" : undefined,
    roles,
  };

  // -- scanner -----------------------------------------------------------------

  const scanner = values.scanner ? await loadScanner(values.scanner) : undefined;

  // -- trim --------------------------------------------------------------------

  const trim = {
    toolLines,
    noThinking: values["no-thinking"],
  };

  // -- render + sink -----------------------------------------------------------

  const format = values.format ?? "ndjson";

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

  if (!stdoutError) {
    console.error(
      `scanned ${stats.sessionsFound} sessions, wrote ${stats.sessionsWritten} (${stats.eventsWritten} events) in ${elapsed}s`,
    );
  }
}

function parsePositiveInteger(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new UsageError(`${flag} requires a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new UsageError(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parseNonnegativeInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`${flag} requires a non-negative integer`);
  }
  return Number(value);
}

function parseList(value: string | undefined, flag: string): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !entry)) {
    throw new UsageError(`${flag} requires non-empty comma-separated values`);
  }
  return entries;
}

function parseChoices<T extends string>(value: string | undefined, flag: string, choices: readonly T[]): T[] | undefined {
  const entries = parseList(value, flag);
  if (!entries) return undefined;
  if (entries.some((entry) => !choices.includes(entry as T))) {
    throw new UsageError(`${flag} must contain only: ${choices.join(", ")}`);
  }
  return entries as T[];
}

function parseDate(value: string | undefined, flag: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  // Date accepts overflowing ISO calendar days (for example February 30).
  const calendar = /^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(value);
  if (calendar) {
    const year = Number(calendar[1]);
    const month = Number(calendar[2]);
    const day = Number(calendar[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) {
      throw new UsageError(`${flag} requires a valid date`);
    }
  }
  if (!Number.isFinite(date.getTime())) throw new UsageError(`${flag} requires a valid date`);
  return date;
}
