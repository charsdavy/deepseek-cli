// Prompt-harness helpers — the single source of truth for how tool results,
// file attachments, and structured envelopes are wrapped before they go back
// to the model.
//
// "Harness" = the standardized XML-ish wrappers + truncation/error line
// formats that delimit tool output inside the conversation. Keeping every
// tool on these helpers means:
//   • the model can always find a result's boundaries (open/close tag pair)
//   • truncation is reported consistently (no silent data drops)
//   • errors carry a machine-readable `error="code"` attribute
//   • line numbers / bullets are plain (no ANSI control codes leak into the
//     model-facing content — terminal colors belong on stdout, not in the
//     messages array)
//
// Tag conventions:
//   <toolname attr="v" attr2="v">body</toolname>   — success with body
//   <toolname attr="v"/>                            — success, empty body
//   <toolname error="code">human message</toolname> — failure
// Multi-word tag names use snake_case to match existing `web_search`.

import { truncateLine } from "../ui/width.ts";

export type AttrValue = string | number | undefined | null;

/** Escape a string for safe use inside a double-quoted attribute value. */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Render an attribute map as ` k="v" k2="v2"` (leading space) or "" if empty. */
export function attrStr(attrs: Record<string, AttrValue>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}="${escapeAttr(String(v))}"`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/**
 * Wrap a body in an open/close tag pair with attributes.
 * An empty body collapses to a self-closing tag: `<name attrs/>`.
 */
export function tag(name: string, attrs: Record<string, AttrValue>, body: string): string {
  const a = attrStr(attrs);
  if (body === "") return `<${name}${a}/>`;
  return `<${name}${a}>\n${body}\n</${name}>`;
}

/**
 * Wrap a failure message in the tool's tag with a machine-readable
 * `error="code"` attribute. Mirrors read_files' per-file error envelope.
 */
export function errTag(name: string, code: string, message: string): string {
  return tag(name, { error: code }, message);
}

/** Standard truncation suffix appended after the kept portion of a result. */
export function trunc(omitted: number, unit = "chars"): string {
  return `\n…(truncated, ${omitted} more ${unit} omitted)`;
}

/**
 * Head-truncate `s` to `max` chars and append the standard truncation note.
 * Use this for outputs where the START is most relevant (file listings, git
 * diffs, search results, fetched page bodies). For tail-relevant output
 * (bash stdout) keep the tail and prepend the note manually.
 */
export function cap(s: string, max: number, unit = "chars"): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + trunc(s.length - max, unit);
}

/**
 * Render a line-number-prefixed source line exactly the way read_file does:
 * a 6-char right-padded number, then ": ", then the (possibly truncated)
 * line content. Plain text only — no ANSI — so the model receives clean
 * `     1: code` prefixes.
 */
export function lineNo(n: number, line: string, max = 1000): string {
  const num = String(n).padStart(6, " ");
  return `${num}: ${truncateLine(line, max)}`;
}

/** Plain bullet prefix used in multi-item results (glob/grep matches). */
export function bullet(text: string): string {
  return `• ${text}`;
}
