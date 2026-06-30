import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { expandFileRefs } from "../src/commands/chat.ts";
import { taskTool } from "../src/tools/task.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

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

  it("annotates a missing file but still attaches nothing useful", async () => {
    const out = await expandFileRefs("see @does-not-exist.ts", tmp);
    // nothing usable → leave prompt untouched (no referenced_files block)
    expect(out).toBe("see @does-not-exist.ts");
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

describe("task tool (sub-agent)", () => {
  it("returns the sub-agent's final text via ctx.spawnAgent", async () => {
    const r = await taskTool.execute(
      { prompt: "summarize x", description: "sum" },
      { cwd: tmp, spawnAgent: async () => "42" },
    );
    expect(r.ok).toBe(true);
    expect(r.content).toBe("42");
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
    // Simulate the parent loop's Promise.all over two task executions: each
    // spawnAgent sleeps briefly; total wall time ≈ one delay, not two.
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
    expect(a.content).toBe("HI");
    expect(b.content).toBe("YO");
    expect(started).toBe(2);
    // two 30ms runs in parallel should be well under 50ms; sequential would be ~60ms.
    expect(elapsed).toBeLessThan(55);
  });
});
