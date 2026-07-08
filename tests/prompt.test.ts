import { describe, it, expect } from "bun:test";
import {
  buildSystemPrompt,
  buildEnvironmentContext,
  clearPromptCache,
  PROMPT_VARIANT,
} from "../src/prompt/builder.ts";
import type { ModelInfo } from "../src/api/models.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

const cwd = "/Users/test/project";

describe("buildSystemPrompt", () => {
  it("emits all core blocks in stable order (static system prompt, no env)", () => {
    const { blocks, text, envContext } = buildSystemPrompt({ cwd });
    // 7 core blocks: identity, tools, behavior, latency, code style, safety, style
    // (may include reasoning addendum if model is reasoning-capable)
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    expect(blocks[0]).toContain("## Identity");
    expect(blocks[1]).toContain("## Tools");
    expect(blocks[2]).toContain("## Proactive behavior");
    expect(blocks[3]).toContain("## Iteration cost");
    expect(blocks[4]).toContain("## Code style");
    expect(blocks[5]).toContain("## Safety");
    expect(blocks[6]).toContain("## Output style");
    // env is not in blocks — it's returned separately
    expect(text).not.toContain("## Environment");
    // envContext should exist
    expect(envContext).toContain("## Environment");
  });

  it("returns envContext with cwd, platform, date", () => {
    const { envContext } = buildSystemPrompt({ cwd });
    expect(envContext).toContain(`Working directory: \`${cwd}\``);
    expect(envContext).toMatch(/Platform: (macOS|Linux|Windows)/);
    expect(envContext).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/);
  });

  it("envContext omits git lines gracefully when not in a git repo", () => {
    const { envContext } = buildSystemPrompt({ cwd: "/tmp" });
    expect(envContext).toContain("Working directory: `/tmp`");
  });

  it("includes model label in envContext when modelInfo provided", () => {
    const reasoner: ModelInfo = { id: "deepseek-reasoner", label: "Reasoner", description: "", thinking: true };
    const { envContext } = buildSystemPrompt({ cwd, modelInfo: reasoner });
    expect(envContext).toContain("Model: Reasoner");
    expect(envContext).toContain("deepseek-reasoner");
  });

  it("includes model id in identity block when modelId is passed", () => {
    const { text } = buildSystemPrompt({ cwd, modelId: "deepseek-v4-pro" });
    expect(text).toContain("You are powered by the model named deepseek-v4-pro");
    expect(text).toContain("The exact model ID is deepseek-v4-pro");
  });

  it("falls back to modelInfo.id when modelId not passed", () => {
    const pro: ModelInfo = { id: "deepseek-v4-pro", label: "V4 Pro", description: "" };
    const { text } = buildSystemPrompt({ cwd, modelInfo: pro });
    expect(text).toContain("deepseek-v4-pro");
  });

  it("does NOT emit the reasoning addendum for chat models", () => {
    const chatModel: ModelInfo = { id: "deepseek-chat", label: "Chat", description: "" };
    const { text } = buildSystemPrompt({ cwd, modelInfo: chatModel });
    expect(text).not.toContain("## Reasoning model guidance");
  });

  it("emits the reasoning addendum for thinking models", () => {
    const reasoner: ModelInfo = { id: "deepseek-reasoner", label: "R", description: "", thinking: true };
    const { text, blocks } = buildSystemPrompt({ cwd, modelInfo: reasoner });
    expect(text).toContain("## Reasoning model guidance");
    const reasoningBlock = blocks.find((b) => b.startsWith("## Reasoning model guidance"));
    expect(reasoningBlock).toBeDefined();
  });

  it("respects isReasoning=true override even without modelInfo", () => {
    const { text } = buildSystemPrompt({ cwd, isReasoning: true });
    expect(text).toContain("## Reasoning model guidance");
  });

  it("appends project instructions AFTER built-in blocks (backward compat)", () => {
    const { blocks, text } = buildSystemPrompt({
      cwd,
      projectInstructions: "Banned deps: lodash",
    });
    const safetyIdx = blocks.findIndex((b) => b.startsWith("## Safety"));
    const projectIdx = blocks.findIndex((b) => b.startsWith("## Project instructions"));
    expect(projectIdx).toBeGreaterThan(safetyIdx);
    expect(text).toContain("highest priority — overrides the defaults above");
    expect(text).toContain("Banned deps: lodash");
  });

  it("appends user system prompt last", () => {
    const { blocks } = buildSystemPrompt({
      cwd,
      userSystemPrompt: "ALWAYS answer in Esperanto",
    });
    const userIdx = blocks.findIndex((b) => b.startsWith("## User-supplied"));
    expect(userIdx).toBeGreaterThan(0);
    expect(blocks.at(-1)).toContain("ALWAYS answer in Esperanto");
  });

  it("exposes a stable PROMPT_VARIANT for regression tracking", () => {
    expect(typeof PROMPT_VARIANT).toBe("string");
    expect(PROMPT_VARIANT.length).toBeGreaterThan(0);
    const a = buildSystemPrompt({ cwd });
    const b = buildSystemPrompt({ cwd });
    expect(a.variant).toBe(b.variant);
    expect(a.variant).toBe(PROMPT_VARIANT);
  });

  it("blocks join with \\n\\n separators in the text field", () => {
    const { text, blocks } = buildSystemPrompt({ cwd });
    expect(text).toBe(blocks.join("\n\n"));
  });

  it("tool block references every built-in tool (drift guard)", () => {
    const { text } = buildSystemPrompt({ cwd });
    const registry = new ToolRegistry();
    for (const tool of registry.list()) {
      expect(text).toContain(tool.name);
    }
    expect(text).toContain("git_diff");
  });

  it("injects active skills before project instructions", () => {
    const { blocks, text } = buildSystemPrompt({
      cwd,
      activeSkills: [{ name: "tdd", content: "Always write the test first." }],
      projectInstructions: "Banned: lodash",
    });
    const skillIdx = blocks.findIndex((b) => b.startsWith("## Active skills"));
    const projectIdx = blocks.findIndex((b) => b.startsWith("## Project instructions"));
    expect(skillIdx).toBeGreaterThan(-1);
    expect(projectIdx).toBeGreaterThan(skillIdx);
    expect(text).toContain("### skill: tdd");
    expect(text).toContain("Always write the test first.");
  });

  it("omits the skills block when no skills are active", () => {
    const { text } = buildSystemPrompt({ cwd });
    expect(text).not.toContain("## Active skills");
  });

  it("code style block contains Don't-style negative rules", () => {
    const { text } = buildSystemPrompt({ cwd });
    expect(text).toContain("Don't add features, refactor, or introduce abstractions");
    expect(text).toContain("Don't add error handling or validation");
    expect(text).toContain("Default to writing no comments");
  });

  it("caches and returns identical BuiltPrompt for same inputs", () => {
    clearPromptCache();
    const a = buildSystemPrompt({ cwd, modelId: "deepseek-v4-pro" });
    const b = buildSystemPrompt({ cwd, modelId: "deepseek-v4-pro" });
    // Same object identity when cached
    expect(a.text).toBe(b.text);
    expect(a.blocks).toBe(b.blocks);
  });

  it("returns different result when inputs change", () => {
    clearPromptCache();
    const a = buildSystemPrompt({ cwd, modelId: "deepseek-v4-flash" });
    const b = buildSystemPrompt({ cwd, modelId: "deepseek-v4-pro" });
    expect(a.text).not.toBe(b.text);
  });

  it("output style defaults to concise", () => {
    const { text } = buildSystemPrompt({ cwd });
    expect(text).toContain("Be concise. Answer in 1–3 sentences");
    expect(text).not.toContain("(explanatory mode)");
    expect(text).not.toContain("(learning mode)");
  });

  it("output style explains adds educational insights", () => {
    const { text } = buildSystemPrompt({ cwd, outputStyle: "explain" });
    expect(text).toContain("(explanatory mode)");
    expect(text).toContain("Explain WHY the code works");
  });

  it("output style learning adds tutoring mode", () => {
    const { text } = buildSystemPrompt({ cwd, outputStyle: "learning" });
    expect(text).toContain("(learning mode)");
    expect(text).toContain("coding tutor");
  });

  it("truncates large skill content to budget limit", () => {
    const largeSkill = "x".repeat(2500);
    const { text } = buildSystemPrompt({
      cwd,
      activeSkills: [{ name: "big-skill", content: largeSkill }],
    });
    expect(text).toContain("### skill: big-skill");
    expect(text).toContain("truncated");
    // Should not contain the full original content
    expect(text).not.toContain(largeSkill);
  });

  it("does not truncate small skill content", () => {
    const smallSkill = "Always use single quotes.";
    const { text } = buildSystemPrompt({
      cwd,
      activeSkills: [{ name: "lint", content: smallSkill }],
    });
    expect(text).toContain(smallSkill);
    expect(text).not.toContain("truncated");
  });

  it("clearPromptCache clears the cache", () => {
    clearPromptCache();
    const a = buildSystemPrompt({ cwd });
    clearPromptCache();
    const b = buildSystemPrompt({ cwd });
    // After clearing, should return same content but new object
    expect(a.text).toBe(b.text);
  });
});

describe("buildEnvironmentContext", () => {
  it("returns env block as standalone string", () => {
    const ctx = buildEnvironmentContext("/home/user");
    expect(ctx).toContain("## Environment");
    expect(ctx).toContain("Working directory: `/home/user`");
  });

  it("includes model info when provided", () => {
    const pro: ModelInfo = { id: "deepseek-v4-pro", label: "V4 Pro", description: "", thinking: true };
    const ctx = buildEnvironmentContext("/tmp", pro);
    expect(ctx).toContain("Model: V4 Pro");
    expect(ctx).toContain("(reasoning enabled)");
  });

  it("does not include model info when not provided", () => {
    const ctx = buildEnvironmentContext("/tmp");
    expect(ctx).not.toContain("Model:");
  });
});
