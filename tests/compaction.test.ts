import { describe, it, expect } from "bun:test";
import { shouldCompact, applyCompaction } from "../src/agent/compaction.ts";
import type { ChatMessage } from "../src/api/client.ts";

function sys(msg: string): ChatMessage {
  return { role: "system", content: msg };
}
function usr(msg: string): ChatMessage {
  return { role: "user", content: msg };
}
function asst(msg: string): ChatMessage {
  return { role: "assistant", content: msg };
}

describe("shouldCompact", () => {
  it("returns null when conversation is too short", () => {
    const msgs = [sys("prompt"), usr("hi"), asst("hello")];
    expect(shouldCompact(msgs)).toBeNull();
  });

  it("returns null when below the drop threshold", () => {
    // 8 messages = 4 pairs, below default threshold of 6 dropped
    const msgs = [sys("prompt"), usr("a"), asst("b"), usr("c"), asst("d"), usr("e"), asst("f"), usr("g")];
    expect(shouldCompact(msgs)).toBeNull();
  });

  it("returns dropped messages when above threshold", () => {
    // Create enough user/assistant pairs to cross the threshold
    const msgs: ChatMessage[] = [sys("system prompt")];
    for (let i = 0; i < 20; i++) {
      msgs.push(usr(`user ${i}`));
      msgs.push(asst(`assistant ${i}`));
    }
    const result = shouldCompact(msgs, 6);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.droppedMessages.length).toBeGreaterThanOrEqual(6);
      // System message at position 0 is preserved.
      expect(result.droppedMessages[0].role).toBe("user");
    }
  });

  it("preserves system messages at the top", () => {
    const msgs: ChatMessage[] = [sys("sys1"), sys("sys2")];
    for (let i = 0; i < 20; i++) {
      msgs.push(usr(`u${i}`));
      msgs.push(asst(`a${i}`));
    }
    const result = shouldCompact(msgs, 6);
    expect(result).not.toBeNull();
    if (result) {
      // Dropped messages should start with the first user message, not a system message.
      expect(result.droppedMessages[0].role).toBe("user");
    }
  });

  it("preserves env context injected user messages", () => {
    const msgs: ChatMessage[] = [
      sys("system prompt"),
      usr("## Environment\ncwd: /test"),
      usr("## Project instructions\nDo X"),
    ];
    for (let i = 0; i < 20; i++) {
      msgs.push(usr(`u${i}`));
      msgs.push(asst(`a${i}`));
    }
    const result = shouldCompact(msgs, 6);
    expect(result).not.toBeNull();
    if (result) {
      // Dropped messages should start after the env/project context.
      const firstDropped = result.droppedMessages[0];
      expect(firstDropped.role).toBe("user");
      expect(typeof firstDropped.content === "string" ? firstDropped.content : "").not.toContain("## Environment");
    }
  });
});

describe("applyCompaction", () => {
  it("replaces dropped messages with a summary message", () => {
    const msgs: ChatMessage[] = [
      sys("system"),
      usr("u1"), asst("a1"),
      usr("u2"), asst("a2"),
      usr("u3"), asst("a3"),
      usr("current"),
    ];
    const dropped = msgs.slice(1, 5); // u1,a1,u2,a2
    const summaryMsg: ChatMessage = { role: "system", content: "## Compacted\nSummary here" };

    const result = applyCompaction(msgs, dropped, summaryMsg);

    // Should have: sys, compacted summary, u3, a3, current
    expect(result.length).toBe(5);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("system");
    expect(result[1].content).toContain("Compacted");
    expect(result[2].role).toBe("user");
    expect(result[2].content).toBe("u3");
    expect(result[3].role).toBe("assistant");
    expect(result[4].role).toBe("user");
    expect(result[4].content).toBe("current");
  });

  it("preserves messages before the dropped range", () => {
    const msgs: ChatMessage[] = [
      sys("system"),
      usr("u1"), asst("a1"),
      usr("u2"), asst("a2"),
    ];
    const dropped = msgs.slice(1, 3); // u1, a1
    const summaryMsg: ChatMessage = { role: "system", content: "summary" };

    const result = applyCompaction(msgs, dropped, summaryMsg);

    expect(result.length).toBe(4);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe("system");
    expect(result[1].role).toBe("system");
    expect(result[1].content).toBe("summary");
    expect(result[2].role).toBe("user");
    expect(result[3].role).toBe("assistant");
  });
});
