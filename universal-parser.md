# Spec: universal session parser

Parse sessions from multiple coding-agent harnesses (pi, Claude Code, Codex)
into one internal event stream, so scanners and consumers work the same way
regardless of which agent produced the session.

This is the foundation under `spawn-capture.md`: the `SessionSource` interface
defined here is what `captureSession()` watches and dispatches to.

## Why

session-scan today parses pi only. Every scanner, the context layer, and the
CLI assume the pi `SessionEvent` model. To mine Claude Code and Codex sessions
(the common case for most users), we need adapters that map each harness's
native JSONL into that same `SessionEvent` stream.

Prior art studied in `tmp/docs/parsing-insights-prior-art.md`:
agent-session-protocol (`capi`), cinsights, clens. Decision: **borrow capi's
event vocabulary and tool-name canonicalization, write our own thin read-only
adapters.** We do not adopt capi as a dependency (its denormalize / transport /
resume machinery is dead weight for read-only mining).

## Scope

**In:**
- A `SessionSource` interface, one implementation per harness.
- Adapters: `pi` (refactor existing parser), `claude-code` (new), `codex` (new).
- Source auto-detection from file content.
- `streamSession()` dispatching to the right adapter.
- A small set of additions to the internal `SessionEvent` model so claude/codex
  data isn't lost (thinking, token usage, errors, tool-name normalization).

**Out:**
- Spawn capture (see `spawn-capture.md`, builds on this).
- Denormalization / writing sessions back / resume.
- Live hook capture (clens-style).
- Copilot and other harnesses (defer; the interface makes them additive).

## Internal format decisions

The current `SessionEvent` union in `src/types.ts` is pi-shaped. It's close to
capi's `NormalizedEvent` already. Changes needed to make it harness-neutral:

### 1. Keep `SessionEvent` as the public type, keep `session_start`

Do **not** rename to `session_init`. `session_start` carries a `SessionHeader`;
keep that, but make the header harness-neutral and add an `agent` field.

```ts
export type AgentType = "pi" | "claude-code" | "codex";

export interface SessionHeader {
  type: "session";
  agent: AgentType;       // NEW
  id: string;
  timestamp: string;
  cwd: string;
  version?: number;
  model?: string;         // NEW (claude/codex carry it on init)
  git?: { branch?: string; commit?: string; remote?: string }; // NEW
  parentSession?: string;
}
```

pi adapter fills `agent: "pi"`; claude/codex fill theirs. Existing pi fields stay.

### 2. Keep tool calls embedded in `assistant_message.toolCalls[]`

capi emits standalone `tool_call` events; pi embeds them. Embedding is the
established session-scan shape (context.ts, scanners, the CLI all assume it).
Keep embedding. Adapters reconcile:

- **pi**: already embedded. No change.
- **claude-code**: `tool_use` blocks are already inside the assistant message
  content. Gather them into `toolCalls[]`. Natural fit.
- **codex**: `function_call` is a *separate* `response_item`, not inside an
  assistant message. The adapter attaches each `function_call` to the most
  recent `assistant_message` it emitted in the same turn; if none exists yet,
  it synthesizes an empty-text `assistant_message` to host the call. Lossless
  for scanning purposes.

`tool_result` stays a separate event keyed by `toolCallId`, matching all three.

### 3. Add a normalized tool name alongside the native one

Steal capi's canonical set and codex command classifier. Add to `ToolCall`:

```ts
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;              // native name (pi: "bash", claude: "Bash", codex: "exec_command")
  normalizedName: string;    // NEW: "terminal" | "file_read" | "file_edit" | ...
  arguments: Record<string, unknown>;
}
```

Canonical names: `terminal`, `file_read`, `file_edit`, `file_write`,
`file_search`, `content_search`, `web_search`, `web_fetch`, `sub_agent`,
fallback to the native name. Lives in `src/sources/tool-names.ts`, ported from
capi `src/tools.ts`. Scanners can match on `normalizedName` to stay
harness-agnostic; existing scanners keep using `name`.

### 4. Add optional events for data only claude/codex expose

Additive to the union, ignored by pi:

- `ThinkingEvent` `{ type: "thinking", id, parentId, summary, text, timestamp }`
  — claude `thinking` blocks, codex `reasoning` items.
- Token usage: attach an optional `usage` field to `assistant_message`
  (`inputTokens`, `outputTokens`, `cachedInputTokens`) rather than a separate
  `turn_complete` event, to avoid a new turn-boundary concept. Pi leaves it
  undefined.
- `ErrorEvent` `{ type: "error", id, parentId, code?, message, timestamp }`
  — claude `api_error`, codex `turn_aborted`. Pi continues to use
  `assistant_message.errorMessage`; optionally also emit an `error` event for
  uniformity (decide during impl).

Keep `bash_execution`, `model_change`, `thinking_level_change`,
`custom_message`, `compaction` — pi-only or shared, no change.

### 5. Timestamps stay ISO strings

Internally we use ISO strings everywhere. Adapters convert capi-style unix-ms
(claude/codex) to ISO at the boundary. Keep one representation downstream.

## SessionSource interface

`src/sources/types.ts` (shared with spawn-capture.md):

```ts
export interface SessionSource {
  name: AgentType;

  /** Where this agent stores sessions for the given cwd. */
  storageDir(opts?: { cwd?: string }): string;

  /** Stream normalized SessionEvents from a known file. */
  parse(filePath: string, opts?: StreamOptions): AsyncGenerator<SessionEvent>;

  /** Is this file produced by this source? Reads only the first few KB. */
  detect(filePath: string): Promise<boolean>;

  /** Discover session files under storageDir, with cwd/date filters. */
  discover(opts?: DiscoverOptions): AsyncGenerator<string>;

  /** Optional spawn-capture override (see spawn-capture.md). */
  findSession?(ctx: FindSessionContext): Promise<string | null>;
}

export const SOURCES: Record<AgentType, SessionSource>;
```

`parse`, `detect`, `discover` cover read-only mining (this spec). `findSession`
and `storageDir` are consumed by `captureSession` (spawn-capture.md).

## Detection and dispatch

```ts
export async function detectSource(filePath: string): Promise<SessionSource | null>;

export async function* streamSession(
  filePath: string,
  opts?: StreamOptions & { source?: AgentType },
): AsyncGenerator<SessionEvent> {
  const source = opts?.source ? SOURCES[opts.source] : await detectSource(filePath);
  if (!source) throw new Error(`unknown session format: ${filePath}`);
  yield* source.parse(filePath, opts);
}
```

`detectSource` reads the first ~20 lines and runs each adapter's `detect()`,
first match wins. Detection signals (from prior-art research):

| Source | Signal |
|---|---|
| pi | first line `type:"session"` with `cwd` + `id` |
| codex | first line `type:"session_meta"`, or any line `{type, payload}` with `payload.originator`/`cwd` |
| claude-code | line with `type` in `user`/`assistant` **and** a `sessionId` field; skip if `isSidechain:true` |

## Adapters

### pi (refactor, no behaviour change)

Move the existing `streamSession` body into `src/sources/pi.ts` as
`piSource.parse`. Move `discoverSessionFiles` into `piSource.discover`. Add
`storageDir()` → `~/.pi/agent/sessions`, `detect()`, `agent:"pi"` on the header,
`normalizedName` on tool calls. No semantic change to existing output beyond the
new fields.

### claude-code (new — `src/sources/claude-code.ts`)

Port logic from capi `normalize/claude.ts` + cinsights `claude_code.py`. Key
handling (detailed in prior-art doc):

- No header line. Synthesize `session_start` from the first entry's metadata
  (`sessionId`, `cwd`, `version`, `gitBranch`), or from a `system/init` line.
- Skip sub-agent files: any line with `isSidechain:true`.
- `type:assistant` content blocks → `assistant_message` (text), `toolCalls[]`
  (from `tool_use`), `thinking` events (from `thinking`). Token usage from
  `message.usage` when `stop_reason==end_turn`.
- `type:user` content blocks → `tool_result` events (from `tool_result` blocks,
  keyed by `tool_use_id`) **and** `user_message` (from text). This is the big
  structural difference: results are folded into the *next* user message.
- `system/compact_boundary` → `compaction`; `api_error` → `error`.
- **Dedup that capi skips but we need** (from cinsights):
  - Streaming fragments: same `message.id` repeated; for token totals take
    max-per-id (last fragment has final counts).
  - Continuation replay: resumed sessions replay prior turns; dedup by
    `(start, end, prompt_tokens)` or skip replayed ranges.
- Filter noise user lines before treating as real input: continuation headers,
  `/compact`, skill base-dir injections, `<task-notification>`,
  `[Request interrupted by user`, empty/`<command-*>` wrappers.
- `storageDir({cwd})` → `~/.claude/projects/<sanitized-cwd>` where
  `sanitized = cwd.replace(/\//g, "-")`.
- `discover()` → two-pass (lock files for active state + direct projects scan),
  recover cwd from first line carrying one.

### codex (new — `src/sources/codex.ts`)

Port logic from capi `normalize/codex.ts` + cinsights `codex.py`. Every line is
`{ timestamp, type, payload }`.

- `session_meta` → `session_start` (id, cwd, cli_version, git).
- `compacted` / `event_msg:context_compacted` → `compaction`.
- `event_msg:turn_aborted` → `error`. `token_count` accumulates usage per turn.
- `response_item`:
  - `message` role user/assistant → `user_message` / `assistant_message`.
  - `function_call` → attach to current `assistant_message` as a `toolCall`
    (synthesize host message if needed; see decision #2).
  - `function_call_output` → `tool_result`. **Parse exit codes ourselves**:
    capi always sets `isError:false` here; we inspect output/metadata for
    non-zero exit to flag real failures.
  - `custom_tool_call(_output)` → tool_call / tool_result (output carries
    `metadata.exit_code`).
  - `reasoning` → `thinking`. `web_search_call` → `toolCall` (synthesize callId).
- `storageDir()` → `~/.codex/sessions` (date-partitioned `YYYY/MM/DD/`).
- `discover()` → recursive scan for `rollout-*.jsonl`; threadId from filename,
  cwd from first line `payload.cwd`.

## Tool-name normalization

`src/sources/tool-names.ts`, ported from capi `tools.ts`:

- Claude static map (`Bash`→`terminal`, `Read`→`file_read`, ...).
- Codex `exec_command` classifier on the command string
  (`cat|head|tail`→`file_read`, `rg --files`/`find|fd|ls`→`file_search`,
  `rg|grep|ag|ack`→`content_search`, else `terminal`); `apply_patch` →
  `file_write` if `*** Add File:` else `file_edit`.
- pi: `bash`→`terminal`, `read`→`file_read`, `edit`→`file_edit`,
  `write`→`file_write`, `find`→`file_search`, `grep`→`content_search`,
  `ls`→`file_search`.

## What to copy vs write fresh

| Piece | Source | Action |
|---|---|---|
| event vocabulary | capi `types.ts` | borrow names, adapt to our `SessionEvent` |
| tool-name map + codex classifier | capi `tools.ts` | copy nearly verbatim |
| claude entry handling | capi `normalize/claude.ts` | port, drop `<channel>` + compaction-filter |
| codex entry handling | capi `normalize/codex.ts` | port, add real exit-code error detection |
| discovery (claude two-pass, codex scan) | capi `sessions.ts` | port `discover*` only |
| streaming/replay dedup | cinsights `claude_code.py` | port (capi lacks this) |
| noise filtering, session signals | cinsights `claude_code.py` | port |
| span/trace model | cinsights `base.py` | ignore (wrong shape) |
| hook capture | clens | ignore (out of scope) |

## Edge cases

- **Claude session with no `system/init`.** Synthesize `session_start` from
  first entry metadata (capi does this).
- **Sub-agent / sidechain files.** Claude: skip files with `isSidechain:true`.
  Pi: `parentSession` in header (keep, expose). Codex: n/a.
- **Streaming fragments inflating token counts.** Max-per-`message.id`.
- **Continuation replay double-counting.** Dedup by `(start,end,prompt_tokens)`.
- **Codex shell failure not flagged.** Parse exit code from output ourselves.
- **Unknown source.** `detectSource` returns null; `streamSession` throws a
  clear "unknown session format" error.
- **Malformed lines.** Skip silently (all three adapters), like the current pi
  parser.

## Order of work

1. **Extend `SessionEvent`** with `agent`, `normalizedName`, `thinking`,
   `usage`, `error`. Update `index.ts` exports. No adapters yet; pi still works.
2. **Refactor pi into `src/sources/pi.ts`** implementing `SessionSource`. Wire
   `streamSession`/`discoverSessionFiles` to delegate. No behaviour change.
3. **Add `tool-names.ts`** + populate pi's `normalizedName`.
4. **Add `detectSource` + dispatch** in `streamSession`. pi-only registry.
5. **Add codex adapter.** Simpler format, separate tool-call items, good for
   exercising the standalone-tool-call → embedded reconciliation.
6. **Add claude-code adapter.** Hardest: folded tool results, dedup, noise
   filtering.
7. **Cross-harness scanner pass.** Confirm `binder-failures` and the CLI work
   unchanged on pi, then run against claude/codex sessions.

Steps 1-4 keep pi green while establishing the framework. Step 5 proves the
multi-harness path on the easier format. Step 6 closes the common case. Step 7
validates that scanners are genuinely harness-agnostic.

## Open questions

- **`normalizedName` everywhere, or opt-in?** Computing it for every tool call
  is cheap. Recommendation: always compute, let scanners pick `name` vs
  `normalizedName`.
- **Standalone `thinking`/`error` events vs fields on `assistant_message`?**
  Thinking as its own event (matches claude/codex stream order); error as both
  a field (pi-compat) and an event (uniformity). Revisit if it complicates
  context.ts turn grouping.
- **Token usage on `assistant_message` vs a `turn_complete` event?** Field is
  simpler and avoids a new turn-boundary concept; turns are already derived in
  context.ts from `user_message` boundaries. Start with the field.
- **Do we need continuation-replay dedup for mining?** It matters for token
  stats, less for error/pattern scanners. Could gate it behind a parse option.
