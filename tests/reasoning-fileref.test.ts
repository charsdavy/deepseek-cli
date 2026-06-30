import { describe, it, expect, beforeEach } from "bun:test";
import { handleSlashCommand } from "../src/commands/chat.ts";
import { newSession } from "../src/session/store.ts";
import { setOutputSilent } from "../src/ui/render.ts";
import type { SlashCtx } from "../src/commands/chat.ts";
import type { Tool } from "../src/tools/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

const noopSkills = { list: async () => [], active: () => [], toggle: async () => false, clear: () => {} };
const noopMcp = { servers: () => [], toggle: () => false, toolsForServer: () => [] as Tool[] };

let reasoningState: boolean;
let savedToCfg: boolean | null;

beforeEach(() => {
  setOutputSilent(true);
  reasoningState = false;
  savedToCfg = null;
});

function ctx(): SlashCtx {
  return {
    apiKey: "sk-test",
    model: "deepseek-v4-pro",
    temperature: 0.7,
    tools: new ToolRegistry(),
    setModel: () => {},
    skills: noopSkills as SlashCtx["skills"],
    mcp: noopMcp as SlashCtx["mcp"],
    reasoning: {
      get: () => reasoningState,
      set: async (on: boolean) => { reasoningState = on; savedToCfg = on; },
    },
  };
}

describe("/reasoning slash command", () => {
  it("reports current state with no arg (no persist)", async () => {
    reasoningState = true;
    const r = await handleSlashCommand("/reasoning", newSession("m"), ctx());
    expect(r).toBe("continue");
    expect(savedToCfg).toBeNull();
  });

  it("turns reasoning on and persists", async () => {
    const r = await handleSlashCommand("/reasoning on", newSession("m"), ctx());
    expect(r).toBe("continue");
    expect(reasoningState).toBe(true);
    expect(savedToCfg).toBe(true);
  });

  it("turns reasoning off (alias /thinking)", async () => {
    const r = await handleSlashCommand("/thinking off", newSession("m"), ctx());
    expect(r).toBe("continue");
    expect(reasoningState).toBe(false);
    expect(savedToCfg).toBe(false);
  });

  it("rejects an unknown value without changing/persisting", async () => {
    const r = await handleSlashCommand("/reasoning maybe", newSession("m"), ctx());
    expect(r).toBe("continue");
    expect(savedToCfg).toBeNull();
  });
});
