import { describe, it, expect, beforeEach } from "bun:test";
import { completeSlash, handleSlashCommand, parseSlashSkillInvocation } from "../src/commands/chat.ts";
import { newSession } from "../src/session/store.ts";
import { setOutputSilent } from "../src/ui/render.ts";
import type { SlashCtx } from "../src/commands/chat.ts";
import type { Tool } from "../src/tools/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

const noopSkills = { list: async () => [], active: () => [], toggle: async () => false, clear: () => {} };
const noopMcp = { servers: () => [], toggle: () => false, toolsForServer: () => [] as Tool[], add: async () => ({ ok: false, toolCount: 0 }) };

beforeEach(() => setOutputSilent(true));

describe("parseSlashSkillInvocation", () => {
  it("parses /<skill> <task> into name + task", () => {
    expect(parseSlashSkillInvocation("/feedback-system 处理反馈 123")).toEqual({ name: "feedback-system", task: "处理反馈 123" });
  });

  it("preserves mixed-case skill names", () => {
    expect(parseSlashSkillInvocation("/Filmly-uikit-dev build a cell")).toEqual({ name: "Filmly-uikit-dev", task: "build a cell" });
  });

  it("returns null when the first token is a builtin slash command (no shadowing)", () => {
    expect(parseSlashSkillInvocation("/model deepseek-v4-pro")).toBeNull();
    expect(parseSlashSkillInvocation("/skill tdd")).toBeNull();
    expect(parseSlashSkillInvocation("/help")).toBeNull();
  });

  it("returns empty task when only the skill is given", () => {
    expect(parseSlashSkillInvocation("/feedback-system")).toEqual({ name: "feedback-system", task: "" });
  });

  it("returns null for non-slash input", () => {
    expect(parseSlashSkillInvocation("just typing")).toBeNull();
  });
});

describe("completeSlash (Tab completion)", () => {
  it("returns nothing for non-slash input", () => {
    expect(completeSlash("hello")).toEqual([]);
  });

  it("lists all commands for a bare '/'", () => {
    const all = completeSlash("/");
    expect(all.length).toBeGreaterThan(10);
    expect(all).toContain("/model");
    expect(all).toContain("/skill");
    expect(all).toContain("/mcp");
    expect(all).toContain("/allow");
  });

  it("filters by prefix", () => {
    expect(completeSlash("/m")).toEqual(["/model", "/mcp"]);
    expect(completeSlash("/mo")).toEqual(["/model"]);
  });

  it("matches aliases too", () => {
    expect(completeSlash("/q")).toContain("/q");
    expect(completeSlash("/q")).toContain("/quit");
    expect(completeSlash("/?")).toContain("/?");
  });

  it("returns empty when prefix matches nothing", () => {
    expect(completeSlash("/zzz")).toEqual([]);
  });
});

describe("/allow slash command", () => {
  let allowed: string[];
  let cleared: boolean;

  beforeEach(() => {
    allowed = [];
    cleared = false;
  });

  function ctx(): SlashCtx {
    return {
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
      temperature: 0.7,
      tools: new ToolRegistry(),
      setModel: () => {},
      skills: noopSkills as SlashCtx["skills"],
      mcp: noopMcp as SlashCtx["mcp"],
      reasoning: { get: () => true, set: async () => {} },
      effort: { get: () => "high", set: async () => {} },
      context: { get: () => 60000, set: async () => {} },
      promptLog: { get: () => true, set: async () => {} },
      permissions: {
        dangerousTools: () => ["bash", "write_file", "edit_file"],
        isAllowed: (n: string) => allowed.includes(n),
        allow: (n: string) => { allowed.push(n); },
        clear: () => { cleared = true; allowed = []; },
      },
      prefillHolder: { value: "" },
      runSideTurn: async () => {},
    };
  }

  it("lists dangerous tools with no arg", async () => {
    const r = await handleSlashCommand("/allow", newSession("m"), ctx());
    expect(r).toBe("continue");
  });

  it("authorizes bash for the session", async () => {
    const r = await handleSlashCommand("/allow bash", newSession("m"), ctx());
    expect(r).toBe("continue");
    expect(allowed).toEqual(["bash"]);
  });

  it("authorizes all dangerous tools", async () => {
    const r = await handleSlashCommand("/allow all", newSession("m"), ctx());
    expect(r).toBe("continue");
    expect(allowed.sort()).toEqual(["bash", "edit_file", "write_file"]);
  });

  it("clears on reset", async () => {
    const c = ctx();
    await handleSlashCommand("/allow bash", newSession("m"), c);
    await handleSlashCommand("/allow reset", newSession("m"), c);
    expect(cleared).toBe(true);
  });

  it("rejects a non-dangerous tool name", async () => {
    const r = await handleSlashCommand("/allow read_file", newSession("m"), ctx());
    expect(r).toBe("continue");
    expect(allowed).toEqual([]);
  });
});
