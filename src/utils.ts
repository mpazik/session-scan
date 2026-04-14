/**
 * Utility functions for scanners.
 */

// ---------------------------------------------------------------------------
// Frustration detection
// ---------------------------------------------------------------------------

interface FrustrationResult {
  /** 0-1 score. Higher = more frustrated. */
  score: number;
  /** Which signals matched */
  signals: string[];
}

const FRUSTRATION_PATTERNS: [RegExp, string, number][] = [
  // Corrections
  [/^no\.?!?$/im, "bare-no", 0.4],
  [/^wrong\.?!?$/im, "bare-wrong", 0.5],
  [/^stop\.?!?$/im, "bare-stop", 0.6],
  [/\bstop\b.*(changing|doing|modifying|touching|removing|deleting)/i, "stop-doing", 0.6],
  [/that'?s not (what|right|correct)/i, "thats-not-right", 0.5],
  [/that'?s wrong/i, "thats-wrong", 0.5],
  [/not what I (asked|said|meant|wanted)/i, "not-what-i-asked", 0.6],

  // Repeated instructions
  [/I (already|just) (said|told|asked|mentioned)/i, "already-said", 0.6],
  [/I said\b/i, "i-said", 0.4],
  [/as I (said|mentioned|told)/i, "as-i-said", 0.5],
  [/again[.!]?$/im, "again", 0.3],

  // Blame
  [/you keep/i, "you-keep", 0.6],
  [/why did you/i, "why-did-you", 0.5],
  [/you (broke|ruined|messed|screwed)/i, "you-broke", 0.7],
  [/you('re| are) (not|ignoring|missing)/i, "youre-not", 0.5],
  [/don'?t (do that|change|touch|modify|remove|delete)/i, "dont-do-that", 0.5],

  // Impatience
  [/just do (it|what)/i, "just-do-it", 0.4],
  [/please just/i, "please-just", 0.3],
  [/can you (just|please)/i, "can-you-just", 0.2],
  [/try again/i, "try-again", 0.3],
  [/revert/i, "revert", 0.3],
  [/undo/i, "undo", 0.3],

  // Emphasis
  [/[A-Z]{5,}/, "caps", 0.3],
  [/!{2,}/, "exclamation", 0.3],
  [/\?{2,}/, "question-marks", 0.3],
];

/**
 * Score frustration in a user message.
 *
 * Returns a 0-1 score and the list of signals that matched.
 * Uses pattern matching only, no LLM. Fast.
 *
 * Factors:
 * - Known frustration phrases
 * - Message brevity (short messages after agent output = correction)
 * - Caps and punctuation
 *
 * Usage in a scanner:
 *   const { score, signals } = frustrationScore(event.text, event.context);
 *   if (score > 0.3) { yield candidate... }
 */
export function frustrationScore(
  text: string,
  opts?: {
    /** Length of the previous assistant message. Short user reply to long output = correction. */
    prevAssistantLength?: number;
  },
): FrustrationResult {
  const signals: string[] = [];
  let raw = 0;

  // Pattern matching
  for (const [pattern, name, weight] of FRUSTRATION_PATTERNS) {
    if (pattern.test(text)) {
      signals.push(name);
      raw += weight;
    }
  }

  // Brevity: short message (< 20 chars) after long assistant output (> 200 chars)
  if (
    opts?.prevAssistantLength &&
    opts.prevAssistantLength > 200 &&
    text.length < 20
  ) {
    // Short reply to long output isn't always frustration,
    // but combined with other signals it's meaningful
    if (signals.length > 0) {
      signals.push("brief-correction");
      raw += 0.2;
    }
  }

  // Clamp to 0-1
  const score = Math.min(1, raw);

  return { score, signals };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

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
