// The agent loop. Streams a chat completion; if the model emits tool calls,
// executes them (with permission) and feeds results back into the conversation
// until the model stops calling tools. This is the heart of the agentic CLI.

import type { ChatMessage, ToolDef, TokenUsage } from "../api/client.ts";
import { DeepSeekError, DeepSeekUnauthorized, streamChatCompletion, withRetry } from "../api/client.ts";
import { isReasoningModel } from "../api/models.ts";
import { estimateConversationTokens } from "../api/tokens.ts";
import { trimToFit } from "./context.ts";
import { trunc } from "../prompt/harness.ts";
import type { PermissionManager } from "./permissions.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext, ToolResult } from "../tools/types.ts";
import { paint, symbol } from "../ui/theme.ts";
import { blank, printError, printSystem, printTip, printToolHeader, streamWrite, writeLine, StreamMarkdown } from "../ui/render.ts";
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
  // Per-loop (cross-iteration) trackers for hallucinated tool names. A model
  // can fire the same bogus name once per iteration for many iterations
  // (observed: "nope" × 43 across a single session). Counting across
  // iterations lets us block that specific name for the rest of the turn
  // WITHOUT bricking other, valid tool calls.
  const unknownCounts = new Map<string, number>();
  const abusiveNames = new Set<string>();
  const registeredNames = tools.list().map((t) => t.name).join(", ");
  // One-shot nudge when this conversation is already large: steer the model
  // toward context-economical tools so it doesn't keep bloating the thread.
  let contextNudgeShown = false;
  // Auto-downgrade reasoning effort during long read-only exploration runs
  // (max→high) so each tool-call iteration stops paying deepest-thinking
  // overhead for pure grep/read work. Restored back to max as soon as the
  // model resumes writing code (edit/write/bash) — the downgrade is for
  // exploration only, never the coding phase the user picked max for.
  let effectiveEffort = opts.reasoningEffort;
  let effortDowngraded = false;
  // One-shot "wrap up" nudge near the iteration cap so the turn ends with a
  // usable answer instead of running off the cliff with finalText empty.
  let wrapUpHintShown = false;
  // Ephemeral system messages (context/wrap-up nudges) are injected for ONE
  // iteration only; we remove them next iteration so they aren't re-sent to
  // the API on every subsequent turn (avoids stale-instruction token bloat).
  const ephemeralSystems: ChatMessage[] = [];
  log.info("agent loop start", { model: opts.model, reasoning: shouldReason, reasonEffort: opts.reasoningEffort, maxContext: opts.maxContext, messages: messagesIn.length, maxIterations });

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

    // Strip last iteration's ephemeral system nudges so they're sent to the
    // API exactly once, not re-sent every subsequent turn (stale-instruction
    // bloat). They were pushed last iteration; remove them before this turn's
    // trim/inject cycle. Safe with trimToFit, which only keeps them within a
    // single iteration.
    if (ephemeralSystems.length > 0) {
      for (const m of ephemeralSystems) {
        const idx = messages.lastIndexOf(m);
        if (idx >= 0) messages.splice(idx, 1);
      }
      ephemeralSystems.length = 0;
    }

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

    // Context-economy nudge: once the live conversation crosses a meaningful
    // size, inject a one-shot reminder to prefer lean tools (grep/glob/task)
    // over whole-file re-reads. Fired once per loop, not every iteration.
    if (!contextNudgeShown && trimmed.tokensBefore > 50_000) {
      contextNudgeShown = true;
      log.info("context nudge shown", { tokensBefore: trimmed.tokensBefore });
      const nudge: ChatMessage = {
        role: "system",
        content:
          "Context is large (>50k tokens). Prefer grep/glob to locate code over whole-file read_file; delegate self-contained investigations to the `task` sub-agent so their context stays out of this thread; do not re-read files already in context.",
      };
      messages.push(nudge);
      ephemeralSystems.push(nudge);
    }

    // Wrap-up nudge: when the iteration budget is running low, steer the model
    // toward finishing with a usable answer instead of running off the cap
    // with an empty finalText (observed: 4 turns hit iter=30 with no output).
    if (!wrapUpHintShown && maxIterations - iterations <= 10) {
      wrapUpHintShown = true;
      log.info("wrap-up nudge shown", { iteration: iterations, remaining: maxIterations - iterations });
      const nudge: ChatMessage = {
        role: "system",
        content:
          "The iteration budget is almost exhausted (~10 left). Wrap up now: finish only the in-flight edit, then produce a concrete final answer stating what was done and what remains for the next turn. Do not start new investigations or new files.",
      };
      messages.push(nudge);
      ephemeralSystems.push(nudge);
      printSystem("approaching iteration cap — prompting the model to wrap up", "yellow");
    }

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
        reasoningEffort: effectiveEffort,
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
        // 401 throws at the fetch stage (before any assistant message is
        // pushed this iteration), so there is no dangling partial assistant
        // to clean up here — the previous iteration always closed with tool
        // messages. Just surface a clear re-auth prompt.
        log.error("api unauthorized", { status: e.status, note: "401 — check API key / baseUrl / proxy; if intermittent, the key may be rate-limited or region-locked" });
        printError(`${e.message} If this keeps happening intermittently, the key may be rate-limited or the baseUrl/proxy may be rejecting some requests. Run \`deepseek auth\` to reconfigure.`);
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

    // Stop the "thinking…" spinner before any blocking user interaction
    // (permission approval). Without this the spinner's setInterval keeps
    // overwriting the readline prompt every 80ms, making it look like the
    // program is still thinking when it's actually waiting for [y/n/a].
    spinner.stop();

    // Collect permission decisions sequentially (keeps the y/n prompts sane),
    // then execute the approved calls in parallel. Denied/aborted/unknown tools
    // get their tool-message pushed immediately so their slots stay ordered.
    interface PendingTask {
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
    const pending: PendingTask[] = [];
    // unknownCounts / abusiveNames / registeredNames are declared at loop
    // scope (above the while) so the hallucination guard accumulates across
    // iterations, not just within one.

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

      // A tool name blocked earlier this turn after repeated unknown-tool
      // calls. Skip just this call (still push a tool message so the
      // tool_call/message counts stay consistent — a mismatch causes a 400)
      // but let the model's OTHER tool calls through.
      if (abusiveNames.has(tc.name)) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: `Skipped — '${tc.name}' is blocked for the rest of this turn after repeated unknown-tool calls.` });
        continue;
      }

      const tool = tools.get(tc.name);
      if (!tool) {
        const c = (unknownCounts.get(tc.name) ?? 0) + 1;
        unknownCounts.set(tc.name, c);
        if (c >= 3) {
          abusiveNames.add(tc.name);
          log.warn("unknown tool abuse", { name: tc.name, count: c, iteration: iterations });
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `STOP: '${tc.name}' is not a registered tool — you have called it ${c} times this turn. It is now blocked for the rest of this turn. Choose ONLY from: ${registeredNames}. If none applies, answer in plain text with no tool call. Other valid tool calls will still run.`,
          });
        } else {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `Tool '${tc.name}' does not exist. Available tools: ${registeredNames}. Pick one of those by its exact name, or respond without a tool call.`,
          });
        }
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
      // Only count reasoning if it was actually displayed: when opts.reasoning
      // is not explicitly true, the renderer suppresses the reasoning trace but
      // acc.reasoning still accumulates — using it here would insert a spurious
      // blank line before the tool marker.
      const reasoningDisplayed = opts.reasoning === true;
      const streamed = acc.content || (reasoningDisplayed ? acc.reasoning : "");
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
      if (allReadOnly) {
        readOnlyStreak++;
      } else {
        readOnlyStreak = 0;
        // The model left exploration and is now writing code (edit/write/bash).
        // Restore the user's configured effort — the max→high downgrade was
        // only meant for the read-only exploration phase, not the coding phase
        // the user picked `max` for in the first place.
        if (effortDowngraded) {
          effectiveEffort = opts.reasoningEffort;
          effortDowngraded = false;
          log.info("effort auto-restored", { to: effectiveEffort ?? "default", iteration: iterations });
        }
      }
      if (
        !explorationHintShown &&
        shouldReason &&
        readOnlyStreak >= EXPLORATION_HINT_THRESHOLD
      ) {
        explorationHintShown = true;
        log.info("exploration hint shown", { iteration: iterations, streak: readOnlyStreak });
        // Auto-downgrade deepest thinking during exploration: max→high trims
        // seconds off every subsequent read-only iteration without hurting
        // accuracy for grep/read/list tasks. Restored when writing resumes.
        if (effectiveEffort === "max" && !effortDowngraded) {
          effortDowngraded = true;
          effectiveEffort = "high";
          log.info("effort auto-downgraded", { from: "max", to: "high", iteration: iterations });
        }
        writeLine();
        printTip(
          `${readOnlyStreak} consecutive read-only iterations under a reasoning model — ` +
          `running /fast switches to deepseek-chat (much snappier exploration); /think switches back when writing code.` +
          (effortDowngraded ? " Thinking effort auto-lowered max→high for exploration; restores when you write code." : ""),
        );
      }
    }

    const iterMs = Math.round(performance.now() - iterStart);
    log.debug("iteration done", {
      iteration: iterations,
      iterMs,
      contentLen: acc.content.length,
      reasoningLen: acc.reasoning.length,
      toolCalls: acc.toolCalls.length,
      readOnlyStreak,
    });
    // Flag suspiciously slow iterations (>5min). Observed in production: a
    // single iteration can spend 55min stuck on a hung API stream; this
    // makes such outliers jump out in `tail -f` instead of hiding in debug.
    if (iterMs > 300_000) {
      log.warn("suspicious slow iteration", {
        iteration: iterations,
        iterMs,
        contentLen: acc.content.length,
        reasoningLen: acc.reasoning.length,
        toolCalls: acc.toolCalls.length,
      });
    }
  }

  if (iterations >= maxIterations) {
    log.warn("max iterations reached", { maxIterations, finalTextLen: finalText.length });
    if (finalText.length === 0) {
      // The turn produced no answer at all — typically a task that's too big
      // for one loop, or a model stuck in a tool loop. Tell the user plainly
      // rather than silently returning an empty response.
      printSystem(
        `max iterations (${maxIterations}) reached with NO output produced. ` +
          `The task was likely too large for one turn, or the model looped. ` +
          `Try splitting it into smaller steps (todo_write) and running them across turns.`,
        "yellow",
      );
    } else {
      printSystem(`max iterations (${maxIterations}) reached — stopping agent.`, "yellow");
    }
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
  return head + trunc(content.length - MAX_TOOL_RESULT_CHARS, "chars") + ` (from ${toolName})`;
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
  let lineBuf = "";
  const md = new StreamMarkdown();
  const label = opts.model ?? "DeepSeek";
  const labelLine = () => writeLine(`${paint.bright.green(symbol.robot)} ${paint.bold(paint.green(label))}:`);

  function flushLines(): void {
    let nl: number;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      streamWrite(md.renderLine(line) + "\n");
    }
  }

  return {
    onContentDelta(delta: string) {
      // The agent loop restarts the "thinking…" spinner at the top of every
      // iteration. In iteration 2+ the `started` flag is already true from
      // a previous iteration, so the `!started` branch below is skipped —
      // but the spinner is still active and would clobber content lines
      // every 80ms. Always stop it first; stop() is a no-op when idle.
      spinner.stop();
      if (!started) {
        writeLine();
        labelLine();
        started = true;
        inReasoning = false;
      } else if (inReasoning && opts.showReasoning) {
        writeLine();
        labelLine();
        inReasoning = false;
      }
      lineBuf += delta;
      flushLines();
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
    /** Flush any pending partial line to stdout. Called by the agent loop
     *  before showing a tool marker so unflushed content from the model's
     *  last delta (which may not end with \n) is displayed instead of
     *  getting concatenated with the next iteration's content. */
    flush() {
      if (lineBuf) {
        streamWrite(md.flush(lineBuf) + "\n");
        lineBuf = "";
      }
    },
    end() {
      // If reasoning was the last output and didn't end with a newline,
      // move to a fresh line so the cursor is at col 0 for subsequent
      // output (prompts, separators, etc.). Reasoning is written raw via
      // process.stdout.write so it may stop mid-line.
      if (inReasoning) {
        writeLine();
        inReasoning = false;
      }
      // Flush any remaining partial line
      if (lineBuf) {
        streamWrite(md.flush(lineBuf) + "\n");
        lineBuf = "";
      }
      // Close an unclosed code fence
      if (md.inCodeBlock) {
        streamWrite(paint.gray("└" + "─".repeat(Math.max(1, 119))) + "\n");
      }
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
