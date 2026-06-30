import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { listSkills, readSkill, skillDirs } from "../src/skills/store.ts";

const ORIG_DS = process.env.DEEPSEEK_SKILLS_DIR;
const ORIG_CC = process.env.CLAUDE_CONFIG_DIR;
const ORIG_CX = process.env.CODEX_HOME;
const ORIG_CM = process.env.CODEMAKER_HOME;
let globalDir: string;
let claudeHome: string;
let codexHome: string;
let codemakerHome: string;
let projectDir: string;
let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ds-skill-test-"));
  globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-skill-global-"));
  claudeHome = await fs.mkdtemp(path.join(os.tmpdir(), "ds-skill-claude-"));
  codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "ds-skill-codex-"));
  codemakerHome = await fs.mkdtemp(path.join(os.tmpdir(), "ds-skill-codemaker-"));
  projectDir = path.join(cwd, ".deepseek", "skills");
  await fs.mkdir(projectDir, { recursive: true });
  process.env.DEEPSEEK_SKILLS_DIR = globalDir;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEMAKER_HOME = codemakerHome;
});

afterEach(async () => {
  for (const [k, v] of Object.entries({ DEEPSEEK_SKILLS_DIR: ORIG_DS, CLAUDE_CONFIG_DIR: ORIG_CC, CODEX_HOME: ORIG_CX, CODEMAKER_HOME: ORIG_CM })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await Promise.all([
    fs.rm(globalDir, { recursive: true, force: true }),
    fs.rm(claudeHome, { recursive: true, force: true }),
    fs.rm(codexHome, { recursive: true, force: true }),
    fs.rm(codemakerHome, { recursive: true, force: true }),
    fs.rm(cwd, { recursive: true, force: true }),
  ]);
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
    // Deduped: shared appears once (deepseek global wins first).
    expect(names.filter((n) => n === "shared").length).toBe(1);
    const shared = list.find((s) => s.name === "shared")!;
    expect(shared.source).toBe("deepseek");
  });

  it("scans Claude Code and Codex skill dirs too", async () => {
    // Global skills under the relocated claude/codex homes + project-level ones.
    await fs.mkdir(path.join(claudeHome, "skills"), { recursive: true });
    await fs.mkdir(path.join(codexHome, "skills"), { recursive: true });
    await fs.writeFile(path.join(claudeHome, "skills", "cc.md"), "claude skill");
    await fs.writeFile(path.join(codexHome, "skills", "cx.md"), "codex skill");

    const list = await listSkills(cwd);
    const byName = new Map(list.map((s) => [s.name, s.source] as const));
    expect(byName.get("cc")).toBe("claude");
    expect(byName.get("cx")).toBe("codex");
  });

  it("discovers directory-layout skills (<name>/SKILL.md), like Claude Code", async () => {
    // A Claude Code skill lives at ~/.claude/skills/<name>/SKILL.md
    const skillDir = path.join(claudeHome, "skills", "feedback-system");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: feedback-system\n---\n# handle feedback\nDo the thing.");
    // non-SKILL directories are ignored
    await fs.mkdir(path.join(claudeHome, "skills", "notaskill"), { recursive: true });

    const list = await listSkills(cwd);
    const entry = list.find((s) => s.name === "feedback-system");
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("claude");
    expect(entry!.path.endsWith("feedback-system/SKILL.md")).toBe(true);
    expect(list.find((s) => s.name === "notaskill")).toBeUndefined();

    const read = await readSkill("feedback-system", cwd);
    expect(read?.content).toContain("# handle feedback");
    expect(read?.content).toContain("_skill directory:"); // footer pointer
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
