import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { handleSlashCommand } from "../src/commands/chat.ts";
import { newSession } from "../src/session/store.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { setOutputSilent } from "../src/ui/render.ts";
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
