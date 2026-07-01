import { describe, it, expect } from "bun:test";
import { runAgentLoop } from "../src/agent/loop.ts";
import { PermissionManager } from "../src/agent/permissions.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/types.ts";

// ---- helpers ----

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sseResponse(events: string[]): Response {
  const body = new ReadableStream({
    start(ctl) {
      ctl.enqueue(new TextEncoder().encode(events.join("")));
      ctl.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function mockFetchSequence(responses: Response[]): typeof fetch {
  let i = 0;
  return (async () => responses[i++] ?? responses[responses.length - 1]) as unknown as typeof fetch;
}

const echoTool: Tool = {
  name: "echo",
  description: "echo back the msg argument",
  category: "memory",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: { msg: { type: "string" } },
    required: ["msg"],
    additionalProperties: false,
  },
  async execute(args) {
    return { ok: true, content: String(args.msg ?? "") };
  },
};

function registryWith(...tools: Tool[]): ToolRegistry {
  return new ToolRegistry(tools);
}

// ---- tests ----

describe("runAgentLoop", () => {
  it("executes a tool call and loops to a final answer", async () => {
    const tools = registryWith(echoTool);
    const perms = new PermissionManager({ mode: "auto" });

    const r1 = sseResponse([
      sseData({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: '{"msg":"hi"}' } }] } }],
      }),
    ]);
    const r2 = sseResponse([
      sseData({ choices: [{ delta: { content: "don" } }] }),
      sseData({ choices: [{ delta: { content: "e" } }] }),
      sseData({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      "data: [DONE]\n\n",
    ]);

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence([r1, r2]);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "echo hi" }],
        { apiKey: "sk-test", model: "deepseek-chat", tools, permissions: perms },
      );
      expect(result.finalText).toBe("done");
      expect(result.iterations).toBe(2);
      // The tool result message was fed back to the model.
      const toolMsg = result.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content).toBe("hi");
      // Real usage captured from the final SSE event.
      expect(result.usage?.totalTokens).toBe(15);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("runs multiple tool calls in parallel and preserves order", async () => {
    const tools = registryWith(echoTool);
    const perms = new PermissionManager({ mode: "auto" });

    // First response emits two echo tool calls at once.
    const r1 = sseResponse([
      sseData({
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: "call_a", function: { name: "echo", arguments: '{"msg":"one"}' } },
              { index: 1, id: "call_b", function: { name: "echo", arguments: '{"msg":"two"}' } },
            ],
          },
        }],
      }),
    ]);
    // Second response is the final text.
    const r2 = sseResponse([
      sseData({ choices: [{ delta: { content: "ok" } }] }),
      "data: [DONE]\n\n",
    ]);

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence([r1, r2]);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "echo two things" }],
        { apiKey: "sk-test", model: "deepseek-chat", tools, permissions: perms },
      );
      expect(result.finalText).toBe("ok");
      const toolMessages = result.messages.filter((m) => m.role === "tool");
      expect(toolMessages.length).toBe(2);
      // Order matches the tool_call indices.
      expect(toolMessages[0].content).toBe("one");
      expect(toolMessages[1].content).toBe("two");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("records a denied tool call and continues", async () => {
    const tools = registryWith(echoTool);

    // A permission manager that denies every check (subclass avoids the prompt).
    class DenyAll extends PermissionManager {
      constructor() { super({ mode: "ask" }); }
      async check() { return { allow: false }; }
    }
    const perms = new DenyAll();

    const r1 = sseResponse([
      sseData({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: '{"msg":"hi"}' } }] } }],
      }),
    ]);
    const r2 = sseResponse([
      sseData({ choices: [{ delta: { content: "ack" } }] }),
      "data: [DONE]\n\n",
    ]);

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence([r1, r2]);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "echo hi" }],
        { apiKey: "sk-test", model: "deepseek-chat", tools, permissions: perms },
      );
      expect(result.finalText).toBe("ack");
      const toolMsg = result.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content).toContain("denied");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("aborts cleanly when the signal is already aborted", async () => {
    const tools = registryWith(echoTool);
    const perms = new PermissionManager({ mode: "auto" });
    const controller = new AbortController();
    controller.abort();

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "x" }],
        { apiKey: "sk-test", model: "deepseek-chat", tools, permissions: perms, signal: controller.signal },
      );
      expect(result.aborted).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("truncates oversized tool results fed back to the model", async () => {
    const bigTool: Tool = {
      name: "big",
      description: "returns a huge payload",
      category: "memory",
      isDangerous: false,
      parameters: { type: "object", properties: {} },
      async execute() {
        return { ok: true, content: "x".repeat(30_000) };
      },
    };
    const tools = registryWith(bigTool);
    const perms = new PermissionManager({ mode: "auto" });

    const callBig = {
      index: 0,
      id: "c1",
      function: { name: "big", arguments: "{}" },
    };
    const r1 = sseResponse([sseData({ choices: [{ delta: { tool_calls: [callBig] } }] })]);
    const r2 = sseResponse([sseData({ choices: [{ delta: { content: "fin" } }] }), "data: [DONE]\n\n"]);

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence([r1, r2]);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "go" }],
        { apiKey: "sk-test", model: "deepseek-chat", tools, permissions: perms },
      );
      const toolMsg = result.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content?.length).toBeLessThan(30_000);
      expect(toolMsg?.content).toContain("truncated");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("flushes a newline between streamed content and the ⏺ tool header", async () => {
    // Regression: when the model streams non-newline-terminated content and
    // then emits tool calls in the same turn, the ⏺ tool header marker must
    // start at column 0 — not glue onto the trailing content line.
    const tools = registryWith(echoTool);
    const perms = new PermissionManager({ mode: "auto" });

    const r1 = sseResponse([
      sseData({ choices: [{ delta: { content: "Let me read the exact code sections I need to modify." } }] }),
      sseData({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: '{"msg":"hi"}' } }],
          },
        }],
      }),
    ]);
    const r2 = sseResponse([
      sseData({ choices: [{ delta: { content: "done" } }] }),
      "data: [DONE]\n\n",
    ]);

    // Capture every stdout write so we can assert on the interleave order
    // between streamed content and the tool header marker.
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: unknown) => {
      writes.push(typeof s === "string" ? s : String(s));
      return true;
    }) as typeof process.stdout.write;

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence([r1, r2]);
    try {
      await runAgentLoop(
        [{ role: "user", content: "echo hi" }],
        {
          apiKey: "sk-test",
          model: "deepseek-chat",
          tools,
          permissions: perms,
          onContentDelta: (d) => process.stdout.write(d),
        },
      );
    } finally {
      process.stdout.write = origWrite;
      globalThis.fetch = origFetch;
    }

    const out = writes.join("");
    // The streamed content was followed by a newline, THEN the ⏺ marker —
    // the marker never glues onto the trailing content line. (The ⏺ is now
    // rendered by the spinner's startTool, so it's preceded by \r + ANSI
    // clear rather than a bare newline from printToolHeader.)
    expect(out).toMatch(/Let me read the exact code sections I need to modify\.\n.*⏺/s);
  });

  it("surfaces a /fast hint after N consecutive read-only iterations on a reasoner", async () => {
    // Three read-only iterations in a row under a reasoning model should emit
    // the exploration-phase tip once. Read-only categories here: "memory" via
    // echoTool is NOT read-only (echoTool category="memory"), so we need a
    // real fs-read tool — use readFileTool which is category "fs-read".
    const readerTool: Tool = {
      name: "reader",
      description: "reads a file",
      category: "fs-read",
      isDangerous: false,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { ok: true, content: "x" }; },
    };
    const tools = registryWith(readerTool);
    const perms = new PermissionManager({ mode: "auto" });

    // Build N=3 SSE responses: each emits one reader tool call; the 4th ends the turn.
    const mkTool = (id: string) => sseData({
      choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "reader", arguments: "{}" } }] } }],
    });
    const responses = [
      sseResponse([mkTool("c1")]),
      sseResponse([mkTool("c2")]),
      sseResponse([mkTool("c3")]),
      sseResponse([sseData({ choices: [{ delta: { content: "done" } }] }), "data: [DONE]\n\n"]),
    ];

    // Capture stdout so we can assert the hint fired.
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: unknown) => { writes.push(typeof s === "string" ? s : String(s)); return true; }) as typeof process.stdout.write;
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence(responses);
    try {
      await runAgentLoop(
        [{ role: "user", content: "explore" }],
        {
          apiKey: "sk-test",
          model: "deepseek-reasoner",
          reasoning: true,
          tools,
          permissions: perms,
        },
      );
    } finally {
      process.stdout.write = origWrite;
      globalThis.fetch = origFetch;
    }

    const out = writes.join("");
    // The one-shot exploration tip fired once and mentioned /fast.
    const hits = (out.match(/consecutive read-only iterations/g) || []).length;
    expect(hits).toBe(1);
    expect(out).toContain("/fast");
  });

  it("does NOT surface the /fast hint when not running a reasoner", async () => {
    // Same shape as above but with reasoning off — the hint must stay silent
    // because deepseek-chat per-iteration latency is already small.
    const readerTool: Tool = {
      name: "reader",
      description: "reads a file",
      category: "fs-read",
      isDangerous: false,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { ok: true, content: "x" }; },
    };
    const tools = registryWith(readerTool);
    const perms = new PermissionManager({ mode: "auto" });
    const mkTool = (id: string) => sseData({
      choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "reader", arguments: "{}" } }] } }],
    });
    const responses = [
      sseResponse([mkTool("c1")]),
      sseResponse([mkTool("c2")]),
      sseResponse([mkTool("c3")]),
      sseResponse([sseData({ choices: [{ delta: { content: "done" } }] }), "data: [DONE]\n\n"]),
    ];

    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: unknown) => { writes.push(typeof s === "string" ? s : String(s)); return true; }) as typeof process.stdout.write;
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence(responses);
    try {
      await runAgentLoop(
        [{ role: "user", content: "explore" }],
        {
          apiKey: "sk-test",
          model: "deepseek-chat",
          reasoning: false,
          tools,
          permissions: perms,
        },
      );
    } finally {
      process.stdout.write = origWrite;
      globalThis.fetch = origFetch;
    }

    const out = writes.join("");
    expect(out).not.toContain("consecutive read-only iterations");
  });
});
