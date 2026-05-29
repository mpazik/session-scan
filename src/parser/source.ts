/**
 * SessionSource: one adapter per coding-agent harness.
 *
 * Each adapter knows how to detect, discover, and parse its harness's native
 * session files into the shared `SessionEvent` stream. `storageDir` and the
 * optional `findSession` are consumed by spawn capture (see spawn-capture.md).
 */

import type { AgentType, SessionEvent } from "../types.js";

// -- Filter options ----------------------------------------------------------

export interface StreamOptions {
  /** Skip the file if the header timestamp is before this date. */
  since?: Date;
  /** Skip the file if the header timestamp is after this date. */
  until?: Date;
  /** Skip files whose cwd does not contain this substring (case-insensitive). */
  cwdFilter?: string;
}

export interface DiscoverOptions {
  /** Override the storage directory to scan. */
  sessionsDir?: string;
  /** Only yield files from directories matching this cwd substring (case-insensitive). */
  cwdFilter?: string;
  /** Only yield files with timestamps on or after this date. */
  since?: Date;
  /** Only yield files with timestamps on or before this date. */
  until?: Date;
}

// -- Source interface --------------------------------------------------------

export interface SessionSource {
  /** Stable identifier, used in CaptureOptions.source and CLI flags. */
  name: AgentType;

  /** Where this agent stores sessions for the given cwd. */
  storageDir(opts?: { cwd?: string }): string;

  /** Stream normalized SessionEvents from a known session file. */
  parse(filePath: string, opts?: StreamOptions): AsyncGenerator<SessionEvent>;

  /** Is this file produced by this source? Reads only the first few KB. */
  detect(filePath: string): Promise<boolean>;

  /** Discover session files under storageDir, with cwd/date filters. */
  discover(opts?: DiscoverOptions): AsyncGenerator<string>;

  /** Optional spawn-capture discovery override (see spawn-capture.md). */
  findSession?(ctx: FindSessionContext): Promise<string | null>;
}

export interface FindSessionContext {
  /** Files present in storageDir before the spawn started. */
  preSnapshot: Set<string>;
  /** When the spawn started. */
  startedAt: Date;
  /** When the spawn finished. */
  finishedAt: Date;
  /** What the spawn callback returned, if anything. */
  spawn: unknown;
  /** The cwd passed to captureSession. */
  cwd?: string;
}
