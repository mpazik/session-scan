/** Byte writers. The runner owns session splitting and sink lifetime. */
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate } from "node:timers/promises";

export interface Sink {
  write(s: string): Promise<void>;
  close(): Promise<void>;
}

/** Wait for each write to finish, bounding buffering even on slow pipes. */
export function stdoutSink(): Sink {
  const output = process.stdout;
  let failure: Error | undefined;
  let closed = false;
  const onError = (error: Error): void => { failure ??= error; };
  output.on("error", onError);
  return {
    async write(s) {
      if (failure) throw failure;
      if (closed) throw new Error("Sink is closed");
      await new Promise<void>((resolve, reject) => {
        output.write(s, (error) => error ? reject(error) : resolve());
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      // A failed write callback can precede the stream's error event.
      await setImmediate();
      output.off("error", onError);
      if (failure) throw failure;
    },
  };
}

/** Exclusively create a file. Existing files and symlinks are never followed. */
export async function openFileSink(path: string): Promise<Sink> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "wx");
  let closed = false;
  return {
    async write(s) {
      if (closed) throw new Error("Sink is closed");
      await file.writeFile(s, "utf8");
    },
    async close() {
      if (closed) return;
      closed = true;
      await file.close();
    },
  };
}
