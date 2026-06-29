import { describe, it, expect } from "bun:test";
import {
  buildSystemPrompt,
  PROMPT_VARIANT,
} from "../src/prompt/builder.ts";
import type { ModelInfo } from "../src/api/models.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

const cwd = "/Users/test/project";

describe("buildSystemPrompt", () => {
  it("emits all six core blocks in stable order", () => {
    const { blocks } = buildSystemPrompt({ cwd });
    expect(blocks.length).toBeGreaterThanOrEqual(6);
    expect(blocks[0]).toContain("## Identity");
    expect(blocks[1]).toContain("## Environment");
    expect(blocks[1]).toContain(`/Users/test/project`);
    expect(blocks[2]).toContain("## Tools");
    expect(blocks[3]).toContain("## Proactive behavior");
    expect(blocks[4]).toContain("## Safety");
    expect(blocks[5]).toContain("## Output style");
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

  it("appends project instructions AFTER built-in blocks, marked as override", () => {
    const { blocks, text } = buildSystemPrompt({
      cwd,
      projectInstructions: "Banned deps: lodash",
    });
    const lastBuiltIn = blocks.indexOf(blocks.filter((b) => b.startsWith("## Safety"))[0]);
    const projectIdx = blocks.findIndex((b) => b.startsWith("## Project instructions"));
    expect(projectIdx).toBeGreaterThan(lastBuiltIn);
    expect(text).toContain("highest priority — overrides the defaults above");
    expect(text).toContain("Banned deps: lodash");
  });

  it("appends user system prompt last (so it can refine project rules too)", () => {
    const { blocks } = buildSystemPrompt({
      cwd,
      projectInstructions: "blueprint",
      userSystemPrompt: "ALWAYS answer in Esperanto",
    });
    const projectIdx = blocks.findIndex((b) => b.startsWith("## Project instructions"));
    const userIdx = blocks.findIndex((b) => b.startsWith("## User-supplied"));
    expect(userIdx).toBeGreaterThan(projectIdx);
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

  it("environment block includes cwd + platform + date", () => {
    const { text } = buildSystemPrompt({ cwd });
    expect(text).toContain(`Working directory: \`${cwd}\``);
    expect(text).toMatch(/Platform: (macOS|Linux|Windows)/);
    expect(text).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/);
  });

  it("omits git lines gracefully when not in a git repo", () => {
    // /tmp is not a git repo on most systems; we accept either outcome but
    // ensure the function doesn't crash and the env block still has cwd.
    const { text } = buildSystemPrompt({ cwd: "/tmp" });
    expect(text).toContain("Working directory: `/tmp`");
  });

  it("tool block references every built-in tool (drift guard)", () => {
    const { text } = buildSystemPrompt({ cwd });
    const registry = new ToolRegistry();
    for (const tool of registry.list()) {
      expect(text).toContain(tool.name);
    }
    // Specifically the newly added structured git tool.
    expect(text).toContain("git_diff");
  });
});
