// Content block-level message management: splits compound assistant messages
// into individual content blocks for finer-grained token tracking and caching.
// Inspired by claude's wS/tgf/GCt message normalization pipeline.
//
// Each block has its own UUID and token estimate, allowing the context
// trimmer to make per-block decisions instead of per-message ones.

import type { ChatMessage } from "../api/client.ts";
import { estimateTokens } from "../api/tokens.ts";

export interface ContentBlock {
  /** Unique ID for this block (deterministic from message uuid + index). */
  id: string;
  /** Block type. */
  type: "text" | "tool_use" | "tool_result" | "reasoning" | "image";
  /** Role of the parent message. */
  role: "assistant" | "user" | "tool" | "system";
  /** The block content. */
  content: string;
  /** Estimated token count. */
  tokens: number;
  /** Original message index in the conversation. */
  messageIndex: number;
  /** Block index within the original message. */
  blockIndex: number;
}

/**
 * Split a compound assistant message (that may contain text + multiple
 * tool_calls) into individual content blocks.
 */
export function splitMessage(
  msg: ChatMessage,
  messageIndex: number,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const uuid = (msg as { uuid?: string }).uuid ?? `msg_${messageIndex}`;
  let blockIdx = 0;

  // Text content (skip for tool messages — they go into tool_result).
  if (typeof msg.content === "string" && msg.content.length > 0 && msg.role !== "tool") {
    blocks.push({
      id: `${uuid}_b${blockIdx}_text`,
      type: "text",
      role: msg.role,
      content: msg.content,
      tokens: estimateTokens(msg.content),
      messageIndex,
      blockIndex: blockIdx++,
    });
  }

  // Reasoning content.
  if (msg.reasoning_content && msg.reasoning_content.length > 0) {
    blocks.push({
      id: `${uuid}_b${blockIdx}_reasoning`,
      type: "reasoning",
      role: msg.role,
      content: msg.reasoning_content,
      tokens: estimateTokens(msg.reasoning_content),
      messageIndex,
      blockIndex: blockIdx++,
    });
  }

  // Tool calls.
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      const tcContent = JSON.stringify({
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
      });
      blocks.push({
        id: tc.id ?? `${uuid}_b${blockIdx}_tc`,
        type: "tool_use",
        role: msg.role,
        content: tcContent,
        tokens: estimateTokens(tcContent) + 8,
        messageIndex,
        blockIndex: blockIdx++,
      });
    }
  }

  // Tool result.
  if (msg.role === "tool" && typeof msg.content === "string") {
    blocks.push({
      id: msg.tool_call_id ?? `${uuid}_b${blockIdx}_tr`,
      type: "tool_result",
      role: "tool",
      content: msg.content,
      tokens: estimateTokens(msg.content),
      messageIndex,
      blockIndex: blockIdx++,
    });
  }

  // System messages.
  if (msg.role === "system" && typeof msg.content === "string") {
    blocks.push({
      id: `${uuid}_b${blockIdx}_sys`,
      type: "text",
      role: "system",
      content: msg.content,
      tokens: estimateTokens(msg.content),
      messageIndex,
      blockIndex: blockIdx++,
    });
  }

  return blocks;
}

/**
 * Split the entire conversation into content blocks for per-block token
 * tracking. Used by the context trimmer for finer-grained decisions.
 */
export function splitConversation(messages: ChatMessage[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < messages.length; i++) {
    blocks.push(...splitMessage(messages[i], i));
  }
  return blocks;
}

/**
 * Aggregate content blocks back into ChatMessage array.
 * Merges adjacent blocks from the same original message back together.
 */
export function mergeBlocks(blocks: ContentBlock[]): ChatMessage[] {
  const groups = new Map<number, ContentBlock[]>();
  for (const b of blocks) {
    const g = groups.get(b.messageIndex) ?? [];
    g.push(b);
    groups.set(b.messageIndex, g);
  }

  const indices = [...groups.keys()].sort((a, b) => a - b);
  const messages: ChatMessage[] = [];
  for (const idx of indices) {
    const group = groups.get(idx)!;
    const first = group[0];
    const msg: ChatMessage = { role: first.role, content: null };

    for (const b of group) {
      switch (b.type) {
        case "text":
          msg.content = (msg.content ?? "") + b.content;
          break;
        case "reasoning":
          msg.reasoning_content = (msg.reasoning_content ?? "") + b.content;
          break;
        case "tool_use": {
          const tc = JSON.parse(b.content);
          msg.tool_calls = msg.tool_calls ?? [];
          msg.tool_calls.push({
            id: b.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          });
          break;
        }
        case "tool_result":
          msg.content = b.content;
          msg.tool_call_id = b.id;
          msg.role = "tool";
          break;
      }
    }
    messages.push(msg);
  }
  return messages;
}

/**
 * Estimate total tokens in an array of content blocks.
 */
export function estimateBlockTokens(blocks: ContentBlock[]): number {
  let total = 0;
  for (const b of blocks) total += b.tokens + 4; // +4 for message overhead
  return total;
}
