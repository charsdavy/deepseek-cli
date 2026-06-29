// grep tool — search file contents with regex. Uses ripgrep when available
// for speed; falls back to a Node-based recursive matcher.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolResult } from "./types.ts";
import { paint } from "../ui/theme.ts";

const execFileAsync = promisify(execFile);

export const grepTool: Tool = {
  name: "grep",
  description: [
    "Searches file contents for a regular expression. Returns matching files/line numbers.",
    "Use `include` (e.g. `*.ts`) to restrict the search to a file pattern.",
    "Prefer this over reading every file when looking for specific keywords/classes/identifiers.",
  ].join(" "),
  category: "fs-read",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "Directory or file to search. Defaults to cwd." },
      include: { type: "string", description: "Optional glob filter for files (e.g. `*.ts`)." },
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
    const include = args.include ? String(args.include) : undefined;

    try {
      const rgAvailable = await hasRg();
      if (rgAvailable) {
        const result = await runRg(pattern, cwd, include);
        if (result) return result;
      }
    } catch {
      // Fall back to in-process search
    }
    return await runNodeGrep(pattern, cwd, include);
  },
};

async function hasRg(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile("rg", ["--version"], (err) => resolve(!err));
  });
}

async function runRg(pattern: string, cwd: string, include?: string): Promise<ToolResult | null> {
  const args = [
    "--color=never",
    "--line-number",
    "--no-heading",
    "--max-count=200",
    "-e",
    pattern,
    include ? `--glob=${include}` : ".",
  ];
  try {
    const { stdout } = await execFileAsync("rg", args, { cwd, maxBuffer: 5_000_000 });
    const lines = stdout.split("\n").filter(Boolean).slice(0, 200);
    return {
      ok: true,
      content: lines.length === 0
        ? "(no matches)"
        : lines.map((l) => paint.gray("•") + " " + l).join("\n"),
      uiSummary: `grep ${pattern} (${lines.length} matches)`,
    };
  } catch (e: unknown) {
    const err = e as { code?: number; stderr?: string };
    if (err.code === 1) {
      return { ok: true, content: "(no matches)", uiSummary: `grep ${pattern} (0 matches)` };
    }
    return null;
  }
}

async function runNodeGrep(pattern: string, cwd: string, include?: string): Promise<ToolResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, content: `Invalid regex: ${msg}`, error: "bad_regex" };
  }
  const matches: string[] = [];
  let scanned = 0;
  const MAX_FILES = 1000;

  async function walk(dir: string): Promise<void> {
    if (scanned >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        if (scanned >= MAX_FILES) return;
        if (include && !matchGlobSimple(ent.name, include)) continue;
        scanned++;
        try {
          const txt = await fs.readFile(full, "utf-8");
          const lines = txt.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              const rel = path.relative(cwd, full);
              matches.push(`${rel}:${i + 1}:${lines[i].slice(0, 200)}`);
              if (matches.length >= 200) return;
            }
          }
        } catch {
          /* ignore unreadable */
        }
      }
    }
  }

  if (existsSync(cwd)) {
    const stat = await fs.stat(cwd).catch(() => null);
    if (stat?.isFile()) {
      try {
        const txt = await fs.readFile(cwd, "utf-8");
        const lines = txt.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push(`${path.basename(cwd)}:${i + 1}:${lines[i].slice(0, 200)}`);
          }
        }
      } catch {
        /* ignore */
      }
    } else {
      await walk(cwd);
    }
  }

  const rendered = matches.length === 0
    ? "(no matches)"
    : matches.map((l) => `${paint.gray("•")} ${l}`).join("\n");
  return {
    ok: true,
    content: `Found ${matches.length} match${matches.length === 1 ? "" : "es"}.\n${rendered}`,
    uiSummary: `grep ${pattern} (${matches.length} matches)`,
  };
}

function matchGlobSimple(name: string, pat: string): boolean {
  // Convert simple glob (e.g. *.ts) to regex
  const re = new RegExp("^" + pat.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  return re.test(name);
}
