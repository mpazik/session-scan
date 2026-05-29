/**
 * Streaming entry points.
 *
 * `streamSession` auto-detects the producing harness and dispatches to the
 * matching adapter. `discoverSessions` enumerates session files across every
 * registered adapter.
 */

import type { SessionEvent } from "../types.js";
import type { StreamOptions, DiscoverOptions } from "./source.js";
import { get, list, detectSource, discover } from "./registry.js";

/**
 * Stream events from a session file, auto-detecting the harness.
 *
 * Yields a `session_start` first, one event per meaningful entry, then a
 * `session_end`. If the file doesn't match filters, yields nothing. Pass
 * `source` to skip detection.
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
  yield* source.parse(filePath, opts);
}

/**
 * Discover session files across all registered adapters. Each adapter scans
 * its own storage layout. Pass `source` to restrict to one adapter.
 */
export async function* discoverSessions(
  opts: DiscoverOptions & { source?: string } = {},
): AsyncGenerator<string> {
  await discover();
  const sources = opts.source ? [get(opts.source)].filter(Boolean) : list();
  for (const source of sources as NonNullable<ReturnType<typeof get>>[]) {
    yield* source.discover(opts);
  }
}
