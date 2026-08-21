# session-scan

Mine the session logs your coding agents already write. One command, `session-scan`, normalizes any harness's on-disk format into a canonical event stream, then filters, trims, and renders it. No instrumentation, no storage, no daemon.

```bash
bun src/cli.ts test/fixtures/pi.jsonl                 # normalize one file to NDJSON
bun src/cli.ts --cwd binder --format md               # readable transcripts of recent sessions
bun src/cli.ts --cwd all --error --type tool_result   # every tool failure, last 7 days
bun src/cli.ts FILE --last-turns 2 --tool-results errors --format md
```

## Why

Agents like Claude Code and Codex log every session to disk: every prompt, response, tool call, token count, and error. The data is already there; it's just locked in per-harness formats. session-scan parses those formats into one event model so you can grep it, diff it, feed it to DuckDB, or pipe it to an LLM.

Deliberately out of scope:

- **LLM calls.** `session-scan` never calls a model. Select context, render markdown, pipe it: `session-scan ... --format md | your-llm "..."`.
- **Aggregation.** No stats engine. Pipe the NDJSON to DuckDB.
- **Storage.** Stateless. Reads session files, writes a stream.

## Pipeline

```
session-scan <input | discover-flags>
  → locate          --cwd / --since / --until / --source / --adapter
  → adapter parse   auto-detect harness / --head <entry-id> → canonical SessionEvent
  → withContext     always on: turn / prevTurn / active model
  → filter          --skill / --last-turns / --type / --tool / --error /
                    --tool-results / --role  (default: keep all)
  → [scanner]       --scanner ./file.ts                    (optional, replaces trim)
  → trim            --tool-lines N / --no-thinking         (default: full payloads)
  → render          ndjson (default) | --format md
  → sink            stdout (default) | --out <file> | --out-dir <dir>
```

Default behavior is faithful normalization. Every reduction is opt-in. `session-scan <file>` with no flags emits the full canonical event stream as lossless NDJSON.

Sessions are flattened into one output stream; every NDJSON line carries a `sid` field so sessions stay separable downstream.

## Flags

| flag | stage | default |
|---|---|---|
| `<input>` (positional) | locate | discovery mode |
| `--cwd <substr>` | locate | current repo name (`--cwd all` scans everything) |
| `--since` / `--until` | locate | last 7 days / open |
| `--source <name>` | locate | all adapters |
| `--adapter <path>` (repeatable) | locate | built-ins + `~/.session-scan/adapters/` |
| `--head <entry-id>` | parse | complete session |
| `--skill <name[,name...]>` | filter | keep all sessions |
| `--last-turns N` | filter | complete session |
| `--type a,b` / `--tool a,b` / `--error` / `--role r` | filter | keep all events |
| `--tool-results all\|errors` | filter | `all` |
| `--scanner <path>` | scanner | none |
| `--tool-lines N` / `--no-thinking` | trim | full payloads |
| `--format md` | render | ndjson |
| `--out <file>` / `--out-dir <dir>` | sink | stdout |

`--head` requires one positional session file and selects the native history ending at that entry, inclusively. Pi accepts native `id` values and Claude Code accepts native `uuid` values. Tree adapters emit only the selected entry's ancestor branch, so sibling branches and entries appended after the head are excluded. Codex and Claude text exports currently reject head selection rather than returning the full session.

`--skill` selects complete transcripts containing a canonical `skill_invocation` event. Names are exact and case-sensitive. Comma-separated names use OR semantics. This session criterion combines with event filters using AND, but it does not remove the surrounding conversation. Normalization is adapter-owned: Pi maps its injected `<skill ...>` user envelope, while Claude Code and Codex map a dedicated `Skill` tool call when the host records one. Available-skill catalogs and incidental `SKILL.md` reads do not count.

`--last-turns N` keeps the final N turns after head selection. A turn starts with a `user_message` and includes all following assistant messages, tool results, and other events until the next user message. The session header remains; preamble events before the first user message do not belong to a turn.

`--tool-results errors` drops successful tool results without dropping user messages, assistant messages, or other event types. This differs from `--error`, which keeps only failed tool results. `--tool-results all` is the default.

Filter values: `--type` takes event types (`user_message`, `assistant_message`, `skill_invocation`, `tool_result`, `compaction`, `error`, `custom_message`), `--tool` takes normalized tool names (`terminal`, `file_read`, `file_edit`, ...), `--role` takes `user` / `assistant` / `tool_result`. Event filter criteria combine with AND.

## Examples

```bash
# normalize one file
bun src/cli.ts test/fixtures/pi.jsonl

# readable transcript of recent binder sessions, slim
bun src/cli.ts --cwd binder --format md --tool-lines 1 --no-thinking

# reproduce a focused Pi branch for feedback review
record=$(tail -n 1 ~/.pi/agent/feedback.jsonl)
sessionFile=$(jq -r .sessionFile <<<"$record")
headId=$(jq -r .leafId <<<"$record")
session-scan "$sessionFile" \
  --head "$headId" \
  --last-turns 2 \
  --no-thinking \
  --tool-results errors \
  --format md

# full transcripts where a skill was invoked
session-scan --cwd journal --skill recruiter-replay --format md

# any of several skills (OR), then keep only assistant events
session-scan --cwd all --skill recruiter-replay,copywriting --type assistant_message --format md

# one markdown file per session
bun src/cli.ts --cwd binder --format md --out-dir tmp/transcripts

# only errored tool results, to a file
bun src/cli.ts --cwd all --error --type tool_result --out tmp/errors.jsonl

# custom detection
bun src/cli.ts --cwd binder --scanner ./examples/scanners/binder-failures.ts

# token spend per model, via DuckDB
bun src/cli.ts --cwd all --type assistant_message \
  | duckdb -c "SELECT model, sum(usage.output) FROM read_json('/dev/stdin') GROUP BY 1"

# LLM-pipe: summarize what went wrong this week
bun src/cli.ts --cwd binder --error --format md | your-llm "what keeps failing?"
```

## Event model

Every adapter produces the same `SessionEvent` union (see `src/session.ts`):

- `session_start`: metadata (id, timestamp, cwd, agent, model, git, parentSession)
- `user_message`: the prompt
- `assistant_message`: one model response; holds `text`, `thinking`, `toolCalls[]`, and `usage` (the response is the billing unit)
- `skill_invocation`: adapter-normalized skill name, optional path and arguments, linked to its source event
- `tool_result`: paired to its call by `toolCallId`; carries `isError` and `exitCode`
- `compaction`, `error`: context compaction and harness-level errors
- `custom_message`: escape hatch for harness-specific entries

Tool names are normalized (`terminal`, `file_read`, `file_edit`, `file_write`, `file_search`, `content_search`, `web_search`, `web_fetch`, `sub_agent`) so scanners stay portable across agents; the native name is preserved alongside.

## Scanners

The one user-extensible unit. A scanner is an async generator over one session's events, loaded by path. State resets per session. It emits partial events (`type` is the only required field, extra fields allowed for findings) and may emit a trailing per-session summary when the input ends.

```ts
// ./my-scanner.ts   →   session-scan --scanner ./my-scanner.ts
import type { ContextualEvent, ScanEvent } from "session-scan";
import type { SessionMetadata } from "session-scan";

export default async function* (
  events: AsyncGenerator<ContextualEvent>,
  session: SessionMetadata, // invariant identity: cwd, path, timestamp, ...
): AsyncGenerator<ScanEvent> {
  let errors = 0;
  for await (const ev of events) {
    if (ev.type === "tool_result" && ev.isError) {
      errors++;
      yield { ...ev, finding: { kind: "error" } }; // annotate
    }
  }
  // per-session summary when the input ends
  yield { type: "custom_message", customType: "scan_summary", errors };
}
```

Each event's `.context` carries the current `turn` (user message plus everything since), `prevTurn`, and the active `model`, so turn-level correlation needs no bookkeeping.

Scanners run after `filter` and replace `trim` (they own their own trimming). They must not compute cross-session rollups; that's DuckDB downstream. See `examples/scanners/binder-failures.ts` for a worked example.

## Adapters

One adapter per harness; the only place that understands a native on-disk format. An adapter detects its files (`detect`), locates sessions (`discover`, `storageDir`), and maps native data into canonical events (`parse`), including `skill_invocation` when the harness records one. Adapters can implement `parseHead` to select native ancestry before canonical mapping. The core selector never parses harness-specific envelopes, ancestry, or tool calls.

- **Built-in:** Claude Code, Codex, Claude Code `/export` (`src/adapters/`)
- **Yours:** drop a module in `~/.session-scan/adapters/` or pass `--adapter <path>`

The `claude-export` adapter is a low-fidelity reader for the plain-text transcript Claude Code's `/export` writes (the rendered terminal UI, not the JSONL). Use it when a teammate sends you their `.txt` and the original `~/.claude/projects/<slug>/<id>.jsonl` (which `claude-code` parses losslessly) is out of reach. It reconstructs a display artifact, so it cannot recover token usage, thinking, real tool-call ids, full (untruncated) payloads, or per-event timestamps; prose newlines are un-wrapped heuristically. Files with no parseable JSON are still probed during detection, so a `.txt` export auto-detects by its banner.

A full reference implementation lives in `examples/adapters/` (auto-loaded by the CLI).

See `src/parser/adapter.ts` for the contract.

## Library use

The parser is usable standalone, without the CLI:

```ts
import { streamSession, discoverSessions, withContext } from "session-scan";

for await (const file of discoverSessions({ cwdFilter: "binder" })) {
  for await (const ev of withContext(streamSession(file))) {
    // canonical events with turn context, regardless of harness
  }
}

// Adapter-owned inclusive selection for one known session file:
for await (const ev of streamSession("/path/to/pi-session.jsonl", {
  head: "a1b2c3d4",
})) {
  // only the native branch through a1b2c3d4
}
```

## Fixtures

`test/fixtures/` holds one session file per supported agent (`pi.jsonl`, `claude.jsonl`, `codex.jsonl`, plus the text export `claude-export.txt`) and its normalized golden output (`*-normalized.jsonl`). Each raw file starts from a real captured session and is extended with synthetic entries covering the edge cases the adapters handle: failing tool results, compaction, API errors / aborted turns, thinking blocks, and machinery lines that must be dropped. Useful for trying the CLI and testing adapters and scanners; regenerate goldens with `bun src/cli.ts test/fixtures/<agent>.jsonl > test/fixtures/<agent>-normalized.jsonl`. The pi on-disk format is documented in `examples/adapters/pi-format.md`.

## Status

Working: normalization, discovery, filter/trim/render/sink, scanner loading, claude-code + codex adapters. Not yet published as a package (the `session-scan` import path in examples requires linking the repo).

## License

MIT
