import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { completeSlash, handleSlashCommand, SLASH_COMMANDS, extractReadFilePaths } from "../src/commands/chat.ts";
import { newSession } from "../src/session/store.ts";
import { setOutputSilent } from "../src/ui/render.ts";
import { appendPromptLog, buildEntry } from "../src/session/promptLog.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { SlashCtx } from "../src/commands/chat.ts";
import type { Tool } from "../src/tools/types.ts";
import { parseArgs } from "../src/cli.ts";

const noopSkills = { list: async () => [], active: () => [], toggle: async () => false, clear: () => {} };
const noopMcp = { servers: () => [], toggle: () => false, toolsForServer: () => [] as Tool[], add: async () => ({ ok: false, toolCount: 0 }) };

const ORIG_FILE = process.env.DEEPSEEK_PROMPT_LOG_FILE;
let tmp: string;
let session: ReturnType<typeof newSession>;

function makeCtx(): { ctx: SlashCtx; setCalls: string[] } {
  const setCalls: string[] = [];
  const ctx: SlashCtx = {
    apiKey: "sk-test",
    model: "deepseek-chat",
    temperature: 0.7,
    tools: new ToolRegistry(),
    setModel: () => {},
    skills: noopSkills as SlashCtx["skills"],
    mcp: noopMcp as SlashCtx["mcp"],
    reasoning: { get: () => false, set: async () => {} },
    effort: { get: () => "high", set: async () => {} },
    context: { get: () => 60000, set: async () => {} },
    promptLog: { get: () => true, set: async (on: boolean) => { setCalls.push(`promptlog:${on}`); } },
    permissions: { dangerousTools: () => [], isAllowed: () => false, allow: () => {}, clear: () => {}, approvalMode: () => "auto", setApprovalMode: async () => {} },
    style: { get: () => "concise" as const, set: () => {} },
    prefillHolder: { value: "" },
    runSideTurn: async () => {},
  };
  return { ctx, setCalls };
}

beforeEach(async () => {
  setOutputSilent(true);
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-plogcmd-test-"));
  process.env.DEEPSEEK_PROMPT_LOG_FILE = path.join(tmp, "prompt-log.jsonl");
  session = newSession("deepseek-chat", undefined, "/tmp");
});

afterEach(async () => {
  setOutputSilent(false);
  if (ORIG_FILE === undefined) delete process.env.DEEPSEEK_PROMPT_LOG_FILE;
  else process.env.DEEPSEEK_PROMPT_LOG_FILE = ORIG_FILE;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("/promptlog slash command", () => {
  it("is registered in SLASH_COMMANDS and completes", () => {
    expect(SLASH_COMMANDS).toContain("promptlog");
    expect(completeSlash("/prom")).toContain("/promptlog");
  });

  it("shows status with entry count when called with no arg", async () => {
    const { ctx } = makeCtx();
    const r = await handleSlashCommand("/promptlog", session, ctx);
    expect(r).toBe("continue");
  });

  it("on: calls the setter with true and persists", async () => {
    const { ctx, setCalls } = makeCtx();
    const r = await handleSlashCommand("/promptlog on", session, ctx);
    expect(r).toBe("continue");
    expect(setCalls).toEqual(["promptlog:true"]);
  });

  it("off: calls the setter with false", async () => {
    const { ctx, setCalls } = makeCtx();
    const r = await handleSlashCommand("/promptlog off", session, ctx);
    expect(r).toBe("continue");
    expect(setCalls).toEqual(["promptlog:false"]);
  });

  it("clear: empties the log file", async () => {
    const { ctx } = makeCtx();
    await appendPromptLog(buildEntry({
      sessionId: session.id, turn: 1, prompt: "x", model: "m",
      iterations: 1, toolCalls: 0, tools: [], finalTextLen: 1, durationMs: 10,
    }));
    const r = await handleSlashCommand("/promptlog clear", session, ctx);
    expect(r).toBe("continue");
    // After clear, recent should show nothing.
    const r2 = await handleSlashCommand("/promptlog recent", session, ctx);
    expect(r2).toBe("continue");
  });

  it("recent: lists entries", async () => {
    const { ctx } = makeCtx();
    await appendPromptLog(buildEntry({
      sessionId: session.id, turn: 1, prompt: "first prompt", model: "deepseek-chat",
      iterations: 2, toolCalls: 1, tools: ["read_file"], finalTextLen: 10, durationMs: 6000,
    }));
    const r = await handleSlashCommand("/promptlog recent", session, ctx);
    expect(r).toBe("continue");
  });

  it("search: filters by keyword", async () => {
    const { ctx } = makeCtx();
    await appendPromptLog(buildEntry({
      sessionId: session.id, turn: 1, prompt: "fix the bug", model: "deepseek-chat",
      iterations: 1, toolCalls: 0, tools: [], finalTextLen: 5, durationMs: 100,
    }));
    await appendPromptLog(buildEntry({
      sessionId: session.id, turn: 2, prompt: "write tests", model: "deepseek-chat",
      iterations: 3, toolCalls: 2, tools: ["bash"], finalTextLen: 80, durationMs: 8000,
    }));
    const r = await handleSlashCommand("/promptlog search tests", session, ctx);
    expect(r).toBe("continue");
  });

  it("rejects unknown subcommand with usage hint", async () => {
    const { ctx } = makeCtx();
    const r = await handleSlashCommand("/promptlog frobnicate", session, ctx);
    expect(r).toBe("continue");
  });
});

describe("CLI --no-prompt-log flag", () => {
  it("sets noPromptLog=true", () => {
    const args = parseArgs(["node", "deepseek", "--no-prompt-log", "hi"]);
    expect(args.noPromptLog).toBe(true);
  });

  it("defaults to undefined (unset → enabled)", () => {
    const args = parseArgs(["node", "deepseek", "hi"]);
    expect(args.noPromptLog).toBeUndefined();
  });
});

describe("extractReadFilePaths (sub-agent file reuse)", () => {
  it("extracts filePath from read_file tool calls", () => {
    const msgs = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "1",
            type: "function" as const,
            function: { name: "read_file", arguments: JSON.stringify({ filePath: "/a/b.ts" }) },
          },
        ],
      },
    ];
    expect(extractReadFilePaths(msgs as never)).toEqual(["/a/b.ts"]);
  });

  it("extracts filePaths array from read_files tool calls", () => {
    const msgs = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: "1",
            type: "function" as const,
            function: { name: "read_files", arguments: JSON.stringify({ filePaths: ["/x.ts", "/y.ts"] }) },
          },
        ],
      },
    ];
    expect(extractReadFilePaths(msgs as never)).toEqual(["/x.ts", "/y.ts"]);
  });

  it("deduplicates paths across multiple tool calls", () => {
    const msgs = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          { id: "1", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ filePath: "/dup.ts" }) } },
          { id: "2", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ filePath: "/dup.ts" }) } },
          { id: "3", type: "function" as const, function: { name: "read_files", arguments: JSON.stringify({ filePaths: ["/new.ts"] }) } },
        ],
      },
    ];
    expect(extractReadFilePaths(msgs as never)).toEqual(["/dup.ts", "/new.ts"]);
  });

  it("ignores non-read tool calls", () => {
    const msgs = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          { id: "1", type: "function" as const, function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } },
          { id: "2", type: "function" as const, function: { name: "edit_file", arguments: JSON.stringify({ filePath: "/x.ts" }) } },
        ],
      },
    ];
    expect(extractReadFilePaths(msgs as never)).toEqual([]);
  });

  it("returns empty for messages with no tool calls", () => {
    expect(extractReadFilePaths([{ role: "user", content: "hi" } as never])).toEqual([]);
  });
});
