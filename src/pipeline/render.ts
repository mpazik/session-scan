/**
 * Render stage. Turns a per-session event stream into output strings. Fixed CLI
 * machinery, not user-pluggable: the model is normalized, so one renderer is
 * universal. Custom formats = pipe ndjson to your own tool.
 *
 * Accepts both `ContextualEvent` (default/trim path) and `ScanEvent` (scanner
 * path). Render owns line termination; the sink writes strings verbatim.
 *
 * - ndjson: one JSON object per line, `sid` on every line, `context` stripped.
 * - md: markdown transcript; `session_start` becomes a header, `sid` dropped.
 */

import type { ContextualEvent, ScanEvent } from "../scanner.js";
import { truncLine } from "../lib/string.js";

export type RenderFormat = "ndjson" | "md";

type RenderInput = ContextualEvent | ScanEvent;

export async function* renderNdjson(
  events: AsyncGenerator<RenderInput>,
  sid: string,
): AsyncGenerator<string> {
  for await (const ev of events) {
    const { context, ...rest } = ev as Record<string, unknown>;
    yield JSON.stringify({ sid, ...rest }) + "\n";
  }
}

export async function* renderMd(
  events: AsyncGenerator<RenderInput>,
  sid: string,
): AsyncGenerator<string> {
  for await (const ev of events) {
    yield mdBlock(ev as Record<string, unknown> & { type: string }, sid) +
      "\n\n";
  }
}

function mdBlock(ev: Record<string, unknown> & { type: string }, sid: string): string {
  const e = ev as any;
  switch (ev.type) {
    case "session_start": {
      const meta = [e.cwd, e.model, e.timestamp].filter(Boolean).join(" · ");
      return `# session ${e.id || sid}${meta ? `\n\n${meta}` : ""}`;
    }
    case "user_message":
      return `## user\n\n${e.text ?? ""}`;
    case "assistant_message": {
      const parts: string[] = [
        `## assistant${e.model ? ` (${e.model})` : ""}`,
      ];
      if (e.thinking?.text) parts.push(quote(e.thinking.text));
      if (e.text) parts.push(e.text);
      for (const tc of e.toolCalls ?? []) {
        parts.push(`→ **${tc.normalizedName ?? tc.name}** \`${argSummary(tc)}\``);
      }
      return parts.join("\n\n");
    }
    case "tool_result": {
      const tag = e.isError ? " [error]" : "";
      return `### tool_result${tag}\n\n\`\`\`\n${e.content ?? ""}\n\`\`\``;
    }
    case "compaction":
      return `--- compaction${e.summary ? `: ${e.summary}` : ""} ---`;
    case "error":
      return `### error\n\n${e.message ?? ""}`;
    default: {
      // type/customType go in the header; id/parentId/timestamp are plumbing.
      const { context, id, parentId, type, customType, timestamp, ...rest } = e;
      const head = customType
        ? `### ${ev.type} · ${customType}`
        : `### ${ev.type}`;
      const body = yamlBlock(rest);
      return body ? `${head}\n\n\`\`\`yaml\n${body}\n\`\`\`` : head;
    }
  }
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

function argSummary(tc: { arguments?: Record<string, unknown> }): string {
  const a = tc.arguments ?? {};
  const cmd = a.command ?? a.cmd ?? a.file_path ?? a.path ?? a.pattern;
  if (typeof cmd === "string") return truncLine(cmd, 100);
  return truncLine(JSON.stringify(a), 100);
}

// -- minimal YAML emitter ----------------------------------------------------
// Enough for transcript bodies: scalars, nested objects/arrays, and block
// scalars for multiline strings. No dependency.

function yamlBlock(obj: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines = Object.entries(obj).map(([k, v]) => yamlEntry(pad, k, v, indent));
  return lines.join("\n");
}

function yamlEntry(pad: string, key: string, v: unknown, indent: number): string {
  if (v === null || v === undefined) return `${pad}${key}: null`;
  if (typeof v === "number" || typeof v === "boolean") return `${pad}${key}: ${v}`;
  if (typeof v === "string") {
    return v.includes("\n")
      ? `${pad}${key}: ${blockScalar(v, indent + 1)}`
      : `${pad}${key}: ${scalar(v)}`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return `${pad}${key}: []`;
    const child = "  ".repeat(indent + 1);
    return `${pad}${key}:\n${v.map((x) => yamlItem(child, x, indent + 1)).join("\n")}`;
  }
  return `${pad}${key}:\n${yamlBlock(v as Record<string, unknown>, indent + 1)}`;
}

function yamlItem(pad: string, v: unknown, indent: number): string {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const block = yamlBlock(v as Record<string, unknown>, indent + 1);
    return pad + "- " + block.slice(pad.length + 2);
  }
  if (typeof v === "string" && v.includes("\n")) {
    return `${pad}- ${blockScalar(v, indent + 1)}`;
  }
  if (v === null || v === undefined) return `${pad}- null`;
  if (typeof v === "object") return `${pad}- ${JSON.stringify(v)}`;
  if (typeof v === "string") return `${pad}- ${scalar(v)}`;
  return `${pad}- ${v}`;
}

function blockScalar(s: string, indent: number): string {
  const inner = "  ".repeat(indent);
  const body = s
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l.length ? inner + l : ""))
    .join("\n");
  return `|-\n${body}`;
}

const YAML_RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;

function scalar(s: string): string {
  if (s === "") return '""';
  if (s !== s.trim()) return JSON.stringify(s);
  if (YAML_RESERVED.test(s)) return JSON.stringify(s);
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return JSON.stringify(s);
  if (s.includes(": ") || s.includes(" #")) return JSON.stringify(s);
  if (/^[0-9.+-]+$/.test(s) && !Number.isNaN(Number(s))) return JSON.stringify(s);
  return s;
}
