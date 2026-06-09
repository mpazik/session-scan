/**
 * The `Adapter` contract: the seam between a coding-agent harness and the rest
 * of session-scan.
 *
 * One adapter per harness (codex, claude-code, pi, ...). It is the ONLY place
 * that understands a harness's native, on-disk session format. Everything
 * downstream works against the canonical `SessionEvent` model (see session.ts),
 * so the framework never needs harness-specific knowledge.
 *
 * An adapter answers four questions about its harness:
 *   - detect:     is this file mine?
 *   - discover:   where do my sessions live, and which ones match the filters?
 *   - parse:      turn one native file into a stream of canonical SessionEvents.
 *   - storageDir: where this harness stores sessions for a given cwd.
 *
 * Adapters are pluggable modules (default export). Built-ins live in
 * src/adapters/; users drop their own into ~/.session-scan/adapters/ or pass
 * `--adapter <path>`. See registry.ts for loading and examples/adapters/pi.ts
 * for a reference implementation.
 */

import type { SessionEvent } from "../session.js";

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

// -- Adapter interface -------------------------------------------------------

export interface Adapter {
  /** Stable identifier, used in CaptureOptions.source and CLI flags. */
  name: string;

  /** Where this agent stores sessions for the given cwd. */
  storageDir(opts?: { cwd?: string }): string;

  /** Stream normalized SessionEvents from a known session file. */
  parse(filePath: string, opts?: StreamOptions): AsyncGenerator<SessionEvent>;

  /** True if this adapter recognizes the file as its own native format. */
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
