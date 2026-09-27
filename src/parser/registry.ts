/**
 * Adapter registry.
 *
 * Adapters are pluggable. Each is a module that exports an `Adapter` (as
 * `source` or default). They load from three places:
 *
 *   Built-in:  src/adapters/*.ts        (ship with the package: codex, claude)
 *   User:      ~/.session-scan/adapters/*.ts
 *   Explicit:  loadAdapterFile(path)     (e.g. CLI --adapter <path>)
 *
 * Pi is NOT built in; it lives in examples/adapters/pi.ts as the reference
 * implementation. Load it with `--adapter examples/adapters/pi.ts`.
 */

import { readdir } from "fs/promises";
import { join, isAbsolute, resolve } from "path";
import type { Adapter, DiscoverSpec } from "./adapter.js";
import { readFirstJsonValue } from "./read-lines.js";

const registry = new Map<string, Adapter>();
let discovered = false;

const BUILTIN_DIR = join(import.meta.dirname, "..", "adapters");
const USER_DIR = join(process.env.HOME || "~", ".session-scan", "adapters");

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function register(s: Adapter): void {
  registry.set(s.name, s);
}

export function get(name: string): Adapter | undefined {
  return registry.get(name);
}

export function list(): Adapter[] {
  return [...registry.values()];
}

function isAdapter(s: unknown): s is Adapter {
  if (!s || typeof s !== "object") return false;
  const a = s as Adapter;
  const d: unknown = a.discover;
  const discoverOk =
    typeof d === "function" ||
    (!!d && typeof d === "object" && typeof (d as DiscoverSpec).match === "function");
  return (
    typeof a.name === "string" &&
    typeof a.parse === "function" &&
    typeof a.detect === "function" &&
    discoverOk
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Import one adapter module and register it. Returns the source or null. */
export async function loadAdapterFile(
  path: string,
): Promise<Adapter | null> {
  // Resolve relative paths against the cwd (where the user ran the CLI), not
  // against this module. Built-in/user dirs already pass absolute paths.
  const resolved = isAbsolute(path) ? path : resolve(process.cwd(), path);
  try {
    const mod = await import(resolved);
    const s: unknown = mod.default ?? mod.source;
    if (isAdapter(s)) {
      register(s);
      return s;
    }
    console.error(
      `Warning: ${path} does not export a valid Adapter (default export with name, parse, detect, and a discover spec or function)`,
    );
  } catch (err) {
    console.error(`Warning: failed to load adapter ${resolved}: ${err}`);
  }
  return null;
}

async function loadDir(dir: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return; // directory doesn't exist
  }
  for (const file of files) {
    if (file.endsWith(".d.ts") || (!file.endsWith(".ts") && !file.endsWith(".js"))) continue;
    await loadAdapterFile(join(dir, file));
  }
}

/**
 * Load built-in and user adapters. Idempotent. Pass `extra` to additionally
 * load specific adapter files (e.g. from a CLI flag); extras always load.
 */
export async function discover(opts: { extra?: string[] } = {}): Promise<void> {
  if (!discovered) {
    await loadDir(BUILTIN_DIR);
    await loadDir(USER_DIR);
    discovered = true;
  }
  for (const path of opts.extra ?? []) {
    await loadAdapterFile(path);
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Identify which adapter produced a file. Reads the file's first JSON value
 * once, then probes each registered adapter's detect() with it.
 *
 * `first` is null when the file has no parseable JSON value (e.g. a plain-text
 * `/export` transcript). Adapters are still probed in that case: JSON adapters
 * key on `first?.x` and return false, while text adapters sniff via `filePath`.
 */
export async function detectSource(
  filePath: string,
): Promise<Adapter | null> {
  await discover();
  const first = await readFirstJsonValue(filePath);
  for (const source of list()) {
    if (source.detect(first, filePath)) return source;
  }
  return null;
}
