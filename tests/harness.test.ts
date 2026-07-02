import { describe, it, expect } from "bun:test";
import {
  attrStr,
  bullet,
  cap,
  escapeAttr,
  errTag,
  lineNo,
  tag,
  trunc,
} from "../src/prompt/harness.ts";

describe("harness: escapeAttr", () => {
  it("escapes & < > and double quotes for attribute values", () => {
    expect(escapeAttr(`a"b<c>&d`)).toBe("a&quot;b&lt;c&gt;&amp;d");
  });
});

describe("harness: attrStr", () => {
  it("renders key=escaped pairs with a leading space, skipping null/undefined", () => {
    expect(attrStr({ a: "x", b: 3, c: undefined, d: null })).toBe(' a="x" b="3"');
  });
  it("returns empty string when no usable attrs", () => {
    expect(attrStr({})).toBe("");
    expect(attrStr({ c: undefined })).toBe("");
  });
  it("escapes attribute values", () => {
    expect(attrStr({ path: '/a"b' })).toBe(' path="/a&quot;b"');
  });
});

describe("harness: tag", () => {
  it("wraps a non-empty body in open/close tags", () => {
    expect(tag("file", { path: "/x" }, "body")).toBe('<file path="/x">\nbody\n</file>');
  });
  it("collapses an empty body to a self-closing tag", () => {
    expect(tag("dir", { path: "/x" }, "")).toBe('<dir path="/x"/>');
  });
  it("supports multi-word snake_case names", () => {
    expect(tag("web_search", { query: "q" }, "r")).toBe('<web_search query="q">\nr\n</web_search>');
  });
});

describe("harness: errTag", () => {
  it("produces a tag carrying an error attribute", () => {
    expect(errTag("edit", "missing_arg", "need filePath")).toBe(
      '<edit error="missing_arg">\nneed filePath\n</edit>',
    );
  });
  it("self-closes when the message is empty", () => {
    expect(errTag("write", "io_error", "")).toBe('<write error="io_error"/>');
  });
});

describe("harness: trunc / cap", () => {
  it("trunc produces the standard suffix with the given unit", () => {
    expect(trunc(42, "chars")).toBe("\n…(truncated, 42 more chars omitted)");
  });
  it("defaults the unit to chars", () => {
    expect(trunc(5)).toBe("\n…(truncated, 5 more chars omitted)");
  });
  it("cap leaves short strings untouched", () => {
    expect(cap("abc", 10)).toBe("abc");
  });
  it("cap head-truncates and appends a note", () => {
    const out = cap("0123456789", 5);
    expect(out.startsWith("01234")).toBe(true);
    expect(out).toContain("truncated");
    expect(out).toContain("5 more chars");
  });
});

describe("harness: lineNo / bullet", () => {
  it("lineNo renders a 6-char-padded prefix", () => {
    expect(lineNo(1, "hi")).toBe("     1: hi");
    expect(lineNo(1000, "x")).toBe("  1000: x");
  });
  it("lineNo truncates very long lines with an ellipsis", () => {
    const long = "a".repeat(2000);
    const out = lineNo(1, long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith("…")).toBe(true);
  });
  it("lineNo is plain text (no ANSI control codes)", () => {
    expect(lineNo(1, "hi")).not.toMatch(/\x1b\[/);
  });
  it("bullet prefixes text with a plain •", () => {
    expect(bullet("a.ts")).toBe("• a.ts");
    expect(bullet("a.ts")).not.toMatch(/\x1b\[/);
  });
});
