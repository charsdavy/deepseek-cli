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
  }
  if (opts.reasoningEffort) {
    // "high" (default) or "max"; the API maps low/medium→high, xhigh→max.
    body.reasoning_effort = opts.reasoningEffort;
  }

  const reqId = randomReqId();
  const reqStart = performance.now();
  const messagesCount = opts.messages.length;
  const toolsCount = opts.tools?.length ?? 0;
  let firstChunkMs: number | undefined;
  let chunkCount = 0;
  let finalUsage: TokenUsage | undefined;

  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl ?? BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    const fetchMs = roundMs(performance.now() - reqStart);
    const aborted = opts.signal?.aborted || (e instanceof Error && e.name === "AbortError");
    if (aborted) {
      log.debug("api fetch aborted", { reqId, model: opts.model, fetchMs });
    } else {
      log.error("api fetch failed", { reqId, model: opts.model, fetchMs, error: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  }

  const fetchMs = roundMs(performance.now() - reqStart);

  if (!res.ok) {
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

  try {
    while (true) {
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
          }
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
  } catch (e) {
    const streamMs = roundMs(performance.now() - reqStart);
    const aborted = opts.signal?.aborted || (e instanceof Error && e.name === "AbortError");
    if (aborted) {
      log.debug("api stream aborted", { reqId, streamMs, chunks: chunkCount });
    } else {
      log.error("api stream error", { reqId, streamMs, chunks: chunkCount, error: e instanceof Error ? e.message : String(e) });
    }
    throw e;
  } finally {
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

/** Retry helper: exponential backoff for transient failures. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < maxAttempts) {
    try {
      const result = await fn();
      if (attempt > 0) {
        log.info("api retry succeeded", { attempt: attempt + 1, maxAttempts });
      }
      return result;
    } catch (e) {
      lastErr = e;
      if (e instanceof DeepSeekUnauthorized) throw e; // do not retry auth
      attempt++;
      if (e instanceof DeepSeekRateLimit) {
        // Backoff harder on rate limit
        const delay = baseDelayMs * Math.pow(2, attempt) * 2;
        log.warn("api retry", { reason: "rate_limit", attempt, maxAttempts, delayMs: delay });
        await sleep(delay);
        continue;
      }
      if (attempt >= maxAttempts) {
        log.error("api retry exhausted", { attempt, maxAttempts, error: e instanceof Error ? e.message : String(e) });
        break;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      log.warn("api retry", { reason: e instanceof Error ? e.message : String(e), attempt, maxAttempts, delayMs: delay });
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
