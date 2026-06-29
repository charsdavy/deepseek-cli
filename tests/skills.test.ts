import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { listSkills, readSkill, skillDirs } from "../src/skills/store.ts";

const ORIG = process.env.DEEPSEEK_SKILLS_DIR;
let globalDir: string;
let projectDir: string;
let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ds-skill-test-"));
  globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-skill-global-"));
  projectDir = path.join(cwd, ".deepseek", "skills");
  await fs.mkdir(projectDir, { recursive: true });
  process.env.DEEPSEEK_SKILLS_DIR = globalDir;
});

afterEach(async () => {
  if (ORIG === undefined) delete process.env.DEEPSEEK_SKILLS_DIR;
  else process.env.DEEPSEEK_SKILLS_DIR = ORIG;
  await fs.rm(globalDir, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("skillDirs", () => {
  it("honors the DEEPSEEK_SKILLS_DIR env override for global", () => {
    const { global: g, project: p } = skillDirs(cwd);
    expect(g).toBe(globalDir);
    expect(p).toBe(path.join(cwd, ".deepseek", "skills"));
  });
});

describe("listSkills", () => {
  it("lists global + project skills, deduped by name", async () => {
    await fs.writeFile(path.join(globalDir, "g1.md"), "global one");
    await fs.writeFile(path.join(globalDir, "shared.md"), "global shared");
    await fs.writeFile(path.join(projectDir, "p1.md"), "project one");
    await fs.writeFile(path.join(projectDir, "shared.md"), "project shared");

    const list = await listSkills(cwd);
    const names = list.map((s) => s.name);
    expect(names).toContain("g1");
    expect(names).toContain("p1");
    expect(names).toContain("shared");
    // Deduped: shared appears once (global wins first).
    expect(names.filter((n) => n === "shared").length).toBe(1);
    const shared = list.find((s) => s.name === "shared")!;
    expect(shared.source).toBe("global");
  });

  it("returns [] when no skill dirs exist", async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
    process.env.DEEPSEEK_SKILLS_DIR = path.join(globalDir, "nope");
    const list = await listSkills(cwd);
    expect(list).toEqual([]);
  });

  it("ignores non-markdown files", async () => {
    await fs.writeFile(path.join(globalDir, "notes.txt"), "not a skill");
    await fs.writeFile(path.join(globalDir, "real.md"), "yes");
    const names = (await listSkills(cwd)).map((s) => s.name);
    expect(names).toEqual(["real"]);
  });
});

describe("readSkill", () => {
  it("reads a global skill", async () => {
    await fs.writeFile(path.join(globalDir, "plan.md"), "plan content");
    const s = await readSkill("plan", cwd);
    expect(s?.content).toBe("plan content");
  });

  it("falls back to project dir", async () => {
    await fs.writeFile(path.join(projectDir, "local.md"), "project content");
    const s = await readSkill("local", cwd);
    expect(s?.content).toBe("project content");
  });

  it("returns null for unknown skill", async () => {
    expect(await readSkill("missing", cwd)).toBeNull();
  });
});
