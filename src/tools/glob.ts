// glob tool — fast file pattern matching using Bun.Glob.

import * as path from "node:path";
import type { Tool, ToolResult } from "./types.ts";
import { paint } from "../ui/theme.ts";

// Resolved lazily at first call; Bun ships Bun.Glob globally.
function getGlobCtor(): (new (pattern: string) => {
  scan: (opts: { cwd?: string; onlyFiles?: boolean; absolute?: boolean }) => AsyncIterable<string>;
}) | null {
  const bunGlob = (globalThis as { Bun?: { Glob?: unknown } }).Bun?.Glob;
  if (typeof bunGlob === "function") {
    return bunGlob as unknown as (new (pattern: string) => {
      scan: (opts: { cwd?: string; onlyFiles?: boolean; absolute?: boolean }) => AsyncIterable<string>;
    });
  }
  return null;
}

export const globTool: Tool = {
  name: "glob",
  description: [
    "Finds files matching one or more glob patterns (e.g. `**/*.ts`, `src/**/*.test.ts`).",
    "Returns matching file paths sorted alphabetically, capped at 500 results.",
    "Prefer glob over listing directories — glob is recursive and pattern-aware.",
  ].join(" "),
  category: "fs-read",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern(s). Use `,` to separate multiple." },
      path: { type: "string", description: "Base directory. Defaults to the current working directory." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    if (!pattern) {
      return { ok: false, content: "Missing required parameter: pattern.", error: "missing_arg" };
    }
    const base = args.path ? String(args.path) : process.cwd();
    const cwd = path.isAbsolute(base) ? base : path.resolve(process.cwd(), base);
    const patterns = pattern.split(",").map((p) => p.trim()).filter(Boolean);

    const all: string[] = [];
    const GlobCtor = getGlobCtor();

    if (GlobCtor) {
      for (const p of patterns) {
        try {
          const glob = new GlobCtor(p);
          for await (const m of glob.scan({ cwd, onlyFiles: true, absolute: false })) {
            all.push(m);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { ok: false, content: `Glob pattern '${p}' failed: ${msg}`, error: "pattern_error" };
        }
      }
    } else {
      // Fallback: a pure-JS recursive walk with brace + `*`/`**`/`?` support.
      // Bun.Glob is normally available; this keeps the tool correct when it
      // isn't (e.g. some bundlers/containers).
      for (const p of patterns) {
        for await (const m of manualGlob(p, cwd)) {
          all.push(m);
        }
      }
    }

    const unique = Array.from(new Set(all)).sort().slice(0, 500);
    const rendered = unique.length === 0
      ? "(no matches)"
      : unique.map((p) => `${paint.gray("•")} ${p}`).join("\n");
    return {
      ok: true,
      content: `Found ${unique.length} file${unique.length === 1 ? "" : "s"}.\n${rendered}`,
      uiSummary: `glob ${pattern} → ${unique.length} files`,
    };
  },
};

// ---- Pure-JS fallback matcher (brace + `*`/`**`/`?`) ----

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function properGlob(pattern: string): string {
  const segs = pattern.split("/");
  let out = "^";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === "**") {
      out += "(?:.*/)?";
      continue;
    }
    out += escapeRegex(seg.replace(/\*/g, "\u0000").replace(/\?/g, "\u0001"))
      .replace(/\u0000/g, "[^/]*")
      .replace(/\u0001/g, "[^/]");
    if (i < segs.length - 1) out += "/";
  }
  out += "$";
  return out;
}

/** Expand a single brace group (e.g. `*.{ts,tsx}` → [`*.ts`, `*.tsx`]). */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open);
  if (close < 0) return [pattern];
  const prefix = pattern.slice(0, open);
  const inner = pattern.slice(open + 1, close);
  const suffix = pattern.slice(close + 1);
  const alts = inner.split(",").map((a) => a.trim()).filter(Boolean);
  const out: string[] = [];
  for (const alt of alts) {
    out.push(...expandBraces(`${prefix}${alt}${suffix}`));
  }
  return out.length ? out : [pattern];
}

const MAX_FALLBACK_FILES = 50_000;

const fs = await import("node:fs/promises");

export async function* manualGlob(pattern: string, cwd: string): AsyncGenerator<string> {
  const res = expandBraces(pattern).map((p) => ({ p, re: new RegExp(properGlob(p)) }));
  const stack: string[] = [cwd];
  let count = 0;
  while (stack.length > 0 && count < MAX_FALLBACK_FILES) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (e.isFile()) {
        const rel = path.relative(cwd, full).split(path.sep).join("/");
        if (res.some(({ re }) => re.test(rel))) yield rel;
        count++;
        if (count >= MAX_FALLBACK_FILES) break;
      }
    }
  }
}
