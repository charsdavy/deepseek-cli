// Terminal output helpers — markdown rendering, streaming, panels, spinner.

import { combine, outputSilent, paint, symbol, C } from "./theme.ts";
export { setOutputSilent } from "./theme.ts";

// ---- Low-level IO ----

// Normalize \n → \r\n at the lowest level. setRawMode(true) calls cfmakeraw()
// which disables OPOST, so the kernel no longer translates \n to \r\n on
// output. Using \r\n everywhere ensures lines start at col 0 in both raw and
// cooked mode (in cooked mode the extra \r is a harmless no-op). The regex
// \r?\n → \r\n handles both bare \n and existing \r\n without doubling.
export function streamWrite(text: string): void {
  if (outputSilent) return;
  Bun.stdout.write(text.replace(/\r?\n/g, "\r\n"));
}

export function writeLine(text = ""): void {
  if (outputSilent) return;
  process.stdout.write(text.replace(/\r?\n/g, "\r\n") + "\r\n");
}

export function blank(): void {
  if (outputSilent) return;
  writeLine();
}

// ---- Markdown rendering (complete strings; not used during streaming) ----

/**
 * Lightweight terminal Markdown renderer. Renders inline + block elements
 * commonly produced by chat models. Stays close to the source semantics
 * without depending on a full parser.
 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inList = false;

  while (i < lines.length) {
    let line = lines[i];

    // Fenced code block
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      out.push(renderCodeBlock(code.join("\n"), lang));
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(paint.dim("─".repeat(termWidth())));
      i++;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(renderHeading(level, inline(h[2].trim())));
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const txt = line.replace(/^>\s?/, "");
      out.push(`${paint.gray("│")} ${paint.italic(inline(txt))}`);
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      if (!inList) inList = true;
      const txt = line.replace(/^\s*[-*+]\s+/, "");
      out.push(`${paint.cyan(symbol.bullet)} ${inline(txt)}`);
      i++;
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const m = line.match(/^\s*(\d+)\.\s+(.*)$/);
      if (m) out.push(`${paint.cyan(m[1] + ".")} ${inline(m[2])}`);
      i++;
      continue;
    }

    if (inList && line.trim() === "") inList = false;

    // Empty
    if (line.trim() === "") {
      out.push("");
      i++;
      continue;
    }

    // Paragraph (consume consecutive non-empty, non-special lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(inline(para.join(" ")));
  }

  return out.join("\n");
}

function renderHeading(level: number, text: string): string {
  const bright = paint.bright;
  switch (level) {
    case 1:
      return combine(paint.bold, paint.underline, bright.cyan)(text);
    case 2:
      return combine(paint.bold, bright.cyan)(text);
    case 3:
      return combine(paint.bold, paint.cyan)(text);
    default:
      return paint.bold(text);
  }
}

function renderCodeBlock(code: string, lang: string): string {
  const w = termWidth();
  const lines = code.split("\n");
  const header = lang ? paint.gray(`┌ ${lang} `) : paint.gray("┌ ");
  const top = header + paint.dim("─".repeat(Math.max(1, w - headerLength(header) - 1)));
  const bottom = paint.gray("└" + "─".repeat(Math.max(1, w - 1)));
  const innerWidth = w - 3;
  const body = lines
    .map((l) => {
      const content = truncateLine(l, innerWidth);
      const visLen = content.replace(/\x1b\[[0-9;]*m/g, "").length;
      const pad = " ".repeat(Math.max(0, innerWidth - visLen));
      return `${paint.gray("│")} ${C.bgGray}${C.white}${content}${pad}${C.reset}`;
    })
    .join("\n");
  return [top, body, bottom].join("\n");
}

function headerLength(header: string): number {
  // Strip ANSI codes when computing visible length
  return header.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Inline formatting: **bold**, *italic*, `code`, [text](url)
export function inline(text: string): string {
  let t = text;
  // Inline code — gray background + white text for readability.
  t = t.replace(/`([^`]+)`/g, (_, c) => `${C.bgGray}${C.white} ${c} ${C.reset}`);
  // Bold
  t = t.replace(/\*\*([^*]+)\*\*/g, (_, c) => paint.bold(c));
  // Italic
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, (_, pre, c) => `${pre}${paint.italic(c)}`);
  // Links
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, label, url) => `${paint.underline(paint.cyan(label))} ${paint.gray(`(${url})`)}`,
  );
  return t;
}

function termWidth(): number {
  return Math.min(120, process.stdout.columns ?? 80);
}

// ---- Streaming markdown renderer ----
// Processes lines one at a time as they arrive from the model's stream,
// applying the same block-level + inline formatting as renderMarkdown but
// without needing the full text upfront. Tracks code-fence state across
// lines so ``` blocks are rendered with borders incrementally.

export class StreamMarkdown {
  private inFence = false;

  /** Render a single complete line (no trailing newline). Returns the
   *  formatted string; the caller is responsible for writing it. */
  renderLine(line: string): string {
    if (this.inFence) {
      if (/^```\s*$/.test(line)) {
        this.inFence = false;
        return paint.gray("└" + "─".repeat(Math.max(1, termWidth() - 1)));
      }
      return `${paint.gray("│")} ${C.bgGray}${C.white}${line}${C.reset}`;
    }
    // Opening code fence
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      this.inFence = true;
      const lang = fence[1] ?? "";
      const header = lang ? paint.gray(`┌ ${lang} `) : paint.gray("┌ ");
      return header + paint.dim("─".repeat(Math.max(1, termWidth() - headerVisible(header) - 1)));
    }
    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      return paint.dim("─".repeat(termWidth()));
    }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = inline(h[2].trim());
      if (level <= 2) return combine(paint.bold, paint.cyan)(text);
      if (level === 3) return combine(paint.bold, paint.cyan)(text);
      return paint.bold(text);
    }
    // Blockquote
    if (/^>\s?/.test(line)) {
      return `${paint.gray("│")} ${paint.italic(inline(line.replace(/^>\s?/, "")))}`;
    }
    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      return `${paint.cyan(symbol.bullet)} ${inline(line.replace(/^\s*[-*+]\s+/, ""))}`;
    }
    // Ordered list
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ol) {
      return `${paint.cyan(ol[1] + ".")} ${inline(ol[2])}`;
    }
    // Empty line
    if (line.trim() === "") {
      return "";
    }
    // Regular paragraph line
    return inline(line);
  }

  /** Render the last partial line (no trailing newline). Same as renderLine
   *  but guaranteed to be the final flush. Also closes an unclosed fence. */
  flush(remaining: string): string {
    let out = "";
    if (remaining) {
      out = this.renderLine(remaining);
    }
    // Close an unclosed fence at end of stream.
    if (this.inFence) {
      this.inFence = false;
    }
    return out;
  }

  /** True if currently inside a ``` code block. */
  get inCodeBlock(): boolean {
    return this.inFence;
  }
}

function headerVisible(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateLine(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ---- Decorated output ----

export function printAssistant(text: string): void {
  writeLine();
  writeLine(`${paint.bright.green(symbol.robot)} ${paint.bold(paint.green("DeepSeek"))}:`);
  writeLine(renderMarkdown(text));
  blank();
}

export type SystemColor = "blue" | "yellow" | "magenta" | "green" | "cyan" | "red";

export function printSystem(text: string, color: SystemColor = "blue"): void {
  const fn = paint[color] ?? paint.blue;
  writeLine(fn(text));
}

export function printError(text: string): void {
  blank();
  writeLine(
    `${paint.red(symbol.err)} ${paint.bold(paint.red("[Error]"))} ${paint.red(text)}`,
  );
  blank();
}

export function printTip(text: string): void {
  writeLine(`${paint.yellow(symbol.tip)} ${paint.gray(text)}`);
}

export function printToolHeader(toolName: string, summary: string): void {
  // Compact, Claude-Code-style: a filled dot marker, bold tool name, dimmed
  // argument summary on the same line.
  const head = summary ? `${paint.bold(toolName)} ${paint.gray(summary)}` : paint.bold(toolName);
  writeLine(`${paint.bright.cyan("⏺")} ${head}`);
}

/** Subtle dim rule between turns, mirroring Claude Code's visual rhythm. */
export function printSeparator(): void {
  writeLine(paint.dim("─".repeat(termWidth())));
}

export function printBordered(title: string, body: string, color: "cyan" | "yellow" | "magenta" = "cyan"): void {
  const w = termWidth();
  const titleLine = paint[color](`┌ ${title} `) + paint.dim("─".repeat(Math.max(1, w - title.length - 3)));
  writeLine(titleLine);
  for (const line of body.split("\n")) {
    writeLine(`${paint.gray("│")} ${line}`);
  }
  writeLine(paint.gray("└" + "─".repeat(Math.max(1, w - 1))));
}
