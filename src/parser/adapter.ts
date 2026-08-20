/**
 * The `Adapter` contract: the seam between a coding-agent harness and the rest
 * of session-scan.
 *
 * One adapter per harness (codex, claude-code, pi, ...). It is the ONLY place
 * that understands a harness's native, on-disk session format. Everything
 * downstream works against the canonical `SessionEvent` model (see session.ts),
 * so the framework never needs harness-specific knowledge.
 *
 * The contract is declarative where possible; the framework does the work:
 *   - detect:     recognize the file's first JSON value (the framework reads
 *                 it once and probes every adapter).
 *   - discover:   a `DiscoverSpec` describing the storage layout (the
 *                 framework walks it and applies cwd/date filters), or a
 *                 custom generator as escape hatch.
 *   - parse:      turn one native file into a stream of canonical
 *                 SessionEvents. Pure format mapping: no filter logic, no
 *                 tool-name normalization.
 *   - parseHead:  optionally select native history through one adapter-owned
 *                 entry ID before mapping it to canonical events.
 *   - toolNames:  native -> canonical tool-name mapping; the framework stamps
 *                 `toolCall.normalizedName` on every assistant_message.
 *   - storageDir: where this harness stores sessions for a given cwd.
 *
 * Adapters are pluggable modules (default export). Built-ins live in
 * src/adapters/; users drop their own into ~/.session-scan/adapters/ or pass
 * `--adapter <path>`. See registry.ts for loading and examples/adapters/pi.ts
 * for a reference implementation.
 */

import type { SessionEvent, NormalizedToolName } from "../session.js";

// -- Discovery ---------------------------------------------------------------

export interface DiscoverOptions {
  /** Override the storage directory to scan. */
  sessionsDir?: string;
  /** Only yield files whose session cwd matches this substring (case-insensitive). */
  cwdFilter?: string;
  /** Only yield files with timestamps on or after this date. */
  since?: Date;
  /** Only yield files with timestamps on or before this date. */
  until?: Date;
  /**
   * Also descend into `subagents/` subdirectories (Claude Code writes
   * sub-agent transcripts to `<slug>/subagents/agent-*.jsonl`). Off by default
   * so standard discovery output is unchanged; harnesses without such dirs are
   * unaffected.
   */
  includeSubagents?: boolean;
}

/**
 * Declarative storage layout. The framework's walker consumes it: it scans
 * `storageDir()` (one directory level by default), matches filenames, and
 * applies the since/until/cwd filters from DiscoverOptions.
 */
export interface DiscoverSpec {
  /** Walk arbitrarily nested dirs (codex: yyyy/mm/dd). Default: storageDir/<dir>/<file>. */
  recursive?: boolean;
  /** Is this filename a session file? */
  match: (fileName: string) => boolean;
  /** "YYYY-MM-DD" extracted from the filename; omit to filter by mtime instead. */
  dateOf?: (fileName: string) => string | undefined;
  /**
   * Resolve the session's cwd for cwd filtering. Receives the file's first
   * JSON value (read only when a cwd filter is active) and the name of the
   * containing directory. Omit to disable cwd filtering for this harness.
   */
  cwdOf?: (firstValue: unknown, dirName: string) => string;
}

// -- Adapter interface -------------------------------------------------------

export interface Adapter {
  /** Stable identifier, used in CaptureOptions.source and CLI flags. */
  name: string;

  /** Where this agent stores sessions for the given cwd. */
  storageDir(opts?: { cwd?: string }): string;

  /**
   * Native -> canonical tool names (see NormalizedToolName). A static map for
   * harnesses with dedicated tools; a classifier function for harnesses that
   * route everything through generic tools (codex). The framework fills
   * `toolCall.normalizedName` from this; unmapped names pass through as-is.
   */
  toolNames?:
    | Record<string, NormalizedToolName>
    | ((name: string, args: Record<string, unknown>) => NormalizedToolName);

  /**
   * True if the file looks like this harness's format. `firstValue` is the
   * file's first parseable JSON value, or null when there is none (a plain-text
   * `/export` transcript): such adapters sniff `filePath` synchronously.
   */
  detect(firstValue: unknown, filePath: string): boolean;

  /** Stream canonical SessionEvents from a known session file. */
  parse(filePath: string): AsyncGenerator<SessionEvent>;

  /**
   * Stream only the native history ending at `headId`, inclusively. Adapters
   * that omit this method explicitly do not support head selection. Selection
   * happens before canonical mapping so skipped and expanded native entries
   * retain their ancestry semantics.
   */
  parseHead?(
    filePath: string,
    headId: string,
  ): AsyncGenerator<SessionEvent>;

  /** Storage layout spec, or a custom discovery generator as escape hatch. */
  discover: DiscoverSpec | ((opts?: DiscoverOptions) => AsyncGenerator<string>);
}
