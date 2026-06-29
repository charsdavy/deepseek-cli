// web_fetch tool — fetch a URL and return its text content.
// Strips HTML tags heuristically to keep the content token-friendly.

import type { Tool, ToolResult } from "./types.ts";

const MAX_BYTES = 64_000;

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: [
    "Fetches content from an HTTP(S) URL and returns the page body as text.",
    "Use for retrieving documentation pages, raw files, or API responses.",
    "Output is trimmed to a reasonable token budget; for long pages consider grep'ing afterwards.",
  ].join(" "),
  category: "network",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Fully-qualified URL to fetch (http/https only)." },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description: "Output format. 'text' (default) strips HTML. 'markdown' keeps readable structure. 'html' returns raw.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const url = String(args.url ?? "");
    if (!url) {
      return { ok: false, content: "Missing required parameter: url.", error: "missing_arg" };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, content: "URL must start with http:// or https://", error: "bad_scheme" };
    }
    const format = (String(args.format ?? "text") as "text" | "markdown" | "html");

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "deepseek-cli/0.3 (+https://github.com/charsdavy/deepseek-cli)" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        return { ok: false, content: `HTTP ${res.status} ${res.statusText} for ${url}`, error: "http_error" };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();

      let out: string;
      if (format === "html" || !contentType.includes("html")) {
        out = body;
      } else if (format === "markdown") {
        out = htmlToMarkdown(body);
      } else {
        out = stripHtml(body);
      }
      out = out.slice(0, MAX_BYTES);
      return {
        ok: true,
        content: `<web title="${extractTitle(body) || url}" url="${url}">\n${out}\n</web>`,
        uiSummary: `fetch ${url} (${out.length} chars)`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `Failed to fetch ${url}: ${msg}`, error: "fetch_failed" };
    }
  },
};

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : "";
}

function stripHtml(html: string): string {
  // Remove scripts/styles, then tags, collapse whitespace
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<h1[^>]*>/gi, "\n# ")
    .replace(/<\/h1>/gi, "\n")
    .replace(/<h2[^>]*>/gi, "\n## ")
    .replace(/<\/h2>/gi, "\n")
    .replace(/<h3[^>]*>/gi, "\n### ")
    .replace(/<\/h3>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<p[^>]*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
