// DeepSeek API client — OpenAI-compatible chat completions with streaming,
// tool/function calling, and reasoning support. Built on fetch + SSE,
// no third-party SDK dependency keeps the bun binary tiny.

import { BASE_URL } from "./models.ts";

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

  const res = await fetch(`${opts.baseUrl ?? BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) throw new DeepSeekUnauthorized();
    if (res.status === 429) throw new DeepSeekRateLimit();
    throw new DeepSeekError(
      `DeepSeek API error ${res.status}: ${truncate(text, 500)}`,
      res.status,
      text,
    );
  }

  if (!res.body) {
    throw new DeepSeekError("Empty response body from DeepSeek API.");
  }

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
        if (chunk) yield chunk;
      }
    }
    // Flush any trailing event
    if (buf.trim().length > 0) {
      const chunk = parseSSEEvent(buf);
      if (chunk) yield chunk;
    }
  } finally {
    reader.releaseLock();
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
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e instanceof DeepSeekUnauthorized) throw e; // do not retry auth
      if (e instanceof DeepSeekRateLimit) {
        // Backoff harder on rate limit
        const delay = baseDelayMs * Math.pow(2, attempt) * 2;
        await sleep(delay);
        attempt++;
        continue;
      }
      attempt++;
      if (attempt >= maxAttempts) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
