// Rough token estimator. DeepSeek tokenizer isn't public; we approximate
// with a heuristic close enough for context-window management.

// English: ~4 chars per token. Chinese / CJK: ~2 chars per token because
// each glyph is its own token in most BPE tokenizers. Code mixes both.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk / 2 + other / 4);
}

export interface MessageLike {
  role: string;
  content?: string | null | unknown[] | unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

export function estimateMessageTokens(msg: MessageLike): number {
  // Role overhead ~4 tokens per message framing
  let total = 4;
  const c = msg.content;
  if (typeof c === "string") total += estimateTokens(c);
  else if (Array.isArray(c)) {
    for (const part of c) {
      if (part && typeof part === "object" && "text" in part) {
        total += estimateTokens(String((part as { text?: string }).text ?? ""));
      }
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      const fn = tc.function;
      if (fn) {
        total += 8 + estimateTokens(fn.name ?? "") + estimateTokens(fn.arguments ?? "");
      }
    }
  }
  return total;
}

export function estimateConversationTokens(messages: MessageLike[]): number {
  // 3-token priming overhead per OpenAI convention
  return 3 + messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
}
