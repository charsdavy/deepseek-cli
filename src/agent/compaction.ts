// LLM-driven context compaction: replaces old messages with a model-generated
// summary instead of blindly dropping them. Inspired by codex's compaction
// mechanism — the model summarizes its own conversation history, preserving
// semantic continuity while freeing up the context window.
//
// Architecture:
//   - Compaction is triggered when trimToFit() would drop more than
//     COMPACTION_DROP_THRESHOLD turns.
//   - A lightweight API call (flash model, no tools, no reasoning) generates
//     a structured summary of the dropped turns.
//   - The summary replaces the original messages as a single system-role
//     message, keeping the token footprint minimal.
//   - Post-compaction hooks allow verification/augmentation (future).
//
// Token economy:
//   - Summary prompt is bounded (~500 tokens) + dropped messages
//   - Response capped at 1500 tokens (compact summary size)
//   - Compaction fires at most once per turn, with a cooldown to prevent
//     runaway compaction loops.

import { BASE_URL } from "../api/models.ts";
import type { ChatMessage } from "../api/client.ts";
import { estimateConversationTokens } from "../api/tokens.ts";
import { log } from "../log/logger.ts";

export const COMPACTION_DROP_THRESHOLD = 6;
export const COMPACTION_COOLDOWN_TURNS = 3;
export const COMPACTION_RESPONSE_MAX_TOKENS = 1500;

export interface CompactionResult {
  summaryMessage: ChatMessage;
  droppedCount: number;
  originalTokens: number;
  summaryTokens: number;
  savings: number;
}

/**
 * Build the compaction prompt — instructs the model to create a structured
 * summary of the conversation history that will replace the original messages.
 */
function buildCompactionPrompt(droppedMessages: ChatMessage[]): string {
  const conversationText = droppedMessages
    .map((m) => {
      const role = m.role;
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const tools = m.tool_calls
        ? ` [TOOL_CALLS: ${m.tool_calls.map((tc) => tc.function.name).join(", ")}]`
        : "";
      return `[${role}]${tools}: ${content.slice(0, 3000)}`;
    })
    .join("\n\n");

  return `## Context Compaction
The conversation below is being compacted to save context space. Produce a structured summary that captures:

1. **Key decisions made** — what was decided and why
2. **Files read/modified** — paths and what was done
3. **Current task state** — what's completed, in-flight, and remaining
4. **Important findings** — bugs discovered, patterns identified, constraints noted
5. **Open questions** — anything unresolved that needs follow-up

Format as a single Markdown list with clear headings. Be concise — this summary replaces ${droppedMessages.length} messages.

## Conversation to summarize
${conversationText}

## Summary (be concise, use bullet points):`;
}

/**
 * Call the API with a compaction prompt to generate a summary.
 * Uses the flash model without tools or reasoning for minimum cost.
 */
export async function compactMessages(
  apiKey: string,
  droppedMessages: ChatMessage[],
  baseUrl?: string,
): Promise<CompactionResult | null> {
  if (droppedMessages.length < COMPACTION_DROP_THRESHOLD) return null;

  const originalTokens = estimateConversationTokens(droppedMessages);
  const prompt = buildCompactionPrompt(droppedMessages);

  log.info("compaction start", {
    droppedMessages: droppedMessages.length,
    originalTokens,
    promptLen: prompt.length,
  });

  try {
    const res = await fetch(`${baseUrl ?? BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: prompt }],
        max_tokens: COMPACTION_RESPONSE_MAX_TOKENS,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      log.warn("compaction api error", { status: res.status });
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { total_tokens?: number };
    };
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary || summary.length < 10) {
      log.warn("compaction empty summary");
      return null;
    }

    const summaryTokens = data.usage?.total_tokens ?? estimateConversationTokens([{ role: "user", content: summary }]);
    const savings = originalTokens - summaryTokens;

    const summaryMessage: ChatMessage = {
      role: "system",
      content: `## Compacted conversation history (${droppedMessages.length} turns summarized)\n${summary}`,
    };

    log.info("compaction done", {
      droppedCount: droppedMessages.length,
      originalTokens,
      summaryTokens,
      savings,
    });

    return {
      summaryMessage,
      droppedCount: droppedMessages.length,
      originalTokens,
      summaryTokens,
      savings,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("compaction failed", { error: msg });
    return null;
  }
}

/**
 * Check whether compaction should be triggered for this conversation.
 * Returns the range of messages that can be compacted (oldest pair segment).
 */
export function shouldCompact(
  messages: ChatMessage[],
  dropThreshold = COMPACTION_DROP_THRESHOLD,
): { droppedMessages: ChatMessage[] } | null {
  if (messages.length < dropThreshold * 2 + 2) return null;

  // System messages at the top are preserved.
  let start = 0;
  while (start < messages.length && messages[start].role === "system") {
    start++;
  }

  // Environment context and project instructions (user messages injected
  // right after system) are also preserved — they're one-shot context.
  if (start < messages.length && messages[start].role === "user") {
    const rawContent = messages[start].content;
    const c = typeof rawContent === "string" ? rawContent : "";
    if (c.startsWith("## Environment") || c.startsWith("## Project instructions")) {
      start++;
      if (start < messages.length && messages[start].role === "user") {
        const rawContent2 = messages[start].content;
        const c2 = typeof rawContent2 === "string" ? rawContent2 : "";
        if (c2.startsWith("## Project instructions")) {
          start++;
        }
      }
    }
  }

  // Count how many messages we can drop — from 'start' to before the last
  // few turns (keep recent context intact).
  const keepLast = dropThreshold; // keep the most recent N messages
  const end = messages.length - keepLast;
  const droppedMessages = messages.slice(start, end);

  if (droppedMessages.length < dropThreshold) return null;
  return { droppedMessages };
}

/**
 * Replace compacted messages with the summary in the message array.
 * Preserves system messages and recent context. Returns the new array.
 */
export function applyCompaction(
  messages: ChatMessage[],
  droppedMessages: ChatMessage[],
  summaryMessage: ChatMessage,
): ChatMessage[] {
  // Find where the dropped range starts
  let insertIdx = 0;
  const firstContent = droppedMessages[0]?.content;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === droppedMessages[0]?.role &&
        messages[i].content === firstContent) {
      insertIdx = i;
      break;
    }
  }

  // Build new array: head up to insertIdx + summary + recent turns
  const head = messages.slice(0, insertIdx);
  const tail = messages.slice(insertIdx + droppedMessages.length);
  return [...head, summaryMessage, ...tail];
}
