// task tool — launch a sub-agent for a self-contained subtask.
//
// Mirrors Claude Code's Task tool: the model delegates independent pieces of
// work to nested agent loops that have their own context window and tool
// access. Because the parent agent loop already runs tool calls in parallel,
// issuing multiple task calls in one turn dispatches several sub-agents at
// once. The sub-agent runs silently (its stdout is suppressed) and only its
// final answer is returned as the tool result.

import type { Tool, ToolResult } from "./types.ts";

export const taskTool: Tool = {
  name: "task",
  description: [
    "Launch a focused sub-agent to handle a self-contained subtask and return its final answer.",
    "Use for work that benefits from its own context (e.g. \"explore the auth module and list entry points\").",
    "Independent subtasks issued together run in parallel. The sub-agent has tool access but a smaller iteration budget.",
  ].join(" "),
  category: "memory",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short label for the subtask (shown in progress)." },
      prompt: { type: "string", description: "The full instruction for the sub-agent." },
    },
    required: ["prompt"],
    additionalProperties: false,
  },

  async execute(args, ctx): Promise<ToolResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt) {
      return { ok: false, content: "Missing required parameter: prompt.", error: "missing_arg" };
    }
    if (!ctx.spawnAgent) {
      return { ok: false, content: "Sub-agent spawning is unavailable in this context.", error: "no_spawner" };
    }
    const description = args.description ? String(args.description) : prompt.slice(0, 60);
    ctx.onProgress?.(`sub-agent: ${description}`);
    try {
      const result = await ctx.spawnAgent(prompt, { description, cwd: ctx.cwd });
      return {
        ok: true,
        content: result || "(sub-agent returned no text)",
        uiSummary: `sub-agent: ${truncate(description, 50)}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `Sub-agent failed: ${msg}`, error: "subagent_error" };
    }
  },
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
