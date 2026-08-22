#!/usr/bin/env bun
/**
 * Deterministic phase-based analysis report for a session export.
 *
 * Uses session-scan as a library: streamSession() normalizes a main thread and
 * its sub-agent transcripts into the canonical event model; everything after is
 * pure, deterministic data transformation. No LLM is called. Sections that need
 * an LLM are emitted as empty headers with <!-- LLM --> markers.
 *
 *   bun scripts/session-report.ts <config.json>
 *
 * The config carries everything session-specific (paths, agent map, phases);
 * the script itself is generic. See report-config.json next to a session export
 * for the shape. Relative `exportDir` / `out` resolve against the config's dir.
 */

import { readdir } from "fs/promises";
import { readFileSync, writeFileSync } from "fs";
import { join, resolve, dirname, isAbsolute } from "path";
import { streamSession } from "../src/parser/index.js";
import { stripAnsi } from "../src/lib/string.js";
import type { SessionEvent } from "../src/session.js";

type Role = string;
interface Config {
  title: string;
  subtitle?: string;
  exportDir: string;
  out: string;
  mainId: string;
  pathStrip?: Record<string, string>;
  outcome?: string[];
  agents: Record<string, [Role, string]>;
  phases: { title: string; ids: string[]; win: [string | null, string | null] }[];
}

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: bun scripts/session-report.ts <config.json>");
  process.exit(1);
}
const cfgDir = dirname(resolve(configPath));
const cfg: Config = JSON.parse(readFileSync(configPath, "utf8"));
const rel = (p: string) => (isAbsolute(p) ? p : resolve(cfgDir, p));
const EXPORT_DIR = rel(cfg.exportDir);
const OUT = rel(cfg.out);
const pathStrip = Object.entries(cfg.pathStrip ?? {});

// ---------------------------------------------------------------------------
// Deterministic error-name classification (first match wins)
// ---------------------------------------------------------------------------

const ERROR_RULES: [RegExp, string][] = [
  [/File has not been read yet/, "write-before-read"],
  [/File has been modified since read/, "stale-read"],
  [/File does not exist/, "file-not-found"],
  [/temporarily unavailable, so auto mode cannot determine the safety/, "model-unavailable (auto-approve blocked)"],
  [/paths are ignored by one of your \.gitignore|FAILED: git add/, "git-add-ignored-path"],
  [/No staged files match any configured task/, "precommit-hook (lint-staged)"],
  [/cannot access .* No such file or directory/, "path-not-found"],
  [/Too many arguments/, "bad-tool-args"],
  [/FAILED\b|Tests\\\\|⨯/, "test-failure"],
  [/\d+ matches for|^0 matches/, "grep-no-match"],
  [/<tool_use_error>/, "tool-use-error"],
];

function errorName(content: string, exitCode?: number): string {
  const c = stripAnsi(String(content).split(/\s+/).join(" "));
  for (const [rx, name] of ERROR_RULES) if (rx.test(c)) return name;
  const m = /^Exit code (\d+)/.exec(c);
  if (m) return `bash-exit-${m[1]}`;
  if (exitCode != null && exitCode !== 0) return `bash-exit-${exitCode}`;
  return "error";
}

const errorTally = new Map<string, number>();
const tally = (n: string) => errorTally.set(n, (errorTally.get(n) ?? 0) + 1);

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function collect(filePath: string, into: Map<string, SessionEvent[]>) {
  let sid = "";
  for await (const ev of streamSession(filePath)) {
    if (ev.type === "session_start") sid = ev.id;
    (into.get(sid) ?? into.set(sid, []).get(sid)!).push(ev);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relpath(p: string): string {
  let out = p;
  for (const [from, to] of pathStrip) out = out.split(from).join(to);
  return out;
}

function primaryArg(a: Record<string, unknown>): string {
  if (!a || typeof a !== "object") return "";
  for (const k of ["command", "cmd"]) if (typeof a[k] === "string") return a[k] as string;
  for (const k of ["file_path", "path", "notebook_path"]) if (typeof a[k] === "string") return relpath(a[k] as string);
  if (typeof a.pattern === "string") return a.pattern + (typeof a.path === "string" ? `  (in ${relpath(a.path)})` : "");
  for (const k of ["query", "url", "prompt", "description"]) if (typeof a[k] === "string") return a[k] as string;
  for (const v of Object.values(a)) if (typeof v === "string") return v;
  return "";
}

// Deterministic user-message intent classification (first match wins).
const INTENT_RULES: [RegExp, string][] = [
  [/why (?:does|is) (?:it|this) (?:take|taking|so)|still (?:not|broken|failing)|come on|seriously|how many times|[?!]{2,}/i, "FRUSTRATION"],
  [/i'?d challenge|i would challenge|why (?:are|did|would|does|is|the)|why dropping|disagree|push ?back|that'?s wrong|are you sure|reconsider|instead of/i, "CHALLENGE"],
  [/did you (?:load|check|read|run|confirm)|i (?:originally |already )?asked|never saw|you (?:didn'?t|forgot|missed|skipped)|should(?:n'?t)? have|undo|revert|that'?s not/i, "CORRECTION"],
  [/proceed|go ahead|commit|lgtm|looks good|happy to|sounds good|continue|ship it|approved?|alright/i, "APPROVAL"],
];
function classifyUser(text: string): { intent: string; text: string } {
  const m = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  if (m) return { intent: "COMMAND", text: m[1]! };
  if (text.startsWith("<command")) return { intent: "COMMAND", text };
  for (const [rx, intent] of INTENT_RULES) if (rx.test(text)) return { intent, text };
  return { intent: text.trim().endsWith("?") ? "QUESTION" : "INSTRUCTION", text };
}

function userMessagesIn(ev: SessionEvent[], win?: [string | null, string | null]) {
  const out: { intent: string; text: string }[] = [];
  for (const d of ev) {
    if (d.type !== "user_message") continue;
    if (win) {
      const ts = d.timestamp ?? "";
      if (win[0] && ts < win[0]) continue;
      if (win[1] && ts >= win[1]) continue;
    }
    const { intent, text } = classifyUser(d.text);
    out.push({ intent, text: oneline(text, 200) });
  }
  return out;
}

function oneline(s: string, n = 140): string {
  const t = String(s).split(/\s+/).join(" ");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function stats(ev: SessionEvent[]) {
  let asst = 0, tools = 0, errs = 0;
  for (const d of ev) {
    if (d.type === "assistant_message") asst++;
    if (d.type === "tool_result") { tools++; if (d.isError) errs++; }
  }
  return { asst, tools, errs };
}

type Line = { name: string; arg: string; flag: string };
function callsFrom(ev: SessionEvent[], win?: [string | null, string | null]): Line[] {
  const results = new Map<string, Extract<SessionEvent, { type: "tool_result" }>>();
  for (const d of ev) if (d.type === "tool_result") results.set(d.toolCallId, d);
  const out: Line[] = [];
  for (const d of ev) {
    if (d.type !== "assistant_message") continue;
    if (win) {
      const ts = d.timestamp ?? "";
      if (win[0] && ts < win[0]) continue;
      if (win[1] && ts >= win[1]) continue;
    }
    for (const c of d.toolCalls) {
      const r = results.get(c.id);
      let flag = "";
      if (r?.isError) { const en = errorName(r.content, r.exitCode); tally(en); flag = `  ❌ ${en}`; }
      out.push({ name: c.name ?? "?", arg: primaryArg(c.arguments), flag });
    }
  }
  return out;
}

const block = (L: string[], heading: string, lines: Line[]) => {
  if (!lines.length) return;
  // Grouped tool counts, e.g. `Bash ×60  Read ×40  Write ×15`.
  const counts = new Map<string, number>();
  for (const { name } of lines) counts.set(name, (counts.get(name) ?? 0) + 1);
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n} ×${c}`)
    .join("  ");
  L.push(`${heading} (${lines.length})`);
  L.push(`\`${summary}\``);
  // Arguments only for the calls that failed.
  const failed = lines.filter((l) => l.flag);
  if (failed.length) {
    L.push(`\nfailed (${failed.length}):`);
    L.push("```");
    for (const { name, arg, flag } of failed) L.push(`${name.padEnd(7)} ${oneline(arg)}${flag}`);
    L.push("```");
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const events = new Map<string, SessionEvent[]>();
await collect(join(EXPORT_DIR, "main-thread.jsonl"), events);
for (const f of (await readdir(join(EXPORT_DIR, "subagents"))).filter((n) => n.endsWith(".jsonl")).sort()) {
  await collect(join(EXPORT_DIR, "subagents", f), events);
}

const meta = new Map<string, Extract<SessionEvent, { type: "session_start" }>>();
const allTimestamps: string[] = [];
for (const [sid, ev] of events) {
  const s = ev.find((d) => d.type === "session_start");
  if (s) meta.set(sid, s as any);
  for (const d of ev) if (d.timestamp) allTimestamps.push(d.timestamp);
}
allTimestamps.sort();
const firstTimestamp = allTimestamps[0];
const lastTimestamp = allTimestamps.at(-1);
const span = firstTimestamp && lastTimestamp
  ? `${firstTimestamp.slice(11, 16)} → ${lastTimestamp.slice(11, 16)} UTC (${firstTimestamp.slice(0, 10)})`
  : "unknown";

const L: string[] = [];
const main = events.get(cfg.mainId) ?? [];
const ms = stats(main);

L.push(`# ${cfg.title}\n`);
if (cfg.subtitle) L.push(`${cfg.subtitle}\n`);
L.push("## Outcome\n");
for (const b of cfg.outcome ?? []) L.push(`- ${b}`);
L.push(`- **Wall-clock:** ${span}.`);
L.push(`- **Sessions:** ${events.size} (1 main + ${events.size - 1} sub-agents).`);
L.push(`- **Main thread:** ${ms.asst} assistant turns, ${ms.tools} tool calls, ${ms.errs} tool errors.\n`);

for (const { title, ids, win } of cfg.phases) {
  L.push(`\n## ${title}\n`);

  if (ids.length) {
    L.push("**Agents**");
    for (const sid of ids) {
      const [role, label] = cfg.agents[sid] ?? ["?", sid];
      const st = stats(events.get(sid) ?? []);
      const errtxt = st.errs ? `, ${st.errs} errors` : "";
      L.push(`- \`${sid.slice(0, 12)}\` [${role}] ${label} — ${meta.get(sid)?.model ?? "?"} (${st.asst} turns, ${st.tools} tools${errtxt})`);
    }
    L.push("");
  }

  const notes: string[] = [];
  for (const sid of ids) {
    const [role, label] = cfg.agents[sid] ?? ["", ""];
    if (label.includes("ORPHANED")) notes.push(`\`${sid.slice(0, 12)}\` reviewer **orphaned** — process exited; verdict never consumed by parent.`);
    if (label.includes("WATCHDOG")) notes.push(`\`${sid.slice(0, 12)}\` implementer **watchdog-killed** mid-run; a retry agent re-did the work.`);
    if (role === "fix") notes.push(`\`${sid.slice(0, 12)}\` is a **fix wave** — the preceding review found problems that needed correcting.`);
  }
  if (notes.length) {
    L.push("**What went wrong / went off**");
    for (const n of notes) L.push(`- ${n}`);
    L.push("");
  }

  const humans = userMessagesIn(main, win);
  if (humans.length) {
    L.push("**Human**");
    for (const h of humans) L.push(`- **[${h.intent}]** ${h.text}`);
    L.push("");
  }

  if (win[0] || win[1]) {
    const mc = callsFrom(main, win);
    if (mc.length) block(L, "**Main-thread tool calls**", mc);
  }
  for (const sid of ids) {
    const [role] = cfg.agents[sid] ?? ["?"];
    block(L, `**\`${sid.slice(0, 12)}\` [${role}] tool calls**`, callsFrom(events.get(sid) ?? []));
  }

  L.push("\n### Assessment");
  L.push("<!-- pending -->");
}

L.push("\n## Error summary\n");
L.push("| error name | count |");
L.push("|---|--:|");
let total = 0;
for (const [name, n] of [...errorTally.entries()].sort((a, b) => b[1] - a[1])) { L.push(`| ${name} | ${n} |`); total += n; }
L.push(`| **total** | **${total}** |`);

L.push("\n## Narrative & assessment\n");
for (const h of [
  "What went well",
  "Where the agent went off (root causes)",
  "Reviewer verdicts (per task)",
  "Recommendations",
]) {
  L.push(`### ${h}`);
  L.push("<!-- pending -->\n");
}

writeFileSync(OUT, L.join("\n"));
console.log(`wrote ${OUT} (${L.length} lines, ${events.size} sessions, ${total} errors)`);
