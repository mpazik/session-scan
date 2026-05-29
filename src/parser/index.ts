/**
 * Parser framework: the SessionSource contract, the adapter registry, and the
 * streaming entry points. Adapters live in src/adapters/ (built-in) and
 * ~/.session-scan/adapters/ (user); see registry.ts.
 */

export type {
  SessionSource,
  StreamOptions,
  DiscoverOptions,
  FindSessionContext,
} from "./source.js";

export {
  register,
  get,
  list,
  discover,
  loadAdapterFile,
  detectSource,
} from "./registry.js";

export { streamSession, discoverSessions } from "./stream.js";

export { normalizeToolName } from "./tool-names.js";
export { readFirstLine, readFirstLines } from "./read-lines.js";
