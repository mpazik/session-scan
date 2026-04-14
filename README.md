# AgentLog

> **Name candidates**: AgentLog, AgentScan, SessionMiner

Post-hoc session mining tool for LLM coding agents. Reads existing session logs, runs pluggable scanners, surfaces structured insights. No instrumentation required.

## The problem

You've been using Claude Code, Cursor, or another AI coding agent for weeks. You know something feels off — the agent keeps getting confused in the same parts of the codebase, your `/commit` skill works great in one repo but breaks in another, sessions in the auth module always go sideways. But you have no way to confirm it or fix it systematically.

Existing tools don't help:

- **Observability platforms** (AgentReplay, Langfuse) require SDK instrumentation and focus on cost/latency metrics. They tell you *how much* the agent did, not *where it struggled*.
- **Anthropic's `/insights`** analyzes how *you* prompt across all your sessions. Good for personal habits, useless for repo-level or skill-level patterns. Can't be scoped to a project.

AgentLog reads the session logs that are already on your machine and tells you what's actually going wrong.

## Use cases

### Repo diagnostics
What in this codebase is making agents struggle?

- Which files get read repeatedly without progress?
- Where does the agent backtrack, retry, or ask for clarification?
- Which modules correlate with failed or incomplete sessions?
- Are CLAUDE.md rules being contradicted by the actual code?

### Skill and tool performance
How does a skill or tool perform across sessions and repos?

- Success/failure rate of `/commit`, `/review`, or any custom skill
- Which repos does an MCP tool fail in most?
- How does skill performance change over time or across agents?

### Session data extraction
Pull structured data out of sessions automatically.

- Auto-summaries
- Decision and insight extraction
- Tool usage statistics
- Obstacle and correction detection

## How it works

AgentLog is an orchestration layer, not an analyzer. It:

1. Reads session logs from supported harnesses (no instrumentation needed)
2. Normalizes them into a common format via adapters
3. Runs configured extractors against matching sessions
4. Stores output per session per extractor
5. Tracks what's been processed for incremental re-runs

**Extractors** are pluggable — LLM calls, scripts, or shell commands. They receive normalized session data and produce structured output. The framework manages lifecycle: trigger, collect, store, re-trigger on update.

**Filtering** scopes which sessions an extractor runs against: project, agent, skill invoked, tools used, date range.

## Supported session sources

| Harness | Location |
|---------|----------|
| Claude Code | `~/.claude/projects/` (JSONL) |
| pi | custom |
| OpenCode | TBD |

## Interface

```
agentlog analyze          # repo diagnostics for current project
agentlog skill /commit    # skill performance across sessions
agentlog session <id>     # extract data from a specific session
agentlog search <query>   # search across sessions
```

Designed to also work as a Claude Code slash command — same UX as `/insights`, repo-aware signal.

## Development

The pi-mono source lives at `../pi-mono/` and is the primary reference for session format, agent types, and tool definitions.

We're building our own session parser, starting with pi as the first adapter. Pi sessions are append-only JSONL files stored under `~/.pi/agent/sessions/`. Each file starts with a `session` header, followed by typed entries (`message`, `compaction`, `branch_summary`, `model_change`, `thinking_level_change`, `custom`, `custom_message`, `label`, `session_info`). Entries form a tree via `id`/`parentId` fields.

### Rules

**Always stream, single walk.** Session data can be large (22 MB single files, 364 MB total). Never load a full session into memory. The parser (`src/parser.ts`) is an `AsyncGenerator<SessionEvent>` that yields typed events line by line. Consumers (scanners, extractors) compose by wrapping the generator:

```ts
// Parser streams events from a JSONL file
for await (const event of streamSession(filePath, opts)) {
  // event.type: "session_start" | "user_message" | "assistant_message" |
  //             "tool_result" | "bash_execution" | "compaction" | ...
}

// Scanner wraps the parser, yields only what it finds
for await (const result of scanForBinderFailures(streamSession(path, opts))) {
  if (result.type === "failure") { ... }
}
```

The parser internally tracks assistant tool calls so that `tool_result` events include the resolved `command` from the originating `toolCall`. This means consumers never need to buffer or correlate entries themselves.

Filters (date range, cwd pattern) are applied at the header level. If a file doesn't match, the stream closes immediately without reading the rest.

## Prior art

Existing tools in this space, kept here for reference if we want to integrate with other agent harnesses later:

- **[agentprobe](https://github.com/vtemian/agentprobe)** — TypeScript library with providers for Cursor, Claude Code, Codex, OpenCode. Focused on real-time observation/lifecycle events, not batch analysis. The parsing layer could be useful.
- **[opensession](https://github.com/hwisu/opensession)** — Rust. Defines a canonical "HAIL JSONL" format with parsers for Claude Code, Codex, Cursor, Gemini CLI, OpenCode. Buried inside a large session-sharing platform. Not usable standalone.
- **[sessionlog](https://github.com/npow/sessionlog)** — Python. Ingests Claude Code, Codex, Cursor, Antigravity sessions into SQLite. More of an ingestion tool than a library.

None of these are well-maintained or popular. We're rolling our own.

## Status

Prototype. Streaming pi session parser and binder failure scanner working.

```bash
bun src/cli.ts --stats                    # scan all binder sessions
bun src/cli.ts --since 2026-04-01          # filter by date
bun src/cli.ts --cwd vision --limit 20     # filter by cwd, limit output
bun src/cli.ts --json                      # JSON output
```

## License

TBD
