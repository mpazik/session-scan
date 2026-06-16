/**
 * Sink stage. Dumb byte writers over a rendered string stream. Per-session
 * splitting (`--out-dir`) is runner-level: the runner opens one file sink per
 * session. Render already terminated each chunk, so sinks write verbatim.
 */

import { mkdir } from "fs/promises";
import { dirname } from "path";

export interface Sink {
  write(s: string): void;
  close(): Promise<void>;
}

/** Stream to stdout. Sessions concatenate. */
export function stdoutSink(): Sink {
  return {
    write(s) {
      process.stdout.write(s);
    },
    async close() {},
  };
}

/** Stream to a single file, creating parent dirs. */
export async function openFileSink(path: string): Promise<Sink> {
  await mkdir(dirname(path), { recursive: true });
  const writer = Bun.file(path).writer();
  return {
    write(s) {
      writer.write(s);
    },
    async close() {
      await writer.end();
    },
  };
}
