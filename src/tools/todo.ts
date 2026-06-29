// todo_write tool — task list state that the agent can read/update.
// Mirrors Claude Code's TodoWrite concept so the model keeps its own checklist.

import type { Tool, ToolResult } from "./types.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

// In-memory shared state — the registry hands the same ctx.state to all tools
// in a single session, so the agent's todo list persists across tool calls.
const STATE_KEY = "todos";

export const todoWriteTool: Tool = {
  name: "todo_write",
  description: [
    "Maintains a structured task list for the current session. Use proactively for multi-step work (3+ items).",
    "Items have status (pending/in_progress/completed/cancelled) and priority (high/medium/low).",
    "Set exactly ONE item to 'in_progress' at any time. Update the list as work progresses in real time.",
  ].join(" "),
  category: "memory",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete updated todo list (replaces the existing list).",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["content", "status", "priority"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },

  async execute(args, ctx): Promise<ToolResult> {
    if (!Array.isArray(args.todos)) {
      return { ok: false, content: "Missing/invalid 'todos' array.", error: "missing_arg" };
    }
    const list: TodoItem[] = args.todos.map((t: Record<string, unknown>) => ({
      content: String(t.content ?? ""),
      status: (String(t.status ?? "pending") as TodoStatus),
      priority: (String(t.priority ?? "medium") as TodoPriority),
    }));
    if (!ctx.state) ctx.state = {};
    ctx.state[STATE_KEY] = list;
    const inProgressCount = list.filter((t) => t.status === "in_progress").length;
    return {
      ok: true,
      content: `Todo list updated. ${list.length} items (${inProgressCount} in progress).`,
      uiSummary: `todos: ${list.length} items`,
    };
  },
};

export function getTodos(ctx: { state?: Record<string, unknown> }): TodoItem[] {
  return (ctx.state?.[STATE_KEY] as TodoItem[] | undefined) ?? [];
}
