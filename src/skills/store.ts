// Skill store — local, file-based skills that specialize the agent's behavior.
//
// A skill is a markdown file whose contents get folded into the system prompt
// when active. To play well with sibling CLIs, skills are discovered from the
// deepseek, Claude Code, and Codex directories (global + project each). On a
// name clash, the deepseek copy wins (scanned first). Activation is
// session-scoped and driven by the /skill slash command.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { CONFIG_DIR } from "../config/config.ts";

export type SkillSource = "deepseek" | "claude" | "codex";

export interface SkillEntry {
  name: string;
  /** Which CLI's skill directory this came from. */
  source: SkillSource;
  path: string;
}

export interface ActiveSkill {
  name: string;
  content: string;
}

export interface SkillSearchPath {
  label: SkillSource;
  dir: string;
}

/** Deepseek-only dirs (kept for back-compat with earlier tests). */
export function skillDirs(cwd: string): { global: string; project: string } {
  const global = process.env.DEEPSEEK_SKILLS_DIR ?? path.join(CONFIG_DIR, "skills");
  return {
    global,
    project: path.join(cwd, ".deepseek", "skills"),
  };
}

/**
 * All skill search paths, in priority order (deepseek wins on name clash).
 * Global paths honor each tool's own relocation env var:
 *   - deepseek: DEEPSEEK_SKILLS_DIR (defaults to ~/.deepseek-cli/skills)
 *   - claude:   CLAUDE_CONFIG_DIR  (defaults to ~/.claude)
 *   - codex:    CODEX_HOME         (defaults to ~/.codex)
 */
export function skillSearchPaths(cwd: string): SkillSearchPath[] {
  const home = os.homedir();
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  const codexHome = process.env.CODEX_HOME ?? path.join(home, ".codex");
  const deepseekGlobal = process.env.DEEPSEEK_SKILLS_DIR ?? path.join(CONFIG_DIR, "skills");
  return [
    { label: "deepseek", dir: deepseekGlobal },
    { label: "deepseek", dir: path.join(cwd, ".deepseek", "skills") },
    { label: "claude", dir: path.join(claudeHome, "skills") },
    { label: "claude", dir: path.join(cwd, ".claude", "skills") },
    { label: "codex", dir: path.join(codexHome, "skills") },
    { label: "codex", dir: path.join(cwd, ".codex", "skills") },
  ];
}

/** List all discoverable skills across every source, deduplicated by name. */
export async function listSkills(cwd: string): Promise<SkillEntry[]> {
  const out: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const { label, dir } of skillSearchPaths(cwd)) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source: label, path: path.join(dir, f) });
    }
  }
  return out;
}

/** Read a skill's content by name, scanning sources in priority order. */
export async function readSkill(name: string, cwd: string): Promise<ActiveSkill | null> {
  const safe = name.replace(/[\\/]/g, "");
  for (const { dir } of skillSearchPaths(cwd)) {
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
