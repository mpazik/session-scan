# Scanners

All scanners produce `ScanResult` items. A scanner that finds failures and a scanner that extracts vocabulary are the same shape. The difference is what `kind` and `data` contain.

Built-in: `src/scanners/*.ts`
User-defined: `~/.agentlog/scanners/*.ts`

## Failure analysis

### 1. Binder API failures
**Status**: done
**Scanner**: `binder-failures`

Find binder CLI errors in tool results and bash executions. Classifies as tool_error, test_failure, or bash_error. Includes user prompt context and prior error count per turn.

### 2. Skill usage failures
**Status**: planned
**Scanner**: `skill-failures`

Track skill invocations and their outcomes. Skills are triggered as user messages (`/commit`, `/review`) or through pi extensions. A skill failure is when the turn that follows a skill invocation ends in error or the user expresses frustration.

Needs:
- Detect skill invocation patterns in user messages (slash commands, known skill names)
- Track multi-turn outcomes (skill may span several assistant turns)
- Classify: succeeded, failed, abandoned, user-corrected

### 3. Repeated tool failures
**Status**: planned
**Scanner**: `spiraling`

Agent hits the same or similar error 3+ times in one turn. Classic spiral where it keeps retrying without changing approach.

Data: the repeated error, how many times, what the user asked, whether the agent eventually recovered or the user intervened.

### 4. Edit conflicts
**Status**: planned
**Scanner**: `edit-conflicts`

Edit tool calls that fail because `oldText` doesn't match the file. High frequency = agent has stale file view.

Data: file path, attempted edit, error message, how many reads preceded the edit.

## Agent behavior

### 5. File hotspots
**Status**: planned
**Scanner**: `file-hotspots`

Files read or edited most across sessions. Yields one result per file per session with read count, edit count, and whether any tool errors occurred while working on that file.

Aggregation across sessions happens outside the scanner.

### 6. Backtracking
**Status**: planned
**Scanner**: `backtracking`

Detect edit-then-revert cycles. Agent writes something, then undoes it (either via another edit or `git checkout`), then tries again.

Pattern: edit file A -> (possibly other steps) -> edit file A reverting previous content -> edit file A again.

### 7. Read without progress
**Status**: planned
**Scanner**: `stuck-reads`

File read 3+ times in a session without ever being edited. Agent is searching for something or confused about the content.

Excludes: reference files that are naturally read-only (like node_modules, lock files).

### 8. Compaction impact
**Status**: planned
**Scanner**: `post-compaction`

Compare error rates before and after compaction events within a session. Does the agent lose important context?

Data: errors before compaction, errors after, compaction summary, what was lost.

### 9. Session length vs outcome
**Status**: planned
**Scanner**: `session-length`

Yield one result per session with: turn count, tool call count, error count, duration, whether the session ended with user approval or abandonment.

Not a failure scanner. More of a metrics emitter.

## Knowledge extraction

### 10. Chinese learning bookmarks
**Status**: planned
**Scanner**: `chinese-vocab`

Extract vocabulary, phrases, and example sentences from Chinese learning agent sessions. Each result is a word or phrase with:
- Chinese characters
- Pinyin
- English meaning
- Example sentence (if present)
- Context from the conversation

Filtering: only sessions with the Chinese learning agent (detect by cwd, model, or content patterns).

### 11. Decision log
**Status**: planned
**Scanner**: `decisions`

Extract decisions from assistant messages. Look for patterns like "I'll do X because Y", "choosing X over Y", "the tradeoff is".

Data: the decision, reasoning, what file/feature it relates to, timestamp.

### 12. TODO extraction
**Status**: planned
**Scanner**: `todos`

Pull action items mentioned in user or assistant messages that weren't completed in the session. Look for "TODO", "we should", "next step", "later we need to".

Cross-reference with what actually happened in the session to filter out completed items.

## Metrics

### 13. Model comparison
**Status**: planned
**Scanner**: `model-usage`

Yield one result per model switch or per session with: model used, error count, turn count, tool calls. Enables comparing model effectiveness across sessions.

### 14. Token usage
**Status**: planned
**Scanner**: `token-usage`

Approximate token usage from message sizes and compaction events. Compaction entries include `tokensBefore`. Message content length gives rough estimates between compactions.

### 15. Time patterns
**Status**: planned
**Scanner**: `time-patterns`

Yield one result per session with: start time, end time, duration, day of week, hour of day. Enables analysis of when work happens and which time slots have highest failure rates.
