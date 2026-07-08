// task tool — launch a sub-agent for a self-contained subtask.
//
// Mirrors Claude Code's Task tool: the model delegates independent pieces of
// work to nested agent loops that have their own context window and tool
// access. Because the parent agent loop already runs tool calls in parallel,
// issuing multiple task calls in one turn dispatches several sub-agents at
// once. The sub-agent runs silently (its stdout is suppressed) and only its
// final answer is returned as the tool result.
//
// Agent types:
//   explore — read-only codebase search (grep, glob, read_file, list_dir only)
//   general — full tool access for complex multi-step tasks
//   plan    — read-only architecture design and planning
//   fork    — inherits parent context for branching exploration

import type { Tool, ToolResult } from "./types.ts";
import { errTag, tag } from "../prompt/harness.ts";

export const AGENT_TYPES = ["explore", "general", "plan", "fork"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const taskTool: Tool = {
  name: "task",
  description: [
    "Launch a focused sub-agent to handle a self-contained subtask and return its final answer.",
    "Specify subagent_type: 'explore' for read-only codebase search, 'general' for",
    "complex multi-step tasks with full tool access, 'plan' for architecture design.",
    "Use for work that benefits from its own context (e.g. \"explore the auth module and list entry points\").",
    "Deploy multiple explore agents in parallel to cover different angles of a research question.",
    "Independent subtasks issued together run in parallel. The sub-agent has tool access but a smaller iteration budget.",
  ].join(" "),
  category: "memory",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      subagent_type: {
        type: "string",
        enum: AGENT_TYPES,
        description:
          "Agent type: 'explore' (read-only search — grep/glob/read), " +
          "'general' (full tools for complex work), " +
          "'plan' (architecture design, read-only). Defaults to 'general'.",
      },
      description: { type: "string", description: "Short label for the subtask (shown in progress)." },
      prompt: { type: "string", description: "The full instruction for the sub-agent." },
    },
    required: ["prompt"],
    additionalProperties: false,
  },

  async execute(args, ctx): Promise<ToolResult> {
    const prompt = String(args.prompt ?? "");
    if (!prompt) {
      return {
        ok: false,
        content: errTag("subtask", "missing_arg", "Missing required parameter: prompt."),
        error: "missing_arg",
      };
    }
    if (!ctx.spawnAgent) {
      return {
        ok: false,
        content: errTag("subtask", "no_spawner", "Sub-agent spawning is unavailable in this context."),
        error: "no_spawner",
      };
    }
    const subagentType = (AGENT_TYPES as readonly string[]).includes(String(args.subagent_type ?? ""))
      ? (args.subagent_type as AgentType)
      : "general";
    const description = args.description ? String(args.description) : prompt.slice(0, 60);
    const typeLabel = subagentType !== "general" ? `[${subagentType}] ` : "";
    ctx.onProgress?.(`sub-agent: ${typeLabel}${description}`);
    try {
      const result = await ctx.spawnAgent(prompt, {
        description,
        cwd: ctx.cwd,
        subagent_type: subagentType,
      });
      return {
        ok: true,
        content: tag(
          "subtask",
          { description: truncate(description, 60), type: subagentType },
          result || "(sub-agent returned no text)",
        ),
        uiSummary: `sub-agent: ${typeLabel}${truncate(description, 50)}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        content: errTag("subtask", "subagent_error", `Sub-agent failed: ${msg}`),
        error: "subagent_error",
      };
    }
  },
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}
