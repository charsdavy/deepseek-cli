// write_file tool — write/overwrite a file. Requires approval.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Tool, ToolResult } from "./types.ts";

export const writeFileTool: Tool = {
  name: "write_file",
  description: [
    "Writes content to a file, creating the file if it does not exist and overwriting it if it does.",
    "You MUST read the existing file first before overwriting it (use read_file) so the user can verify your edits visually.",
    "Prefer edit_file for targeted changes; use write_file only for brand-new files or complete rewrites.",
    "ALWAYS prefer editing existing files in the codebase. NEVER write new files unless clearly required.",
  ].join(" "),
  category: "fs-write",
  isDangerous: true,
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path of the file to write." },
      content: { type: "string", description: "The content to write to the file." },
    },
    required: ["filePath", "content"],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const filePath = String(args.filePath ?? "");
    const content = String(args.content ?? "");
    if (!filePath) {
      return { ok: false, content: "Missing required parameter: filePath.", error: "missing_arg" };
    }
    if (args.content === undefined || args.content === null) {
      return { ok: false, content: "Missing required parameter: content.", error: "missing_arg" };
    }
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf-8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `Failed to write '${abs}': ${msg}`, error: "io_error" };
    }

    const action = existsSync(abs) ? "overwrote" : "created";
    return {
      ok: true,
      content: `Successfully ${action} ${abs} (${Buffer.byteLength(content, "utf-8")} bytes).`,
      uiSummary: `${action} ${abs}`,
    };
  },
};
