#!/usr/bin/env bun
/**
 * Per-session message-count and token stats for binder feat-* / fix-* worktrees.
 *
 * Splits each session into segments delimited by `compaction` events. Emits TSV
 * to stdout: one row per (session, segment).
 *
 * Buckets per segment:
 *   user            user messages (incl. skill-expansion prompts)
 *   assistant_text  assistant messages with at least one non-empty text block
 *   tool_call       count of toolCall blocks across assistant messages
 *   tool_result     toolResult messages (errors included)
 *   tokens_in       sum of message.usage.input across assistant messages
 *   tokens_out      sum of message.usage.output across assistant messages
 *
 * Excluded: bashExecution, assistant thinking-only messages, model_change,
 * thinking_level_change, custom_message, file-history-snapshot, session header.
 */

import { createReadStream, statSync } from "fs";
import { readdir } from "fs/promises";
import { createInterface } from "readline";
import { join } from "path";
import { homedir } from "os";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const DIR_RE = /^--Users-marekpazik-src-binder-(feat|fix)-(.+)--$/;

type Counts = {
  user: number;
  assistant_text: number;
  tool_call: number;
  tool_result: number;
  tokens_in: number;
  tokens_out: number;
};

const newCounts = (): Counts => ({
  user: 0,
  assistant_text: 0,
  tool_call: 0,
  tool_result: 0,
  tokens_in: 0,
  tokens_out: 0,
});

interface Row {
  branch_type: string;
  branch: string;
  session: string; // filename without .jsonl
  started_at: string;
  segment: number;
  counts: Counts;
}

async function* discoverDirs(): AsyncGenerator<{ type: string; branch: string; path: string }> {
  let entries;
  try {
    entries = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = DIR_RE.exec(e.name);
    if (!m) continue;
    yield { type: m[1]!, branch: m[2]!, path: join(SESSIONS_DIR, e.name) };
  }
}

function hasNonEmptyText(content: unknown): boolean {
  if (!Array.isArray(content)) return typeof content === "string" && content.trim().length > 0;
  for (const b of content as any[]) {
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) return true;
  }
  return false;
}

function countToolCalls(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content as any[]) if (b?.type === "toolCall") n++;
  return n;
}

async function processFile(filePath: string): Promise<{ started_at: string; segments: Counts[] } | null> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const segments: Counts[] = [newCounts()];
  let started_at = "";
  let headerSeen = false;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let raw: any;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }

      if (raw.type === "session") {
        headerSeen = true;
        started_at = String(raw.timestamp ?? "");
        continue;
      }
      if (!headerSeen) return null;

      const seg = segments[segments.length - 1]!;

      if (raw.type === "compaction") {
        // Boundary: subsequent events go into a new segment.
        segments.push(newCounts());
        continue;
      }

      if (raw.type !== "message") continue; // drop meta
      const msg = raw.message;
      if (!msg) continue;

      switch (msg.role) {
        case "user":
          seg.user++;
          break;
        case "assistant": {
          if (hasNonEmptyText(msg.content)) seg.assistant_text++;
          seg.tool_call += countToolCalls(msg.content);
          const u = msg.usage;
          if (u) {
            if (typeof u.input === "number") seg.tokens_in += u.input;
            if (typeof u.output === "number") seg.tokens_out += u.output;
          }
          break;
        }
        case "toolResult":
          seg.tool_result++;
          break;
        // bashExecution and anything else: ignored
      }
    }
  } finally {
    rl.close();
  }

  if (!headerSeen) return null;
  return { started_at, segments };
}

async function main() {
  const rows: Row[] = [];

  for await (const dir of discoverDirs()) {
    let files;
    try {
      files = await readdir(dir.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const filePath = join(dir.path, f.name);
      // Skip empty files fast.
      try {
        if (statSync(filePath).size === 0) continue;
      } catch {
        continue;
      }
      const result = await processFile(filePath);
      if (!result) continue;
      const sessionId = f.name.replace(/\.jsonl$/, "");
      result.segments.forEach((counts, idx) => {
        rows.push({
          branch_type: dir.type,
          branch: dir.branch,
          session: sessionId,
          started_at: result.started_at,
          segment: idx,
          counts,
        });
      });
    }
  }

  // Sort: branch_type, branch, started_at, segment.
  rows.sort((a, b) =>
    a.branch_type.localeCompare(b.branch_type) ||
    a.branch.localeCompare(b.branch) ||
    a.started_at.localeCompare(b.started_at) ||
    a.segment - b.segment,
  );

  const header = [
    "branch_type",
    "branch",
    "session",
    "started_at",
    "segment",
    "user",
    "assistant_text",
    "tool_call",
    "tool_result",
    "tokens_in",
    "tokens_out",
  ];
  process.stdout.write(header.join("\t") + "\n");
  for (const r of rows) {
    process.stdout.write(
      [
        r.branch_type,
        r.branch,
        r.session,
        r.started_at,
        String(r.segment),
        String(r.counts.user),
        String(r.counts.assistant_text),
        String(r.counts.tool_call),
        String(r.counts.tool_result),
        String(r.counts.tokens_in),
        String(r.counts.tokens_out),
      ].join("\t") + "\n",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
