/**
 * Shared line-reading helpers for source adapters.
 *
 * Used by detect() implementations to peek at the first few lines of a file
 * without reading the whole thing.
 */

import { open } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";

/**
 * Stream every top-level JSON value from a file. Tolerant of both one-value-
 * per-line JSONL (the native harness format) and pretty-printed concatenated
 * JSON: lines are accumulated into a buffer until they parse, then flushed.
 */
export async function* readJsonValues(
  filePath: string,
): AsyncGenerator<unknown> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let buf = "";
  try {
    for await (const line of rl) {
      if (!buf && !line.trim()) continue;
      buf += line + "\n";
      try {
        const value = JSON.parse(buf);
        yield value;
        buf = "";
      } catch {
        // incomplete value: keep accumulating lines
      }
    }
  } finally {
    rl.close();
  }
}

/** First complete JSON value in a file, or null. Tolerant of pretty-print. */
export async function readFirstJsonValue(
  filePath: string,
): Promise<unknown> {
  for await (const value of readJsonValues(filePath)) return value;
  return null;
}

/** Read just the first non-empty line of a file. */
export async function readFirstLine(filePath: string): Promise<string | null> {
  const lines = await readFirstLines(filePath, 1);
  return lines[0] ?? null;
}

/** Read up to `n` non-empty lines of a file. */
export async function readFirstLines(
  filePath: string,
  n: number,
): Promise<string[]> {
  let fh;
  try {
    fh = await open(filePath, "r");
  } catch {
    return [];
  }
  try {
    const rl = createInterface({
      input: fh.createReadStream({ encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    const out: string[] = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      out.push(line);
      if (out.length >= n) break;
    }
    rl.close();
    return out;
  } finally {
    await fh.close();
  }
}
