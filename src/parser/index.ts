/**
 * Parser framework: the SessionSource contract, the adapter registry, and the
 * streaming entry points. Adapters live in src/adapters/ (built-in) and
 * ~/.session-scan/adapters/ (user); see registry.ts.
 */

export type {
  Adapter,
  DiscoverOptions,
  DiscoverSpec,
} from "./adapter.js";

export {
  register,
  get,
  list,
  discover,
  loadAdapterFile,
  detectSource,
} from "./registry.js";

export { streamSession, discoverSessions } from "./stream.js";
export type { StreamOptions } from "./stream.js";

export {
  readJsonValues,
  readFirstJsonValue,
  readFirstLine,
  readFirstLines,
} from "./read-lines.js";

export { joinTextBlocks } from "./content.js";
