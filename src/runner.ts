/**
 * Per-session runner. Wires the pipeline stages over each located session and
 * flattens every session into one output stream, tagging each record with `sid`
 * so sessions stay separable without downstream state.
 *
 * Per session:
 *   adapter parse/head selection → withContext → filter
 *     → [scanner] → trim → render → sink
 *
 * `session_start` is peeked off the front: its metadata becomes the scanner's
 * `session` arg and the render header, and it is re-prepended into the render
 * input. So the scanner receives only the body (it has `session` instead), yet
 * every session still emits exactly one `session_start` row.
 */

import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { streamSession } from "./parser/index.js";
import { withContext } from "./context.js";
import type { ContextualEvent, ScanEvent, Scanner } from "./scanner.js";
import type { SessionMetadata } from "./session.js";
import {
  filter,
  trim,
  renderMd,
  renderNdjson,
  stdoutSink,
  openFileSink,
  type FilterCriteria,
  type TrimOptions,
  type RenderFormat,
  type Sink,
} from "./pipeline/index.js";

export type SinkConfig =
  | { kind: "stdout" }
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string };

export interface RunOptions {
  /** Located session files (single-file mode or discovery output). */
  files: AsyncIterable<string>;
  /** Skip harness detection when set. */
  source?: string;
  /** Adapter-native inclusive session head. */
  head?: string;
  filter: FilterCriteria;
  /** Optional; runs after filter, replaces trim. */
  scanner?: Scanner;
  trim: TrimOptions;
  format: RenderFormat;
  sink: SinkConfig;
}

export interface RunStats {
  sessionsFound: number;
  sessionsWritten: number;
  eventsWritten: number;
}

export async function run(opts: RunOptions): Promise<RunStats> {
  const stats: RunStats = {
    sessionsFound: 0,
    sessionsWritten: 0,
    eventsWritten: 0,
  };

  // Snapshot discovery before creating output, so it cannot discover our own files.
  const files = opts.sink.kind === "stdout"
    ? opts.files
    : await prepareFiles(opts.files, opts.sink);
  const ext = opts.format === "md" ? "md" : "jsonl";
  let shared: Sink | null = null;
  if (opts.sink.kind === "stdout") shared = stdoutSink();
  else if (opts.sink.kind === "file") shared = await openFileSink(opts.sink.path);

  try {
    for await (const file of files) {
      let it: AsyncIterator<ContextualEvent> | undefined;
      let sourceIt: AsyncIterator<ContextualEvent> | undefined;
      let startEv: ContextualEvent & { type: "session_start" };

      try {
        if (opts.filter.skills?.length) {
          const contextual = withContext(
            streamSession(file, { source: opts.source, head: opts.head }),
          );
          sourceIt = contextual[Symbol.asyncIterator]();
          const sourceHead = await sourceIt.next();
          if (sourceHead.done) continue; // adapter filtered the file out
          if (sourceHead.value.type !== "session_start") continue;
          stats.sessionsFound++;

          const filtered = filter(
            prepend(sourceHead.value, drain(sourceIt)),
            opts.filter,
          );
          it = filtered[Symbol.asyncIterator]();
          const selectedHead = await it.next();
          if (selectedHead.done) continue; // skill did not occur in this session
          if (selectedHead.value.type !== "session_start") continue;
          startEv = selectedHead.value;
        } else {
          const stream = filter(
            withContext(streamSession(file, { source: opts.source, head: opts.head })),
            opts.filter,
          );
          it = stream[Symbol.asyncIterator]();
          const head = await it.next();
          if (head.done) continue; // adapter filtered the file out
          if (head.value.type !== "session_start") continue;
          stats.sessionsFound++;
          startEv = head.value;
        }

        const session = toMetadata(startEv);
        const sid = session.id || basename(file, extname(file));
        const sink = opts.sink.kind === "dir"
          ? await openFileSink(sessionOutputPath(opts.sink.path, sid, ext))
          : shared!;

        try {
          const rest = drain(it);
          const body: AsyncGenerator<ContextualEvent | ScanEvent> = opts.scanner
            ? opts.scanner(rest, session)
            : trim(rest, opts.trim);
          const events = prepend<ContextualEvent | ScanEvent>(startEv, body);
          const lines = opts.format === "md"
            ? renderMd(events, sid)
            : renderNdjson(events, sid);

          for await (const line of lines) {
            await sink.write(line);
            stats.eventsWritten++;
          }
          stats.sessionsWritten++;
        } finally {
          if (opts.sink.kind === "dir") await sink.close();
        }
      } finally {
        try {
          await it?.return?.();
        } finally {
          await sourceIt?.return?.();
        }
      }
    }
  } finally {
    if (shared) await shared.close();
  }
  return stats;
}

// -- helpers -----------------------------------------------------------------

function toMetadata(ev: ContextualEvent & { type: "session_start" }): SessionMetadata {
  return {
    id: ev.id,
    timestamp: ev.timestamp,
    cwd: ev.cwd,
    agent: ev.agent,
    model: ev.model,
    git: ev.git,
    parentSession: ev.parentSession,
  };
}

async function* drain(
  it: AsyncIterator<ContextualEvent>,
): AsyncGenerator<ContextualEvent> {
  try {
    while (true) {
      const r = await it.next();
      if (r.done) return;
      yield r.value;
    }
  } finally {
    await it.return?.();
  }
}

async function* prepend<T>(head: T, tail: AsyncGenerator<T>): AsyncGenerator<T> {
  try {
    yield head;
    yield* tail;
  } finally {
    await tail.return(undefined);
  }
}

function contains(directory: string, path: string): boolean {
  const suffix = relative(directory, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function sessionOutputPath(directory: string, sid: string, ext: string): string {
  // Reject both platform separators, drive prefixes, NUL and dot components.
  if (!sid || sid === "." || sid === ".." || /[/\\\\:\u0000]/.test(sid)) {
    throw new Error(`Unsafe session ID: ${JSON.stringify(sid)}`);
  }
  const root = resolve(directory);
  const path = resolve(root, `${sid}.${ext}`);
  if (!contains(root, path) || dirname(path) !== root) {
    throw new Error(`Session output escapes directory: ${JSON.stringify(sid)}`);
  }
  return path;
}

/** Resolve symlinked ancestors even when the requested output does not exist. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

async function prepareFiles(files: AsyncIterable<string>, sink: Exclude<SinkConfig, { kind: "stdout" }>): Promise<string[]> {
  const paths: string[] = [];
  for await (const file of files) paths.push(file);
  const output = await canonicalPath(resolve(sink.path));
  for (const file of paths) {
    const input = await realpath(file);
    const overlap = sink.kind === "dir"
      ? contains(output, input) || contains(resolve(sink.path), resolve(file))
      : output === input;
    if (overlap) throw new Error(`Input/output overlap: ${file} and ${sink.path}`);
  }
  return paths;
}
