// web_search tool — search the public web via DuckDuckGo's no-JS HTML endpoint.
// No API key required, no third-party SDK. Returns N results with title/url/snippet
// in a model-friendly envelope. Pairs naturally with web_fetch: search to find,
// then fetch the best hit for deeper reading.

import type { Tool, ToolResult } from "./types.ts";
import { errTag, tag } from "../prompt/harness.ts";
import { stripHtml } from "./web_fetch.ts";
import { truncateLine } from "../ui/width.ts";

const DEFAULT_MAX_RESULTS = 5;
const ABSOLUTE_MAX_RESULTS = 10;
const FETCH_TIMEOUT_MS = 30_000;

export const webSearchTool: Tool = {
  name: "web_search",
  description: [
    "Search the public web via DuckDuckGo (no API key required).",
    "Returns up to N result entries with title, url, and a short snippet.",
    "Use when you need fresh information beyond your training data — latest",
    "library versions, current docs, release notes, news, recent API behavior.",
    "Do NOT use for things you already know or can derive from local files;",
    "that wastes a network round-trip. For fetching a SPECIFIC known URL,",
    "prefer web_fetch. Recommended flow: web_search to discover, then",
    "web_fetch the best hit for deeper reading.",
  ].join(" "),
  category: "network",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query. Keep it short and specific; add version/year if you need fresh results.",
      },
      maxResults: {
        type: "number",
        description: `Maximum results to return (1..${ABSOLUTE_MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS}).`,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return { ok: false, content: errTag("web_search", "missing_arg", "Missing required parameter: query."), error: "missing_arg" };
    }
    const max = clampMaxResults(args.maxResults);

    try {
      const results = await searchDuckDuckGo(query, max);
      if (results.length === 0) {
        return {
          ok: true,
          content: tag("web_search", { query }, "(no results)"),
          uiSummary: `search "${truncate(query, 50)}" (0 results)`,
        };
      }
      const body = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");
      return {
        ok: true,
        content: tag("web_search", { query, count: results.length }, body),
        uiSummary: `search "${truncate(query, 50)}" (${results.length} results)`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: errTag("web_search", "search_failed", `web_search failed: ${msg}`), error: "search_failed" };
    }
  },
};

interface DDGResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchDuckDuckGo(query: string, max: number): Promise<DDGResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "deepseek-cli/0.3 (+https://github.com/charsdavy/deepseek-cli)",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`DuckDuckGo returned HTTP ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  return parseDuckDuckGoHtml(html, max);
}

/**
 * Parse DuckDuckGo's no-JS HTML results page.
 *
 * Each result is shaped like:
 *   <h2 class="result__title">
 *     <a class="result__a" href="//duckduckgo.com/l/?uddg=<encoded-real-url>&...">Title</a>
 *   </h2>
 *   <a class="result__snippet" href="...">Snippet text …</a>
 *
 * The `result__a` and `result__snippet` class names have been stable since
 * 2018; if DDG ever redesigns this surface the parser silently returns an
 * empty list and the tool surfaces a "(no results)" message rather than
 * crashing.
 */
export function parseDuckDuckGoHtml(html: string, max: number): DDGResult[] {
  const links: Array<{ url: string; title: string }> = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    const url = decodeDdgRedirect(href);
    const title = stripHtml(m[2]).trim();
    if (url && title) links.push({ url, title });
  }

  const snippets: string[] = [];
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = snippetRe.exec(html)) !== null) {
    const s = stripHtml(m[1]).trim();
    snippets.push(s);
  }

  const out: DDGResult[] = [];
  for (let i = 0; i < Math.min(max, links.length); i++) {
    out.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] ?? "",
    });
  }
  return out;
}

/** DDG wraps every result URL in a redirect: /l/?uddg=<encoded-real-url>&...
 *  Unwrap it back to the actual destination. Falls back to the raw href when
 *  it doesn't look like a DDG redirect (e.g. already a real URL). */
function decodeDdgRedirect(href: string): string {
  const m = href.match(/uddg=([^&]+)/);
  if (!m) {
    // Some hrefs come back as protocol-relative ("//example.com/..."), normalize.
    if (href.startsWith("//")) return `https:${href}`;
    return href.startsWith("http") ? href : "";
  }
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function truncate(s: string, n: number): string {
  return truncateLine(s, n);
}

function clampMaxResults(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_MAX_RESULTS;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(ABSOLUTE_MAX_RESULTS, Math.trunc(n)));
}
