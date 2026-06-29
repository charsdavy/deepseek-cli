// Terminal output helpers — markdown rendering, streaming, panels, spinner.

import { combine, paint, symbol } from "./theme.ts";

// ---- Low-level IO ----

export function streamWrite(text: string): void {
  Bun.stdout.write(text);
}

export function writeLine(text = ""): void {
  process.stdout.write(text + "\n");
}

export function blank(): void {
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
  const body = lines
    .map((l) => `${paint.gray("│")} ${paint.dim(truncateLine(l, w - 2))}`)
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
  // Inline code
  t = t.replace(/`([^`]+)`/g, (_, c) => paint.inverse(paint.gray(c)));
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
  writeLine(
    `${paint.cyan(symbol.arrow)} ${paint.bold(toolName)} ${paint.gray(summary)}`,
  );
}

export function printBordered(title: string, body: string, color: "cyan" | "yellow" = "cyan"): void {
  const w = termWidth();
  const titleLine = paint[color](`┌ ${title} `) + paint.dim("─".repeat(Math.max(1, w - title.length - 3)));
  writeLine(titleLine);
  for (const line of body.split("\n")) {
    writeLine(`${paint.gray("│")} ${line}`);
  }
  writeLine(paint.gray("└" + "─".repeat(Math.max(1, w - 1))));
}
