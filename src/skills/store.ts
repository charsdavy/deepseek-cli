// Skill store — local, file-based skills that specialize the agent's behavior.
//
// A skill is a markdown file whose contents get folded into the system prompt
// when active. Skills are discovered from two locations:
//   • global:  ~/.deepseek-cli/skills/<name>.md
//   • project: <cwd>/.deepseek/skills/<name>.md
// Project skills are listed alongside global ones; global wins on name clash
// only for listing order (both are readable). Activation is session-scoped
// and driven by the /skill slash command.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { CONFIG_DIR } from "../config/config.ts";

export interface SkillEntry {
  name: string;
  source: "global" | "project";
  path: string;
}

export interface ActiveSkill {
  name: string;
  content: string;
}

export function skillDirs(cwd: string): { global: string; project: string } {
  // Honor DEEPSEEK_SKILLS_DIR so tests (and power users) can relocate global
  // skills without touching ~/.deepseek-cli.
  const global = process.env.DEEPSEEK_SKILLS_DIR ?? path.join(CONFIG_DIR, "skills");
  return {
    global,
    project: path.join(cwd, ".deepseek", "skills"),
  };
}

/** List all discoverable skills (global + project), deduplicated by name. */
export async function listSkills(cwd: string): Promise<SkillEntry[]> {
  const { global, project } = skillDirs(cwd);
  const out: SkillEntry[] = [];
  const seen = new Set<string>();
  const scan = async (dir: string, source: "global" | "project"): Promise<void> => {
    if (!existsSync(dir)) return;
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const f of files.sort()) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source, path: path.join(dir, f) });
    }
  };
  await scan(global, "global");
  await scan(project, "project");
  return out;
}

/** Read a skill's content by name, preferring global then project. */
export async function readSkill(name: string, cwd: string): Promise<ActiveSkill | null> {
  const safe = name.replace(/[\\/]/g, "");
  for (const dir of Object.values(skillDirs(cwd))) {
    const p = path.join(dir, `${safe}.md`);
    if (existsSync(p)) {
      try {
        const content = await fs.readFile(p, "utf-8");
        return { name, content };
      } catch {
        /* try next */
      }
    }
  }
  return null;
}
