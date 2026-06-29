// edit_file tool — perform exact string replacement within a file.
// Matches Claude Code's Edit semantics: error if oldString not found,
// error if multiple matches (unless replaceAll is set).

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Tool, ToolResult } from "./types.ts";

export const editFileTool: Tool = {
  name: "edit_file",
  description: [
    "Performs an exact string replacement in an existing file.",
    "Provide enough surrounding context to make `oldString` unique within the file. If `oldString` matches multiple locations, the call errors unless `replaceAll` is true.",
    "You MUST read the file with read_file before editing it.",
    "Never edit with a guess — always have the exact current content.",
  ].join(" "),
  category: "fs-write",
  isDangerous: true,
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path of the file to edit." },
      oldString: { type: "string", description: "The exact text to be replaced." },
      newString: { type: "string", description: "The text that replaces oldString." },
      replaceAll: {
        type: "boolean",
        description: "When true, replaces every occurrence of oldString in the file.",
      },
    },
    required: ["filePath", "oldString", "newString"],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const filePath = String(args.filePath ?? "");
    const oldStr = String(args.oldString ?? "");
    const newStr = String(args.newString ?? "");
    const replaceAll = args.replaceAll === true;

    if (!filePath) {
      return { ok: false, content: "Missing required parameter: filePath.", error: "missing_arg" };
    }
    if (oldStr === "") {
      return { ok: false, content: "oldString must be non-empty.", error: "missing_arg" };
    }
    if (oldStr === newStr) {
      return { ok: false, content: "oldString and newString are identical; nothing to do.", error: "noop" };
    }

    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

    let content: string;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `Cannot read '${abs}': ${msg}`, error: "read_failed" };
    }

    if (!content.includes(oldStr)) {
      return {
        ok: false,
        content: `oldString not found in ${abs}. Re-check the file content (it may have changed) and ensure your oldString matches exactly, including whitespace.`,
        error: "old_not_found",
      };
    }

    const occurrences = countOccurrences(content, oldStr);
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        content: `Found ${occurrences} matches for oldString in ${abs}. Provide more surrounding context to make oldString unique, or set replaceAll=true.`,
        error: "multiple_matches",
      };
    }

    let newContent: string;
    if (replaceAll) {
      newContent = content.split(oldStr).join(newStr);
    } else {
      // Replace first occurrence only
      const idx = content.indexOf(oldStr);
      newContent = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    }

    try {
      await fs.writeFile(abs, newContent, "utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `Failed to write '${abs}': ${msg}`, error: "io_error" };
    }

    const diffLines = unidiff(content, newContent);
    return {
      ok: true,
      content: `Edited ${abs} (${occurrences} replacement${occurrences > 1 ? "s" : ""}).\n\n${diffLines}`,
      uiSummary: `edited ${abs}`,
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

function unidiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const max = Math.max(a.length, b.length);
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    const al = a[i];
    const bl = b[i];
    if (al === bl) continue;
    if (al !== undefined) lines.push(`- ${al}`);
    if (bl !== undefined) lines.push(`+ ${bl}`);
  }
  return lines.slice(0, 80).join("\n");
}
