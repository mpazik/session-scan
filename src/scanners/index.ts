/**
 * Scanner discovery and registry.
 *
 * Built-in scanners are registered on import.
 * User-defined scanners are loaded from ~/.session-scan/scanners/*.ts
 * User files override built-ins by name.
 */

import { readdir } from "fs/promises";
import { join } from "path";
import type { Scanner } from "../scanner.js";

// Built-ins
import { scanner as binderFailures } from "./binder-failures.js";

const scanners = new Map<string, Scanner>();

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function register(s: Scanner): void {
  scanners.set(s.name, s);
}

export function get(name: string): Scanner | undefined {
  return scanners.get(name);
}

export function list(): Scanner[] {
  return [...scanners.values()];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const USER_DIR = join(
  process.env.HOME || "~",
  ".session-scan",
  "scanners",
);

/**
 * Load all scanners: built-ins first, then user-defined (which can override).
 * Call once at startup before accessing the registry.
 */
export async function discover(): Promise<void> {
  // Register built-ins
  register(binderFailures);

  // Load user-defined scanners
  let files: string[];
  try {
    files = await readdir(USER_DIR);
  } catch {
    return; // directory doesn't exist
  }

  for (const file of files) {
    if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;

    const fullPath = join(USER_DIR, file);
    try {
      const mod = await import(fullPath);
      const s: Scanner | undefined = mod.scanner ?? mod.default;
      if (s && s.name && s.collect && s.extract) {
        register(s);
      } else {
        console.error(
          `Warning: ${file} does not export a valid scanner (need: scanner or default with name, collect, extract)`,
        );
      }
    } catch (err) {
      console.error(`Warning: failed to load ${file}: ${err}`);
    }
  }
}
