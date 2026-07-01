import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import {
  appendPromptLog,
  buildEntry,
  loadPromptLog,
  searchPromptLog,
  countPromptLog,
  clearPromptLog,
  prunePromptLog,
  type PromptLogEntry,
} from "../src/session/promptLog.ts";

const ORIG_FILE = process.env.DEEPSEEK_PROMPT_LOG_FILE;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-plog-test-"));
  process.env.DEEPSEEK_PROMPT_LOG_FILE = path.join(tmp, "prompt-log.jsonl");
});

afterEach(async () => {
  if (ORIG_FILE === undefined) delete process.env.DEEPSEEK_PROMPT_LOG_FILE;
  else process.env.DEEPSEEK_PROMPT_LOG_FILE = ORIG_FILE;
  await fs.rm(tmp, { recursive: true, force: true });
});

type BuildEntryInput = Parameters<typeof buildEntry>[0];

function mkEntry(overrides: Partial<BuildEntryInput> = {}): PromptLogEntry {
  return buildEntry({
    sessionId: "s1",
    turn: 1,
    prompt: "list files in src",
    model: "deepseek-chat",
    promptVariant: "v1",
    reasoning: false,
    reasoningEffort: undefined,
    iterations: 1,
    toolCalls: 2,
    tools: ["list_dir", "read_file"],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    finalTextLen: 42,
    aborted: false,
    durationMs: 3000,
    ...overrides,
  });
}

describe("prompt log store", () => {
  it("appendPromptLog writes one JSONL line per entry", async () => {
    await appendPromptLog(mkEntry({ prompt: "first", turn: 1 }));
    await appendPromptLog(mkEntry({ prompt: "second", turn: 2 }));
    const entries = await loadPromptLog(10);
    // newest-first
    expect(entries.length).toBe(2);
    expect(entries[0].prompt).toBe("second");
    expect(entries[1].prompt).toBe("first");
  });

  it("loadPromptLog returns [] when the file does not exist", async () => {
    const entries = await loadPromptLog(10);
    expect(entries).toEqual([]);
  });

  it("buildEntry caps overly long prompt text", async () => {
    const long = "x".repeat(10000);
    const e = mkEntry({ prompt: long });
    expect(e.prompt.length).toBeLessThan(10000);
    expect(e.prompt.endsWith("…")).toBe(true);
  });

  it("buildEntry omits usage when no tokens reported", () => {
    const e = buildEntry({
      sessionId: "s1",
      turn: 1,
      prompt: "hi",
      model: "deepseek-chat",
      iterations: 1,
      toolCalls: 0,
      tools: [],
      usage: undefined,
      finalTextLen: 3,
      durationMs: 100,
    });
    expect(e.usage).toBeUndefined();
  });

  it("searchPromptLog matches case-insensitively on prompt text", async () => {
    await appendPromptLog(mkEntry({ prompt: "Fix the broken tests", turn: 1 }));
    await appendPromptLog(mkEntry({ prompt: "explain the architecture", turn: 2 }));
    const hits = await searchPromptLog("BROKEN");
    expect(hits.length).toBe(1);
    expect(hits[0].prompt).toBe("Fix the broken tests");
  });

  it("searchPromptLog with empty query returns recent entries", async () => {
    await appendPromptLog(mkEntry({ prompt: "a", turn: 1 }));
    await appendPromptLog(mkEntry({ prompt: "b", turn: 2 }));
    const hits = await searchPromptLog("");
    expect(hits.length).toBe(2);
  });

  it("countPromptLog counts JSONL lines", async () => {
    expect(await countPromptLog()).toBe(0);
    await appendPromptLog(mkEntry({ turn: 1 }));
    await appendPromptLog(mkEntry({ turn: 2 }));
    await appendPromptLog(mkEntry({ turn: 3 }));
    expect(await countPromptLog()).toBe(3);
  });

  it("clearPromptLog empties the file", async () => {
    await appendPromptLog(mkEntry({ turn: 1 }));
    expect(await countPromptLog()).toBe(1);
    await clearPromptLog();
    expect(await countPromptLog()).toBe(0);
    // file still exists but is empty
    expect(existsSync(process.env.DEEPSEEK_PROMPT_LOG_FILE!)).toBe(true);
  });

  it("clearPromptLog is a no-op when the file is absent", async () => {
    delete process.env.DEEPSEEK_PROMPT_LOG_FILE;
    process.env.DEEPSEEK_PROMPT_LOG_FILE = path.join(tmp, "nope.jsonl");
    await clearPromptLog();
    expect(existsSync(process.env.DEEPSEEK_PROMPT_LOG_FILE!)).toBe(false);
  });

  it("prunePromptLog keeps only the most recent N entries", async () => {
    for (let i = 1; i <= 5; i++) {
      await appendPromptLog(mkEntry({ prompt: `p${i}`, turn: i }));
    }
    const removed = await prunePromptLog(2);
    expect(removed).toBe(3);
    const entries = await loadPromptLog(10);
    expect(entries.length).toBe(2);
    // newest-first → p5, p4 kept
    expect(entries[0].prompt).toBe("p5");
    expect(entries[1].prompt).toBe("p4");
  });

  it("prunePromptLog does nothing when under the cap", async () => {
    await appendPromptLog(mkEntry({ turn: 1 }));
    const removed = await prunePromptLog(10);
    expect(removed).toBe(0);
  });

  it("entries round-trip all fields through append + load", async () => {
    const original = mkEntry({
      prompt: "write tests",
      turn: 3,
      model: "deepseek-reasoner",
      reasoning: true,
      reasoningEffort: "max",
      iterations: 5,
      toolCalls: 4,
      tools: ["read_file", "edit_file", "bash"],
      usage: { promptTokens: 500, completionTokens: 200, totalTokens: 700 },
      finalTextLen: 1200,
      aborted: true,
      durationMs: 45678,
    });
    await appendPromptLog(original);
    const loaded = (await loadPromptLog(1))[0];
    expect(loaded.prompt).toBe("write tests");
    expect(loaded.turn).toBe(3);
    expect(loaded.model).toBe("deepseek-reasoner");
    expect(loaded.reasoning).toBe(true);
    expect(loaded.reasoningEffort).toBe("max");
    expect(loaded.iterations).toBe(5);
    expect(loaded.toolCalls).toBe(4);
    expect(loaded.tools).toEqual(["read_file", "edit_file", "bash"]);
    expect(loaded.usage?.total).toBe(700);
    expect(loaded.finalTextLen).toBe(1200);
    expect(loaded.aborted).toBe(true);
    expect(loaded.durationMs).toBe(45678);
  });

  it("skips broken JSONL lines gracefully", async () => {
    // Manually write a bad line followed by a good one.
    const f = process.env.DEEPSEEK_PROMPT_LOG_FILE!;
    await fs.writeFile(f, "{not json}\n" + JSON.stringify(mkEntry({ prompt: "good", turn: 1 })) + "\n", "utf-8");
    const entries = await loadPromptLog(10);
    expect(entries.length).toBe(1);
    expect(entries[0].prompt).toBe("good");
  });
});
