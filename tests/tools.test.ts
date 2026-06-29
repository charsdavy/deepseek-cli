import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";

// ---- Token estimation ----
import { estimateTokens, estimateConversationTokens } from "../src/api/tokens.ts";

describe("tokens", () => {
  it("counts English roughly as chars/4", () => {
    const t = estimateTokens("hello world");
    expect(t).toBeGreaterThan(0);
    // 11 chars / 4 ≈ 3
    expect(t).toBeGreaterThanOrEqual(2);
    expect(t).toBeLessThanOrEqual(4);
  });

  it("counts CJK with smaller char/token ratio", () => {
    const en = estimateTokens("hello world"); // 11 chars
    const zh = estimateTokens("你好世界"); // 4 chars
    // CJK should report more tokens per char than English
    expect(zh).toBeGreaterThanOrEqual(2); // 4/2 = 2
    expect(zh).toBeLessThanOrEqual(3);
    void en;
  });

  it("sums messages with overhead", () => {
    const t = estimateConversationTokens([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
    ]);
    expect(t).toBeGreaterThan(10);
  });
});

// ---- Tool registry ----
import { ToolRegistry } from "../src/tools/registry.ts";

describe("ToolRegistry", () => {
  it("lists built-in tools", () => {
    const r = new ToolRegistry();
    const names = r.list().map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("bash");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("web_fetch");
    expect(names).toContain("todo_write");
  });

  it("schemas are OpenAI-shaped", () => {
    const r = new ToolRegistry();
    const s = r.schemas();
    expect(s.length).toBeGreaterThan(0);
    expect(s[0].type).toBe("function");
    expect(typeof s[0].function.name).toBe("string");
    expect(typeof s[0].function.parameters).toBe("object");
  });

  it("rejects unknown tools", async () => {
    const r = new ToolRegistry();
    const res = await r.execute("nope", {}, { cwd: process.cwd() });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unknown_tool");
  });
});

// ---- read_file tool ----
import { readFileTool } from "../src/tools/read_file.ts";

describe("read_file tool", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-test-"));
    tmpFile = path.join(tmpDir, "sample.txt");
    await fs.writeFile(tmpFile, "line1\nline2\nline3\n", "utf-8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a file with line numbers", async () => {
    const res = await readFileTool.execute({ filePath: tmpFile }, { cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("line1");
    expect(res.content).toContain("line2");
    expect(res.content).toContain(tmpFile);
  });

  it("errors on a directory", async () => {
    const res = await readFileTool.execute({ filePath: tmpDir }, { cwd: process.cwd() });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("is_directory");
  });

  it("errors on missing file", async () => {
    const res = await readFileTool.execute({ filePath: path.join(tmpDir, "missing") }, { cwd: process.cwd() });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("stat_failed");
  });

  it("respects offset and limit", async () => {
    const res = await readFileTool.execute({ filePath: tmpFile, offset: 2, limit: 1 }, { cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("line2");
    expect(res.content).not.toContain("line1");
    expect(res.content).not.toContain("line3");
  });
});

// ---- write_file + edit_file tools ----
import { writeFileTool } from "../src/tools/write_file.ts";
import { editFileTool } from "../src/tools/edit_file.ts";

describe("write_file + edit_file tools", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-test-"));
    tmpFile = path.join(tmpDir, "out.txt");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("write_file creates a file", async () => {
    const res = await writeFileTool.execute({ filePath: tmpFile, content: "hello" }, { cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(await fs.readFile(tmpFile, "utf-8")).toBe("hello");
  });

  it("write_file creates parent directories", async () => {
    const nested = path.join(tmpDir, "sub", "dir", "file.txt");
    const res = await writeFileTool.execute({ filePath: nested, content: "x" }, { cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it("edit_file replaces a unique string", async () => {
    await fs.writeFile(tmpFile, "alpha beta gamma\n", "utf-8");
    const res = await editFileTool.execute(
      { filePath: tmpFile, oldString: "beta", newString: "BETA" },
      { cwd: process.cwd() },
    );
    expect(res.ok).toBe(true);
    expect(await fs.readFile(tmpFile, "utf-8")).toBe("alpha BETA gamma\n");
  });

  it("edit_file errors on multiple matches without replaceAll", async () => {
    await fs.writeFile(tmpFile, "x x x\n", "utf-8");
    const res = await editFileTool.execute(
      { filePath: tmpFile, oldString: "x", newString: "y" },
      { cwd: process.cwd() },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("multiple_matches");
  });

  it("edit_file replaceAll replaces every occurrence", async () => {
    await fs.writeFile(tmpFile, "x x x\n", "utf-8");
    const res = await editFileTool.execute(
      { filePath: tmpFile, oldString: "x", newString: "y", replaceAll: true },
      { cwd: process.cwd() },
    );
    expect(res.ok).toBe(true);
    expect(await fs.readFile(tmpFile, "utf-8")).toBe("y y y\n");
  });

  it("edit_file errors when oldString not present", async () => {
    await fs.writeFile(tmpFile, "alpha\n", "utf-8");
    const res = await editFileTool.execute(
      { filePath: tmpFile, oldString: "zzz", newString: "y" },
      { cwd: process.cwd() },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("old_not_found");
  });
});

// ---- bash tool ----
import { bashTool } from "../src/tools/bash.ts";

describe("bash tool", () => {
  it("captures stdout and exit code", async () => {
    const res = await bashTool.execute({ command: "echo hi" }, { cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("hi");
    expect(res.content).toContain("exit 0");
  });

  it("captures non-zero exit", async () => {
    const res = await bashTool.execute({ command: "exit 3" }, { cwd: process.cwd() });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("exit 3");
  });
});

// ---- context trimming ----
import { trimToFit } from "../src/agent/context.ts";

describe("trimToFit", () => {
  it("no-op when within budget", () => {
    const msgs = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hi" },
    ];
    const r = trimToFit(msgs);
    expect(r.droppedTurns).toBe(0);
    expect(r.messages.length).toBe(2);
  });

  it("trims oldest turns when over budget", () => {
    // Build a conversation that exceeds the budget.
    const big = "a".repeat(4000);
    const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: "sys" },
    ];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: "user", content: `user ${i} ${big}` });
      msgs.push({ role: "assistant", content: `assistant ${i} ${big}` });
    }
    const r = trimToFit(msgs);
    expect(r.droppedTurns).toBeGreaterThan(0);
    expect(r.messages.length).toBeLessThan(msgs.length);
    // System prompt is always preserved
    expect(r.messages[0].role).toBe("system");
  });
});

// ---- todos tool ----
import { todoWriteTool, getTodos } from "../src/tools/todo.ts";

describe("todo_write tool", () => {
  it("stores the list in ctx.state", async () => {
    const ctx = { cwd: process.cwd(), state: {} };
    const res = await todoWriteTool.execute(
      {
        todos: [
          { content: "a", status: "pending", priority: "high" },
          { content: "b", status: "in_progress", priority: "medium" },
        ],
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    const list = getTodos(ctx);
    expect(list.length).toBe(2);
    expect(list[0].content).toBe("a");
    expect(list[1].status).toBe("in_progress");
  });
});

// ---- CLI parsing ----
import { parseArgs, ArgError } from "../src/cli.ts";

describe("parseArgs", () => {
  it("parses a positional prompt", () => {
    const a = parseArgs(["node", "deepseek", "hello world"]);
    expect(a.command).toBe("chat");
    expect(a.prompt).toBe("hello world");
  });

  it("parses --model and --reasoning", () => {
    const a = parseArgs(["node", "deepseek", "-m", "deepseek-reasoner", "-r", "q"]);
    expect(a.model).toBe("deepseek-reasoner");
    expect(a.reasoning).toBe(true);
    expect(a.prompt).toBe("q");
  });

  it("dispatches auth subcommand", () => {
    const a = parseArgs(["node", "deepseek", "auth"]);
    expect(a.command).toBe("auth");
  });

  it("parses --yolo", () => {
    const a = parseArgs(["node", "deepseek", "--yolo", "do it"]);
    expect(a.yolo).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["node", "deepseek", "--bogus"])).toThrow(ArgError);
  });

  it("parses --continue and --resume", () => {
    const a1 = parseArgs(["node", "deepseek", "-c"]);
    expect(a1.continueLast).toBe(true);
    const a2 = parseArgs(["node", "deepseek", "--resume", "20251231-120000"]);
    expect(a2.resume).toBe("20251231-120000");
  });
});

// ---- SSE parser (client) ----
// We can't make real network calls in tests, but we can verify the SSE parser
// by feeding it a fake stream via a mocked fetch. Use Bun's built-in mocking
// via a global override is heavy; instead we exercise the parser's pure logic
// by replicating one event through streamChatCompletion with a stubbed Response.
import { streamChatCompletion, DeepSeekError } from "../src/api/client.ts";

describe("DeepSeek client SSE parsing", () => {
  it("parses content + tool_call deltas", async () => {
    const sse = [
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "Hel", tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: "{\"co" } }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "lo", tool_calls: [{ index: 0, function: { arguments: "mmand\":\"echo hi\"}" } }] } }],
      })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const body = new ReadableStream({
      start(ctl) {
        ctl.enqueue(new TextEncoder().encode(sse));
        ctl.close();
      },
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    try {
      let content = "";
      let toolName = "";
      let toolArgs = "";
      for await (const c of streamChatCompletion({
        apiKey: "sk-test",
        model: "deepseek-chat",
        messages: [],
      })) {
        if (c.content) content += c.content;
        for (const tc of c.toolCalls) {
          if (tc.name) toolName += tc.name;
          if (tc.arguments) toolArgs += tc.arguments;
        }
      }
      // SSE parser yields per-event deltas — the agent loop accumulates them.
      expect(content).toBe("Hello");
      expect(toolName).toBe("bash");
      expect(toolArgs).toBe('{"command":"echo hi"}');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("maps 401 to DeepSeekUnauthorized", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    try {
      const iter = streamChatCompletion({
        apiKey: "sk-bad",
        model: "deepseek-chat",
        messages: [],
      })[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toThrow(DeepSeekError);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
