#!/usr/bin/env bun
/**
 * Per-segment "first assistant turn" length report for binder feat-* / fix-*.
 *
 * A *first turn* is the span from the first user message of a segment up to
 * (but not including) the next user message — i.e. everything the agent does
 * autonomously before you reply. Span boundaries are also compaction events
 * and end-of-session.
 *
 * Per first-turn we record:
 *   asst_turns      number of assistant API calls in the span
 *   tool_calls      toolCall blocks issued
 *   output_tokens   sum of assistant usage.output  (the "length of what the
 *                   agent produced", i.e. text + thinking that was billed)
 *   input_tokens    sum of assistant usage.input   (fresh, post-cache)
 *   cache_read      sum of assistant usage.cacheRead
 *
 * Outputs:
 *   tmp/first-turn-lengths.tsv      one row per (session, segment) first-turn
 *   tmp/session-lengths-report.md   markdown summary
 */

import { createReadStream, mkdirSync } from "fs";
import { writeFile, readdir } from "fs/promises";
import { createInterface } from "readline";
import { join } from "path";
import { homedir } from "os";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const DIR_RE = /^--Users-marekpazik-src-binder-(feat|fix)-(.+)--$/;
const OUT_DIR = "tmp";

interface FirstTurn {
  branch_type: "feat" | "fix";
  branch: string;
  session: string;
  started_at: string;
  segment: number;
  asst_turns: number;
  tool_calls: number;
  output_tokens: number;
  input_tokens: number;
  cache_read: number;
}

async function* discoverDirs() {
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
    yield { type: m[1] as "feat" | "fix", branch: m[2]!, path: join(SESSIONS_DIR, e.name) };
  }
}

function countToolCalls(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content as any[]) if (b?.type === "toolCall") n++;
  return n;
}

async function processFile(
  filePath: string,
  branch_type: "feat" | "fix",
  branch: string,
  session: string,
): Promise<FirstTurn[]> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const turns: FirstTurn[] = [];
  let started_at = "";
  let segment = 0;
  // State for current segment's first-turn:
  //   "pre_user"   waiting for first user msg in segment (skip everything)
  //   "in_turn"    saw first user, accumulating until next user
  //   "done"       already recorded; ignore until segment boundary
  let state: "pre_user" | "in_turn" | "done" = "pre_user";
  let curr: FirstTurn | null = null;
  let headerSeen = false;

  const flushIfNeeded = () => {
    if (curr && state !== "pre_user") turns.push(curr);
    curr = null;
    state = "pre_user";
  };

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let raw: any;
      try { raw = JSON.parse(line); } catch { continue; }

      if (raw.type === "session") {
        headerSeen = true;
        started_at = String(raw.timestamp ?? "");
        continue;
      }
      if (!headerSeen) return turns;

      if (raw.type === "compaction") {
        flushIfNeeded();
        segment++;
        continue;
      }

      if (raw.type !== "message") continue;
      const msg = raw.message;
      if (!msg) continue;

      if (msg.role === "user") {
        if (state === "pre_user") {
          curr = {
            branch_type, branch, session, started_at, segment,
            asst_turns: 0, tool_calls: 0,
            output_tokens: 0, input_tokens: 0, cache_read: 0,
          };
          state = "in_turn";
        } else if (state === "in_turn") {
          // First user follow-up closes the first turn.
          turns.push(curr!);
          curr = null;
          state = "done";
        }
        // "done": ignore further user msgs in this segment
        continue;
      }

      if (msg.role === "assistant" && state === "in_turn" && curr) {
        curr.asst_turns++;
        curr.tool_calls += countToolCalls(msg.content);
        const u = msg.usage;
        if (u) {
          if (typeof u.output === "number") curr.output_tokens += u.output;
          if (typeof u.input === "number") curr.input_tokens += u.input;
          if (typeof u.cacheRead === "number") curr.cache_read += u.cacheRead;
        }
      }
    }
  } finally {
    rl.close();
  }

  flushIfNeeded();
  return turns;
}

// ---- stats helpers ----
const sortNum = (xs: number[]) => [...xs].sort((a, b) => a - b);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = sortNum(xs);
  const i = Math.min(s.length - 1, Math.floor(s.length * p));
  return s[i]!;
};
const fmt = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d });

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const all: FirstTurn[] = [];
  for await (const dir of discoverDirs()) {
    let files;
    try { files = await readdir(dir.path); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const session = f.replace(/\.jsonl$/, "");
      const ts = await processFile(join(dir.path, f), dir.type, dir.branch, session);
      all.push(...ts);
    }
  }

  // Drop turns where the agent did nothing (no assistant call).
  const turns = all.filter(t => t.asst_turns > 0);

  // Sort.
  turns.sort((a, b) =>
    a.branch_type.localeCompare(b.branch_type) ||
    a.branch.localeCompare(b.branch) ||
    a.started_at.localeCompare(b.started_at) ||
    a.segment - b.segment,
  );

  // ---- TSV ----
  const header = [
    "branch_type", "branch", "session", "started_at", "segment",
    "asst_turns", "tool_calls", "output_tokens", "input_tokens", "cache_read",
  ];
  const tsvLines = [header.join("\t")];
  for (const t of turns) {
    tsvLines.push([
      t.branch_type, t.branch, t.session, t.started_at, t.segment,
      t.asst_turns, t.tool_calls, t.output_tokens, t.input_tokens, t.cache_read,
    ].join("\t"));
  }
  await writeFile(join(OUT_DIR, "first-turn-lengths.tsv"), tsvLines.join("\n") + "\n");

  // ---- Stats by branch_type ----
  const summary = (bt: "feat" | "fix") => {
    const xs = turns.filter(t => t.branch_type === bt);
    const out = xs.map(t => t.output_tokens);
    const inp = xs.map(t => t.input_tokens);
    const ca = xs.map(t => t.cache_read);
    const at = xs.map(t => t.asst_turns);
    const tc = xs.map(t => t.tool_calls);
    return { n: xs.length, out, inp, ca, at, tc };
  };
  const sfeat = summary("feat");
  const sfix = summary("fix");
  const sall = (() => {
    const out = turns.map(t => t.output_tokens);
    const inp = turns.map(t => t.input_tokens);
    const ca = turns.map(t => t.cache_read);
    const at = turns.map(t => t.asst_turns);
    const tc = turns.map(t => t.tool_calls);
    return { n: turns.length, out, inp, ca, at, tc };
  })();

  const dist = (label: string, xs: number[]) =>
    `| ${label} | ${fmt(mean(xs))} | ${fmt(pct(xs, 0.5))} | ${fmt(pct(xs, 0.9))} | ${fmt(pct(xs, 0.99))} | ${fmt(Math.max(0, ...xs))} |`;

  const block = (name: string, s: ReturnType<typeof summary>) => `
### ${name} (n=${s.n} first-turns)

| metric | mean | p50 | p90 | p99 | max |
|---|---:|---:|---:|---:|---:|
${dist("output_tokens", s.out)}
${dist("input_tokens", s.inp)}
${dist("cache_read", s.ca)}
${dist("asst_turns", s.at)}
${dist("tool_calls", s.tc)}
`.trim();

  // Top 10 longest first-turns by output_tokens.
  const top = [...turns].sort((a, b) => b.output_tokens - a.output_tokens).slice(0, 10);
  const topTable = [
    "| # | type | branch | started_at | seg | asst_turns | tool_calls | output_tokens |",
    "|---|---|---|---|---:|---:|---:|---:|",
    ...top.map((t, i) =>
      `| ${i + 1} | ${t.branch_type} | ${t.branch} | ${t.started_at} | ${t.segment} | ${t.asst_turns} | ${t.tool_calls} | ${fmt(t.output_tokens)} |`,
    ),
  ].join("\n");

  const totalOut = sall.out.reduce((a, b) => a + b, 0);
  const totalIn = sall.inp.reduce((a, b) => a + b, 0);
  const totalCache = sall.ca.reduce((a, b) => a + b, 0);

  const md = `# Binder feat/fix — first assistant-turn lengths

Source: \`~/.pi/agent/sessions/--Users-marekpazik-src-binder-{feat,fix}-*--/*.jsonl\`
Generated: ${new Date().toISOString()}

A *first turn* spans from the first user message of a segment to the next user
message (segment = compaction-delimited slice of a session). It captures
everything the agent does autonomously before you reply.

\`output_tokens\` = sum of \`usage.output\` across assistant calls in the span —
the actual length of what the model produced. \`input_tokens\` is fresh
(post-cache) input; \`cache_read\` is the repeated prefix re-sent each call.

Empty first-turns (no assistant call) excluded.

## Totals

- first-turns analyzed: **${sall.n}** (feat: ${sfeat.n}, fix: ${sfix.n})
- combined output tokens: **${fmt(totalOut)}**
- combined fresh input tokens: **${fmt(totalIn)}**
- combined cache_read tokens: **${fmt(totalCache)}**

${block("All", sall)}

${block("feat", sfeat)}

${block("fix", sfix)}

## Top 10 longest first-turns by output_tokens

${topTable}

## Files

- \`tmp/first-turn-lengths.tsv\` — per-segment first-turn rows
- \`tmp/session-lengths.tsv\` — full per-segment counts (from previous run)
`;

  await writeFile(join(OUT_DIR, "session-lengths-report.md"), md);

  // Also echo a short summary to stdout.
  console.log(`wrote ${OUT_DIR}/first-turn-lengths.tsv (${turns.length} rows)`);
  console.log(`wrote ${OUT_DIR}/session-lengths-report.md`);
}

main().catch(e => { console.error(e); process.exit(1); });
