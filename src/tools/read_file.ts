// read_file tool — read a file from the local filesystem, with optional
// line offset and limit. Mirrors the behavior of Claude Code's Read tool.
//
// mtime+size LRU cache: production logs show the model issues read_file for
// the SAME file across many turns (observed: PersistenceController.swift was
// read 5x across 5 separate loops, several other Swift files read 3-4x).
// Every repeated read re-stat + re-readFile + re-stream the entire file
// content as a tool result back into messages, costing both disk I/O and
// API prompt tokens for content that hasn't changed. The cache keys on
// absPath + mtimeMs + size so an unchanged file always hits the cache; any
// write to the file (mtimeMs moves) invalidates it.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Tool, ToolResult } from "./types.ts";
import { lineNo, tag } from "../prompt/harness.ts";

const MAX_BYTES = 200_000; // ~200KB hard ceiling per read
const DEFAULT_LIMIT = 2000;
const CACHE_MAX_ENTRIES = 32;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  content: string;
}

const readFileCache = new Map<string, CacheEntry>();

/** Track last-access order for FIFO eviction. Map preserves insertion order
 *  in JS, so re-inserting on access via delete+set refreshes recency. */
function touchCache(key: string, entry: CacheEntry): void {
  readFileCache.delete(key);
  readFileCache.set(key, entry);
  if (readFileCache.size > CACHE_MAX_ENTRIES) {
    // evict oldest entry (first key in insertion order)
    const oldest = readFileCache.keys().next().value;
    if (typeof oldest === "string") readFileCache.delete(oldest);
  }
}

export const readFileTool: Tool = {
  name: "read_file",
  description: [
    "Reads a file from the local filesystem. Use absolute paths whenever possible.",
    "Returns file content prefixed with line numbers (`<lineNo>: <content>`).",
    "Use `offset` (1-indexed) and `limit` (max lines) to read slices of large files.",
    "Avoid tiny repeated slices; prefer a larger window when context is needed.",
    "Images and binary files are detected and reported as such.",
  ].join(" "),
  category: "fs-read",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path to the file to read." },
      offset: {
        type: "integer",
        description: "Line number to start reading from (1-indexed). Defaults to 1.",
        minimum: 1,
      },
      limit: {
        type: "integer",
        description: `Maximum number of lines to read. Defaults to ${DEFAULT_LIMIT}.`,
        minimum: 1,
      },
    },
    required: ["filePath"],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const filePath = String(args.filePath ?? "");
    if (!filePath) {
      return { ok: false, content: "Missing required parameter: filePath.", error: "missing_arg" };
    }
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(args.limit ?? DEFAULT_LIMIT)));

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `Cannot stat '${abs}': ${msg}`, error: "stat_failed" };
    }
    if (stat.isDirectory()) {
      return {
        ok: false,
        content: `'${abs}' is a directory. Use the 'glob' tool to list its contents.`,
        error: "is_directory",
      };
    }
    if (stat.size > MAX_BYTES) {
      return {
        ok: false,
        content: `File is ${(stat.size / 1024).toFixed(1)}KB, exceeds the ${MAX_BYTES / 1000}KB read ceiling. Use 'offset'/'limit' or 'grep' to slice it.`,
        error: "too_large",
      };
    }

    // Cache hit on (path, mtimeMs, size) → skip disk read entirely. This
    // is the hot path for cross-turn re-reads of unchanged files; otherwise
    // every repeated read_file call re-reads the file and re-streams its
    // full content into messages, bloating the prompt token budget.
    const cached = readFileCache.get(abs);
    let content: string;
    let fromCache = false;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      content = cached.content;
      fromCache = true;
      touchCache(abs, cached);
    } else {
      try {
        content = await fs.readFile(abs, "utf-8");
      } catch (e) {
        // Could be a non-UTF8 / binary file
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          content: `Could not read '${abs}' as text: ${msg}. May be binary — describe its purpose instead of reading.`,
          error: "binary_or_unreadable",
        };
      }
      // Populate cache so the next read of the same unchanged file skips disk.
      const entry: CacheEntry = { mtimeMs: stat.mtimeMs, size: stat.size, content };
      touchCache(abs, entry);
    }

    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const startIdx = offset - 1;
    const slice = lines.slice(startIdx, startIdx + limit);
    const rendered = slice.map((line, i) => lineNo(offset + i, line)).join("\n");

    const totalLines = lines.length;
    const shown = slice.length;
    const suffix = shown < totalLines
      ? `\n\n(showing lines ${offset}-${offset + shown - 1} of ${totalLines}; use offset to continue)`
      : "";

    return {
      ok: true,
      content: `${tag("file", { path: abs }, rendered)}${suffix}`,
      uiSummary: `read ${abs} (${shown}/${totalLines} lines${fromCache ? ", cached" : ""})`,
    };
  },
};

