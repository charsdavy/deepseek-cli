import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { expandFileRefs } from "../src/commands/chat.ts";
import { taskTool, AGENT_TYPES } from "../src/tools/task.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { getAgentPrompt, buildSystemPrompt } from "../src/prompt/builder.ts";
import type { AgentType } from "../src/prompt/builder.ts";

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-fr-")); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe("expandFileRefs (@ syntax)", () => {
  it("appends file content when the referenced file exists", async () => {
    const file = path.join(tmp, "x.ts");
    await fs.writeFile(file, "export const y = 1;\n");
    const out = await expandFileRefs(`look at @x.ts`, tmp);
    expect(out).toContain("<referenced_files>");
    expect(out).toContain('path="x.ts"');
    expect(out).toContain("export const y = 1;");
  });

  it("leaves the prompt untouched when no @ refs are present", async () => {
    const out = await expandFileRefs("just a plain question", tmp);
    expect(out).toBe("just a plain question");
  });

  it("does not treat emails as file refs", async () => {
    const out = await expandFileRefs("contact me at a@b.com please", tmp);
    expect(out).toBe("contact me at a@b.com please");
  });

  it("registers the task tool in the built-in registry", () => {
    const r = new ToolRegistry();
    const names = r.list().map((t) => t.name);
    expect(names).toContain("task");
  });
});

describe("task tool (sub-agent) — backward compat", () => {
  it("returns the sub-agent's final text via ctx.spawnAgent", async () => {
    const r = await taskTool.execute(
      { prompt: "summarize x", description: "sum" },
      { cwd: tmp, spawnAgent: async () => "42" },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("42");
    expect(r.content).toContain("<subtask");
    expect(r.uiSummary).toContain("sub-agent");
  });

  it("errors when spawnAgent is unavailable", async () => {
    const r = await taskTool.execute({ prompt: "x" }, { cwd: tmp });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_spawner");
  });

  it("errors when prompt is missing", async () => {
    const r = await taskTool.execute({}, { cwd: tmp, spawnAgent: async () => "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing_arg");
  });

  it("surfaces a sub-agent failure as a non-ok result", async () => {
    const r = await taskTool.execute(
      { prompt: "boom" },
      { cwd: tmp, spawnAgent: async () => { throw new Error("depth"); } },
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("Sub-agent failed");
  });

  it("two task calls issued together run concurrently (parallel dispatch)", async () => {
    let started = 0;
    const spawn = async (prompt: string) => {
      started++;
      await new Promise((r) => setTimeout(r, 30));
      return prompt.toUpperCase();
    };
    const ctx = { cwd: tmp, spawnAgent: spawn };
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      taskTool.execute({ prompt: "hi" }, ctx),
      taskTool.execute({ prompt: "yo" }, ctx),
    ]);
    const elapsed = Date.now() - t0;
    expect(a.content).toContain("HI");
    expect(b.content).toContain("YO");
    expect(started).toBe(2);
    expect(elapsed).toBeLessThan(55);
  });
});

// ---- Round 1.1: Agent types and subagent_type parameter ----

describe("task tool — subagent_type parameter", () => {
  it("defaults to 'general' when subagent_type is omitted", async () => {
    let receivedType: string | undefined;
    const spawn = async (_p: string, opts?: { subagent_type?: AgentType }) => {
      receivedType = opts?.subagent_type ?? "general";
      return "ok";
    };
    const r = await taskTool.execute(
      { prompt: "do something" },
      { cwd: tmp, spawnAgent: spawn },
    );
    expect(r.ok).toBe(true);
    expect(receivedType).toBe("general");
    expect(r.content).toContain('type="general"');
  });

  it("passes 'explore' subagent_type through to spawnAgent", async () => {
    let receivedType: string | undefined;
    const spawn = async (_p: string, opts?: { subagent_type?: AgentType }) => {
      receivedType = opts?.subagent_type;
      return "found: src/auth.ts";
    };
    const r = await taskTool.execute(
      { subagent_type: "explore", prompt: "find auth files" },
      { cwd: tmp, spawnAgent: spawn },
    );
    expect(r.ok).toBe(true);
    expect(receivedType).toBe("explore");
    expect(r.content).toContain('type="explore"');
  });

  it("passes 'plan' subagent_type through to spawnAgent", async () => {
    let receivedType: string | undefined;
    const spawn = async (_p: string, opts?: { subagent_type?: AgentType }) => {
      receivedType = opts?.subagent_type;
      return "plan: 3 files";
    };
    const r = await taskTool.execute(
      { subagent_type: "plan", prompt: "design payment module" },
      { cwd: tmp, spawnAgent: spawn },
    );
    expect(r.ok).toBe(true);
    expect(receivedType).toBe("plan");
    expect(r.content).toContain('type="plan"');
  });

  it("rejects invalid subagent_type and falls back to general", async () => {
    let receivedType: string | undefined;
    const spawn = async (_p: string, opts?: { subagent_type?: AgentType }) => {
      receivedType = opts?.subagent_type;
      return "result";
    };
    const r = await taskTool.execute(
      { subagent_type: "bogus", prompt: "x" },
      { cwd: tmp, spawnAgent: spawn },
    );
    expect(r.ok).toBe(true);
    expect(receivedType).toBe("general");
  });

  it("uiSummary includes [explore] prefix for explore type", async () => {
    const spawn = async () => "ok";
    const r = await taskTool.execute(
      { subagent_type: "explore", prompt: "search", description: "pattern search" },
      { cwd: tmp, spawnAgent: spawn },
    );
    expect(r.ok).toBe(true);
    expect(r.uiSummary).toContain("[explore]");
  });

  it("uiSummary omits type prefix for general type", async () => {
    const spawn = async () => "ok";
    const r = await taskTool.execute(
      { subagent_type: "general", prompt: "do work", description: "work" },
      { cwd: tmp, spawnAgent: spawn },
    );
    expect(r.ok).toBe(true);
    expect(r.uiSummary).not.toContain("[general]");
  });
});

// ---- Round 1.2: Agent system prompts ----

describe("agent system prompts", () => {
  it("AGENT_TYPES contains all agent types", () => {
    expect(AGENT_TYPES).toContain("explore");
    expect(AGENT_TYPES).toContain("general");
    expect(AGENT_TYPES).toContain("plan");
    expect(AGENT_TYPES).toContain("fork");
  });

  it("getAgentPrompt returns non-empty prompts for all types", () => {
    for (const t of AGENT_TYPES) {
      const prompt = getAgentPrompt(t as AgentType);
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(100);
    }
  });

  it("explore agent prompt is read-only", () => {
    const prompt = getAgentPrompt("explore");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("NEVER use write_file");
    expect(prompt).toContain("read_file");
    expect(prompt).toContain("grep");
    expect(prompt).toContain("glob");
  });

  it("general agent prompt describes full tool access", () => {
    const prompt = getAgentPrompt("general");
    expect(prompt).toContain("same file/code tools as the parent");
    expect(prompt).toContain("Complete the assigned subtask");
  });

  it("plan agent prompt is read-only with structured output", () => {
    const prompt = getAgentPrompt("plan");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("NEVER use write_file");
    expect(prompt).toContain("Architecture overview");
    expect(prompt).toContain("File-by-file changes");
    expect(prompt).toContain("trade-offs");
  });
});

// ---- Round 1.3: Concurrency Superpower in system prompt ----

describe("system prompt concurrency block", () => {
  it("system prompt mentions subagent_type in task tool description", () => {
    const built = buildSystemPrompt({ cwd: "/tmp" });
    const text = built.text;
    expect(text).toContain("subagent_type");
    expect(text).toContain('"explore"');
    expect(text).toContain('"plan"');
  });

  it("system prompt includes Concurrency Superpower section", () => {
    const built = buildSystemPrompt({ cwd: "/tmp" });
    const text = built.text;
    expect(text).toContain("Superpower");
    expect(text).toContain("Parallelism");
    expect(text).toContain("When to parallelize");
    expect(text).toContain("When NOT to parallelize");
    expect(text).toContain("Agent type guide");
  });

  it("system prompt still includes all original critical blocks", () => {
    const built = buildSystemPrompt({ cwd: "/tmp" });
    const text = built.text;
    expect(text).toContain("## Identity");
    expect(text).toContain("Iteration cost");
    expect(text).toContain("Proactive behavior");
    expect(text).toContain("Code style");
    expect(text).toContain("## Safety");
  });
});
