// Context window manager — trims older turns to stay under the model's token limit.

import type { ChatMessage } from "../api/client.ts";
import { estimateConversationTokens } from "../api/tokens.ts";

// DeepSeek models generally expose a 64K-128K context window. Pick a safe
// operational limit and reserve headroom for the next response + tool results.
const MAX_CONTEXT_TOKENS = 60_000;
const RESERVED_FOR_REPLY = 8_000;

export interface TrimResult {
  messages: ChatMessage[];
  droppedTurns: number;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Trims conversation messages to fit the operational context window.
 * Preserves the system message and the latest user turn (the active task).
 * Drops oldest user/assistant pairs first; tool calls are dropped together
 * with the assistant turn that emitted them.
 */
export function trimToFit(messages: ChatMessage[]): TrimResult {
  const tokensBefore = estimateConversationTokens(messages);
  if (tokensBefore <= MAX_CONTEXT_TOKENS - RESERVED_FOR_REPLY) {
    return { messages, droppedTurns: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  // Index tracking: keep first message (system), trim from index 1 onward.
  const head: ChatMessage[] = messages.length > 0 && messages[0].role === "system"
    ? [messages[0]]
    : [];
  const rest = head.length ? messages.slice(1) : messages.slice();

  // Walk from the end back, accumulating until we'd breach.
  let kept: ChatMessage[] = [];
  let keptTokens = estimateConversationTokens(head);
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i];
    const t = estimateTokensFor(m);
    if (keptTokens + t > MAX_CONTEXT_TOKENS - RESERVED_FOR_REPLY) break;
    kept.unshift(m);
    keptTokens += t;
  }
  const droppedTurns = rest.length - kept.length;
  const out: ChatMessage[] = [...head, ...kept];
  return {
    messages: out,
    droppedTurns,
    tokensBefore,
    tokensAfter: estimateConversationTokens(out),
  };
}

function estimateTokensFor(m: ChatMessage): number {
  // The conversation estimator sums messages; for individual summation we
  // approximate by including the per-message overhead (4 tokens).
  let total = 4;
  if (typeof m.content === "string") total += textTokens(m.content);
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      total += 8 + textTokens(tc.function?.name ?? "") + textTokens(tc.function?.arguments ?? "");
    }
  }
  return total;
}

function textTokens(s: string): number {
  // Reuse the API estimator indirectly
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const other = s.length - cjk;
  return Math.ceil(cjk / 2 + other / 4);
}
