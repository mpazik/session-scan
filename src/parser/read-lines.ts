/**
 * Shared line-reading helpers for source adapters.
 *
 * Used by detect() implementations to peek at the first few lines of a file
 * without reading the whole thing.
 */

import { open } from "fs/promises";
import { createInterface } from "readline";

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
