# Pi Session JSONL Format

Append-only JSONL files. One JSON object per line. First line is always the session header.

## File location

`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

The directory name encodes the cwd: `/Users/foo/src/bar` becomes `--Users-foo-src-bar--`.

## Entry types

### Session header (line 0, always first)
```json
{"type":"session", "version":3, "id":"uuid", "timestamp":"iso", "cwd":"/abs/path", "parentSession":"path-to-parent.jsonl"}
```

### All other entries share a base:
```json
{"type":"...", "id":"8hexchars", "parentId":"8hexchars|null", "timestamp":"iso", ...}
```

The `id`/`parentId` fields form a tree (not a flat list). Branching creates siblings under the same parent. These native entry IDs are accepted by `session-scan --head <entry-id>`.

Pass any entry ID as the session-scan head to reproduce the history up to that entry:

```bash
session-scan "$sessionFile" --head "$entryId" --format md
```

Selection includes the head and its native ancestors. It excludes sibling branches and later descendants. IDs of bookkeeping entries such as `custom`, `label`, or `branch_summary` are valid even when those entries do not map to canonical events.

### model_change
```json
{"type":"model_change", "id":"...", "parentId":"...", "timestamp":"...", "provider":"anthropic", "modelId":"claude-opus-4-6"}
```

### thinking_level_change
```json
{"type":"thinking_level_change", "id":"...", "parentId":"...", "timestamp":"...", "thinkingLevel":"high"}
```

### message (wraps different roles)

#### role: system
```json
{"type":"message", "id":"...", "parentId":"...", "timestamp":"...", "message":{"role":"system", "content":"", "sections":{"project_context":"<project_instructions path=\"/project/AGENTS.md\">\n...\n</project_instructions>"}, "toolsAdded":[], "timestamp":1234}}
```

System messages patch prompt sections by name; `null` removes a section. The reference adapter emits a `custom_message` with `customType:"instruction_files"` whenever a patch sets or removes `project_context`. Its `content` is the complete list of instruction file paths in effect from then on. Other sections are not emitted.

#### role: user
```json
{"type":"message", "id":"...", "parentId":"...", "timestamp":"...", "message":{"role":"user", "content":[{"type":"text","text":"..."}], "timestamp":1234}}
```

Pi injects invoked skill instructions as a user message beginning with:

```xml
<skill name="copywriting" location="/path/to/copywriting/SKILL.md">
```

The reference adapter preserves that `user_message` and immediately emits a
canonical `skill_invocation` containing the exact name and path.

#### role: assistant
```json
{"type":"message", "id":"...", "parentId":"...", "timestamp":"...", "message":{
  "role":"assistant",
  "provider":"anthropic",
  "model":"claude-opus-4-6",
  "content":[
    {"type":"text", "text":"Let me look at this."},
    {"type":"toolCall", "id":"toolu_xxx", "name":"bash", "arguments":{"command":"ls -la"}}
  ],
  "timestamp":1234,
  "stopReason":"toolCall"
}}
```

Tool call fields: `type:"toolCall"`, `id`, `name` (tool name), `arguments` (object).

#### role: toolResult
```json
{"type":"message", "id":"...", "parentId":"...", "timestamp":"...", "message":{
  "role":"toolResult",
  "toolCallId":"toolu_xxx",
  "toolName":"bash",
  "content":[{"type":"text","text":"output here"}],
  "details":{},
  "isError":true,
  "timestamp":1234
}}
```

#### role: bashExecution (user ran `!command` in TUI)
```json
{"type":"message", "id":"...", "parentId":"...", "timestamp":"...", "message":{
  "role":"bashExecution",
  "command":"git rebase main",
  "output":"...",
  "exitCode":1,
  "cancelled":false,
  "truncated":false,
  "timestamp":1234,
  "excludeFromContext":false
}}
```

### custom_message (injected by extensions/skills)
```json
{"type":"custom_message", "id":"...", "parentId":"...", "timestamp":"...",
  "customType":"context",
  "display":true,
  "content":[{"type":"text","text":"<bash command=\"binder search ...\">...</bash>"}],
  "details":{"items":[{"kind":"bash","label":"binder search ...","lines":2,"result":"ok"}]}
}
```

The `customType:"context"` entries are skill resolution results. The `details.items` array shows what was resolved (bash commands, file reads) and whether each succeeded.

### compaction
```json
{"type":"compaction", "id":"...", "parentId":"...", "timestamp":"...",
  "summary":"...long markdown summary...",
  "tokensBefore":111262,
  "firstKeptEntryId":"48f5a22e",
  "details":{"readFiles":[], "modifiedFiles":[]},
  "systemMessage":{"role":"system", "content":"", "sections":{}, "timestamp":1234}}
```

`systemMessage` is a complete prompt checkpoint. When it is present, the reference adapter emits an `instruction_files` event after the compaction, which is empty if the checkpoint has no `project_context`.

### branch_summary
```json
{"type":"branch_summary", "id":"...", "parentId":"...", "timestamp":"...",
  "summary":"...", "fromId":"entryid"}
```

### label
```json
{"type":"label", "id":"...", "parentId":"...", "timestamp":"...",
  "targetId":"entryid", "label":"bookmark name"}
```

### session_info
```json
{"type":"session_info", "id":"...", "parentId":"...", "timestamp":"...", "name":"display name"}
```

### custom (extension state, not sent to LLM)
```json
{"type":"custom", "id":"...", "parentId":"...", "timestamp":"...",
  "customType":"ext-name", "data":{}}
```

## Tool names observed

`bash`, `read`, `edit`, `write`, `find`, `grep`, `ls`

## Binder failure patterns

From scanning real sessions, binder failures show up as:

1. **toolResult with isError:true** where the preceding assistant toolCall ran a `bash` command containing "binder"
2. **toolResult with isError:true** where output text contains binder error codes like `workspace-not-found`, `changeset-input-process-failed`, `cannot_determine_type`
3. **bashExecution with exitCode != 0** where command contains "binder"
4. **custom_message with customType:"context"** where `details.items[].result` might indicate failure (though "ok" is the norm)
5. **bun test failures** on binder test files (exit code != 0, output mentions test file paths under `packages/`)
