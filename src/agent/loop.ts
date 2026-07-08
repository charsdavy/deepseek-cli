// The agent loop. Streams a chat completion; if the model emits tool calls,
// executes them (with permission) and feeds results back into the conversation
// until the model stops calling tools. This is the heart of the agentic CLI.

import type { ChatMessage, ToolDef, TokenUsage } from "../api/client.ts";
import { DeepSeekUnauthorized, streamChatCompletion } from "../api/client.ts";
import { isReasoningModel } from "../api/models.ts";
import { estimateConversationTokens } from "../api/tokens.ts";
import { trimToFit, trimToFitWithCompaction } from "./context.ts";
import { trunc } from "../prompt/harness.ts";
import type { PermissionManager } from "./permissions.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext, ToolResult } from "../tools/types.ts";
import type { ClassificationResult } from "./classifier.ts";
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
  /** Task classification result set by the caller before the loop. */
  classification?: ClassificationResult;
  /** Allow the loop to use LLM compaction when context is tight. */
  allowCompaction?: boolean;
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
  // Auto-downgrade reasoning effort during long read-only exploration runs.
  let effectiveEffort = opts.reasoningEffort;
  let effortDowngraded = false;
  // One-shot "wrap up" nudge near the iteration cap.
  let wrapUpHintShown = false;
  // Ephemeral system messages (context/wrap-up nudges) injected for ONE iteration only.
  const ephemeralSystems: ChatMessage[] = [];
  log.info("agent loop start", { model: opts.model, reasoning: shouldReason, reasonEffort: opts.reasoningEffort, maxContext: opts.maxContext, messages: messagesIn.length, maxIterations });

  // Compaction cooldown tracker: incremented on compaction, decremented each turn.
  const compactionCooldown = { value: 0 };

  while (iterations < maxIterations) {
    iterations++;
    const iterStart = performance.now();
    log.debug("iteration", { iteration: iterations });

    // Bail out early if the user aborted the turn.
    if (opts.signal?.aborted) {
      spinner.stop();
      return { messages, iterations, finalText, usage: lastUsage, aborted: true };
    }

    // Restart the spinner for this iteration's "thinking" phase.
    spinner.start("thinking…");

    // Strip last iteration's ephemeral system nudges.
    if (ephemeralSystems.length > 0) {
      for (const m of ephemeralSystems) {
        const idx = messages.lastIndexOf(m);
        if (idx >= 0) messages.splice(idx, 1);
      }
      ephemeralSystems.length = 0;
    }

    // Trim context — with optional LLM-driven compaction for smart preservation.
    const compactionBudget = (opts.maxContext ?? 60_000) - 8000;
    const needCompaction = opts.allowCompaction !== false &&
      estimateConversationTokens(messages) > compactionBudget &&
      compactionCooldown.value <= 0;

    let trimmed: ReturnType<typeof trimToFit> = { messages, droppedTurns: 0, tokensBefore: 0, tokensAfter: 0 };
    if (needCompaction) {
      const result = await trimToFitWithCompaction(messages, {
        maxContext: opts.maxContext,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        compactionCooldown,
      });
      trimmed = result;
      if (result.compacted) {
        spinner.stop();
        printSystem(
          `context compacted: ${result.droppedTurns} turns → summary ` +
            `(saved ~${Math.round((result.compactionSavings ?? 0) / 1000)}k tokens)`,
          "cyan",
        );
        spinner.start("thinking…");
      }
    } else {
      trimmed = trimToFit(messages, opts.maxContext);
      // Decrement cooldown.
      if (compactionCooldown.value > 0) compactionCooldown.value--;
    }

    if (trimmed.droppedTurns > 0 && !trimmed.compacted) {
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

    // Token-budget countdown: when the remaining operational budget drops
    // below ~20% of the max, inject a one-shot reminder so the model knows
    // it's approaching the context limit and can prioritize lean tools.
    // Different from the context-nudge (which fires once at >50k); this fires
    // when context is getting tight (<12k remaining for default 60k budget).
    if (!contextNudgeShown && trimmed.tokensAfter > 0) {
      const budgetRemaining = (opts.maxContext ?? 60_000) - trimmed.tokensAfter;
      const lowThreshold = Math.min(12_000, (opts.maxContext ?? 60_000) * 0.2);
      if (budgetRemaining < lowThreshold && budgetRemaining > 0) {
        contextNudgeShown = true;
        log.info("token countdown shown", { budgetRemaining, tokensAfter: trimmed.tokensAfter });
        const nudge: ChatMessage = {
          role: "system",
          content:
            `Context budget running low (~${Math.round(budgetRemaining / 1000)}k tokens remaining). ` +
            `Stop re-reading files already in context. Use grep/glob for lookups. ` +
            `Delegate new investigations to \`task\` sub-agents. ` +
            `Finish the current unit of work and produce an answer before the budget is exhausted.`,
        };
        messages.push(nudge);
        ephemeralSystems.push(nudge);
      }
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
      const eStatus = (e as { status?: number }).status;
      log.error("api error", { error: msg, iteration: iterations, status: eStatus });
      printError(`API error: ${msg}`);
      // 5xx is upstream fault — break the loop (no automatic retry) so we
      // don't re-send the entire (potentially huge) prompt and burn tokens
      // for a request that will likely fail again. Surface a plain-text
      // nudge so the user knows it's server-side and a manual re-run is fine.
      if (typeof eStatus === "number" && eStatus >= 500 && eStatus < 600) {
        printSystem(
          `Upstream ${eStatus} — server-side fault. Stopped without auto-retry to avoid wasting tokens. Re-run your request manually when the upstream recovers.`,
          "yellow",
        );
      }
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
      // The turn produced no answer at all. Rather than silently returning an
      // empty response — forcing the user to ask "status?" to learn anything
      // — make one more request WITHOUT tools so the model must answer in
      // plain text: a concise progress summary (done / in flight / remaining).
      // Streamed to the user via onContentDelta and recorded as finalText so
      // session resume, /undo, and /retry all see something coherent instead
      // of a blank turn.
      printSystem(`max iterations (${maxIterations}) reached — generating a wrap-up summary…`, "yellow");
      spinner.stop();
      spinner.start("summarizing…");
      try {
        // Trim the conversation before the summary: tool results from the
        // last iteration may have pushed messages past the context window.
        const trimmed = trimToFit(messages, opts.maxContext);
        const summaryMessages: ChatMessage[] = [
          ...trimmed.messages,
          {
            role: "system",
            content:
              "The iteration budget is exhausted and you produced no final answer. Stop calling tools. " +
              "Based on the conversation so far, write a concise progress summary: what has been done, " +
              "what is in flight, and what remains for the next turn. Be brief and concrete.",
          },
        ];
        // Disable reasoning for the summary: we want a quick text response,
        // not deep chain-of-thought thinking. With reasoning + max effort,
        // the model can spend 60+ seconds thinking before the first token,
        // hitting the watchdog timeout (120s first-byte) and falling through
        // to the "NO output produced" fallback — the exact cliff we're
        // trying to avoid.
        const gen = streamChatCompletion({
          apiKey: opts.apiKey,
          model: opts.model,
          messages: summaryMessages,
          temperature: opts.temperature,
          reasoning: false,
          maxTokens: Math.min(opts.maxTokens ?? 4096, 1024),
          signal: opts.signal,
          baseUrl: opts.baseUrl,
        });
        let summary = "";
        for await (const chunk of gen) {
          if (chunk.usage) {
            lastUsage = {
              promptTokens: chunk.usage.promptTokens ?? lastUsage?.promptTokens,
              completionTokens: chunk.usage.completionTokens ?? lastUsage?.completionTokens,
              totalTokens: chunk.usage.totalTokens ?? lastUsage?.totalTokens,
            };
          }
          if (chunk.content) {
            summary += chunk.content;
            opts.onContentDelta?.(chunk.content);
          }
        }
        spinner.stop();
        finalText = summary;
        messages.push({ role: "assistant", content: summary || null });
        log.info("wrap-up summary generated", { summaryLen: summary.length, iteration: iterations });
      } catch (e) {
        spinner.stop();
        const aborted = opts.signal?.aborted || (e instanceof Error && e.name === "AbortError");
        if (aborted) {
          log.info("wrap-up summary aborted", { iteration: iterations });
          printSystem("interrupted", "yellow");
        } else {
          log.warn("wrap-up summary failed", { error: e instanceof Error ? e.message : String(e) });
          // Persist a local fallback so session resume / /undo / /retry see
          // something coherent instead of a blank turn. Without this, a
          // failed wrap-up summary (observed: API 500 "boom") left finalText
          // empty and the assistant turn's messages slot silent — the next
          // turn's messages started with no assistant reply at all, pushing
          // the model to re-loop the same investigation.
          const fallback =
            `Max iterations (${maxIterations}) reached with NO model output produced. ` +
            `The task was likely too large for one turn, or the model looped. ` +
            `Try splitting it into smaller steps (todo_write) and running them across turns. ` +
            `(wrap-up summary request failed: ${e instanceof Error ? e.message : String(e)})`;
          printSystem(fallback, "yellow");
          finalText = fallback;
          messages.push({ role: "assistant", content: fallback });
        }
      }
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
  let reasonBuf = "";
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

  /** Output complete reasoning lines from reasonBuf. Partial lines (no
   *  trailing \n) stay buffered so the cursor doesn't trail mid-line —
   *  it rests at col 0 of the empty line below the last complete line. */
  function flushReasoning(): void {
    let nl: number;
    while ((nl = reasonBuf.indexOf("\n")) >= 0) {
      const line = reasonBuf.slice(0, nl);
      reasonBuf = reasonBuf.slice(nl + 1);
      process.stdout.write(paint.dim(line) + "\r\n");
    }
  }

  /** Flush any remaining partial reasoning line (no trailing \n). */
  function flushReasoningTail(): void {
    if (reasonBuf) {
      process.stdout.write(paint.dim(reasonBuf) + "\r\n");
      reasonBuf = "";
    }
  }

  return {
    onContentDelta(delta: string) {
      // The agent loop restarts the "thinking…" spinner at the top of every
      // iteration. Always stop it first; stop() is a no-op when idle.
      spinner.stop();
      if (!started) {
        writeLine();
        labelLine();
        started = true;
        inReasoning = false;
      } else if (inReasoning && opts.showReasoning) {
        // Flush any partial reasoning line, then add a blank separator
        // before the model's reply label.
        flushReasoningTail();
        writeLine();
        labelLine();
        inReasoning = false;
      }
      lineBuf += delta;
      flushLines();
    },
    onReasoningDelta(delta: string) {
      if (!opts.showReasoning) return;
      // Always stop the spinner — the agent loop re-starts "thinking…" at
      // the top of every iteration, so it may be active even when
      // inReasoning is still true from a previous iteration.
      spinner.stop();
      if (!inReasoning) {
        writeLine(`${paint.gray(`${symbol.brain} reasoning:`)}`);
        inReasoning = true;
        started = true;
      }
      // Buffer and output only complete lines. The cursor rests at col 0
      // of the empty line below the last output line instead of trailing
      // along with every character fragment.
      reasonBuf += delta;
      flushReasoning();
    },
    /** Flush any pending partial line to stdout. Called by the agent loop
     *  before showing a tool marker so unflushed content/reasoning from the
     *  model's last delta (which may not end with \n) is displayed instead
     *  of getting concatenated with the next iteration's content. */
    flush() {
      flushReasoningTail();
      if (lineBuf) {
        streamWrite(md.flush(lineBuf) + "\n");
        lineBuf = "";
      }
    },
    end() {
      // Flush any remaining partial reasoning line.
      if (inReasoning) {
        flushReasoningTail();
        inReasoning = false;
      }
      // Flush any remaining partial content line
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

void estimateConversationTokens; // referenced indirectly through context
