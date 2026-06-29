// The agent loop. Streams a chat completion; if the model emits tool calls,
// executes them (with permission) and feeds results back into the conversation
// until the model stops calling tools. This is the heart of the agentic CLI.

import type { ChatMessage, ToolDef } from "../api/client.ts";
import { DeepSeekError, DeepSeekUnauthorized, streamChatCompletion, withRetry } from "../api/client.ts";
import { isReasoningModel } from "../api/models.ts";
import { estimateConversationTokens } from "../api/tokens.ts";
import { trimToFit } from "./context.ts";
import type { PermissionManager } from "./permissions.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext, ToolResult } from "../tools/types.ts";
import { paint, symbol } from "../ui/theme.ts";
import { blank, printError, printSystem, printToolHeader, streamWrite, writeLine } from "../ui/render.ts";
import { spinner } from "../ui/spinner.ts";

export interface AgentOptions {
  apiKey: string;
  model: string;
  reasoning?: boolean;
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  tools: ToolRegistry;
  permissions: PermissionManager;
  cwd?: string;
  signal?: AbortSignal;
  // UI callbacks (kept here so the loop stays decoupled from stdout specifics)
  onContentDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolStart?: (name: string, args: Record<string, unknown>) => boolean | Promise<boolean>;
  onToolEnd?: (name: string, result: ToolResult) => void;
}

export interface AgentRunResult {
  messages: ChatMessage[];
  iterations: number;
  finalText: string;
}

const DEFAULT_MAX_ITERATIONS = 30;

interface AccumulatedAssistant {
  content: string;
  reasoning: string;
  toolCalls: Array<{ index: number; id: string; name: string; arguments: string }>;
}

export async function runAgentLoop(
  messagesIn: ChatMessage[],
  opts: AgentOptions,
): Promise<AgentRunResult> {
  const tools = opts.tools;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let messages = messagesIn;
  let finalText = "";
  let iterations = 0;

  const shouldReason = opts.reasoning ?? isReasoningModel(opts.model);

  while (iterations < maxIterations) {
    iterations++;

    // Trim context if necessary
    const trimmed = trimToFit(messages);
    if (trimmed.droppedTurns > 0) {
      printSystem(
        `context trimmed: dropped ${trimmed.droppedTurns} turn(s) ` +
          `(${trimmed.tokensBefore} → ${trimmed.tokensAfter} tokens)`,
        "yellow",
      );
    }
    messages = trimmed.messages;

    let acc: AccumulatedAssistant = { content: "", reasoning: "", toolCalls: [] };
    let hadApiError = false;

    try {
      const gen = streamChatCompletion({
        apiKey: opts.apiKey,
        model: opts.model,
        messages,
        tools: tools.schemas() as ToolDef[],
        temperature: opts.temperature,
        reasoning: shouldReason,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
      });

      for await (const chunk of gen) {
        if (chunk.content) {
          acc.content += chunk.content;
          opts.onContentDelta?.(chunk.content);
        }
        if (chunk.reasoning) {
          acc.reasoning += chunk.reasoning;
          opts.onReasoningDelta?.(chunk.reasoning);
        }
        if (chunk.toolCalls.length > 0) {
          for (const tc of chunk.toolCalls) {
            const idx = tc.index;
            let slot = acc.toolCalls.find((x) => x.index === idx);
            if (!slot) {
              slot = { index: idx, id: "", name: "", arguments: "" };
              acc.toolCalls.push(slot);
            }
            if (tc.id) slot.id = tc.id;
            if (tc.name) slot.name += tc.name;
            if (tc.arguments) slot.arguments += tc.arguments;
          }
        }
      }
    } catch (e) {
      hadApiError = true;
      if (e instanceof DeepSeekUnauthorized) {
        printError(`${e.message} Run \`deepseek auth\` to reconfigure.`);
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      printError(`API error: ${msg}`);
      // Stop the loop on unrecoverable errors but return partial state.
      break;
    }

    if (hadApiError) break;

    // Build assistant message and push to history
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: acc.content || null,
    };
    if (acc.toolCalls.length > 0) {
      assistantMsg.tool_calls = acc.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments || "{}" },
      }));
    }
    if (acc.reasoning) {
      assistantMsg.reasoning_content = acc.reasoning;
    }
    messages.push(assistantMsg);

    finalText = acc.content;

    if (acc.toolCalls.length === 0) {
      // No more tool calls — model finished its turn.
      return { messages, iterations, finalText };
    }

    // Execute tool calls sequentially (parallel could be added later).
    for (const tc of acc.toolCalls) {
      const args = safeParseArgs(tc.arguments);

      // UI hook
      let proceed = true;
      if (opts.onToolStart) {
        proceed = await opts.onToolStart(tc.name, args);
      }
      if (!proceed) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "User aborted this tool call.",
        });
        continue;
      }

      // Permission check & execute
      const tool = tools.get(tc.name);
      if (!tool) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Tool '${tc.name}' is not registered.`,
        });
        continue;
      }

      const decision = await opts.permissions.check(tool, args);
      if (!decision.allow) {
        printSystem(`denied: ${tc.name}`, "yellow");
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "User denied this operation.",
        });
        continue;
      }

      const ctx: ToolContext = {
        cwd: opts.cwd ?? process.cwd(),
        onProgress: (m) => spinner.update(m),
        state: toolSharedState,
      };

      printToolHeader(tc.name, summarizeArgs(args));
      const result = await tools.execute(tc.name, args, ctx);
      opts.onToolEnd?.(tc.name, result);
      spinner.stop();

      const payload = result.content ?? "";
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: payload,
      });
    }
  }

  if (iterations >= maxIterations) {
    printSystem(`max iterations (${maxIterations}) reached — stopping agent.`, "yellow");
  }

  return { messages, iterations, finalText };
}

// In-memory store shared across tools (todos, etc.)
const toolSharedState: Record<string, unknown> = {};

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
  } catch {
    // Tolerate fragmented JSON by best-effort — model may have emitted partial.
    return { __raw: raw };
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";
  const keys = ["filePath", "path", "command", "pattern", "url"];
  for (const k of keys) {
    if (args[k] !== undefined) return shortStr(String(args[k]));
  }
  return "";
}

function shortStr(s: string): string {
  const m = 80;
  if (s.length <= m) return s;
  return s.slice(0, m - 1) + "…";
}

// Streaming render helper for the chat command — wraps the loop with stdout.
export interface StreamRenderOptions {
  showReasoning: boolean;
}

export function makeStreamRenderer(opts: StreamRenderOptions) {
  let started = false;
  let inReasoning = false;
  return {
    onContentDelta(delta: string) {
      if (!started) {
        spinner.stop();
        writeLine();
        writeLine(`${paint.bright.green(symbol.robot)} ${paint.bold(paint.green("DeepSeek"))}:`);
        started = true;
        inReasoning = false;
      } else if (inReasoning && opts.showReasoning) {
        // Transition from reasoning trace to final content
        writeLine();
        writeLine(`${paint.bold(paint.green("DeepSeek"))}:`);
        inReasoning = false;
      }
      streamWrite(delta);
    },
    onReasoningDelta(delta: string) {
      if (!opts.showReasoning) return;
      if (!inReasoning) {
        spinner.stop();
        writeLine(`${paint.gray(`${symbol.brain} reasoning:`)}`);
        inReasoning = true;
        started = true;
      }
      process.stdout.write(paint.dim(delta));
    },
    end() {
      if (started) {
        writeLine();
        blank();
      }
    },
  };
}

// Helper exposed for the receipt of nicer UI in chat commands:
// wraps a promise with a spinner that auto-stops on completion.
export async function withSpinnerAndRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  spinner.start(label);
  try {
    return await withRetry(fn);
  } finally {
    spinner.stop();
  }
}

void estimateConversationTokens; // referenced indirectly through context
void DeepSeekError;
