# Write a custom scanner

Save a `.mjs` module with a default-exported async generator, as in the examples below. These examples run under Node.js or Bun without imports.

## Contract

The CLI calls the scanner once per selected session with:

- `events`: an async generator of normalized, contextual events after CLI filtering. The CLI handles the `session_start` header separately; it is not part of this generator.
- `session`: metadata with `id`, `timestamp`, `cwd`, and optional `agent`, `model`, `git`, and `parentSession`. The input path is not part of this metadata.

Yield partial events with a canonical `type` and any extra finding fields. Use `custom_message` with `customType` for synthetic findings. NDJSON adds `sid`, strips `context`, and preserves other fields.

Keep state inside the generator to reset per session. Emit summaries at the end; aggregate across sessions downstream.

### Fields to inspect

| Event type | Fields |
|---|---|
| `user_message` | `id`, `timestamp`, `text` |
| `assistant_message` | `id`, `timestamp`, `text`, `toolCalls`, `provider`, `model`, optional `thinking` and `usage` |
| `tool_result` | `id`, `timestamp`, `toolCallId`, `toolName`, `content`, `isError`, optional `exitCode` |
| `skill_invocation` | `id`, `name`, optional `path`, `arguments`, `sourceEventId` |
| `error` | `id`, `message`, optional `code` and retry fields |
| `compaction` | `id`, optional `summary`, `tokensBefore` |
| `custom_message` | `id`, `customType`, `content` |

Tool calls are embedded in `assistant_message.toolCalls`, not separate events. A call has `id`, native `name`, optional `normalizedName`, and `arguments`. Match a result's `toolCallId` to the call's `id`. Prefer `normalizedName` for portable tool categories such as `terminal` and `file_read`; do not assume a result has that field.

Every input event also has `context`:

- `turn`: current turn, or `null` before the first user message. Read its `userMessage.text` and `events`.
- `prevTurn`: previous turn, or `null`.
- `model`: active model name.

`turn.events` contains earlier events in the turn, including events excluded by filters. Its arrays grow during scanning; extract needed values immediately.

### Filtering and memory

Filters run before scanners; retain every event type your analysis needs. Scanners replace trimming: `--no-thinking` and `--tool-lines` have no effect on their output. Select and truncate fields yourself.

Consume with `for await`; yield findings immediately instead of collecting input or spreading contextual events. This bounds scanner-added state, not the whole pipeline: context retains two turns, and adapters or selection stages can buffer data.

## Example: error matches with user context

Save as `permission-failures.mjs`. It selects permission-related failures and caps evidence excerpts at 500 characters.

```js
export default async function* scanner(events) {
  for await (const event of events) {
    if (event.type !== "tool_result" || !event.isError) continue;
    if (!/permission denied|EACCES|EPERM/i.test(event.content)) continue;

    yield {
      type: "custom_message",
      customType: "permission_failure",
      sourceEventId: event.id,
      toolCallId: event.toolCallId,
      timestamp: event.timestamp,
      content: {
        tool: event.toolName,
        error: event.content.slice(0, 500),
        userRequest: event.context.turn?.userMessage.text.slice(0, 500),
      },
    };
  }
}
```

```sh
session-scan /path/to/session.jsonl --scanner ./permission-failures.mjs
session-scan --cwd my-project --scanner ./permission-failures.mjs \
  --out ./permission-findings.jsonl
```

## Example: per-session failure count

Save as `failure-count.mjs`. Do not add `--error`; the denominator needs successful results too.

```js
export default async function* scanner(events) {
  let total = 0;
  let failed = 0;
  for await (const event of events) {
    if (event.type !== "tool_result") continue;
    total++;
    if (event.isError) failed++;
  }
  yield {
    type: "custom_message",
    customType: "failure_count",
    content: { total, failed },
  };
}
```

```sh
session-scan /path/to/session.jsonl --scanner ./failure-count.mjs
```

Counts describe the filtered input, not necessarily the full session. Exclude headers when aggregating summaries.

## Test a new scanner

Before a broad scan, compare emitted IDs or counts with a small known input containing matching, nonmatching, and empty cases. Headers are not findings; the count example should emit zero totals for an empty session. Resolve import, syntax, or generator errors before expanding scope.
