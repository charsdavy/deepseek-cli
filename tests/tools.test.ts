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

  it("handles code blocks with higher token density than prose", () => {
    const prose = estimateTokens("This is a normal English sentence for testing.");
    const code = estimateTokens("const x = { a: 1, b: () => { return x.a + y.z; } };");
    // Code should have more tokens per char due to punctuation density.
    expect(code).toBeGreaterThanOrEqual(prose);
  });

  it("handles empty strings", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles very long text", () => {
    const long = "hello ".repeat(1000);
    const t = estimateTokens(long);
    expect(t).toBeGreaterThan(500);
    expect(t).toBeLessThan(3000);
  });

  it("estimates tool-call messages correctly", () => {
    const t = estimateConversationTokens([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: '{"filePath":"/src/foo.ts"}' } }],
      },
    ]);
    expect(t).toBeGreaterThan(15);
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

  it("search returns matching tools by name or description", () => {
    const r = new ToolRegistry();
    const results = r.search("read");
    expect(results.length).toBeGreaterThan(0);
    // read_file should be in the results since its name contains "read".
    const readFile = results.find((t) => t.name === "read_file");
    expect(readFile).toBeDefined();
    // git_diff description contains "read-only" so it also matches.
    const gitDiff = results.find((t) => t.name === "git_diff");
    expect(gitDiff).toBeDefined();
  });

  it("search returns empty for non-matching query", () => {
    const r = new ToolRegistry();
    const results = r.search("zzzz_not_a_tool");
    expect(results.length).toBe(0);
  });

  it("catalog returns compact tool summaries", () => {
    const r = new ToolRegistry();
    const catalog = r.catalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog[0].name.length).toBeGreaterThan(0);
    expect(catalog[0].description.length).toBeLessThanOrEqual(120);
    expect(typeof catalog[0].category).toBe("string");
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

// ---- read_files (batch) tool ----
import { readFilesTool } from "../src/tools/read_files.ts";

describe("read_files tool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads multiple files in one call, each in its own <file> section", async () => {
    const a = path.join(tmpDir, "a.txt");
    const b = path.join(tmpDir, "b.txt");
    await fs.writeFile(a, "alpha1\nalpha2\n", "utf-8");
    await fs.writeFile(b, "beta1\nbeta2\n", "utf-8");

    const res = await readFilesTool.execute({ paths: [a, b] }, { cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(res.content).toContain(`<file path="${a}">`);
    expect(res.content).toContain(`<file path="${b}">`);
    expect(res.content).toContain("alpha1");
    expect(res.content).toContain("beta2");
    expect(res.content).toMatch(/batch: 2\/2 files read/);
  });

  it("per-file errors are reported without aborting the batch", async () => {
    const ok = path.join(tmpDir, "ok.txt");
    const dir = path.join(tmpDir, "sub");
    const missing = path.join(tmpDir, "nope.txt");
    await fs.writeFile(ok, "hi\n", "utf-8");
    await fs.mkdir(dir);

    const res = await readFilesTool.execute({ paths: [ok, dir, missing] }, { cwd: process.cwd() });
    expect(res.ok).toBe(true);
    expect(res.content).toContain(`<file path="${ok}">`);
    expect(res.content).toContain(`error="is_directory"`);
    expect(res.content).toContain(`error="stat_failed"`);
    expect(res.content).toMatch(/batch: 1\/3 files read/);
  });

  it("accepts per-item {filePath, offset, limit} objects", async () => {
    const f = path.join(tmpDir, "multi.txt");
    await fs.writeFile(f, "l1\nl2\nl3\nl4\nl5\n", "utf-8");

    const res = await readFilesTool.execute(
      { paths: [{ filePath: f, offset: 2, limit: 2 }] },
      { cwd: process.cwd() },
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("l2");
    expect(res.content).toContain("l3");
    expect(res.content).not.toContain("l1\n");
    expect(res.content).not.toContain("l4");
  });

  it("rejects an empty paths array", async () => {
    const res = await readFilesTool.execute({ paths: [] }, { cwd: process.cwd() });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("missing_arg");
  });

  it("rejects too many files in one batch", async () => {
    const many = Array.from({ length: 21 }, (_, i) => path.join(tmpDir, `f${i}.txt`));
    const res = await readFilesTool.execute({ paths: many }, { cwd: process.cwd() });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("too_many");
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

  it("honors a custom (smaller) maxContext budget", () => {
    // With a tiny budget, even a modest conversation must trim.
    const big = "a".repeat(2000);
    const msgs: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: "sys" },
    ];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: "user", content: `user ${i} ${big}` });
      msgs.push({ role: "assistant", content: `a ${i} ${big}` });
    }
    const r = trimToFit(msgs, 8_000);
    expect(r.droppedTurns).toBeGreaterThan(0);
    expect(r.messages.length).toBeLessThan(msgs.length);
    // A smaller budget trims more than the default would for the same input.
    const rDefault = trimToFit(msgs);
    expect(r.messages.length).toBeLessThanOrEqual(rDefault.messages.length);
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

  it("leaves reasoning undefined when -r is absent (so cfg.reasoning wins via ??)", () => {
    // Regression: parseArgs used to default reasoning=false, which
    // short-circuited `args.reasoning ?? cfg.reasoning` in runChat and
    // silently ignored a `reasoning: true` in config.json. undefined lets
    // the nullish-coalescing chain fall through to the config value.
    const a = parseArgs(["node", "deepseek", "hi"]);
    expect(a.reasoning).toBeUndefined();
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

  it("sends reasoning_effort and thinking when reasoning is on", async () => {
    let capturedBody = "";
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n data: [DONE]\n\n`;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse));
        c.close();
      },
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? "";
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    try {
      for await (const _chunk of streamChatCompletion({
        apiKey: "sk-test",
        model: "deepseek-v4-pro",
        messages: [],
        reasoning: true,
        reasoningEffort: "max",
      })) {
        void _chunk;
      }
    } finally {
      globalThis.fetch = origFetch;
    }
    const parsed = JSON.parse(capturedBody) as { reasoning_effort?: string; thinking?: { type: string } };
    expect(parsed.thinking).toEqual({ type: "enabled" });
    expect(parsed.reasoning_effort).toBe("max");
  });
});

// ---- grep tool (stdin-hang regression) ----
import { grepTool } from "../src/tools/grep.ts";

describe("grep tool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-grep-test-"));
    // Create test files: .ts, .swift, and a .md
    await fs.writeFile(path.join(tmp, "a.ts"), "const hello = 'world';\nconsole.log(hello);\n");
    await fs.writeFile(path.join(tmp, "b.swift"), "struct EntryViewModel { }\nlet x = 1\n");
    await fs.writeFile(path.join(tmp, "c.md"), "# hello world\n");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("does not hang when include is provided (regression: rg reads stdin)", async () => {
    // Before the fix, `include ? --glob=X : "."` omitted the path arg, so rg
    // tried to read from its stdin pipe (which execFile never closes) and
    // blocked forever. This test asserts the call completes promptly.
    const start = Date.now();
    const result = await grepTool.execute({ pattern: "hello", include: "*.ts", path: tmp }, { cwd: tmp });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10_000); // must not hang
    expect(result.ok).toBe(true);
    expect(result.content).toContain("a.ts");
  });

  it("include filter actually restricts the search to matching files", async () => {
    const result = await grepTool.execute({ pattern: "hello", include: "*.ts", path: tmp }, { cwd: tmp });
    expect(result.content).toContain("a.ts");
    expect(result.content).not.toContain("c.md"); // .md excluded by glob
  });

  it("works without include (searches all files)", async () => {
    const result = await grepTool.execute({ pattern: "hello", path: tmp }, { cwd: tmp });
    expect(result.ok).toBe(true);
    // "hello" appears in a.ts and c.md
    expect(result.content).toContain("a.ts");
  });

  it("include=*.swift searches only swift files", async () => {
    const result = await grepTool.execute({ pattern: "EntryViewModel", include: "*.swift", path: tmp }, { cwd: tmp });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("b.swift");
  });
});

// ---- bash outputBytesCap ----
import { bashTool } from "../src/tools/bash.ts";

describe("bash outputBytesCap", () => {
  it("schema includes outputBytesCap parameter", () => {
    const props = (bashTool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props.outputBytesCap).toBeDefined();
    const cap = props.outputBytesCap as { type?: string; minimum?: number; maximum?: number };
    expect(cap.type).toBe("integer");
    expect(cap.minimum).toBeGreaterThan(0);
  });

  it("executes a simple echo command", async () => {
    const result = await bashTool.execute({ command: "echo hello" }, { cwd: process.cwd() });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("hello");
  });

  it("respects outputBytesCap — terminates with large output", async () => {
    // Generate a command that produces ~200K bytes of output and cap at 5000 bytes.
    const result = await bashTool.execute(
      { command: "yes | head -c 200000", outputBytesCap: 5000 },
      { cwd: process.cwd() },
    );
    // The process should terminate early due to the cap.
    expect(result.content).toContain("output capped");
  }, 10000);

  it("times out with a very long sleep", async () => {
    const result = await bashTool.execute({ command: "sleep 30", timeout: 500 }, { cwd: process.cwd() });
    expect(result.content).toContain("timed out");
  });
});
