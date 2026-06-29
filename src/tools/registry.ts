// Tool registry: aggregates all built-in tools and exposes OpenAI schemas.

import type { Tool, ToolContext, ToolResult } from "./types.ts";
import { toOpenAiTool } from "./types.ts";
import { readFileTool } from "./read_file.ts";
import { writeFileTool } from "./write_file.ts";
import { editFileTool } from "./edit_file.ts";
import { bashTool } from "./bash.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { webFetchTool } from "./web_fetch.ts";
import { todoWriteTool } from "./todo.ts";
import { gitDiffTool } from "./git_diff.ts";

const BUILTIN_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  bashTool,
  globTool,
  grepTool,
  webFetchTool,
  todoWriteTool,
  gitDiffTool,
];

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = BUILTIN_TOOLS) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** OpenAI-compatible tool definitions sent to the model. */
  schemas() {
    return this.list().map(toOpenAiTool);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        content: `Tool '${name}' is not registered.`,
        error: "unknown_tool",
      };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        content: `Tool '${name}' threw: ${msg}`,
        error: "exception",
      };
    }
  }
}
