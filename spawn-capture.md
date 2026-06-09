# Spec: spawn capture

Add a runtime "capture the session produced by this spawn" capability on top of the existing file-reading API. This is what tools like skill-drill (eval harness) need to integrate with session-scan without reimplementing per-agent file-discovery logic.

## Motivating use case

Skill-drill spawns a coding agent (`claude`, `pi`, etc.) once per trial, then needs to:
1. Find the session file that agent wrote.
2. Stream its events to extract tool calls, token usage, transcript.

Today every consumer would reimplement step 1 because each agent stores sessions in a different place with a different naming convention. session-scan already encodes this knowledge for parsing. Exposing it for discovery closes the loop.

Other future consumers: any wrapper that runs an agent programmatically and wants structured access to what happened (CI bots, regression harnesses, retry loops).

## Scope

**In:**
- A `captureSession()` helper that wraps a spawn and returns the session file produced.
- A `SessionSource` interface that each adapter implements, declaring storage layout and (optionally) a discovery strategy.
- Discovery defaulting to snapshot-then-diff. Adapter override for cleaner strategies (e.g. parse session id from stdout).

**Out:**
- Spawning the agent process. The caller owns cwd, env, argv, timeouts, output capture.
- Lifecycle management (kill, restart, retry).
- Anything beyond "where is the file this agent wrote."

## API

```ts
// src/capture.ts

export interface CaptureOptions {
  /** Which session source to watch. */
  source: SessionSourceName; // "claude-code" | "pi"
  /** Working directory the agent will run in. Used for per-cwd storage layouts. */
  cwd?: string;
}

export interface CaptureResult<T> {
  /** Path to the new session file, or null if none was found. */
  sessionPath: string | null;
  /** Whatever the spawn callback returned. */
  spawn: T;
}

/**
 * Wrap a spawn. Snapshots the source's storage dir before, identifies the new
 * file after. Adapter may override with a more reliable strategy.
 *
 * The spawn callback is responsible for running the process and waiting for
 * it to exit. captureSession does not care how.
 */
export async function captureSession<T>(
  opts: CaptureOptions,
  spawn: (ctx: SpawnContext) => Promise<T>,
): Promise<CaptureResult<T>>;

export interface SpawnContext {
  /** Best-effort path the adapter expects the session to land at. May be
   *  empty for adapters that can't predict. Useful for `--session-file` style
   *  flags where the caller wants to force the path. */
  expectedSessionPath?: string;
}
```

Usage from a consumer (skill-drill):

```ts
const result = await captureSession(
  { source: "claude-code", cwd: workspaceDir },
  async () => {
    const proc = Bun.spawn(["claude", "-p", prompt, ...], { cwd: workspaceDir });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  },
);

// result.sessionPath: "/Users/x/.claude/projects/-Users-x-foo/<id>.jsonl"
// result.spawn: { stdout, stderr, exitCode }

if (result.sessionPath) {
  for await (const evt of streamSession(result.sessionPath)) {
    // ...
  }
}
```

## SessionSource interface

Each adapter (one per agent harness) implements:

```ts
// src/sources/types.ts

export interface SessionSource {
  /** Stable identifier used in CaptureOptions.source */
  name: SessionSourceName;

  /** Where this agent stores sessions for the given cwd.
   *  Some agents partition by cwd (Claude Code), some don't (pi). */
  storageDir(opts?: { cwd?: string }): string;

  /** Stream events from a known session file. The existing parse function. */
  parse(filePath: string, opts?: ParseOptions): AsyncGenerator<SessionEvent>;

  /** Is this file produced by this source? Used for auto-detection in
   *  streamSession when the source isn't specified. */
  detect(filePath: string): Promise<boolean>;

  /** Optional: custom discovery strategy. Called by captureSession after the
   *  spawn completes. If omitted, captureSession falls back to snapshot-diff
   *  against storageDir(). */
  findSession?(ctx: FindSessionContext): Promise<string | null>;
}

export interface FindSessionContext {
  /** Files present in storageDir before the spawn started. */
  preSnapshot: Set<string>;
  /** When the spawn started. */
  startedAt: Date;
  /** When the spawn finished. */
  finishedAt: Date;
  /** What the spawn callback returned, if it returned anything with stdout. */
  spawn: unknown;
  /** The cwd passed to captureSession. */
  cwd?: string;
}
```

## Discovery strategies

**Default (snapshot-diff).** Used when an adapter doesn't override `findSession`.

1. Before spawn: list files in `storageDir(opts)`, store the set.
2. After spawn: list again, take the set difference.
3. Filter to files whose mtime is `>= startedAt`.
4. If exactly one match → return it. If zero → return null. If many → return the most recently modified.

Trade-offs: simple, no spawn-specific knowledge. Breaks if multiple sessions land in the same storage dir during the spawn window (concurrent runs in same cwd for Claude Code; concurrent runs at all for pi).

**Override (per-adapter).** When the agent emits its session id somewhere observable, the adapter can short-circuit:

- **Claude Code**: parses the first stream-json event from stdout for `session_id`, then constructs the path via `storageDir({cwd}) + "/" + session_id + ".jsonl"`. Only works when the caller captured stdout and passes it via `ctx.spawn`. Falls back to default if not.
- **pi**: no known cleaner strategy yet. Use default.

Adapters can also handle "wait for file to fully fsync" if needed. Default implementation should poll briefly (e.g. 200ms with a few retries) when a file is found but is zero bytes or empty JSONL.

## Auto-detection in `streamSession`

Today `streamSession(filePath)` assumes pi format. With multiple adapters:

```ts
export async function* streamSession(
  filePath: string,
  opts?: ParseOptions & { source?: SessionSourceName },
): AsyncGenerator<SessionEvent> {
  const source = opts?.source
    ? SOURCES[opts.source]
    : await detectSource(filePath);
  if (!source) throw new Error(`unknown session format: ${filePath}`);
  yield* source.parse(filePath, opts);
}
```

`detectSource` tries each registered adapter's `detect()`. First match wins.

## Adapter work

| Adapter | Status | Needs |
|---|---|---|
| `pi` | implemented | factor existing parser into `SessionSource`. Add `storageDir()` (default `~/.pi/agent/sessions`). Add `detect()`. |
| `claude-code` | not started | new file. Parse JSONL from `~/.claude/projects/<encoded-cwd>/<id>.jsonl`. Encode cwd the same way Claude Code does (path with `/` → `-`). Override `findSession()` to parse session id from stdout for cleaner discovery. |

Format reference for claude-code: see prior art in [opensession](https://github.com/hwisu/opensession) and [agentprobe](https://github.com/vtemian/agentprobe), but writing fresh is fine.

## Edge cases

- **No session file appears.** Return `sessionPath: null`. Caller decides what to do (skill-drill falls back to stdout-only mode).
- **Multiple new files match.** Snapshot-diff: take the most recently modified. Log a warning. Document this as a known limitation for concurrent runs.
- **File exists but is empty / incomplete.** Poll briefly. If still empty after retry budget, return the path anyway; the parser will yield nothing and the caller can detect.
- **Spawn never started writing.** Same as "no session file appears."
- **`cwd` doesn't exist or is unreadable.** `storageDir({cwd})` returns a path that doesn't exist. Snapshot-diff handles this naturally (pre-snapshot is empty).
- **Caller doesn't pass `cwd` to an adapter that needs it.** Adapter's `storageDir()` falls back to scanning the parent dir or returns an empty pre-snapshot. Document per adapter.

## Backwards compatibility

- Existing `streamSession(filePath)` calls keep working. Auto-detection picks pi for existing files.
- The pi source's `parse()` is the existing parser, no behaviour change.
- Adding `captureSession` and `SessionSource` is purely additive.

## Order of work

1. **Refactor pi into a `SessionSource`.** No new functionality. Establishes the adapter shape.
2. **Add `detectSource` and update `streamSession` to dispatch by source.**
3. **Add `captureSession` with snapshot-diff default.** Pi-only at this stage, but usable.
4. **Add Claude Code adapter.** Parser + `storageDir` + `detect`. Default discovery.
5. **Add stdout-id override for Claude Code's `findSession`.** Optional polish; only needed if concurrent runs become real.

Steps 1–3 unblock pi-based agent wrapping. Step 4 unblocks skill-drill for Claude Code (the common case). Step 5 is a follow-up.

## Open questions

- **`SpawnContext.expectedSessionPath`**: do any current agents support `--session-file <path>` style flags? If yes, callers can force the path and skip discovery entirely. If no, drop the field for now.
- **Concurrency model**: should `captureSession` lock the storage dir to prevent overlapping captures from confusing each other? My read: no, document the constraint, let callers serialise if they care.
- **Adapter registration**: built-in only, or pluggable via a user dir (similar to `~/.session-scan/scanners/`)? Built-in only is simpler. Defer pluggable until requested.
