// Tool framework types. Each tool is a self-contained module that
// the agent loop can call. The schema mirrors OpenAI function-calling.

export type JSONSchema = Record<string, unknown>;

export type ToolCategory =
  | "fs-read"
  | "fs-write"
  | "bash"
  | "network"
  | "memory"
  | "git";

export interface ToolContext {
  cwd: string;
  fileSystemAccess?: boolean;
  onProgress?: (msg: string) => void;
  // Used by tools to interact with the agent's own state (e.g., todos)
  state?: Record<string, unknown>;
}

export interface ToolResult {
  /** Whether the tool call succeeded. */
  ok: boolean;
  /** Stringified content sent back to the model. */
  content: string;
  /** Optional side-effect summary printed to the user (besides tool result). */
  uiSummary?: string;
  /** Optional structured error for the model. */
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  category: ToolCategory;
  /** OpenAI-style tool parameters JSON Schema. */
  parameters: JSONSchema;
  /** Whether the tool performs side effects the user should approve. */
  isDangerous: boolean;
  /** Execute the tool. Must never throw — wrap errors in ToolResult. */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function toOpenAiTool(tool: Tool) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
