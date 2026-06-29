import { describe, it, expect } from "bun:test";
import { runJsonOneShot } from "../src/commands/chat.ts";
import { newSession } from "../src/session/store.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { PermissionManager } from "../src/agent/permissions.ts";
import { setOutputSilent } from "../src/ui/render.ts";

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

describe("runJsonOneShot (--output-format json)", () => {
  it("emits a single JSON blob with finalText + usage, no streaming noise", async () => {
    const session = newSession("deepseek-chat", undefined, "/tmp");
    const tools = new ToolRegistry();
    const permissions = new PermissionManager({ mode: "auto" });

    const resp = sseResponse([
      sseData({ choices: [{ delta: { content: "Hello " } }] }),
      sseData({ choices: [{ delta: { content: "world" } }] }),
      sseData({ choices: [{ delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }),
      "data: [DONE]\n\n",
    ]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => resp) as unknown as typeof fetch;

    // Capture stdout.
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await runJsonOneShot(session, {
        apiKey: "sk-test",
        model: "deepseek-chat",
        tools,
        permissions,
        toolCtx: { cwd: "/tmp" },
        prompt: "say hi",
      });
    } finally {
      process.stdout.write = origWrite;
      globalThis.fetch = origFetch;
      setOutputSilent(false);
    }

    // Exactly one JSON line on stdout.
    const lines = captured.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.finalText).toBe("Hello world");
    expect(parsed.prompt).toBe("say hi");
    expect(parsed.usage.totalTokens).toBe(12);
    expect(parsed.iterations).toBe(1);
  });
});
