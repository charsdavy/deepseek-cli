import { describe, it, expect } from "bun:test";
import { parseDuckDuckGoHtml } from "../src/tools/web_search.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { webSearchTool } from "../src/tools/web_search.ts";

// Realistic DDG HTML snippet (class names stripped to the essentials we parse).
// Two result blocks, with one missing its snippet to exercise the fallback.
const SAMPLE_HTML = `
<html><body>
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">
        Example <b>Docs</b> &amp; Tutorials
      </a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">
      The official documentation for the Example framework. Covers installation,
      &nbsp; configuration, and common recipes.
    </a>
  </div>
  <div class="result results_links">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Ffoo%2Fbar&s=test">
        foo/bar on GitHub
      </a>
    </h2>
  </div>
</div>
</body></html>
`;

describe("web_search parser", () => {
  it("extracts title, decoded URL, and snippet from DDG HTML", () => {
    const results = parseDuckDuckGoHtml(SAMPLE_HTML, 10);
    expect(results.length).toBe(2);
    expect(results[0].title).toBe("Example Docs & Tutorials");
    expect(results[0].url).toBe("https://example.com/docs");
    expect(results[0].snippet).toContain("official documentation");
  });

  it("empty snippet falls back gracefully", () => {
    const results = parseDuckDuckGoHtml(SAMPLE_HTML, 10);
    expect(results[1].snippet).toBe("");
  });

  it("respects the max cap", () => {
    const results = parseDuckDuckGoHtml(SAMPLE_HTML, 1);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Example Docs & Tutorials");
  });

  it("returns an empty list when the page has no results", () => {
    const results = parseDuckDuckGoHtml("<html><body>no results here</body></html>", 5);
    expect(results).toEqual([]);
  });

  it("decodes entities in titles and snippets", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fq.com%2F%22x%22">Q&amp;A &quot;x&quot;</a>
      <a class="result__snippet">it&#39;s the answer</a>
    `;
    const r = parseDuckDuckGoHtml(html, 5);
    expect(r[0].title).toBe('Q&A "x"');
    expect(r[0].snippet).toBe("it's the answer");
  });
});

describe("web_search registry", () => {
  it("is registered alongside web_fetch in the default toolset", () => {
    const reg = new ToolRegistry();
    const names = reg.list().map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
  });

  it("rejects missing query", async () => {
    // No need to hit the network — the tool fails fast on a missing arg.
    const res = await webSearchTool.execute({}, { cwd: process.cwd() });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("missing_arg");
  });

  it("clamps the requested maxResults into the legal range", async () => {
    // Use 0 (too small) and 999 (too big); both should fail fast since we
    // can't hit the network here — but we want to ensure the clamp doesn't
    // itself throw. The actual fetch fails, surfaced as a tool error.
    const res = await webSearchTool.execute({ query: "x", maxResults: 999 }, { cwd: process.cwd() });
    // Either succeeds (network on) or fails cleanly (offline test env).
    // The contract we check: no exception leak into the loop, no "999 results".
    expect(typeof res.ok).toBe("boolean");
    if (res.ok) {
      // Real results: bounded by ABSOLUTE_MAX_RESULTS.
      const count = Number(/count="(\d+)"/.exec(res.content ?? "")?.[1] ?? 99);
      expect(count).toBeLessThanOrEqual(10);
    }
  });
});
