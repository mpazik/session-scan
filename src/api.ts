import { resolve } from "node:path";
import { withContext } from "./context.js";
import { discover as discoverAdapters, streamSession } from "./parser/index.js";
import { filter, type FilterCriteria } from "./pipeline/filter.js";
import { trim, type TrimOptions } from "./pipeline/trim.js";
import type { ContextualEvent } from "./scanner.js";

export interface ScanSessionOptions {
  /** Adapter-native inclusive session head. */
  head?: string;
  /** Skip adapter detection and use this source. */
  source?: string;
  /** Additional adapter module paths to load. */
  adapters?: string[];
  /** Semantic event and turn filters. */
  filter?: FilterCriteria;
  /** Presentation payload trimming. */
  trim?: TrimOptions;
}

/**
 * Stream one session as canonical, contextual events.
 *
 * This is the programmatic equivalent of the CLI's single-file path through
 * adapter discovery, head selection, filtering, and trimming.
 */
export async function* scanSession(
  file: string,
  options: ScanSessionOptions = {},
): AsyncGenerator<ContextualEvent> {
  const piReferenceAdapter = resolve(import.meta.dirname, `../examples/adapters/pi.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`);
  await discoverAdapters({
    extra: [piReferenceAdapter, ...(options.adapters ?? [])],
  });

  const events = filter(
    withContext(streamSession(file, {
      source: options.source,
      head: options.head,
    })),
    options.filter ?? {},
  );
  yield* trim(events, options.trim ?? {});
}
