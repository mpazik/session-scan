<p align="center">
  <img src=".github/assets/banner-sticker.png" alt="Session Scan" width="720">
</p>

<h1 align="center">Session Scan</h1>

<p align="center">Read, filter, and export coding-agent sessions with ease.</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-experimental-orange" alt="Status: experimental">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/runtime-Node.js-5FA04E?logo=nodedotjs&logoColor=white" alt="Runtime: Node.js"></a>
  <img src="https://img.shields.io/badge/output-NDJSON%20%7C%20Markdown-6d5b99" alt="Output: NDJSON or Markdown">
</p>

`session-scan` reads the logs Claude Code, Codex, and Pi already write. Get readable transcripts or a common JSON event stream without adding instrumentation, a database, or a daemon. It makes no model calls.

- **Investigate failures.** Extract failed tool results across recent sessions instead of opening each transcript.
- **Prepare a handoff or review.** Export the last few turns, keep failed results, and leave successful tool output behind.
- **Analyze across agents.** Feed one event format into your own scripts or queries instead of parsing each harness separately.
- **Review skill use.** Find conversations where a particular skill was explicitly invoked, with surrounding context.

**Experimental.** Keep your original logs: normalization is not lossless, and output is not a backup or replay format. Logs may contain credentials and private code; there is no automatic redaction.

## Install

Requires [Node.js](https://nodejs.org).

```bash
npm install --global session-scan
```

## Examples

### Investigate what failed

```bash
# Failed tool results from the last seven days, across projects.
session-scan --cwd all --error --format md
```

### Extract context for a handoff

```bash
# Last two turns, preserving conversation and failed tool results.
session-scan /path/to/session.jsonl \
  --last-turns 2 --tool-results errors --no-thinking --format md
```

Inspect the output before sharing it or sending it to another agent.

### Work with one format across agents

```bash
# Structured events from recent sessions for a project.
session-scan --cwd my-project > sessions.jsonl

# Extract assistant text with jq.
jq -r 'select(.type == "assistant_message") | .text' sessions.jsonl
```

### Find conversations that used a skill

```bash
session-scan --cwd my-project --skill copywriting --format md
```

Output goes to stdout; scan statistics and errors go to stderr. NDJSON is the default. Each record includes a session identifier (`sid`). Markdown is a reading view that summarizes tool arguments and omits fields such as usage and event IDs.

Use `--out <file>` for one output file or `--out-dir <dir>` for separate session files. Existing files are never overwritten. Output paths must not overlap input files, and an output directory must not contain any input. Unsafe session IDs and filename collisions fail rather than writing outside the directory or replacing earlier output. Errors can leave partial output; choose a new destination before retrying.

Run `session-scan --help` for options. Invalid arguments exit with status 2; read, parse, and write failures exit with status 1. A downstream command closing the stdout pipe is treated as normal termination.

## Selection

Without a positional file, discovery defaults to the current project name and the last seven days. Project matching is a case-insensitive working-directory substring. `--cwd all` removes the project filter, not the date filter. Dates use filenames where available and file modification times otherwise, not individual event timestamps. A positional file bypasses discovery filters.

`--head` selects an inclusive ancestor branch using a Pi entry `id` or Claude Code `uuid`. Without it, tree logs are not automatically reduced to the latest branch. A turn starts at a user message and continues until the next user message.

`--skill` matches exact, case-sensitive canonical skill names, not incidental file reads or mentions. It selects the session before the last-turn window, so the invoking event may fall outside the retained turns. Event filters combine with AND; comma-separated values within a filter use OR. Selected sessions retain their header.

`--error` means failed tool results, not harness-level errors. Use `--type error` for the latter. Failure detection depends on the adapter and the information recorded by the harness.

## Supported inputs and fidelity

| Input | What to expect |
|---|---|
| **Claude Code JSONL** | Text, recorded thinking, tool calls/results, usage, and selected errors and compaction records. Drops machinery, some injected messages, and unsupported non-text blocks. Separate subagent transcripts require `--include-subagents`. |
| **Codex rollout JSONL** | Text, tools, reasoning summaries, usage, and selected lifecycle events. Omits injected instructions, coalesces response items, and synthesizes event IDs. Usage is associated by response order; tool classification and failure detection include heuristics. |
| **Pi JSONL** | Text, tools, usage, compaction, and selected custom records. Does not retain assistant thinking blocks or non-text blocks. Skips branch summaries, labels, and unsupported entries. |
| **Claude Code text export** | Best-effort reconstruction of visible transcript text. Cannot recover hidden thinking, usage, truncated payloads, native tool IDs, or per-event timestamps. Pairing and paragraph unwrapping are heuristic. Prefer native JSONL. |

Unknown or newly introduced harness records may be omitted. Missing output does not prove something was absent from the session. Token usage is not an authoritative billing report. Some adapters and selectors buffer session data, so large logs can consume substantial memory.

Once a JSON adapter is selected, malformed JSON stops parsing with a file and line diagnostic; already emitted records remain in the output. A syntactically valid but incomplete final record is ignored so logs can be read while an agent is still writing them.

## Privacy and trust

**There is no automatic secret redaction.** Logs and output can contain source code, prompts, credentials, personal data, tool output, local paths, and repository URLs. Inspect them before sharing, committing, or piping them to a hosted service or model.

Filters and trimming are not a privacy boundary. A matching assistant event can retain other tool calls and arguments. `--no-thinking` and `--tool-lines` only reduce selected payloads.

Custom adapters and scanners execute code with your permissions. Only load modules you trust, including those automatically loaded from `~/.session-scan/adapters/`.

## Node.js library

Install in your project:

```bash
npm install session-scan
```

Save as `scan.mjs` and run with `node scan.mjs`:

```js
import { scanSession } from "session-scan";

for await (const event of scanSession("/path/to/session.jsonl", {
  filter: { lastTurns: 2, toolResults: "errors" },
  trim: { noThinking: true },
})) {
  if (event.type === "tool_result" && event.isError) {
    console.log(event.toolName, event.content);
  }
}
```

`scanSession` handles adapter loading, normalization, context, selection, and trimming. It and the CLI load the bundled Pi adapter automatically; lower-level parser entry points require explicit loading of Pi.

## Extensions

Load another adapter with `--adapter <path>`. Use `--scanner <path>` for a custom async generator over one session's filtered events. Scanners replace the trim stage and own their output: `--no-thinking` and `--tool-lines` do not trim scanner results.

Library and scanner context can reference events excluded by filters. Rendered NDJSON omits that in-memory context. Do not treat filtered contextual objects as sanitized data.

## License

[MIT](LICENSE)
