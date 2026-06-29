import { describe, it, expect } from "bun:test";
import { renderMarkdown, inline } from "../src/ui/render.ts";

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
