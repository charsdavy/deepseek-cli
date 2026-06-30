import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { handleSlashCommand, runModelSetupFlow } from "../src/commands/chat.ts";
import { newSession } from "../src/session/store.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { setOutputSilent } from "../src/ui/render.ts";
import { selectOption } from "../src/ui/input.ts";
import type { SlashCtx } from "../src/commands/chat.ts";
import type { Tool } from "../src/tools/types.ts";

// Minimal stubs for the skills/mcp halves of SlashCtx — /model doesn't touch them.
const noopSkills = {
  list: async () => [],
  active: () => [],
  toggle: async () => false,
  clear: () => {},
};
const noopMcp = {
  servers: () => [],
  toggle: () => false,
  toolsForServer: () => [] as Tool[],
};
const noopPerms = { dangerousTools: () => ["bash"], isAllowed: () => false, allow: () => {}, clear: () => {} };

describe("/model slash command", () => {
  let session: ReturnType<typeof newSession>;
  let setModelCalls: string[];
  let ctx: SlashCtx;

  beforeEach(() => {
    setOutputSilent(true); // suppress the handler's stdout prints
    session = newSession("deepseek-chat", undefined, "/tmp");
    setModelCalls = [];
    ctx = {
      apiKey: "sk-test",
      model: session.model,
      temperature: 0.7,
      tools: new ToolRegistry(),
      setModel: (id: string) => {
        setModelCalls.push(id);
        session.model = id;
      },
      skills: noopSkills as SlashCtx["skills"],
      mcp: noopMcp as SlashCtx["mcp"], permissions: noopPerms, prefillHolder: { value: "" },
      reasoning: { get: () => false, set: async () => {} },
      effort: { get: () => undefined, set: async () => {} },
      context: { get: () => undefined, set: async () => {} },
    };
  });

  afterEach(() => setOutputSilent(false));

  it("lists models when called with no arg and does not switch", async () => {
    const r = await handleSlashCommand("/model", session, ctx);
    expect(r).toBe("continue");
    expect(setModelCalls).toEqual([]);
    expect(session.model).toBe("deepseek-chat");
  });

  it("switches to a catalog model", async () => {
    const r = await handleSlashCommand("/model deepseek-reasoner", session, ctx);
    expect(r).toBe("continue");
    expect(setModelCalls).toEqual(["deepseek-reasoner"]);
    expect(session.model).toBe("deepseek-reasoner");
  });

  it("switches to a non-catalog model id (e.g. via --base-url)", async () => {
    const r = await handleSlashCommand("/model gpt-4o-mini", session, ctx);
    expect(r).toBe("continue");
    expect(setModelCalls).toEqual(["gpt-4o-mini"]);
    expect(session.model).toBe("gpt-4o-mini");
  });
});

describe("selectOption picker", () => {
  it("returns null in a non-TTY (test) environment, signaling fallback to listing", async () => {
    const r = await selectOption("pick", [{ label: "a", value: "a" }, { label: "b", value: "b" }]);
    // In the test runner stdin is not a TTY → no interactive picker.
    expect(r).toBeNull();
  });
});

describe("runModelSetupFlow (non-TTY guard)", () => {
  it("cancels without switching when no TTY is available", async () => {
    // stdin is not a TTY in the test runner → the first picker returns null;
    // the whole flow must abort without touching setModel/effort/context.
    const calls: string[] = [];
    const ctx2: SlashCtx = {
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
      temperature: 0.7,
      tools: new ToolRegistry(),
      setModel: (id: string) => { calls.push(`model:${id}`); },
      skills: noopSkills as SlashCtx["skills"],
      mcp: noopMcp as SlashCtx["mcp"], permissions: noopPerms, prefillHolder: { value: "" },
      reasoning: { get: () => true, set: async () => { calls.push("reasoning"); } },
      effort: { get: () => "high", set: async () => { calls.push("effort"); } },
      context: { get: () => 60000, set: async () => { calls.push("context"); } },
    };
    await runModelSetupFlow(ctx2);
    expect(calls).toEqual([]);
  });
});

describe("runModelSetupFlow logic (injected picks)", () => {
  function makeCtx(opts: { reasoning: boolean; effort: "high" | "max" | undefined; context: number }) {
    const calls: string[] = [];
    const ctx: SlashCtx = {
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
      temperature: 0.7,
      tools: new ToolRegistry(),
      setModel: (id: string) => { calls.push(`model:${id}`); },
      skills: noopSkills as SlashCtx["skills"],
      mcp: noopMcp as SlashCtx["mcp"], permissions: noopPerms, prefillHolder: { value: "" },
      reasoning: { get: () => opts.reasoning, set: async (on: boolean) => { calls.push(`reasoning:${on}`); } },
      effort: { get: () => opts.effort, set: async (e: "high" | "max") => { calls.push(`effort:${e}`); } },
      context: { get: () => opts.context, set: async (n: number) => { calls.push(`context:${n}`); } },
    };
    return { ctx, calls };
  }

  it("applies model + effort(max) + context(1M) from explicit picks", async () => {
    const { ctx, calls } = makeCtx({ reasoning: false, effort: undefined, context: 60000 });
    const queue = ["deepseek-v4-pro", "max", "1000000"];
    const pick = async () => queue.shift() ?? null;
    await runModelSetupFlow(ctx, pick);
    expect(calls).toEqual([
      "model:deepseek-v4-pro",
      "reasoning:true", // max turns reasoning on
      "effort:max",
      "context:1000000",
    ]);
  });

  it("keep restores the pre-switch reasoning/effort and skips context", async () => {
    // Pre: reasoning off, effort high. setModel would clobber reasoning on,
    // so "keep current" must restore reasoning:false + effort:high and not
    // touch context.
    const { ctx, calls } = makeCtx({ reasoning: false, effort: "high", context: 60000 });
    const queue = ["deepseek-v4-pro", "keep", "keep"];
    const pick = async () => queue.shift() ?? null;
    await runModelSetupFlow(ctx, pick);
    expect(calls).toEqual([
      "model:deepseek-v4-pro",
      "reasoning:false", // restored (undo the model's default thinking)
      "effort:high",
      // context NOT set
    ]);
  });

  it("off disables reasoning even when switching to a thinking model", async () => {
    const { ctx, calls } = makeCtx({ reasoning: true, effort: "max", context: 60000 });
    const queue = ["deepseek-v4-pro", "off", "keep"];
    const pick = async () => queue.shift() ?? null;
    await runModelSetupFlow(ctx, pick);
    expect(calls).toEqual([
      "model:deepseek-v4-pro",
      "reasoning:false",
      // effort not set when off; context keep → not set
    ]);
  });

  it("Esc at the effort step cancels the whole flow (no apply)", async () => {
    const { ctx, calls } = makeCtx({ reasoning: true, effort: "high", context: 60000 });
    const queue = ["deepseek-v4-pro", null];
    const pick = async () => queue.shift() ?? null;
    await runModelSetupFlow(ctx, pick);
    expect(calls).toEqual([]);
  });
});
