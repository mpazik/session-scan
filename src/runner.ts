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

import { basename, extname, join } from "path";
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

  const ext = opts.format === "md" ? "md" : "jsonl";
  let shared: Sink | null = null;
  if (opts.sink.kind === "stdout") shared = stdoutSink();
  else if (opts.sink.kind === "file") shared = await openFileSink(opts.sink.path);

  for await (const file of opts.files) {
    let it: AsyncIterator<ContextualEvent>;
    let startEv: ContextualEvent & { type: "session_start" };

    if (opts.filter.skills?.length) {
      const contextual = withContext(
        streamSession(file, { source: opts.source, head: opts.head }),
      );
      const sourceIt = contextual[Symbol.asyncIterator]();
      const sourceHead = await sourceIt.next();
      if (sourceHead.done) continue; // adapter filtered the file out
      if (sourceHead.value.type !== "session_start") continue; // malformed; skip
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
      // Preserve the original streaming path when session selection is absent.
      const stream = filter(
        withContext(streamSession(file, { source: opts.source, head: opts.head })),
        opts.filter,
      );
      it = stream[Symbol.asyncIterator]();
      const head = await it.next();
      if (head.done) continue; // adapter filtered the file out
      if (head.value.type !== "session_start") continue; // malformed; skip
      stats.sessionsFound++;
      startEv = head.value;
    }

    const session = toMetadata(startEv);
    const sid = session.id || basename(file, extname(file));

    const rest = drain(it);
    const body: AsyncGenerator<ContextualEvent | ScanEvent> = opts.scanner
      ? opts.scanner(rest, session)
      : trim(rest, opts.trim);

    const events = prepend<ContextualEvent | ScanEvent>(startEv, body);
    const lines =
      opts.format === "md"
        ? renderMd(events, sid)
        : renderNdjson(events, sid);

    const perSession = opts.sink.kind === "dir";
    const sink =
      opts.sink.kind === "dir"
        ? await openFileSink(join(opts.sink.path, `${sid}.${ext}`))
        : shared!;

    for await (const line of lines) {
      sink.write(line);
      stats.eventsWritten++;
    }
    if (perSession) await sink.close();
    stats.sessionsWritten++;
  }

  if (shared) await shared.close();
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
  while (true) {
    const r = await it.next();
    if (r.done) return;
    yield r.value;
  }
}

async function* prepend<T>(head: T, tail: AsyncGenerator<T>): AsyncGenerator<T> {
  yield head;
  yield* tail;
}
