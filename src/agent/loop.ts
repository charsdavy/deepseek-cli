// The agent loop. Streams a chat completion; if the model emits tool calls,
// executes them (with permission) and feeds results back into the conversation
// until the model stops calling tools. This is the heart of the agentic CLI.

import type { ChatMessage, ToolDef, TokenUsage } from "../api/client.ts";
import { DeepSeekError, DeepSeekUnauthorized, streamChatCompletion, withRetry } from "../api/client.ts";
import { isReasoningModel } from "../api/models.ts";
import { estimateConversationTokens } from "../api/tokens.ts";
import { trimToFit } from "./context.ts";
import type { PermissionManager } from "./permissions.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext, ToolResult } from "../tools/types.ts";
import { paint, symbol } from "../ui/theme.ts";
import { blank, printError, printSystem, printTip, printToolHeader, streamWrite, writeLine } from "../ui/render.ts";
import { spinner } from "../ui/spinner.ts";
import { log } from "../log/logger.ts";

export interface AgentOptions {
  apiKey: string;
  model: string;
  reasoning?: boolean;
  /** Thinking intensity: "high" (default) or "max". */
  reasoningEffort?: "high" | "max";
  temperature?: number;
  maxTokens?: number;
  /** Operational context budget for trimming (tokens). Defaults to 60_000. */
  maxContext?: number;
  maxIterations?: number;
  tools: ToolRegistry;
  permissions: PermissionManager;
  cwd?: string;
  signal?: AbortSignal;
  /** Override API base URL (self-hosted / proxy). */
  baseUrl?: string;
  /** Optional sub-agent spawner surfaced to tools via ToolContext. */
  spawnAgent?: (prompt: string, opts?: { description?: string; cwd?: string }) => Promise<string>;
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
  /** Real token usage reported by the API for the last completion (if any). */
  usage?: TokenUsage;
  /** True if the run was aborted via the supplied AbortSignal. */
  aborted?: boolean;
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
  let lastUsage: TokenUsage | undefined;

  const shouldReason = opts.reasoning ?? isReasoningModel(opts.model);
  const loopStart = performance.now();
  let apiTotalMs = 0;
  let toolsTotalMs = 0;
  // Streak of consecutive iterations where every emitted tool was read-only
  // (read_file / grep / glob / list_dir / git_* / web_fetch). When this hits
  // the threshold while running under a reasoning model, surface a one-shot
  // /fast hint — the user is mid-exploration and paying seconds of thinking
  // per iteration for work that doesn't need chain-of-thought.
  let readOnlyStreak = 0;
  let explorationHintShown = false;
  const EXPLORATION_HINT_THRESHOLD = 3;
  log.info("agent loop start", { model: opts.model, reasoning: shouldReason, reasonEffort: opts.reasoningEffort, messages: messagesIn.length, maxIterations });

  while (iterations < maxIterations) {
    iterations++;
    const iterStart = performance.now();
    log.debug("iteration", { iteration: iterations });

    // Bail out early if the user aborted the turn.
    if (opts.signal?.aborted) {
      spinner.stop();
      return { messages, iterations, finalText, usage: lastUsage, aborted: true };
    }

    // Restart the spinner for this iteration's "thinking" phase. Without this,
    // after tools finish (spinner.stop) and the next API call starts, the
    // terminal shows a bare blinking cursor instead of an active indicator.
    spinner.start("thinking…");

    // Trim context if necessary
    const trimmed = trimToFit(messages, opts.maxContext);
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

    const apiStart = performance.now();
    try {
      const gen = streamChatCompletion({
        apiKey: opts.apiKey,
        model: opts.model,
        messages,
        tools: tools.schemas() as ToolDef[],
        temperature: opts.temperature,
        reasoning: shouldReason,
        reasoningEffort: opts.reasoningEffort,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        baseUrl: opts.baseUrl,
      });

      for await (const chunk of gen) {
        if (chunk.usage) {
          lastUsage = {
            promptTokens: chunk.usage.promptTokens ?? lastUsage?.promptTokens,
            completionTokens: chunk.usage.completionTokens ?? lastUsage?.completionTokens,
            totalTokens: chunk.usage.totalTokens ?? lastUsage?.totalTokens,
          };
        }
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
        log.error("api unauthorized", { status: e.status });
        printError(`${e.message} Run \`deepseek auth\` to reconfigure.`);
        throw e;
      }
      // An AbortError means the user interrupted the stream — stop cleanly.
      if (opts.signal?.aborted || (e instanceof Error && e.name === "AbortError")) {
        spinner.stop();
        log.info("agent loop aborted", { iteration: iterations });
        printSystem("interrupted", "yellow");
        return { messages, iterations, finalText, usage: lastUsage, aborted: true };
      }
      spinner.stop();
      const msg = e instanceof Error ? e.message : String(e);
      log.error("api error", { error: msg, iteration: iterations, status: (e as { status?: number }).status });
      printError(`API error: ${msg}`);
      // Stop the loop on unrecoverable errors but return partial state.
      break;
    } finally {
      apiTotalMs += Math.round(performance.now() - apiStart);
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
      return { messages, iterations, finalText, usage: lastUsage };
    }

    // Collect permission decisions sequentially (keeps the y/n prompts sane),
    // then execute the approved calls in parallel. Denied/aborted/unknown tools
    // get their tool-message pushed immediately so their slots stay ordered.
    interface PendingTask {
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
    const pending: PendingTask[] = [];

    for (const tc of acc.toolCalls) {
      const args = safeParseArgs(tc.arguments);

      let proceed = true;
      if (opts.onToolStart) {
        proceed = await opts.onToolStart(tc.name, args);
      }
      if (!proceed) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: "User aborted this tool call." });
        continue;
      }

      const tool = tools.get(tc.name);
      if (!tool) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: `Tool '${tc.name}' is not registered.` });
        continue;
      }

      const decision = await opts.permissions.check(tool, args);
      if (!decision.allow) {
        printSystem(`denied: ${tc.name}`, "yellow");
        messages.push({ role: "tool", tool_call_id: tc.id, content: "User denied this operation." });
        continue;
      }

      pending.push({ id: tc.id, name: tc.name, args });
    }

    if (pending.length > 0) {
      // The assistant's streamed content/reasoning may not have ended with a
      // newline (e.g. "Let me read the file." then tool_calls in the same turn).
      // Each ⏺ tool marker MUST start at column 0 — flush a newline if needed
      // so the marker never glues onto a trailing content line.
      const streamed = acc.content || acc.reasoning;
      if (streamed.length > 0 && !streamed.endsWith("\n")) writeLine();

      // Show a blinking ⏺ marker while tools execute. For a single tool, the
      // marker line carries the tool name + args so it serves as both the
      // "in progress" indicator and the permanent record (once it stops
      // blinking). For multiple tools, use a summary label and print the
      // individual headers as permanent lines after execution.
      if (pending.length === 1) {
        spinner.startTool(`${paint.bold(pending[0].name)} ${paint.gray(summarizeArgs(pending[0].args))}`);
      } else {
        for (const p of pending) printToolHeader(p.name, summarizeArgs(p.args));
        spinner.startTool(`running ${pending.length} tools in parallel…`);
      }

      const ctx: ToolContext = {
        cwd: opts.cwd ?? process.cwd(),
        onProgress: (m) => spinner.update(m),
        state: toolSharedState,
        spawnAgent: opts.spawnAgent,
      };

      const toolsStart = performance.now();
      const results = await Promise.all(
        pending.map(async (p) => {
          const r = await tools.execute(p.name, p.args, ctx);
          return { id: p.id, name: p.name, result: r, ms: r.ms };
        }),
      );
      toolsTotalMs += Math.round(performance.now() - toolsStart);
      spinner.stop();

      // Push tool messages in original order for the model.
      for (const r of results) {
        opts.onToolEnd?.(r.name, r.result);
        const payload = capToolResult(r.result.content ?? "", r.name);
        messages.push({ role: "tool", tool_call_id: r.id, content: payload });
      }
    }

    // Exploration-phase hint: count consecutive read-only-only iterations to
    // nudge the user toward /fast when they're paying reasoning-overhead for
    // tasks that don't need it.
    if (pending.length > 0) {
      const cats = pending
        .map((p) => tools.get(p.name)?.category ?? "memory")
        .filter((c): c is "fs-read" | "git" | "network" => c === "fs-read" || c === "git" || c === "network");
      const allReadOnly = cats.length === pending.length;
      if (allReadOnly) readOnlyStreak++;
      else readOnlyStreak = 0;
      if (
        !explorationHintShown &&
        shouldReason &&
        readOnlyStreak >= EXPLORATION_HINT_THRESHOLD
      ) {
        explorationHintShown = true;
        log.info("exploration hint shown", { iteration: iterations, streak: readOnlyStreak });
        writeLine();
        printTip(
          `${readOnlyStreak} consecutive read-only iterations under a reasoning model — ` +
          `run /fast to switch to deepseek-chat (much snappier exploration); /think to switch back when writing code.`,
        );
      }
    }

    log.debug("iteration done", {
      iteration: iterations,
      iterMs: Math.round(performance.now() - iterStart),
      contentLen: acc.content.length,
      reasoningLen: acc.reasoning.length,
      toolCalls: acc.toolCalls.length,
      readOnlyStreak,
    });
  }

  if (iterations >= maxIterations) {
    log.warn("max iterations reached", { maxIterations });
    printSystem(`max iterations (${maxIterations}) reached — stopping agent.`, "yellow");
  }

  const loopMs = Math.round(performance.now() - loopStart);
  log.info("agent loop end", {
    iterations,
    usage: lastUsage,
    finalTextLen: finalText.length,
    loopMs,
    apiMs: apiTotalMs,
    toolsMs: toolsTotalMs,
    apiSharePct: loopMs > 0 ? Math.round((apiTotalMs / loopMs) * 100) : 0,
    toolsSharePct: loopMs > 0 ? Math.round((toolsTotalMs / loopMs) * 100) : 0,
  });
  return { messages, iterations, finalText, usage: lastUsage };
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

// Hard backstop: cap any single tool result fed back to the model. Individual
// tools already self-truncate, but this guarantees one giant output can never
// blow the context budget on its own. ~25K chars ≈ 6K tokens leaves plenty of
// room for the rest of the conversation.
const MAX_TOOL_RESULT_CHARS = 25_000;

function capToolResult(content: string, toolName: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  const head = content.slice(0, MAX_TOOL_RESULT_CHARS);
  return (
    head +
    `\n\n…(output truncated at ${MAX_TOOL_RESULT_CHARS} chars; ${content.length - MAX_TOOL_RESULT_CHARS} more omitted from ${toolName})`
  );
}

// Streaming render helper for the chat command — wraps the loop with stdout.
export interface StreamRenderOptions {
  showReasoning: boolean;
  /** Model id shown as the assistant label instead of a hardcoded brand. */
  model?: string;
}

export function makeStreamRenderer(opts: StreamRenderOptions) {
  let started = false;
  let inReasoning = false;
  const label = opts.model ?? "DeepSeek";
  const labelLine = () => writeLine(`${paint.bright.green(symbol.robot)} ${paint.bold(paint.green(label))}:`);
  return {
    onContentDelta(delta: string) {
      if (!started) {
        spinner.stop();
        writeLine();
        labelLine();
        started = true;
        inReasoning = false;
      } else if (inReasoning && opts.showReasoning) {
        // Transition from reasoning trace to final content
        writeLine();
        labelLine();
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
