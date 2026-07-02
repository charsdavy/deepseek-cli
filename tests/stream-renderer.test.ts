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

  // streamWrite in render.ts uses Bun.stdout.write (returns Promise<number>).
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

// Strip ANSI escape sequences for readable assertions.
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
  //
  // Scenario: iteration 1 has reasoning → tools (no content). inReasoning
  // stays true. The agent loop re-starts "thinking…" spinner at the top
  // of iteration 2. When reasoning deltas arrive, the OLD code skipped
  // spinner.stop() because inReasoning was already true, so the spinner's
  // 80ms render() clobbered the reasoning text.
  // ═══════════════════════════════════════════════════════════════════
  it("onReasoningDelta stops the spinner even when inReasoning is stale true (Bug 2)", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: true, model: "test-model" });
    try {
      // --- Iteration 1: reasoning → (no content, simulate tools next) ---

      // Spinner is started by the agent loop at the top of each iteration.
      spinner.start("thinking…");
      expect(spinner.isActive()).toBe(true);

      // First reasoning delta: stops spinner, writes header + text.
      renderer.onReasoningDelta("thinking about the task");
      expect(spinner.isActive()).toBe(false);
      expect(stripAnsi(cap.captured)).toContain("reasoning");
      expect(stripAnsi(cap.captured)).toContain("thinking about the task");

      // --- Simulate tools finishing, loop back to iteration 2 ---

      // The agent loop re-starts the spinner at the top of the next iteration.
      // inReasoning is still true from iteration 1 (no content reset it).
      spinner.start("thinking…");
      expect(spinner.isActive()).toBe(true);

      // Second reasoning delta: MUST stop the spinner again.
      // Bug 2: the old code skipped spinner.stop() because inReasoning was
      // already true, so the spinner stayed active and clobbered the text.
      renderer.onReasoningDelta("more thinking in iteration 2");
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
      renderer.onReasoningDelta("chunk1");
      renderer.onReasoningDelta(" chunk2");
      const plain = stripAnsi(cap.captured);
      // Header appears once.
      const headerCount = (plain.match(/reasoning/g) || []).length;
      expect(headerCount).toBe(1);
      // Both chunks appear.
      expect(plain).toContain("chunk1");
      expect(plain).toContain("chunk2");
    } finally {
      renderer.end();
      cap.restore();
    }
  });

  it("onContentDelta writes a label after reasoning", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: true, model: "mymodel" });
    try {
      spinner.start("thinking…");
      // Reasoning first
      renderer.onReasoningDelta("let me think");
      expect(spinner.isActive()).toBe(false);

      // Then content — should print a label line + the content.
      renderer.onContentDelta("Hello world\n");
      const plain = stripAnsi(cap.captured);
      expect(plain).toContain("mymodel");
      expect(plain).toContain("Hello world");
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
      renderer.onReasoningDelta("secret thoughts");
      spinner.stop();
      const plain = stripAnsi(cap.captured);
      expect(plain).not.toContain("secret thoughts");
      expect(plain).not.toContain("reasoning");
    } finally {
      renderer.end();
      cap.restore();
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Multi-iteration scenario: reasoning → tools → reasoning → content.
  // This is the full flow that was broken.
  // ═══════════════════════════════════════════════════════════════════
  it("full multi-iteration flow: reasoning → tools → reasoning → content", () => {
    const cap = captureStdout();
    const renderer = makeStreamRenderer({ showReasoning: true, model: "test" });
    try {
      // Iteration 1: reasoning → tools (no content)
      spinner.start("thinking…");
      renderer.onReasoningDelta("iter1 reasoning");
      expect(spinner.isActive()).toBe(false);

      // Tools execute (renderer.flush is called before tool markers)
      renderer.flush();
      spinner.startTool("running tool…");
      spinner.stop();
      // Loop back to iteration 2

      // Iteration 2: reasoning → content
      spinner.start("thinking…");
      renderer.onReasoningDelta("iter2 reasoning");
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
      // end() should write a newline to move to a fresh line
      const lenBeforeEnd = cap.captured.length;
      renderer.end();
      const tail = cap.captured.slice(lenBeforeEnd);
      // Should contain at least one newline to end the reasoning line.
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
      // The closing fence marker should be present.
      expect(plain).toContain("└");
    } finally {
      cap.restore();
    }
  });
});
