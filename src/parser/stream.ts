/**
 * Streaming entry points.
 *
 * `streamSession` auto-detects the producing harness, dispatches to the
 * matching adapter, and layers the cross-harness concerns on top of the
 * adapter's raw parse: session-level cwd/date filtering (against the
 * `session_start` event) and tool-name normalization (stamping
 * `toolCall.normalizedName` from the adapter's `toolNames`).
 *
 * `discoverSessions` enumerates session files across every registered
 * adapter, walking each adapter's declarative `DiscoverSpec` (or delegating
 * to its custom discover generator).
 */

import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import type { SessionEvent } from "../session.js";
import type { Adapter, DiscoverOptions, DiscoverSpec } from "./adapter.js";
import { get, list, detectSource, discover } from "./registry.js";
import { readFirstJsonValue } from "./read-lines.js";

// -- Streaming ---------------------------------------------------------------

export interface StreamOptions {
  /** Skip the session if its header timestamp is before this date. */
  since?: Date;
  /** Skip the session if its header timestamp is after this date. */
  until?: Date;
  /** Skip the session if its cwd does not contain this substring (case-insensitive). */
  cwdFilter?: string;
}

/**
 * Stream events from a session file, auto-detecting the harness.
 *
 * Yields a `session_start` first, then one event per meaningful entry. If the
 * session doesn't match the filters, yields nothing. Pass `source` to skip
 * detection.
 */
export async function* streamSession(
  filePath: string,
  opts: StreamOptions & { source?: string } = {},
): AsyncGenerator<SessionEvent> {
  await discover();
  const source = opts.source ? get(opts.source) : await detectSource(filePath);
  if (!source) {
    throw new Error(`unknown session format: ${filePath}`);
  }

  const normalize = toolNormalizer(source);
  for await (const ev of source.parse(filePath)) {
    if (ev.type === "session_start") {
      if (opts.cwdFilter && !ev.cwd.toLowerCase().includes(opts.cwdFilter.toLowerCase())) return;
      if (ev.timestamp && opts.since && new Date(ev.timestamp) < opts.since) return;
      if (ev.timestamp && opts.until && new Date(ev.timestamp) > opts.until) return;
    } else if (ev.type === "assistant_message") {
      for (const tc of ev.toolCalls) {
        tc.normalizedName ??= normalize(tc.name, tc.arguments);
      }
    }
    yield ev;
  }
}

/** Build the normalizedName resolver from an adapter's `toolNames`. */
function toolNormalizer(
  source: Adapter,
): (name: string, args: Record<string, unknown>) => string {
  const t = source.toolNames;
  if (!t) return (name) => name;
  if (typeof t === "function") return t;
  return (name) => t[name] ?? name;
}

// -- Discovery ---------------------------------------------------------------

/**
 * Discover session files across all registered adapters. Each adapter
 * describes its storage layout (`DiscoverSpec`); the framework walks it.
 * Pass `source` to restrict to one adapter.
 */
export async function* discoverSessions(
  opts: DiscoverOptions & { source?: string } = {},
): AsyncGenerator<string> {
  await discover();
  const sources = opts.source ? [get(opts.source)].filter(Boolean) : list();
  for (const source of sources as Adapter[]) {
    if (typeof source.discover === "function") {
      yield* source.discover(opts);
    } else {
      yield* walkSpec(opts.sessionsDir ?? source.storageDir(), source.discover, opts);
    }
  }
}

/** Generic session-file walker driven by a DiscoverSpec. */
async function* walkSpec(
  root: string,
  spec: DiscoverSpec,
  opts: DiscoverOptions,
): AsyncGenerator<string> {
  const sinceStr = opts.since?.toISOString().slice(0, 10);
  const untilStr = opts.until?.toISOString().slice(0, 10);
  const cwdPattern = opts.cwdFilter?.toLowerCase();

  async function* walk(dir: string, depth: number): AsyncGenerator<string> {
    let entries: import("fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Default layout is storageDir/<dir>/<file>; recursive specs nest deeper.
        if (spec.recursive || depth === 0) yield* walk(full, depth + 1);
        continue;
      }
      if (!spec.match(entry.name)) continue;

      // Date filter: filename-derived date when the spec provides one, mtime otherwise.
      if (sinceStr || untilStr) {
        const dateStr = spec.dateOf?.(entry.name);
        if (dateStr) {
          if (sinceStr && dateStr < sinceStr) continue;
          if (untilStr && dateStr > untilStr) continue;
        } else {
          try {
            const st = await stat(full);
            if (opts.since && st.mtime < opts.since) continue;
            if (opts.until && st.mtime > opts.until) continue;
          } catch {
            continue;
          }
        }
      }

      if (cwdPattern && spec.cwdOf) {
        const first = await readFirstJsonValue(full);
        const cwd = spec.cwdOf(first, basename(dir));
        if (!cwd.toLowerCase().includes(cwdPattern)) continue;
      }
      yield full;
    }
  }

  yield* walk(root, 0);
}
