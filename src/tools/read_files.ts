// read_files tool — batch-read multiple files in a single tool call.
//
// Why this exists: the agent loop is sequential across iterations. Reading
// N files one-by-one costs N full API round-trips (one per read_file call
// the model emits in separate turns). This batch tool collapses those N
// reads into ONE tool call, cutting N-1 iterations of latency for the very
// common "read these files then propose a solution" workflow.
//
// The result is a single string with per-file sections, each carrying the
// same `<lineNo>: <content>` rendering as read_file so the model's existing
// line-reference habits keep working.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Tool, ToolResult } from "./types.ts";
import { lineNo, tag } from "../prompt/harness.ts";
import { readFileCache, touchCache, type CacheEntry } from "./read_file.ts";

const MAX_BYTES = 200_000; // per-file ceiling, matches read_file
const DEFAULT_LIMIT = 2000;
const MAX_FILES = 20; // cap batch size so one call can't blow the context budget

interface ReadSpec {
  filePath: string;
  offset: number;
  limit: number;
}

export const readFilesTool: Tool = {
  name: "read_files",
  description: [
    "Batch-read multiple files in one call. Prefer this over multiple read_file calls",
    "when you need 2+ files — it saves round-trips. Each file is returned in its own",
    "<file> section with line numbers (`<lineNo>: <content>`), identical to read_file.",
    "Pass an array of paths; optionally per-item `offset` (1-indexed) and `limit`.",
    "Binary/oversized/directory entries are reported per-file without aborting the batch.",
  ].join(" "),
  category: "fs-read",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        description: "List of absolute file paths to read. Pass at least 1, at most 20.",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_FILES,
      },
      offset: {
        type: "integer",
        description: `Default line to start from (1-indexed) for every file. Defaults to 1. Overrides only files that don't set their own offset.`,
        minimum: 1,
      },
      limit: {
        type: "integer",
        description: `Default max lines per file. Defaults to ${DEFAULT_LIMIT}. Per-item limit overrides this.`,
        minimum: 1,
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },

  async execute(args, ctx): Promise<ToolResult> {
    const rawPaths = args.paths;
    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      return { ok: false, content: "Missing or empty required parameter: paths (non-empty array of file paths).", error: "missing_arg" };
    }
    if (rawPaths.length > MAX_FILES) {
      return { ok: false, content: `Too many files in one batch: ${rawPaths.length} > ${MAX_FILES}. Split into smaller read_files calls.`, error: "too_many" };
    }

    const defaultOffset = Math.max(1, Number(args.offset ?? 1));
    const defaultLimit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(args.limit ?? DEFAULT_LIMIT)));

    // Normalize specs. Array items may be plain strings or {filePath, offset?, limit?}.
    const specs: ReadSpec[] = rawPaths.map((p) => {
      if (typeof p === "string") {
        return { filePath: p, offset: defaultOffset, limit: defaultLimit };
      }
      if (p && typeof p === "object") {
        const fp = String((p as Record<string, unknown>).filePath ?? "");
        return {
          filePath: fp,
          offset: Math.max(1, Number((p as Record<string, unknown>).offset ?? defaultOffset)),
          limit: Math.min(DEFAULT_LIMIT, Math.max(1, Number((p as Record<string, unknown>).limit ?? defaultLimit))),
        };
      }
      return { filePath: String(p), offset: defaultOffset, limit: defaultLimit };
    });

    // Read all files concurrently — disk IO is the only cost and it parallelizes well.
    const sections = await Promise.all(specs.map((s) => readOne(s, ctx.cwd)));

    const okCount = sections.filter((s) => s.ok).length;
    const totalShown = sections.reduce((n, s) => n + (s.ok ? s.shownLines : 0), 0);

    const body = sections.map((s) => s.block).join("\n\n");
    const summary = `\n\n(batch: ${okCount}/${specs.length} files read, ${totalShown} lines shown)`;

    return {
      ok: okCount > 0,
      content: body + summary,
      uiSummary: `read ${okCount}/${specs.length} files (${totalShown} lines)`,
    };
  },
};

interface ReadOutcome {
  ok: boolean;
  shownLines: number;
  block: string;
}

async function readOne(spec: ReadSpec, baseCwd: string): Promise<ReadOutcome> {
  const abs = path.isAbsolute(spec.filePath) ? spec.filePath : path.resolve(baseCwd, spec.filePath);

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failBlock(abs, `Cannot stat: ${msg}`, "stat_failed");
  }
  if (stat.isDirectory()) {
    return failBlock(abs, "Is a directory. Use the 'glob' tool to list its contents.", "is_directory");
  }
  if (stat.size > MAX_BYTES) {
    return failBlock(abs, `File is ${(stat.size / 1024).toFixed(1)}KB, exceeds the ${MAX_BYTES / 1000}KB read ceiling. Use read_file with offset/limit or grep to slice it.`, "too_large");
  }

  let content: string;
  const cached = readFileCache.get(abs);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    content = cached.content;
    touchCache(abs, cached);
  } else {
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return failBlock(abs, `Could not read as text: ${msg}. May be binary — describe its purpose instead of reading.`, "binary_or_unreadable");
    }
    const entry: CacheEntry = { mtimeMs: stat.mtimeMs, size: stat.size, content };
    touchCache(abs, entry);
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const startIdx = spec.offset - 1;
  const slice = lines.slice(startIdx, startIdx + spec.limit);
  const rendered = slice.map((line, i) => lineNo(spec.offset + i, line)).join("\n");

  const totalLines = lines.length;
  const shown = slice.length;
  const suffix = shown < totalLines
    ? `\n(showing lines ${spec.offset}-${spec.offset + shown - 1} of ${totalLines}; use offset to continue)`
    : "";

  return {
    ok: true,
    shownLines: shown,
    block: `${tag("file", { path: abs }, rendered)}${suffix}`,
  };
}

function failBlock(abs: string, message: string, error: string): ReadOutcome {
  return {
    ok: false,
    shownLines: 0,
    block: tag("file", { path: abs, error }, message),
  };
}

