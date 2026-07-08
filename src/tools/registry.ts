// Tool registry: aggregates all built-in tools and exposes OpenAI schemas.

import type { Tool, ToolContext, ToolResult } from "./types.ts";
import { toOpenAiTool } from "./types.ts";
import { log } from "../log/logger.ts";
import { readFileTool } from "./read_file.ts";
import { readFilesTool } from "./read_files.ts";
import { writeFileTool } from "./write_file.ts";
import { editFileTool } from "./edit_file.ts";
import { bashTool } from "./bash.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { webFetchTool } from "./web_fetch.ts";
import { webSearchTool } from "./web_search.ts";
import { todoWriteTool } from "./todo.ts";
import { gitDiffTool } from "./git_diff.ts";
import { gitStatusTool } from "./git_status.ts";
import { listDirTool } from "./list_dir.ts";
import { taskTool } from "./task.ts";

const BUILTIN_TOOLS: Tool[] = [
  readFileTool,
  readFilesTool,
  writeFileTool,
  editFileTool,
  bashTool,
  globTool,
  grepTool,
  webFetchTool,
  webSearchTool,
  todoWriteTool,
  gitDiffTool,
  gitStatusTool,
  listDirTool,
  taskTool,
];

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = BUILTIN_TOOLS) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** Remove a tool by name (used to toggle MCP servers off at runtime). */
  unregister(name: string): boolean {
    return this.tools.delete(name);
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

  /**
   * Search tools by keyword. Returns matching tools. Useful for lazy tool
   * loading when a large number of MCP tools are registered — the model can
   * discover tools on demand instead of having all definitions in the prompt.
   */
  search(query: string): Tool[] {
    const lower = query.toLowerCase();
    return this.list().filter((t) => {
      const hay = `${t.name} ${t.description} ${t.category}`.toLowerCase();
      return hay.includes(lower);
    });
  }

  /** Generate a compact tool catalog for the prompt (names + summaries only). */
  catalog(): { name: string; description: string; category: string }[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description.slice(0, 120),
      category: t.category,
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult & { ms: number }> {
    const tool = this.tools.get(name);
    if (!tool) {
      log.warn("tool unknown", { name });
      return {
        ok: false,
        content: `Tool '${name}' is not registered.`,
        error: "unknown_tool",
        ms: 0,
      };
    }
    const start = performance.now();
    let result: ToolResult;
    try {
      result = await tool.execute(args, ctx);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("tool exception", { name, error: msg, ms: Math.round(performance.now() - start) });
      return {
        ok: false,
        content: `Tool '${name}' threw: ${msg}`,
        error: "exception",
        ms: Math.round(performance.now() - start),
      };
    }
    const ms = Math.round(performance.now() - start);
    log.info("tool", {
      name,
      ok: result.ok,
      error: result.error,
      contentLen: (result.content ?? "").length,
      summary: result.uiSummary,
      ms,
    });
    return { ...result, ms };
  }
}
