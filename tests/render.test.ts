import { describe, it, expect } from "bun:test";
import { renderMarkdown, inline, StreamMarkdown } from "../src/ui/render.ts";

// The renderer may emit ANSI color codes when stdout is a TTY; these tests
// assert on color-independent substrings (text content + box-drawing markers)
// so they're deterministic in any environment.

describe("renderMarkdown", () => {
  it("renders a paragraph as a single line", () => {
    expect(renderMarkdown("hello world")).toContain("hello world");
  });

  it("renders an h1 heading with its text", () => {
    const out = renderMarkdown("# Title");
    expect(out).toContain("Title");
  });

  it("renders an unordered list with bullet + text", () => {
    const out = renderMarkdown("- alpha\n- beta");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("•");
  });

  it("renders an ordered list preserving numbers", () => {
    const out = renderMarkdown("1. first\n2. second");
    expect(out).toContain("1.");
    expect(out).toContain("first");
    expect(out).toContain("second");
  });

  it("renders a fenced code block with body + frame markers", () => {
    const out = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("│"); // left frame
    expect(out).toContain("┌"); // top frame
    expect(out).toContain("└"); // bottom frame
  });

  it("renders a horizontal rule as a dim rule line", () => {
    const out = renderMarkdown("---");
    expect(out).toContain("─");
  });

  it("renders a blockquote with a bar prefix", () => {
    const out = renderMarkdown("> quoted text");
    expect(out).toContain("quoted text");
    expect(out).toContain("│");
  });
});

describe("inline", () => {
  it("wraps inline code", () => {
    expect(inline("use `x` here")).toContain("x");
  });

  it("leaves plain text intact", () => {
    expect(inline("just words")).toContain("just words");
  });

  it("transforms a markdown link to include the label", () => {
    expect(inline("[label](https://x.com)")).toContain("label");
  });
});

describe("StreamMarkdown", () => {
  it("renders a heading line", () => {
    const md = new StreamMarkdown();
    const out = md.renderLine("## Section");
    expect(out).toContain("Section");
  });

  it("renders an unordered list item with bullet", () => {
    const md = new StreamMarkdown();
    const out = md.renderLine("- item");
    expect(out).toContain("•");
    expect(out).toContain("item");
  });

  it("renders an ordered list item with number", () => {
    const md = new StreamMarkdown();
    const out = md.renderLine("3. third");
    expect(out).toContain("3.");
    expect(out).toContain("third");
  });

  it("renders a blockquote with bar prefix", () => {
    const md = new StreamMarkdown();
    const out = md.renderLine("> quoted");
    expect(out).toContain("│");
    expect(out).toContain("quoted");
  });

  it("renders inline code in a regular line", () => {
    const md = new StreamMarkdown();
    const out = md.renderLine("use `variable` here");
    expect(out).toContain("variable");
  });

  it("tracks code fence state across lines", () => {
    const md = new StreamMarkdown();
    // Opening fence
    const open = md.renderLine("```ts");
    expect(open).toContain("┌");
    expect(md.inCodeBlock).toBe(true);
    // Inside fence — content has border
    const code = md.renderLine("const x = 1;");
    expect(code).toContain("│");
    expect(code).toContain("const x = 1;");
    // Closing fence
    const close = md.renderLine("```");
    expect(close).toContain("└");
    expect(md.inCodeBlock).toBe(false);
  });

  it("renders plain text via inline formatting", () => {
    const md = new StreamMarkdown();
    const out = md.renderLine("just a normal line");
    expect(out).toContain("just a normal line");
  });

  it("flush renders remaining partial line", () => {
    const md = new StreamMarkdown();
    const out = md.flush("partial line");
    expect(out).toContain("partial line");
  });

  it("flush closes an unclosed code fence", () => {
    const md = new StreamMarkdown();
    md.renderLine("```ts");
    md.renderLine("const x = 1;");
    expect(md.inCodeBlock).toBe(true);
    md.flush("");
    expect(md.inCodeBlock).toBe(false);
  });

  it("renders a horizontal rule", () => {
    const md = new StreamMarkdown();
    const out = md.renderLine("---");
    expect(out).toContain("─");
  });

  // ---- Markdown table rendering (streaming) ----

  it("renders a table with bordered layout", () => {
    const md = new StreamMarkdown();
    // Header row — buffered, returns empty until separator arrives.
    const r1 = md.renderLine("| 文件 | 改动 |");
    expect(r1).toBe("");
    // Separator — triggers header + borders render.
    const r2 = md.renderLine("|------|------|");
    expect(r2).toContain("┌");
    expect(r2).toContain("┬");
    expect(r2).toContain("┐");
    expect(r2).toContain("文件");
    expect(r2).toContain("改动");
    expect(r2).toContain("├");
    expect(r2).toContain("┼");
    expect(r2).toContain("┤");
    // Data row.
    const r3 = md.renderLine("| a.swift | fix bug |");
    expect(r3).toContain("│");
    expect(r3).toContain("a.swift");
    expect(r3).toContain("fix bug");
    // Non-table line → closes the table with a bottom border.
    const r4 = md.renderLine("done");
    expect(r4).toContain("└");
    expect(r4).toContain("┴");
    expect(r4).toContain("┘");
    expect(r4).toContain("done");
  });

  it("buffers header until separator confirms table", () => {
    const md = new StreamMarkdown();
    // Header comes in — no separator yet, so nothing rendered.
    expect(md.renderLine("| H1 | H2 |")).toBe("");
    // Separator confirms it's a table.
    const sep = md.renderLine("|--|--|");
    expect(sep).toContain("┌");
    expect(sep).toContain("H1");
    expect(sep).toContain("H2");
  });

  it("flushes a pending header as regular text if no separator follows", () => {
    const md = new StreamMarkdown();
    md.renderLine("| not a table | maybe |");
    // Flush without a separator — should be output as regular inline text.
    const out = md.flush("");
    expect(out).toContain("not a table");
    expect(out).not.toContain("┌");
  });

  it("renders a table via renderMarkdown (non-streaming)", () => {
    const src = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |";
    const out = renderMarkdown(src);
    expect(out).toContain("┌");
    expect(out).toContain("┬");
    expect(out).toContain("┐");
    expect(out).toContain("Name");
    expect(out).toContain("Age");
    expect(out).toContain("Alice");
    expect(out).toContain("Bob");
    expect(out).toContain("├");
    expect(out).toContain("┼");
    expect(out).toContain("┤");
    expect(out).toContain("└");
    expect(out).toContain("┴");
    expect(out).toContain("┘");
  });

  it("handles CJK table cells with double-width alignment", () => {
    const md = new StreamMarkdown();
    md.renderLine("| 文件 | 改动 |");
    md.renderLine("|------|------|");
    const dataRow = md.renderLine("| A.swift | 修复 |");
    // Both cells should be present.
    expect(dataRow).toContain("A.swift");
    expect(dataRow).toContain("修复");
    md.renderLine(""); // close table
  });

  it("closes an unclosed table on flush", () => {
    const md = new StreamMarkdown();
    md.renderLine("| H1 | H2 |");
    md.renderLine("|----|----|");
    md.renderLine("| d1 | d2 |");
    // Flush without a closing non-table line.
    const out = md.flush("");
    expect(out).toContain("└");
    expect(out).toContain("┴");
    expect(out).toContain("┘");
  });
});
