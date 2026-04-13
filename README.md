# AgentLog

Post-hoc session mining tool for LLM coding agents. Reads existing session logs, runs pluggable extractors, surfaces structured insights. No instrumentation required.

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

## Status

Early concept. Research and design phase.

## License

TBD
