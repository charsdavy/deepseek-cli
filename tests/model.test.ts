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
      mcp: noopMcp as SlashCtx["mcp"],
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
      mcp: noopMcp as SlashCtx["mcp"],
      reasoning: { get: () => true, set: async () => { calls.push("reasoning"); } },
      effort: { get: () => "high", set: async () => { calls.push("effort"); } },
      context: { get: () => 60000, set: async () => { calls.push("context"); } },
    };
    await runModelSetupFlow(ctx2);
    expect(calls).toEqual([]);
  });
});
