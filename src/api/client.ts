// DeepSeek API client — OpenAI-compatible chat completions with streaming,
// tool/function calling, and reasoning support. Built on fetch + SSE,
// no third-party SDK dependency keeps the bun binary tiny.

import { BASE_URL } from "./models.ts";
import { log } from "../log/logger.ts";

export interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatStreamChunk {
  content?: string;
  reasoning?: string;
  toolCalls: ToolCallAccumulator[];
  /** Populated on the final SSE event that carries `usage`. */
  usage?: TokenUsage;
}

export interface ChatMessageContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | ChatMessageContent[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  reasoning?: boolean;
  /** Thinking intensity: "high" (default) or "max" (deeper, costlier). */
  reasoningEffort?: "high" | "max";
  maxTokens?: number;
  signal?: AbortSignal;
  /** Override the API base URL (e.g. for self-hosted / proxy). Falls back to models.ts BASE_URL. */
  baseUrl?: string;
}

export class DeepSeekError extends Error {
  status?: number;
  body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class DeepSeekUnauthorized extends DeepSeekError {
  constructor(message = "Invalid or revoked API key (401).") {
    super(message, 401);
  }
}

export class DeepSeekRateLimit extends DeepSeekError {
  constructor(message = "Rate limit hit. Please slow down.") {
    super(message, 429);
  }
}

/**
 * Stream a chat completion. Yields incremental chunks containing
 * content deltas, reasoning_content deltas (for thinking models),
 * and tool-call deltas indexed by `index`.
 */
function randomReqId(): string {
  // Compact correlation id per logical API call — readable in `tail -f` logs
  // without bloating each JSON line. Not cryptographically unique.
  return Math.random().toString(36).slice(2, 10);
}

function roundMs(n: number): number {
  return Math.round(n);
}

// Watchdog timeouts guarding against hung API streams. Observed in the wild:
// a single iteration can spend 55+ minutes stuck in reader.read() when the
// server accepts the connection but never resumes the SSE stream. These caps
// bound a stuck request so the agent loop can surface an error instead of
// freezing the whole turn.
const FIRST_BYTE_TIMEOUT_MS = 120_000; // no data at all 120s after fetch resolves
const CHUNK_GAP_TIMEOUT_MS = 60_000; // 60s with no new SSE event mid-stream

/**
 * Combine two abort signals into one that fires when either input fires.
 * Uses AbortSignal.any when available (Bun 1.1+ / Node 20+); falls back to a
 * manual bridge so older runtimes still work.
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn.call(AbortSignal, [a, b]);
  const c = new AbortController();
  const bridge = (sig: AbortSignal) => () => c.abort(sig.reason);
  const onA = bridge(a);
  const onB = bridge(b);
  a.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return c.signal;
}

export async function* streamChatCompletion(
  opts: ChatOptions,
): AsyncGenerator<ChatStreamChunk, void, void> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  if (typeof opts.maxTokens === "number") body.max_tokens = opts.maxTokens;
  if (opts.reasoning) {
    // DeepSeek-specific extension to enable thinking trace
    body.thinking = { type: "enabled" };
    // Effort is only meaningful with the thinking trace enabled; sending it
    // standalone (reasoning off but effort set) is a no-op against the API
    // and a symptom of a stale/inconsistent config — gate it on reasoning.
    if (opts.reasoningEffort) {
      body.reasoning_effort = opts.reasoningEffort;
    }
  }

  const reqId = randomReqId();
  const reqStart = performance.now();
  const messagesCount = opts.messages.length;
  const toolsCount = opts.tools?.length ?? 0;
  let firstChunkMs: number | undefined;
  let chunkCount = 0;
  let finalUsage: TokenUsage | undefined;

  let res: Response;
  // Watchdog: a dedicated controller so we can abort a hung request without
  // depending on the user's manual abort signal. Merged with opts.signal so
  // either one cancels the fetch and the body reader.
  const timeoutController = new AbortController();
  const signal = opts.signal ? mergeSignals(opts.signal, timeoutController.signal) : timeoutController.signal;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const armWatchdog = (ms: number, reason: string) => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      timedOut = true;
      log.warn("api stream timeout", { reqId, model: opts.model, reason, ms });
      timeoutController.abort();
    }, ms);
  };
  // Start the first-byte timer as soon as the request leaves; fetch resolves
  // once response headers arrive, but if the server hangs mid-handshake this
  // never fires and the timer is cleared in the first-chunk path below.
  armWatchdog(FIRST_BYTE_TIMEOUT_MS, "no first byte");
  try {
    res = await fetch(`${opts.baseUrl ?? BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const fetchMs = roundMs(performance.now() - reqStart);
    if (watchdog) clearTimeout(watchdog);
    const aborted = opts.signal?.aborted || (e instanceof Error && e.name === "AbortError");
    if (timedOut) {
      log.warn("api fetch timed out", { reqId, model: opts.model, fetchMs });
    } else if (aborted) {
      log.debug("api fetch aborted", { reqId, model: opts.model, fetchMs });
    } else {
      log.error("api fetch failed", { reqId, model: opts.model, fetchMs, error: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  }

  const fetchMs = roundMs(performance.now() - reqStart);

  if (!res.ok) {
    if (watchdog) clearTimeout(watchdog);
    const text = await res.text().catch(() => "");
    log.warn("api request failed", {
      reqId,
      model: opts.model,
      status: res.status,
      fetchMs,
      bodyLen: text.length,
      messages: messagesCount,
      tools: toolsCount,
    });
    if (res.status === 401) throw new DeepSeekUnauthorized();
    if (res.status === 429) throw new DeepSeekRateLimit();
    throw new DeepSeekError(
      `DeepSeek API error ${res.status}: ${truncate(text, 500)}`,
      res.status,
      text,
    );
  }

  if (!res.body) {
    if (watchdog) clearTimeout(watchdog);
    log.error("api empty body", { reqId, model: opts.model, fetchMs });
    throw new DeepSeekError("Empty response body from DeepSeek API.");
  }

  log.debug("api response", {
    reqId,
    model: opts.model,
    status: res.status,
    fetchMs,
    messages: messagesCount,
    tools: toolsCount,
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  // Active cancellation: when the signal fires (double-Esc / Ctrl-C, or the
  // watchdog timeout above), cancel the reader directly. In Bun, aborting an
  // AbortSignal passed to fetch() doesn't always propagate to the body reader
  // after headers arrive, so a pending reader.read() can hang indefinitely.
  // Calling reader.cancel() forces the pending read to reject (or resolve
  // with done=true), unblocking the loop so the agent can stop promptly.
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort);

  try {
    while (true) {
      // Catch aborts that fire between chunks (while data is flowing).
      if (signal.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE boundaries are blank lines
      let boundary: number;
      while ((boundary = buf.indexOf("\n\n")) !== -1) {
        const rawEvent = buf.slice(0, boundary);
        buf = buf.slice(boundary + 2);
        const chunk = parseSSEEvent(rawEvent);
        if (chunk) {
          if (firstChunkMs === undefined) {
            firstChunkMs = roundMs(performance.now() - reqStart);
            log.debug("api first chunk", { reqId, ttfbMs: firstChunkMs, fetchMs });
            // Switch from the (longer) first-byte cap to the per-chunk-gap
            // cap: bytes are now flowing, so a stall means the stream died.
            armWatchdog(CHUNK_GAP_TIMEOUT_MS, "chunk gap");
          }
          // Every flowing event resets the gap watchdog.
          armWatchdog(CHUNK_GAP_TIMEOUT_MS, "chunk gap");
          chunkCount++;
          if (chunk.usage) finalUsage = chunk.usage;
          yield chunk;
        }
      }
    }
    // Flush any trailing event
    if (buf.trim().length > 0) {
      const chunk = parseSSEEvent(buf);
      if (chunk) {
        if (firstChunkMs === undefined) {
          firstChunkMs = roundMs(performance.now() - reqStart);
        }
        chunkCount++;
        if (chunk.usage) finalUsage = chunk.usage;
        yield chunk;
      }
    }
    // reader.cancel() (from the abort listener) may cause read() to resolve
    // with done=true rather than rejecting. Check the signal and throw so
    // the caller knows the turn was interrupted.
    if (signal.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
  } catch (e) {
    const streamMs = roundMs(performance.now() - reqStart);
    const aborted = signal.aborted || (e instanceof Error && e.name === "AbortError");
    if (timedOut) {
      log.warn("api stream timed out", { reqId, streamMs, chunks: chunkCount });
    } else if (aborted) {
      log.debug("api stream aborted", { reqId, streamMs, chunks: chunkCount });
    } else {
      log.error("api stream error", { reqId, streamMs, chunks: chunkCount, error: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
    const streamMs = roundMs(performance.now() - reqStart);
    log.debug("api stream done", {
      reqId,
      streamMs,
      ttfbMs: firstChunkMs,
      chunks: chunkCount,
      usage: finalUsage,
    });
  }
}

function parseSSEEvent(rawEvent: string): ChatStreamChunk | null {
  // SSE event lines start with `data:` or `event:`
  const lines = rawEvent.split("\n");
  let dataLine = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      dataLine += trimmed.slice(5).trim();
    }
  }
  if (!dataLine) return null;
  if (dataLine === "[DONE]") return null;

  try {
    const json = JSON.parse(dataLine);
    const delta = json?.choices?.[0]?.delta;

    const out: ChatStreamChunk = { toolCalls: [] };

    // The final SSE event (and sometimes a dedicated `[DONE]`-preceded event)
    // carries a top-level `usage` object. Capture it regardless of delta presence.
    if (json?.usage && typeof json.usage === "object") {
      const u = json.usage as Record<string, unknown>;
      out.usage = {
        promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
        completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
        totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : undefined,
      };
    }

    if (!delta) return out;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      out.content = delta.content;
    }
    // DeepSeek reasoning models emit `reasoning_content`
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      out.reasoning = delta.reasoning_content;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        out.toolCalls.push({
          index: typeof tc.index === "number" ? tc.index : 0,
          id: typeof tc.id === "string" ? tc.id : "",
          name: tc?.function?.name ?? "",
          arguments: tc?.function?.arguments ?? "",
        });
      }
    }
    // Skip chunks that carry no actionable payload (keeps the stream quiet).
    if (!out.content && !out.reasoning && out.toolCalls.length === 0 && !out.usage) {
      return null;
    }
    return out;
  } catch {
    // Malformed JSON event — ignore rather than crash the stream
    return null;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
