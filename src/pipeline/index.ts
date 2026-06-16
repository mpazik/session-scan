/**
 * Pipeline stages: composable async-generator transforms over the canonical
 * event stream. Each takes a plain options object (no CLI knowledge) so it's
 * testable in isolation. The runner wires them per session; the CLI only parses
 * args into these option shapes.
 */

export { filter, hasFilters } from "./filter.js";
export type { FilterCriteria } from "./filter.js";

export { trim, hasTrim } from "./trim.js";
export type { TrimOptions } from "./trim.js";

export { renderNdjson, renderMd } from "./render.js";
export type { RenderFormat } from "./render.js";

export { stdoutSink, openFileSink } from "./sink.js";
export type { Sink } from "./sink.js";

export { loadScanner } from "./scanner-loader.js";
