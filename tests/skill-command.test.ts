import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { runSkillCommand } from "../src/commands/skill.ts";
import { skillDirs } from "../src/skills/store.ts";

const ORIG = process.env.DEEPSEEK_SKILLS_DIR;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-skillcmd-"));
  process.env.DEEPSEEK_SKILLS_DIR = tmp;
});

afterEach(async () => {
  if (ORIG === undefined) delete process.env.DEEPSEEK_SKILLS_DIR;
  else process.env.DEEPSEEK_SKILLS_DIR = ORIG;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("deepseek skill create command", () => {
  it("writes a codex-style template file", async () => {
    await runSkillCommand(["create", "tdd"]);
    const file = path.join(skillDirs(process.cwd()).global, "tdd.md");
    expect(existsSync(file)).toBe(true);
    const body = await fs.readFile(file, "utf-8");
    expect(body).toContain("---"); // frontmatter
    expect(body).toContain("name: tdd");
    expect(body).toContain("# tdd");
    expect(body).toContain("## When to use");
    expect(body).toContain("## Instructions");
    expect(body).toContain("## Examples");
    expect(body).toContain("## Constraints");
  });

  it("refuses to overwrite an existing skill", async () => {
    const file = path.join(skillDirs(process.cwd()).global, "dup.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "original");
    await runSkillCommand(["create", "dup"]);
    expect(await fs.readFile(file, "utf-8")).toBe("original");
  });

  it("rejects an invalid skill name", async () => {
    await runSkillCommand(["create", "bad name!"]);
    expect(existsSync(path.join(skillDirs(process.cwd()).global, "bad name!.md"))).toBe(false);
  });
});
