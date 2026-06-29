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
      // Fallback: shell `find` with the pattern's tail only (since `find -name`
      // doesn't support `**`). Strip any leading `**/` and use the trailing
      // segment as the filename name-pattern. Crude but works for simple cases.
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      for (const p of patterns) {
        const namePart = p.replace(/^\*\*\//, "").replace(/^[./]+/, "") || "*";
        try {
          const { stdout } = await exec("find", [cwd, "-type", "f", "-name", namePart], { maxBuffer: 5_000_000 });
          for (const line of stdout.split("\n")) {
            if (line) all.push(path.relative(cwd, line));
          }
        } catch {
          /* ignore find errors */
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
