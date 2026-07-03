import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { makeStreamRenderer } from "../src/agent/loop.ts";
import { spinner } from "../src/ui/spinner.ts";
import { setOutputSilent } from "../src/ui/render.ts";

// Capture BOTH process.stdout.write (used by writeLine, reasoning, spinner)
// AND Bun.stdout.write (used by streamWrite for content lines).
function captureStdout(): { captured: string; restore: () => void } {
  let captured = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;

  const origBunWrite = Bun.stdout.write.bind(Bun.stdout);
  (Bun.stdout as { write: (chunk: string | Uint8Array) => Promise<number> }).write = ((
    chunk: string | Uint8Array,
  ) => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return Promise.resolve(typeof chunk === "string" ? chunk.length : chunk.length);
  }) as typeof Bun.stdout.write;

  return {
    get captured() {
      return captured;
    },
    restore() {
      process.stdout.write = origWrite;
      (Bun.stdout as { write: typeof Bun.stdout.write }).write = origBunWrite;
    },
  };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

describe("makeStreamRenderer", () => {
  beforeEach(() => {
    setOutputSilent(false);
    spinner.stop();
  });

  afterEach(() => {
    spinner.stop();
    setOutputSilent(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Bug 2: onReasoningDelta must always stop the spinner, even when
  // inReasoning is stale true from a previous iteration.
  // ═══════════════════════════════════════════════════════════════════
  it("onReasoningDelta stops the spinner even when inReasoning is stale true (Bug 2)", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: true, model: "test-model" });
    try {
      // --- Iteration 1 ---
      spinner.start("thinking…");
      expect(spinner.isActive()).toBe(true);
      // Delta with \n so it's output immediately (reasoning is line-buffered).
      renderer.onReasoningDelta("thinking about the task\n");
      expect(spinner.isActive()).toBe(false);
      expect(stripAnsi(cap.captured)).toContain("reasoning");
      expect(stripAnsi(cap.captured)).toContain("thinking about the task");

      // --- Iteration 2: spinner re-started, inReasoning still true ---
      spinner.start("thinking…");
      expect(spinner.isActive()).toBe(true);
      renderer.onReasoningDelta("more thinking in iteration 2\n");
      expect(spinner.isActive()).toBe(false);
      expect(stripAnsi(cap.captured)).toContain("more thinking in iteration 2");
    } finally {
      renderer.end();
      cap.restore();
    }
  });

  it("onReasoningDelta writes the 🧠 header on the first delta only", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: true, model: "m" });
    try {
      renderer.onReasoningDelta("chunk1\n");
      renderer.onReasoningDelta("chunk2\n");
      const plain = stripAnsi(cap.captured);
      // Header appears once.
      const headerCount = (plain.match(/reasoning/g) || []).length;
      expect(headerCount).toBe(1);
      expect(plain).toContain("chunk1");
      expect(plain).toContain("chunk2");
    } finally {
      renderer.end();
      cap.restore();
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Reasoning is line-buffered: partial lines (no \n) are NOT output
  // until a newline arrives or flush()/end() is called. The cursor rests
  // at col 0 of the empty line below the last complete line instead of
  // trailing along with every character fragment.
  // ═══════════════════════════════════════════════════════════════════
  it("reasoning buffers partial lines — cursor doesn't trail mid-line", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: true, model: "m" });
    try {
      // Header IS output immediately (writeLine).
      renderer.onReasoningDelta("partial text");
      // "partial text" has no \n → buffered, NOT output.
      expect(stripAnsi(cap.captured)).toContain("reasoning"); // header
      expect(stripAnsi(cap.captured)).not.toContain("partial text");

      // Complete line arrives → both fragments output as one line.
      renderer.onReasoningDelta(" continues\n");
      const plain = stripAnsi(cap.captured);
      expect(plain).toContain("partial text continues");

      // Another partial — buffered again.
      const lenAfter = cap.captured.length;
      renderer.onReasoningDelta("not yet");
      expect(cap.captured.length).toBe(lenAfter); // nothing new written

      // flush() outputs the remaining partial line.
      renderer.flush();
      expect(stripAnsi(cap.captured)).toContain("not yet");
    } finally {
      renderer.end();
      cap.restore();
    }
  });

  it("onContentDelta flushes remaining reasoning before label", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: true, model: "mymodel" });
    try {
      spinner.start("thinking…");
      // Partial reasoning — buffered, not output.
      renderer.onReasoningDelta("let me think");
      expect(stripAnsi(cap.captured)).not.toContain("let me think");
      expect(spinner.isActive()).toBe(false);

      // Content arrives — flushes the partial reasoning, then writes label.
      renderer.onContentDelta("Hello world\n");
      const plain = stripAnsi(cap.captured);
      expect(plain).toContain("let me think"); // flushed
      expect(plain).toContain("mymodel"); // label
      expect(plain).toContain("Hello world"); // content
    } finally {
      renderer.end();
      cap.restore();
    }
  });

  it("onContentDelta stops the spinner on the first content delta", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: false, model: "m" });
    try {
      spinner.start("thinking…");
      expect(spinner.isActive()).toBe(true);
      renderer.onContentDelta("answer");
      expect(spinner.isActive()).toBe(false);
    } finally {
      renderer.end();
      cap.restore();
    }
  });

  it("onReasoningDelta is suppressed when showReasoning is false", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: false, model: "m" });
    try {
      spinner.start("thinking…");
      renderer.onReasoningDelta("secret thoughts\n");
      spinner.stop();
      const plain = stripAnsi(cap.captured);
      expect(plain).not.toContain("secret thoughts");
      expect(plain).not.toContain("reasoning");
    } finally {
      renderer.end();
      cap.restore();
    }
  });

  it("full multi-iteration flow: reasoning → tools → reasoning → content", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: true, model: "test" });
    try {
      // Iteration 1: reasoning → tools (no content)
      spinner.start("thinking…");
      renderer.onReasoningDelta("iter1 reasoning\n");
      expect(spinner.isActive()).toBe(false);

      renderer.flush();
      spinner.startTool("running tool…");
      spinner.stop();

      // Iteration 2: reasoning → content
      spinner.start("thinking…");
      renderer.onReasoningDelta("iter2 reasoning\n");
      expect(spinner.isActive()).toBe(false);

      renderer.onContentDelta("final answer\n");
      expect(spinner.isActive()).toBe(false);

      const plain = stripAnsi(cap.captured);
      expect(plain).toContain("iter1 reasoning");
      expect(plain).toContain("iter2 reasoning");
      expect(plain).toContain("final answer");
      expect(plain).toContain("test"); // model label
    } finally {
      renderer.end();
      cap.restore();
    }
  });

  it("end() flushes remaining reasoning with a newline", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: true, model: "m" });
    try {
      renderer.onReasoningDelta("unfinished reasoning without newline");
      // Partial — not output yet.
      expect(stripAnsi(cap.captured)).not.toContain("unfinished reasoning");
      const lenBeforeEnd = cap.captured.length;
      renderer.end();
      const tail = cap.captured.slice(lenBeforeEnd);
      // Should contain the flushed text + a newline.
      expect(stripAnsi(tail)).toContain("unfinished reasoning without newline");
      expect(tail).toContain("\n");
    } finally {
      cap.restore();
    }
  });

  it("end() closes an unclosed code fence in content", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: false, model: "m" });
    try {
      renderer.onContentDelta("```ts\nconst x = 1;\n");
      renderer.end();
      const plain = stripAnsi(cap.captured);
      expect(plain).toContain("└");
    } finally {
      cap.restore();
    }
  });
});
