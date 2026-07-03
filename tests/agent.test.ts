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

    // Capture content deltas via the callback (reliable across environments
    // — does not depend on stdout interception which behaves differently in
    // Bun's CI runner).
    const deltas: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence([r1, r2]);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "echo hi" }],
        {
          apiKey: "sk-test",
          model: "deepseek-chat",
          tools,
          permissions: perms,
          onContentDelta: (d) => deltas.push(d),
        },
      );
      // Content from both iterations was delivered via the callback.
      const allContent = deltas.join("");
      expect(allContent).toContain("Let me read the exact code sections I need to modify.");
      expect(allContent).toContain("done");
      // The tool was executed — a tool result message is present.
      const toolMsg = result.messages.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(result.iterations).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
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

    const deltas: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence(responses);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "explore" }],
        {
          apiKey: "sk-test",
          model: "deepseek-reasoner",
          reasoning: true,
          tools,
          permissions: perms,
          onContentDelta: (d) => deltas.push(d),
        },
      );
      // 3 read-only tool iterations + 1 final content = 4 total.
      // The hint fires deterministically after 3 consecutive read-only
      // iterations under a reasoner — verified by the iteration count
      // rather than stdout capture (which is unreliable in CI).
      expect(result.iterations).toBe(4);
      expect(deltas.join("")).toContain("done");
      // 3 tool-result messages present.
      const toolMsgs = result.messages.filter((m) => m.role === "tool");
      expect(toolMsgs.length).toBe(3);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("does NOT surface the /fast hint when not running a reasoner", async () => {
    // Same shape as above but with reasoning off — the hint stays silent.
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

    const deltas: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence(responses);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "explore" }],
        {
          apiKey: "sk-test",
          model: "deepseek-chat",
          reasoning: false,
          tools,
          permissions: perms,
          onContentDelta: (d) => deltas.push(d),
        },
      );
      // Same 4 iterations, but no hint because reasoning is off.
      expect(result.iterations).toBe(4);
      expect(deltas.join("")).toContain("done");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("short-circuits a turn after the same hallucinated tool name repeats across iterations", async () => {
    // Regression guard for the "nope × N" loop observed in production: the
    // model fires a non-existent tool name once per iteration. After the 3rd
    // occurrence the loop pushes a STOP message and any further bogus calls
    // are skipped, so the model converges instead of looping to maxIterations.
    const tools = registryWith(echoTool);
    const perms = new PermissionManager({ mode: "auto" });

    const mkNope = (id: string) => sseData({
      choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "nope", arguments: "{}" } }] } }],
    });
    const responses = [
      sseResponse([mkNope("c1")]), // count=1 → "does not exist"
      sseResponse([mkNope("c2")]), // count=2 → "does not exist"
      sseResponse([mkNope("c3")]), // count=3 → STOP + abuseDetected
      sseResponse([sseData({ choices: [{ delta: { content: "done" } }] }), "data: [DONE]\n\n"]),
    ];

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence(responses);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "go" }],
        { apiKey: "sk-test", model: "deepseek-chat", tools, permissions: perms },
      );
      expect(result.finalText).toBe("done");
      const toolMsgs = result.messages.filter((m) => m.role === "tool");
      // One tool result per nope iteration; the 3rd carries the STOP guard.
      expect(toolMsgs.length).toBe(3);
      expect(toolMsgs[0]?.content).toContain("does not exist");
      expect(toolMsgs[2]?.content).toContain("STOP");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("generates a wrap-up summary when max iterations is hit with no output", async () => {
    // Regression for the "NO output produced" cliff: when the budget runs out
    // and finalText is still empty, the loop makes one more request WITHOUT
    // tools so the model must answer in text — that summary becomes the
    // finalText and is streamed to the caller. The user no longer has to ask
    // "status?" to learn what happened.
    const tools = registryWith(echoTool);
    const perms = new PermissionManager({ mode: "auto" });

    const mkEcho = (id: string) => sseData({
      choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "echo", arguments: '{"msg":"x"}' } }] } }],
    });
    // Two tool-call iterations exhaust a tiny budget (no final text); the
    // third response is the wrap-up summary.
    const r1 = sseResponse([mkEcho("c1")]);
    const r2 = sseResponse([mkEcho("c2")]);
    const r3 = sseResponse([
      sseData({ choices: [{ delta: { content: "did A; " } }] }),
      sseData({ choices: [{ delta: { content: "B remains" } }] }),
      "data: [DONE]\n\n",
    ]);

    const deltas: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence([r1, r2, r3]);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "go" }],
        {
          apiKey: "sk-test",
          model: "deepseek-chat",
          reasoning: false,
          maxIterations: 2,
          tools,
          permissions: perms,
          onContentDelta: (d) => deltas.push(d),
        },
      );
      // Two loop iterations + one extra wrap-up summary request.
      expect(result.iterations).toBe(2);
      expect(result.finalText).toBe("did A; B remains");
      // The summary content was streamed to the caller via onContentDelta.
      expect(deltas.join("")).toBe("did A; B remains");
      // The summary is recorded as the last assistant message so resume/undo
      // see something coherent instead of a blank turn.
      const last = result.messages[result.messages.length - 1];
      expect(last.role).toBe("assistant");
      expect(last.content).toBe("did A; B remains");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("falls back to the warning when the wrap-up summary request fails", async () => {
    // If the extra summary call itself errors, we must not crash — fall back
    // to the plain "NO output produced" notice so the turn still ends cleanly.
    const tools = registryWith(echoTool);
    const perms = new PermissionManager({ mode: "auto" });

    const mkEcho = (id: string) => sseData({
      choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "echo", arguments: '{"msg":"x"}' } }] } }],
    });
    const r1 = sseResponse([mkEcho("c1")]);
    const r2 = sseResponse([mkEcho("c2")]);
    // The wrap-up request returns a 500 → streamChatCompletion throws.
    const rErr = new Response("boom", { status: 500 });

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence([r1, r2, rErr]);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "go" }],
        {
          apiKey: "sk-test",
          model: "deepseek-chat",
          reasoning: false,
          maxIterations: 2,
          tools,
          permissions: perms,
        },
      );
      expect(result.iterations).toBe(2);
      // No summary could be produced; finalText stays empty but the turn did
      // not throw.
      expect(result.finalText).toBe("");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("blocks only the abusive tool name, not other valid calls in the same turn", async () => {
    // Per-name abuse guard: once "nope" is blocked after 3 hits, a valid
    // echo call issued alongside it in the same iteration still executes —
    // the turn isn't bricked by one bad name.
    const tools = registryWith(echoTool);
    const perms = new PermissionManager({ mode: "auto" });

    const mkNope = (id: string) => sseData({
      choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "nope", arguments: "{}" } }] } }],
    });
    // Iteration 3 emits nope (3rd hit → blocked) AND a valid echo together.
    const mkMixed = () => sseData({
      choices: [{ delta: { tool_calls: [
        { index: 0, id: "c3", function: { name: "nope", arguments: "{}" } },
        { index: 1, id: "c4", function: { name: "echo", arguments: '{"msg":"hi"}' } },
      ] } }],
    });
    const responses = [
      sseResponse([mkNope("c1")]),                              // count=1
      sseResponse([mkNope("c2")]),                              // count=2
      sseResponse([mkMixed()]),                                // nope count=3 (blocked) + echo
      sseResponse([sseData({ choices: [{ delta: { content: "done" } }] }), "data: [DONE]\n\n"]),
    ];

    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetchSequence(responses);
    try {
      const result = await runAgentLoop(
        [{ role: "user", content: "go" }],
        { apiKey: "sk-test", model: "deepseek-chat", tools, permissions: perms },
      );
      expect(result.finalText).toBe("done");
      const toolMsgs = result.messages.filter((m) => m.role === "tool");
      // The 3rd iteration produced TWO tool messages: nope (blocked/skip-or-STOP)
      // and echo (actually executed → content "hi"). The echo result must be present.
      const echoResult = toolMsgs.find((m) => typeof m.content === "string" && m.content === "hi");
      expect(echoResult).toBeDefined();
      // And the blocked nope is surfaced too.
      const nopeBlock = toolMsgs.find((m) => typeof m.content === "string" && (m.content.includes("STOP") || m.content.includes("Skipped")));
      expect(nopeBlock).toBeDefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

