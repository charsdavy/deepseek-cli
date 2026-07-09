// web_fetch tool — fetch a URL and return its text content.
// Strips HTML tags heuristically to keep the content token-friendly.

import type { Tool, ToolResult } from "./types.ts";
import { errTag, tag, trunc } from "../prompt/harness.ts";

const MAX_BYTES = 64_000;
const MAX_BODY_BYTES = 1_000_000;

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  // IPv4, including decimal/hex/octal encodings that resolve to private ranges.
  let ip = h;
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isFinite(n)) ip = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
  }
  if (/^0x[0-9a-f]+$/i.test(h)) {
    const n = parseInt(h, 16);
    if (Number.isFinite(n)) ip = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
  }
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224) {
      return true;
    }
  }
  return false;
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    try { return await res.text(); } catch { return ""; }
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let received = 0;
  let text = "";
  let done = false;
  while (received < maxBytes && !done) {
    const r = await reader.read();
    done = r.done;
    if (r.value) {
      received += r.value.byteLength;
      text += decoder.decode(r.value, { stream: true });
    }
  }
  try { await reader.cancel(); } catch {}
  text += decoder.decode();
  return text;
}

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
      return { ok: false, content: errTag("web", "missing_arg", "Missing required parameter: url."), error: "missing_arg" };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, content: errTag("web", "bad_scheme", "URL must start with http:// or https://"), error: "bad_scheme" };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, content: errTag("web", "bad_url", "Invalid URL."), error: "bad_url" };
    }
    if (isPrivateHost(parsed.hostname)) {
      return { ok: false, content: errTag("web", "blocked", "Refusing to fetch private/localhost addresses (SSRF protection)."), error: "blocked" };
    }
    const format = (String(args.format ?? "text") as "text" | "markdown" | "html");

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "deepseek-cli/0.3 (+https://github.com/charsdavy/deepseek-cli)" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        return { ok: false, content: errTag("web", "http_error", `HTTP ${res.status} ${res.statusText}`), error: "http_error" };
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const body = await readBodyCapped(res, MAX_BODY_BYTES);

      let out: string;
      if (format === "html" || !contentType.includes("html")) {
        out = body;
      } else if (format === "markdown") {
        out = htmlToMarkdown(body);
      } else {
        out = stripHtml(body);
      }
      const originalLen = out.length;
      const sliced = out.slice(0, MAX_BYTES);
      const note = originalLen > MAX_BYTES ? trunc(originalLen - MAX_BYTES, "chars") : "";
      return {
        ok: true,
        content: tag("web", { url, title: extractTitle(body) || url, format }, `${sliced}${note}`),
        uiSummary: `fetch ${url} (${sliced.length} chars)`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: errTag("web", "fetch_failed", `Failed to fetch: ${msg}`), error: "fetch_failed" };
    }
  },
};

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : "";
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
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
