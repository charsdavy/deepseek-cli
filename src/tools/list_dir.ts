// list_dir tool — single-level directory listing with type indicators.
//
// Gives the model a cheap structural view of a folder (files + subdirs) so it
// can orient itself without shelling out to `ls` or running a glob. Read-only;
// respects the ToolContext cwd. Not dangerous.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Tool, ToolResult } from "./types.ts";

const MAX_ENTRIES = 1000;

export const listDirTool: Tool = {
  name: "list_dir",
  description: [
    "List the immediate contents of a directory. Read-only.",
    "Directory entries are suffixed with `/` so the model can orient itself",
    "without shelling out to `ls`. Prefer `glob` for pattern matching.",
  ].join(" "),
  category: "fs-read",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list. Defaults to the current working directory.",
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx): Promise<ToolResult> {
    const target = args.path ? String(args.path) : ctx.cwd;
    const resolved = path.isAbsolute(target) ? target : path.resolve(ctx.cwd, target);

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(resolved, { withFileTypes: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as NodeJS.ErrnoException)?.code;
      return {
        ok: false,
        content: `Cannot list ${resolved}: ${msg}`,
        error: code === "ENOTDIR" ? "not_a_directory" : (code ?? "stat_failed"),
      };
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    const capped = entries.slice(0, MAX_ENTRIES);
    const rows = capped.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    const header = `${resolved} (${entries.length} entries${entries.length > MAX_ENTRIES ? `, showing first ${MAX_ENTRIES}` : ""})`;
    const body = rows.length > 0 ? rows.join("\n") : "(empty directory)";
    return {
      ok: true,
      content: `${header}\n${body}`,
      uiSummary: `list_dir: ${resolved.split(path.sep).pop()} · ${entries.length} entries`,
    };
  },
};
