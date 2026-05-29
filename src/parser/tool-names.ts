/**
 * Tool-name normalization across harnesses.
 *
 * Maps each harness's native tool name to a harness-neutral canonical name so
 * scanners can match on `toolCall.normalizedName` without knowing which agent
 * produced the session.
 *
 * Ported from agent-session-protocol `src/tools.ts` (Apache-2.0), extended with
 * a pi mapping. The codex `exec_command` / `apply_patch` classifiers inspect the
 * command arguments because codex routes everything through two generic tools.
 */

import type { AgentType, NormalizedToolName } from "../types.js";

const CLAUDE_MAP: Record<string, NormalizedToolName> = {
  Bash: "terminal",
  Read: "file_read",
  Edit: "file_edit",
  Write: "file_write",
  Glob: "file_search",
  Grep: "content_search",
  WebSearch: "web_search",
  WebFetch: "web_fetch",
  Agent: "sub_agent",
  Task: "sub_agent",
};

const PI_MAP: Record<string, NormalizedToolName> = {
  bash: "terminal",
  read: "file_read",
  edit: "file_edit",
  write: "file_write",
  find: "file_search",
  glob: "file_search",
  ls: "file_search",
  grep: "content_search",
};

/** Classify a codex `exec_command` by inspecting the shell command string. */
function classifyExecCommand(cmd: string): NormalizedToolName {
  const c = cmd.trim();
  if (/^(cat|head|tail|less|more|nl)\s/.test(c)) return "file_read";
  if (/^rg\s.*--files/.test(c)) return "file_search";
  if (/^(find|fd|ls)\s/.test(c)) return "file_search";
  if (/^(rg|grep|ag|ack)\s/.test(c)) return "content_search";
  return "terminal";
}

/**
 * Resolve a native tool name to its canonical form. Returns the native name
 * unchanged when there's no known mapping.
 */
export function normalizeToolName(
  tool: string,
  agent: AgentType,
  input?: Record<string, unknown>,
): NormalizedToolName {
  if (agent === "pi") {
    return PI_MAP[tool] ?? tool;
  }

  if (agent === "claude-code") {
    return CLAUDE_MAP[tool] ?? tool;
  }

  if (agent === "codex") {
    if (tool === "exec_command" || tool === "shell") {
      const cmd =
        typeof input?.cmd === "string"
          ? input.cmd
          : typeof input?.command === "string"
            ? input.command
            : Array.isArray(input?.command)
              ? (input.command as unknown[]).join(" ")
              : "";
      return classifyExecCommand(cmd);
    }
    if (tool === "apply_patch") {
      const patch = typeof input?.input === "string" ? input.input : "";
      return patch.includes("*** Add File:") ? "file_write" : "file_edit";
    }
    if (tool === "web_search") {
      const action = input?.action as Record<string, unknown> | undefined;
      return action?.type === "open_page" ? "web_fetch" : "web_search";
    }
    return tool;
  }

  return tool;
}
