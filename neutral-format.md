# Spec: neutral session format

A documented, versioned, JSONL wire format that any harness adapter can write and any consumer can read via session-scan's `neutral` adapter. Lets tools (skill-drill, future eval harnesses, custom wrappers) produce sessions for agents that don't have a native adapter — or for agents whose native format we'd rather not handle directly.

The format is session-scan's existing `SessionEvent` IR, committed as a public wire format with explicit versioning.

## Motivation

session-scan's per-agent adapters (claude-code, codex, pi) parse each agent's *native* on-disk session format into a normalized `SessionEvent` stream. Consumers (scanners, skill-drill) work against the normalized stream and don't care which agent produced it.

For agents without a native session file (aider, a wrapper around a raw API, an experimental coding agent), there's no native format to adapt. We need a path for those: a harness adapter writes events directly to disk in a known format, and session-scan reads them via a `neutral` adapter.

The cheap design: publish what session-scan already produces internally. Wrappers write `SessionEvent` JSONL. `neutral` reads it. Done.

## Why not an existing standard

**agent-session-protocol (ASP).** Closest fit. Apache-2.0, npm package, normalizers for Claude Code and Codex, event types overlap session-scan's. Worth converging on later if interop with `capi` users becomes valuable. Not today because:

- session-scan's IR and ASP's IR differ in shape (e.g. ASP splits `tool_call` from `assistant_message`; session-scan embeds `toolCalls` inside `assistant_message`). Aligning is a refactor in session-scan, not a free import.
- ASP is designed for share/resume; session-scan is designed for mining/analysis. The schemas reflect that.
- Pinning to ASP's evolution adds an external dependency on someone else's roadmap.

**OpenTelemetry GenAI.** Span-and-attribute model designed for distributed tracing. Wrong shape for a single-file session log. The `gen_ai.conversation.id` / `session.id` semantics are about correlation across spans, not about expressing what happened inside one session.

**Custom (this spec).** session-scan owns its IR. Wrappers write it. Zero translation. Add a `formatVersion` field so we can migrate to ASP later without breaking consumers.

## File shape

One JSON object per line. UTF-8. No leading BOM. No trailing comma. Empty lines allowed and ignored.

The first non-empty line MUST be a `session_start` event carrying the format version.

```jsonl
{"type":"session_start","formatVersion":1,"header":{"type":"session","id":"<uuid>","timestamp":"<iso8601>","cwd":"/abs/path"},"path":"<absolute path to this file or empty>"}
{"type":"user_message","id":"u1","parentId":null,"text":"Add a Person record named Alice","timestamp":"2026-05-29T12:00:01Z"}
{"type":"assistant_message","id":"a1","parentId":"u1","text":"I'll create the record.","toolCalls":[{"type":"toolCall","id":"tc1","name":"Bash","arguments":{"command":"binder create Person --name Alice"}}],"provider":"anthropic","model":"claude-sonnet-4-5","timestamp":"2026-05-29T12:00:02Z"}
{"type":"tool_result","id":"r1","parentId":"a1","toolCallId":"tc1","toolName":"Bash","content":"created record abc123","isError":false,"command":"binder create Person --name Alice","timestamp":"2026-05-29T12:00:03Z"}
{"type":"assistant_message","id":"a2","parentId":"r1","text":"Done.","toolCalls":[],"provider":"anthropic","model":"claude-sonnet-4-5","stopReason":"end_turn","timestamp":"2026-05-29T12:00:04Z"}
{"type":"session_end"}
```

The writer SHOULD fsync after each line for crash safety. The reader MUST tolerate truncation of the last line.

## Event types

Drawn directly from session-scan's existing `SessionEvent` types. Every field is REQUIRED unless marked optional.

### `session_start`

The first event. Carries the version and session identity.

```ts
{
  type: "session_start",
  formatVersion: 1,                  // integer, monotonically increasing
  header: {
    type: "session",
    id: string,                      // uuid or any stable identifier
    timestamp: string,               // ISO 8601
    cwd: string,                     // absolute path the agent ran in
    parentSession?: string,          // optional: session this was resumed from
  },
  path: string,                      // absolute path to this file, or "" if unknown at write time
}
```

### `user_message`

```ts
{
  type: "user_message",
  id: string,
  parentId: string | null,           // null for the first user message
  text: string,
  timestamp: string,
}
```

### `assistant_message`

Tool calls live inside, matching session-scan's embedded model.

```ts
{
  type: "assistant_message",
  id: string,
  parentId: string | null,
  text: string,                      // may be empty if the message is tool-call only
  toolCalls: ToolCall[],             // [] if none
  provider: string,                  // "anthropic" | "openai" | other
  model: string,                     // canonical model name
  stopReason?: string,               // "end_turn" | "tool_use" | "max_tokens" | ...
  errorMessage?: string,             // if the assistant turn errored
  tokens?: {
    input: number,
    output: number,
    cacheCreation?: number,
    cacheRead?: number,
  },
  timestamp: string,
}

type ToolCall = {
  type: "toolCall",
  id: string,                        // unique within the session
  name: string,                      // canonical tool name (Bash, Read, Write, Edit, ...)
  arguments: Record<string, unknown>,
}
```

### `tool_result`

Paired with a tool call by `toolCallId`.

```ts
{
  type: "tool_result",
  id: string,
  parentId: string | null,
  toolCallId: string,                // matches assistant_message.toolCalls[].id
  toolName: string,
  content: string,                   // result text, possibly truncated by the writer
  isError: boolean,
  command?: string,                  // for Bash-shaped tools, the resolved command
  timestamp: string,
}
```

### `bash_execution` (optional)

For harness adapters that distinguish bash execution from generic tool calls. Most writers can skip this and just emit `tool_result` for Bash.

```ts
{
  type: "bash_execution",
  id: string,
  parentId: string | null,
  command: string,
  output: string,
  exitCode: number | undefined,
  cancelled: boolean,
  timestamp: string,
}
```

### `thinking` (optional)

For agents that expose internal reasoning.

```ts
{
  type: "thinking",
  id: string,
  parentId: string | null,
  text: string,
  timestamp: string,
}
```

### `compaction` (optional)

```ts
{
  type: "compaction",
  id: string,
  parentId: string | null,
  summary: string,
  tokensBefore: number,
  timestamp: string,
}
```

### `model_change`, `thinking_level_change`, `custom_message` (optional)

As defined in session-scan's existing types. Writers MAY emit them; readers MUST tolerate them.

### `error` (optional)

```ts
{
  type: "error",
  id: string,
  parentId: string | null,
  message: string,
  source: "agent" | "harness" | "tool",
  timestamp: string,
}
```

### `session_end`

```ts
{ type: "session_end" }
```

SHOULD be the last line. Reader MUST handle its absence (writer crashed before emitting).

## Versioning

`formatVersion: 1` is this spec.

Forward-compatibility rules:

- Readers MUST tolerate unknown event types and skip them (no throw).
- Readers MUST tolerate unknown fields within known event types (no throw).
- Writers MAY add new optional fields without bumping the version.
- New REQUIRED fields, removed fields, renamed fields, or changed semantics REQUIRE a version bump.

A version-2 reader SHOULD accept version-1 files. A version-1 reader MAY reject version-2 files explicitly.

## Adapter contract

session-scan ships a `neutral` adapter that satisfies the existing `SessionSource` interface:

```ts
// src/adapters/neutral.ts
import type { SessionSource } from "../parser/source.js";

export default {
  name: "neutral",

  storageDir(opts) {
    // Neutral sessions don't have a canonical storage dir. Default to the cwd
    // or a configurable path. Most callers pass an explicit file path and
    // don't use discovery.
    return opts?.cwd ?? process.cwd();
  },

  async *parse(filePath, opts) {
    // Read line by line, JSON.parse, yield session-scan SessionEvents.
    // Validate first line is session_start with formatVersion.
    // Skip unknown event types.
  },

  async detect(filePath) {
    // Read first line; return true if type === "session_start" && formatVersion
    // is a known integer.
  },

  async *discover(opts) {
    // No native discovery. Yield nothing by default.
    // Callers explicitly pass file paths.
  },
} satisfies SessionSource;
```

## Write helpers (optional, recommended)

Many harness adapters will be tiny scripts. To make emitting valid neutral sessions easy, session-scan SHOULD ship write helpers in a separate module:

```ts
import { NeutralSessionWriter } from "session-scan/write";

const w = new NeutralSessionWriter({
  path: process.env.SKILL_DRILL_SESSION_PATH!,
  cwd: process.cwd(),
});

await w.start();
await w.userMessage("Add a Person record");
const callId = await w.assistantMessage({
  text: "I'll create it.",
  toolCalls: [{ name: "Bash", arguments: { command: "binder create Person --name Alice" } }],
  model: "claude-sonnet-4-5",
  provider: "anthropic",
});
await w.toolResult({ toolCallId: callId, toolName: "Bash", content: "created abc123", isError: false });
await w.end();
```

The writer handles: id generation, parent threading, timestamps, fsync, atomic line writes.

For shell-based wrappers, a minimal `session-scan-write` CLI helps:

```bash
session-scan-write start --path "$SKILL_DRILL_SESSION_PATH" --cwd "$PWD"
session-scan-write user-message --text "Add a Person record"
session-scan-write assistant-message --text "Done." --model claude-sonnet-4-5
session-scan-write end
```

Both are nice-to-haves, not required by the format. A wrapper that just `jq -nc | tee -a "$out"` is also valid.

## Interaction with spawn-capture

When skill-drill (or any consumer) wraps a harness adapter via `captureSession`, the neutral path works like:

```ts
const result = await captureSession(
  {
    source: "neutral",
    sessionPath: "/abs/path/to/session.jsonl",   // explicit, since neutral has no native storage
  },
  async () => {
    // spawn the wrapper, which writes to that path
    const proc = Bun.spawn(["./my-wrapper.sh"], {
      cwd: workspaceDir,
      env: { ...process.env, SKILL_DRILL_SESSION_PATH: "/abs/path/to/session.jsonl" },
    });
    return { exitCode: await proc.exited };
  },
);

// result.sessionPath === "/abs/path/to/session.jsonl"
for await (const evt of streamSession(result.sessionPath)) {
  // ...
}
```

`captureSession` for `source: "neutral"` skips the snapshot-diff dance entirely — the caller already knows the path. The capture helper just verifies the file exists after the spawn and returns it.

This is a small adjustment to the captureSession spec: `CaptureOptions` gains an optional `sessionPath` field that, when set, short-circuits discovery.

## Open questions

1. **Do we ship the write helpers in the same package or a separate one?** Same package keeps things together. Separate (`session-scan-write`) avoids forcing the bigger lib on tiny wrappers. My lean: same package, separate import path (`session-scan/write`).
2. **Does `formatVersion` belong on `session_start.header` or on `session_start` itself?** Putting it on `header` couples it to the session identity. Putting it on the event itself separates concerns. Current draft has it on `session_start`. Confirm before locking.
3. **Tool name canonicalization.** session-scan's `normalizeToolName` exists for read adapters. Should writers be expected to emit canonical names (`Bash`, `Read`, `Write`, `Edit`), or any name they like (with the reader normalizing)? My lean: writers emit canonical names. Cheaper for downstream.
4. **`timestamp` precision.** ISO 8601 to second or millisecond? Lean: millisecond (`2026-05-29T12:00:01.234Z`). Cheap to emit, lossless.
5. **`parentId` threading.** Strict tree, or allow `null` everywhere as "previous event implied"? Strict tree is more useful for analysis (matches claude-code's session structure). Lean: strict — writers thread events through `parentId` referring to the most recent assistant or user message.

## Order of work

1. Lock the schema in this file. Decide the open questions.
2. Add `src/adapters/neutral.ts` — read-side parser, validates `formatVersion`, yields `SessionEvent`s. Register in adapter registry.
3. Ship optional write helpers (`src/write.ts` + `NeutralSessionWriter`).
4. Update `captureSession` (per spawn-capture.md) to accept an explicit `sessionPath` for the neutral case.
5. Add a `session-scan-write` CLI thin wrapper. Optional, can defer.

Steps 1–2 unblock consumers. Steps 3–5 are polish.
