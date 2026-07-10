// Terminal output helpers — markdown rendering, streaming, panels, spinner.

import { combine, outputSilent, paint, symbol, C } from "./theme.ts";
import { visWidth, truncateLine } from "./width.ts";
export { setOutputSilent } from "./theme.ts";

// ---- Low-level IO ----

// Normalize \n → \r\n at the lowest level. setRawMode(true) calls cfmakeraw()
// which disables OPOST, so the kernel no longer translates \n to \r\n on
// output. Using \r\n everywhere ensures lines start at col 0 in both raw and
// cooked mode (in cooked mode the extra \r is a harmless no-op). The regex
// \r?\n → \r\n handles both bare \n and existing \r\n without doubling.
//
// EPIPE guard: when stdout's downstream pipe goes away (user piped to `head`
// that exited, terminal detached, or the user Ctrl-C'd while a readline
// prompt is mid-refresh), Bun.stdout.write / process.stdout.write throw
// EPIPE. Without a guard, each subsequent readline prompt refresh re-throws
// and trips the global `uncaughtException` handler — observed in production
// logs as 424 turns with no `agent loop end`. Catching it at the source and
// flipping `stdoutBroken` to true makes every later write a silent no-op, so
// the readline refresh loop stops spawning exceptions and the caller above
// (the uncaughtException handler in index.ts) can exit cleanly.
let stdoutBroken = false;

function isEpipe(e: unknown): boolean {
  return e instanceof Error && /EPIPE/.test(e.message);
}

export function isStdoutBroken(): boolean {
  return stdoutBroken;
}

export function safeStdoutWrite(text: string): void {
  if (outputSilent || stdoutBroken) return;
  try {
    process.stdout.write(text);
  } catch (e) {
    if (isEpipe(e)) {
      stdoutBroken = true;
      return;
    }
    throw e;
  }
}

export function streamWrite(text: string): void {
  if (outputSilent || stdoutBroken) return;
  try {
    Bun.stdout.write(text.replace(/\r?\n/g, "\r\n"));
  } catch (e) {
    if (isEpipe(e)) {
      stdoutBroken = true;
      return;
    }
    throw e;
  }
}

export function writeLine(text = ""): void {
  if (outputSilent || stdoutBroken) return;
  try {
    process.stdout.write(text.replace(/\r?\n/g, "\r\n") + "\r\n");
  } catch (e) {
    if (isEpipe(e)) {
      stdoutBroken = true;
      return;
    }
    throw e;
  }
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
      while (i < lines.length && !/^```(\w+)?\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        i++; // consume closing ```
      }
      out.push(renderCodeBlock(code.join("\n"), lang));
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(paint.dim("─".repeat(termWidth())));
      i++;
      continue;
    }

    // Markdown table: header row | separator row | data rows
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines: string[] = [line];
      i++; // consume header
      tableLines.push(lines[i]); // consume separator
      i++;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      out.push(renderTable(tableLines));
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
  t = t.replace(/`([^`]+)`/g, (_, c) => `${paint.bgGray}${paint.white} ${c} ${paint.reset}`);
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
  private pendingTableHeader: string | null = null;
  private tableWidths: number[] = [];
  private inTable = false;

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

    // ---- Table handling (streaming) ----
    // A markdown table starts with a header row (|...|...|) followed by a
    // separator row (|---|---|). Since lines arrive one at a time, we buffer
    // the header until the separator confirms it's a table.
    const isTableRow = /^\s*\|.*\|\s*$/.test(line);

    // Non-table line: close any open table state first.
    if (!isTableRow) {
      let prefix = "";
      if (this.inTable) {
        this.inTable = false;
        prefix += this.tableBorder("└", "┴", "┘") + "\n";
      }
      if (this.pendingTableHeader) {
        const pending = this.pendingTableHeader;
        this.pendingTableHeader = null;
        prefix += this.renderRegular(pending) + "\n";
      }
      return prefix + this.renderRegular(line);
    }

    // It IS a table row.
    // Case 1: separator row → confirms a pending header is a real table.
    if (isTableSeparator(line)) {
      if (this.pendingTableHeader) {
        // Parse column widths from separator + header content.
        const sepCells = parseTableRow(line);
        const headerCells = parseTableRow(this.pendingTableHeader);
        this.tableWidths = sepCells.map((sep, j) => {
          const dashLen = sep.replace(/^:?/, "").replace(/:?$/, "").length;
          const hdrW = headerCells[j] ? visWidth(headerCells[j]) : 0;
          return Math.max(dashLen, hdrW, 3);
        });
        // Render: top border + header row + mid border (all in one return).
        const out = [
          this.tableBorder("┌", "┬", "┐"),
          this.renderTableRow(headerCells, true),
          this.tableBorder("├", "┼", "┤"),
        ].join("\n");
        this.pendingTableHeader = null;
        this.inTable = true;
        return out;
      }
      // Separator without a pending header — skip (malformed table).
      return "";
    }

    // Case 2: data row while in a table.
    if (this.inTable) {
      const cells = parseTableRow(line);
      // Grow widths if a data cell is wider than the initial header-based guess.
      cells.forEach((cell, j) => {
        if (j < this.tableWidths.length) {
          this.tableWidths[j] = Math.max(this.tableWidths[j], visWidth(cell));
        }
      });
      return this.renderTableRow(cells, false);
    }

    // Case 3: potential header row — buffer it, wait for separator.
    if (!this.pendingTableHeader) {
      this.pendingTableHeader = line;
      return ""; // empty — the header will be rendered when the separator arrives
    }

    // Case 4: another table-like row, but no separator seen yet.
    // The pending line wasn't a table header after all. Flush it, then
    // treat the current line as a new potential header.
    const pending = this.pendingTableHeader;
    this.pendingTableHeader = null;
    const flushed = this.renderRegular(pending);
    this.pendingTableHeader = line;
    return flushed;
  }

  /** Render all non-table, non-fence line types. */
  private renderRegular(line: string): string {
    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      return paint.dim("─".repeat(termWidth()));
    }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = inline(h[2].trim());
      if (level <= 2) return combine(paint.bold, paint.bright.cyan)(text);
      if (level === 3) return combine(paint.bold, paint.cyan)(text);
      return paint.cyan(text);
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

  /** Render one table row with │ borders and cell padding. */
  private renderTableRow(cells: string[], isHeader: boolean): string {
    const parts = cells.map((cell, j) => {
      const w = this.tableWidths[j] ?? Math.max(visWidth(cell), 3);
      const content = isHeader ? paint.bold(inline(cell)) : inline(cell);
      const pad = " ".repeat(Math.max(0, w - visWidth(content)));
      return ` ${content}${pad} `;
    });
    return `${paint.gray("│")}${parts.join(paint.gray("│"))}${paint.gray("│")}`;
  }

  /** Render a horizontal table border (┌┬┐ / ├┼┤ / └┴┘). */
  private tableBorder(l: string, m: string, r: string): string {
    const segments = this.tableWidths.map((w) => paint.gray("─".repeat(w + 2)));
    return `${paint.gray(l)}${segments.join(paint.gray(m))}${paint.gray(r)}`;
  }

  /** Render the last partial line (no trailing newline). Same as renderLine
   *  but guaranteed to be the final flush. Also closes an unclosed fence/table. */
  flush(remaining: string): string {
    let out = "";
    if (this.inFence) {
      // We're still inside an unclosed code fence. Render any remaining content
      // as a fence line, then close the bottom border.
      if (remaining) {
        out = `${paint.gray("│")} ${C.bgGray}${C.white}${remaining}${C.reset}`;
      }
      this.inFence = false;
      out += (out ? "\n" : "") + paint.gray("└" + "─".repeat(Math.max(1, termWidth() - 1)));
    } else if (remaining) {
      out = this.renderLine(remaining);
    }
    // Close an unclosed table.
    if (this.inTable) {
      this.inTable = false;
      out += (out ? "\n" : "") + this.tableBorder("└", "┴", "┘");
    }
    // Flush a pending (unconfirmed) table header as a regular line.
    if (this.pendingTableHeader) {
      const pending = this.pendingTableHeader;
      this.pendingTableHeader = null;
      out += (out ? "\n" : "") + this.renderRegular(pending);
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

/** Visible width of a string (ANSI stripped; emoji/CJK = 2, else 1). */
// ---- Table rendering ----

/** Parse a markdown table row into cell contents (without leading/trailing pipes). */
function parseTableRow(line: string): string[] {
  return line.split("|").slice(1, -1).map((c) => c.trim());
}

/** True if a line looks like a table separator row: |---|:--:|--:| */
function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/** Render a complete table (header + separator + data rows) as a bordered block. */
function renderTable(rows: string[]): string {
  if (rows.length < 2) return rows.map((r) => inline(r)).join("\n");
  const headerCells = parseTableRow(rows[0]);
  const sepCells = parseTableRow(rows[1]);
  const dataRows = rows.slice(2).map(parseTableRow);

  // Column widths: max of separator dashes, header content, and data content.
  const widths = sepCells.map((sep, j) => {
    const dashLen = sep.replace(/^:?/, "").replace(/:?$/, "").length;
    const hdrW = headerCells[j] ? visWidth(headerCells[j]) : 0;
    return Math.max(dashLen, hdrW, 3);
  });
  for (const cells of dataRows) {
    cells.forEach((cell, j) => {
      if (j < widths.length) widths[j] = Math.max(widths[j], visWidth(cell));
    });
  }

  const border = (l: string, m: string, r: string): string => {
    const segments = widths.map((w) => paint.gray("─".repeat(w + 2)));
    return `${paint.gray(l)}${segments.join(paint.gray(m))}${paint.gray(r)}`;
  };
  const renderRow = (cells: string[], isHeader: boolean): string => {
    const parts = cells.map((cell, j) => {
      const w = widths[j] ?? Math.max(visWidth(cell), 3);
      const content = isHeader ? paint.bold(inline(cell)) : inline(cell);
      const pad = " ".repeat(Math.max(0, w - visWidth(content)));
      return ` ${content}${pad} `;
    });
    return `${paint.gray("│")}${parts.join(paint.gray("│"))}${paint.gray("│")}`;
  };

  const out = [border("┌", "┬", "┐"), renderRow(headerCells, true), border("├", "┼", "┤")];
  for (const cells of dataRows) {
    out.push(renderRow(cells, false));
  }
  out.push(border("└", "┴", "┘"));
  return out.join("\n");
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
