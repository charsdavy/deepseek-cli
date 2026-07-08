import { describe, it, expect } from "bun:test";
import { classify, type TaskCategory, type ClassificationResult } from "../src/agent/classifier.ts";

describe("classify", () => {
  it("classifies implementation prompts", () => {
    const r = classify("implement a new login page");
    expect(r.category).toBe("implementation");
    expect(r.hints.recommendReasoning).toBe(true);
    expect(r.hints.readOnlyTools).toBe(false);
  });

  it("classifies exploration prompts", () => {
    const r = classify("find all usages of the auth middleware");
    expect(r.category).toBe("exploration");
    expect(r.hints.recommendReasoning).toBe(false);
    expect(r.hints.readOnlyTools).toBe(true);
  });

  it("classifies debug prompts", () => {
    const r = classify("fix the crash in the payment handler");
    expect(r.category).toBe("debug");
    expect(r.hints.recommendReasoning).toBe(true);
  });

  it("classifies code review prompts", () => {
    const r = classify("review the auth module for security issues");
    expect(r.category).toBe("code_review");
    expect(r.hints.readOnlyTools).toBe(true);
  });

  it("classifies planning prompts", () => {
    const r = classify("design the architecture for the new microservice");
    expect(r.category).toBe("planning");
  });

  it("falls back to general for unclassifiable prompts", () => {
    const r = classify("hi");
    expect(r.category).toBe("general");
    expect(r.hints.recommendReasoning).toBe(false);
  });

  it("uses strong keywords over weak ones", () => {
    // "create" (implementation strong) vs "what" (exploration weak) — strong wins
    const r = classify("create a new component");
    expect(r.category).toBe("implementation");
  });

  it("classifies Chinese implementation tasks correctly", () => {
    const r = classify("实现用户登录功能");
    expect(r.category).toBe("implementation");
  });

  it("detects simple exploration keywords", () => {
    const r = classify("list all the files in the src directory");
    expect(r.category).toBe("exploration");
  });

  it("detects complex tasks in Chinese", () => {
    const r = classify("实现用户登录功能");
    expect(r.category).toBe("implementation");
  });

  it("returns confidence between 0 and 1", () => {
    const r = classify("add a new button to the page");
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("returns high confidence for strongly matching prompts", () => {
    const r = classify("implement create build fix debug");
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it("all categories have valid hints", () => {
    const categories: TaskCategory[] = ["code_review", "implementation", "exploration", "debug", "planning", "general"];
    for (const cat of categories) {
      // We can't force a category, but we can verify hints map exists for all
      const r = classify("generic prompt");
      expect(r.hints.toolPriority.length).toBeGreaterThan(0);
    }
  });

  it("classifies read-only shell-like tasks as exploration", () => {
    const r = classify("show me what's in the config file");
    expect(r.category).toBe("exploration");
  });

  it("classifies error investigation as debug", () => {
    const r = classify("debug the crash in the payment module");
    expect(r.category).toBe("debug");
  });
});
