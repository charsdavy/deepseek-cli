// read_file tool — read a file from the local filesystem, with optional
// line offset and limit. Mirrors the behavior of Claude Code's Read tool.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Tool, ToolResult } from "./types.ts";
import { lineNo, tag } from "../prompt/harness.ts";

const MAX_BYTES = 200_000; // ~200KB hard ceiling per read
const DEFAULT_LIMIT = 2000;

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

    let content: string;
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
      uiSummary: `read ${abs} (${shown}/${totalLines} lines)`,
    };
  },
};

