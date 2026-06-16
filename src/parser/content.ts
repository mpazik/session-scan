/**
 * Content helpers shared by adapters. The on-disk message `content` is, across
 * every harness so far, either a plain string or an array of blocks each
 * carrying a `.text`. Adapters use this to flatten that into one string.
 */

/**
 * Join the text of a string-or-block-array `content` with newlines.
 *
 * @param typed When true (default) only blocks with `type === "text"` count;
 *   set false to take any block exposing a string `.text` (codex emits typeless
 *   text blocks).
 */
export function joinTextBlocks(
  content: unknown,
  opts: { typed?: boolean } = {},
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const typed = opts.typed ?? true;
  return content
    .filter((b: any) => typeof b?.text === "string" && (!typed || b.type === "text"))
    .map((b: any) => b.text)
    .join("\n");
}
