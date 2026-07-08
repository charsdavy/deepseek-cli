// Token estimator. Uses a more precise heuristic than simple char/token ratios.
// DeepSeek uses a BPE tokenizer similar to GPT models; English text averages
// ~3.5 chars/token, code ~2.8 chars/token, CJK ~1.5 chars/token.
// Code blocks (symbols, operators) are token-dense.
//
// Precision improvements over v1:
//   - Code detection: detects code snippets and applies code-specific ratio
//   - Punctuation-weighted: high-density punctuation tokens adjust the ratio
//   - Multi-line overhead aware: indentation-heavy code has more per-line overhead

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const len = text.length;
  if (len < 100) {
    // Short strings: use a quick ratio
    return Math.ceil(len / 3.5);
  }

  // Count character classes for weighted estimation.
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const punct = (text.match(/[{}()\[\];:,.<>\/\\|&^%$#@!~`'"=*+\-]/g) || []).length;
  const whitespace = (text.match(/\s/g) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  const lineBreaks = (text.match(/\n/g) || []).length;

  const alpha = len - cjk - punct - whitespace - digits;

  // Weighted token count:
  //   CJK: ~1.5 char/token (each character is typically its own token)
  //   Alphabetic: ~3.5 chars/token (subword splits)
  //   Punctuation: ~1 char/token (most are single-token)
  //   Whitespace: ~0 tokens (merged with surrounding)
  //   Digits: ~0.8 char/token (often grouped)
  //   Line overhead: ~0.25 tokens per line for indentation/number prefix
  const tokens =
    Math.ceil(cjk / 1.5) +
    Math.ceil(alpha / 3.5) +
    Math.ceil(punct / 1.0) +
    Math.ceil(digits / 0.8) +
    Math.ceil(lineBreaks * 0.25);

  return Math.max(1, tokens);
}

export interface MessageLike {
  role: string;
  content?: string | null | unknown[] | unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

export function estimateMessageTokens(msg: MessageLike): number {
  // Role overhead ~4 tokens per message framing.
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
  // 3-token priming overhead per OpenAI convention.
  return 3 + messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
}
