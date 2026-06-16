/** Truncate text, adding ... if trimmed. */
export function truncate(text: string, maxLen = 300): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

/** Flatten text to a single line, truncated. */
export function truncLine(text: string, maxLen = 120): string {
  const line = text.replace(/\n/g, " ").trim();
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen) + "...";
}

/** Strip ANSI escape codes. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
