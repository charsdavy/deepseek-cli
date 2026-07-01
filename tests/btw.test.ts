import { describe, it, expect } from "bun:test";
import { handleSlashCommand, type SlashCtx } from "../src/commands/chat.ts";
import { newSession } from "../src/session/store.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/types.ts";

// Minimal stubs for the skills/mcp halves of SlashCtx — /btw doesn't touch them.
const noopSkills = {
  list: async () => [],
  active: () => [],
  toggle: async () => false,
  clear: () => {},
  read: async () => null,
  deactivate: () => {},
} as unknown as SlashCtx["skills"];

const noopMcp = {
  servers: () => [],
  toggle: () => false,
  toolsForServer: () => [] as Tool[],
  add: async () => ({ ok: false, toolCount: 0 }),
  list: () => [],
} as unknown as SlashCtx["mcp"];

// Minimal SlashCtx stub: only the runSideTurn field is exercised by /btw,
// the rest is filled with no-ops so TypeScript is satisfied.
function makeCtx(runSideTurn: (q: string) => Promise<void>): SlashCtx {
  return {
    apiKey: "sk-test",
    model: "deepseek-chat",
    temperature: 0.7,
    tools: new ToolRegistry(),
    setModel: () => {},
    skills: noopSkills,
    mcp: noopMcp,
    reasoning: { get: () => false, set: async () => {} },
    effort: { get: () => "high", set: async () => {} },
    context: { get: () => 60000, set: async () => {} },
    promptLog: { get: () => true, set: async () => {} },
    permissions: { dangerousTools: () => [], isAllowed: () => false, allow: () => {}, clear: () => {} },
    prefillHolder: { value: "" },
    runSideTurn,
  };
}

describe("/btw slash command", () => {
  it("without a question prints usage and does not run a side turn", async () => {
    const calls: string[] = [];
    const session = newSession("deepseek-chat", undefined, "/tmp");
    const r = await handleSlashCommand("/btw", session, makeCtx(async (q) => { calls.push(q); }));
    expect(r).toBe("continue");
    expect(calls).toEqual([]);
  });

  it("dispatches the question to runSideTurn and returns continue", async () => {
    const calls: string[] = [];
    const session = newSession("deepseek-chat", undefined, "/tmp");
    const before = session.messages.length;
    const r = await handleSlashCommand("/btw what's 2+2?", session, makeCtx(async (q) => { calls.push(q); }));
    expect(r).toBe("continue");
    expect(calls).toEqual(["what's 2+2?"]);
    // Main session is untouched: no user message appended, no state change.
    expect(session.messages.length).toBe(before);
  });

  it("joins a multi-word prompt (consecutive spaces collapse)", async () => {
    const calls: string[] = [];
    const session = newSession("deepseek-chat", undefined, "/tmp");
    const r = await handleSlashCommand("/btw   remind me   how bash arrays work", session, makeCtx(async (q) => { calls.push(q); }));
    expect(r).toBe("continue");
    expect(calls).toEqual(["remind me how bash arrays work"]);
  });
});
