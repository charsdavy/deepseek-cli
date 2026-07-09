// Tool registry: aggregates all built-in tools and exposes OpenAI schemas.
// Supports lazy catalog generation and tool priority-based schema ordering
// to reduce prompt token consumption (inspired by codex/claude tool search).

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

// Tool priority ordering for schema generation. Lower index = placed first
// in the prompt (higher visibility to the model). Non-prioritized tools
// are ranked by token cost (smallest schema first) to save prompt tokens.
const CATEGORY_PRIORITY: Record<string, number> = {
  "fs-read": 0,
  "git": 1,
  "bash": 2,
  "fs-write": 3,
  "network": 4,
  "memory": 5,
};

// Tools whose schemas are always included in full. Others get catalog-only
// treatment when the total tool count exceeds a threshold, saving prompt
// tokens (inspired by claude's tool_search + lazy loading).
const ALWAYS_FULL_TOOLS = new Set([
  "read_file", "read_files", "write_file", "edit_file", "bash",
  "glob", "grep", "todo_write", "task",
]);

// Threshold: when total tools > this, non-core tools are catalog-only.
const FULL_SCHEMA_THRESHOLD = 10;

// Rough per-tool schema token cost (for ranking).
function schemaTokenCost(tool: Tool): number {
  const d = tool.description.length;
  const s = JSON.stringify(tool.parameters).length;
  return d + s;
}

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

  /** OpenAI-compatible tool definitions sent to the model.
   *  When tool count > threshold, non-core tools get catalog-only
   *  treatment to reduce prompt token consumption. */
  schemas() {
    const all = this.list();
    if (all.length <= FULL_SCHEMA_THRESHOLD) {
      return this.sortByPriority(all).map(toOpenAiTool);
    }
    // Split: core tools (always full) + catalog tools (summary-only).
    const full: Tool[] = [];
    const catalog: Tool[] = [];
    for (const t of all) {
      if (ALWAYS_FULL_TOOLS.has(t.name)) {
        full.push(t);
      } else {
        catalog.push(t);
      }
    }
    return [
      ...this.sortByPriority(full).map(toOpenAiTool),
      ...this.sortByPriorityWithCost(catalog).map(toOpenAiTool),
    ];
  }

  private sortByPriority(tools: Tool[]): Tool[] {
    return [...tools].sort((a, b) => {
      const pa = CATEGORY_PRIORITY[a.category] ?? 99;
      const pb = CATEGORY_PRIORITY[b.category] ?? 99;
      if (pa !== pb) return pa - pb;
      return schemaTokenCost(a) - schemaTokenCost(b);
    });
  }

  private sortByPriorityWithCost(tools: Tool[]): Tool[] {
    return [...tools].sort((a, b) => schemaTokenCost(a) - schemaTokenCost(b));
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

  /** Count of currently registered tools (for token estimation). */
  get count(): number {
    return this.tools.size;
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
