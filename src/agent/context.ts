// Context window manager — trims older turns to stay under the model's token limit.
// Supports LLM-driven compaction for smarter context preservation (P0 optimization).

import type { ChatMessage } from "../api/client.ts";
import { estimateConversationTokens } from "../api/tokens.ts";
import { compactMessages, COMPACTION_DROP_THRESHOLD, shouldCompact, applyCompaction } from "./compaction.ts";
import { log } from "../log/logger.ts";

const DEFAULT_MAX_CONTEXT_TOKENS = 60_000;
const DEFAULT_RESERVED_FOR_REPLY = 8_000;

export interface TrimResult {
  messages: ChatMessage[];
  droppedTurns: number;
  tokensBefore: number;
  tokensAfter: number;
  /** If compaction was used instead of simple dropping. */
  compacted?: boolean;
  compactionSavings?: number;
}

export interface TrimOptions {
  maxContext?: number;
  reserved?: number;
  /** API key for compaction calls (flash model). */
  apiKey?: string;
  /** Base URL override for compaction API calls. */
  baseUrl?: string;
  /** Cooldown counter — incremented each compaction, reset when below threshold. */
  compactionCooldown?: { value: number };
}

/**
 * Trims conversation messages to fit the operational context window.
 * When too many turns would be dropped, attempts LLM-driven compaction first.
 * Preserves system messages and the latest user turn (the active task).
 */
export function trimToFit(
  messages: ChatMessage[],
  maxContext = DEFAULT_MAX_CONTEXT_TOKENS,
  reserved = DEFAULT_RESERVED_FOR_REPLY,
): TrimResult {
  const budget = maxContext - reserved;
  const tokensBefore = estimateConversationTokens(messages);
  if (tokensBefore <= budget) {
    return { messages, droppedTurns: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  const head = messages.length > 0 && messages[0].role === "system"
    ? [messages[0]]
    : [];
  const rest = head.length ? messages.slice(1) : messages.slice();

  let kept: ChatMessage[] = [];
  let keptTokens = estimateConversationTokens(head);
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i];
    const t = estimateTokensFor(m);
    if (keptTokens + t > budget) break;
    kept.unshift(m);
    keptTokens += t;
  }
  const dropped = rest.length - kept.length;
  const out: ChatMessage[] = [...head, ...kept];
  return {
    messages: out,
    droppedTurns: dropped,
    tokensBefore,
    tokensAfter: estimateConversationTokens(out),
  };
}

/**
 * Async trim with optional LLM compaction.
 * Call this instead of synchronous trimToFit when in an async context
 * and apiKey is available.
 */
export async function trimToFitWithCompaction(
  messages: ChatMessage[],
  opts: TrimOptions = {},
): Promise<TrimResult> {
  const maxContext = opts.maxContext ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const reserved = opts.reserved ?? DEFAULT_RESERVED_FOR_REPLY;
  const budget = maxContext - reserved;
  const tokensBefore = estimateConversationTokens(messages);

  if (tokensBefore <= budget) {
    return { messages, droppedTurns: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  // Check if compaction would help.
  const compactionCandidate = shouldCompact(messages, COMPACTION_DROP_THRESHOLD);
  const cooldown = opts.compactionCooldown?.value ?? 0;

  if (compactionCandidate && opts.apiKey && cooldown <= 0) {
    log.info("compaction candidate", {
      toDrop: compactionCandidate.droppedMessages.length,
      cooldown,
    });

    const result = await compactMessages(
      opts.apiKey,
      compactionCandidate.droppedMessages,
      opts.baseUrl,
    );

    if (result) {
      const compacted = applyCompaction(
        messages,
        compactionCandidate.droppedMessages,
        result.summaryMessage,
      );

      // Reset cooldown.
      if (opts.compactionCooldown) {
        opts.compactionCooldown.value = 3;
      }

      // Still trim if compacted messages exceed budget.
      const afterCompactionTokens = estimateConversationTokens(compacted);
      if (afterCompactionTokens > budget) {
        return trimToFit(compacted, maxContext, reserved);
      }

      return {
        messages: compacted,
        droppedTurns: result.droppedCount,
        tokensBefore,
        tokensAfter: afterCompactionTokens,
        compacted: true,
        compactionSavings: result.savings,
      };
    }

    // Compaction failed — fall through to standard trim.
  }

  // Decrement cooldown each turn.
  if (opts.compactionCooldown && opts.compactionCooldown.value > 0) {
    opts.compactionCooldown.value--;
  }

  return trimToFit(messages, maxContext, reserved);
}

export function defaultMaxContext(): number {
  return DEFAULT_MAX_CONTEXT_TOKENS;
}
export function defaultReserved(): number {
  return DEFAULT_RESERVED_FOR_REPLY;
}

function estimateTokensFor(m: ChatMessage): number {
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
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const other = s.length - cjk;
  return Math.ceil(cjk / 2 + other / 4);
}
