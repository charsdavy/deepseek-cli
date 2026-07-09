// Shared terminal-width helpers — single source for CJK/emoji width detection
// and line truncation. Used by render.ts and input.ts.

/** Compute the display width of a string, accounting for ANSI escapes and
 *  double-width CJK/emoji codepoints. */
export function visWidth(s: string): number {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of stripped) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20) continue;
    w += isWideChar(c) ? 2 : 1;
  }
  return w;
}

/** True for codepoints that occupy two terminal columns (emoji / CJK / Hangul /
 *  fullwidth). The 0x2000–0x2E7F block (General Punctuation, Arrows, Math, …)
 *  is explicitly narrow so symbols like U+203A `›` are not mis-counted. */
export function isWideChar(c: number): boolean {
  if (c >= 0x1F000 || (c >= 0x2600 && c <= 0x27BF)) return true;
  if (c >= 0x2000 && c < 0x2E80) return false;
  return (
    (c >= 0x1100 && c < 0x2000) ||
    (c >= 0x2E80 && c <= 0xA4CF) ||
    (c >= 0xAC00 && c <= 0xD7A3) ||
    (c >= 0xF900 && c <= 0xFAFF) ||
    (c >= 0xFE30 && c <= 0xFE4F) ||
    (c >= 0xFF00 && c <= 0xFFE6)
  );
}

/** Truncate a string to `max` visible columns, appending an ellipsis if cut. */
export function truncateLine(s: string, max: number): string {
  if (max <= 1) return s.length > 0 ? "…" : s;
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
