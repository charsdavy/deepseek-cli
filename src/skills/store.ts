// Skill store — local skill discovery that specializes the agent's behavior.
//
// A skill is a markdown file whose contents get folded into the system prompt
// when active. Two on-disk layouts are supported:
//   • flat:    <root>/<name>.md            (our `deepseek skill create` output)
//   • dir:     <root>/<name>/SKILL.md      (Claude Code / codemaker layout)
//
// Roots are scanned from the deepseek, Claude Code, Codex, and codemaker
// directories (global + project each). On a name clash, deepseek wins first.
// Claude/codex/codemaker global roots honor their own relocation env vars.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { CONFIG_DIR } from "../config/config.ts";

export type SkillSource = "deepseek" | "claude" | "codex" | "codemaker";

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
 *   - deepseek:  DEEPSEEK_SKILLS_DIR (defaults to ~/.deepseek-cli/skills)
 *   - claude:    CLAUDE_CONFIG_DIR  (defaults to ~/.claude)
 *   - codex:     CODEX_HOME         (defaults to ~/.codex)
 *   - codemaker: CODEMAKER_HOME     (defaults to ~/.codemaker)
 */
export function skillSearchPaths(cwd: string): SkillSearchPath[] {
  const home = os.homedir();
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  const codexHome = process.env.CODEX_HOME ?? path.join(home, ".codex");
  const codemakerHome = process.env.CODEMAKER_HOME ?? path.join(home, ".codemaker");
  const deepseekGlobal = process.env.DEEPSEEK_SKILLS_DIR ?? path.join(CONFIG_DIR, "skills");
  return [
    { label: "deepseek", dir: deepseekGlobal },
    { label: "deepseek", dir: path.join(cwd, ".deepseek", "skills") },
    { label: "claude", dir: path.join(claudeHome, "skills") },
    { label: "claude", dir: path.join(cwd, ".claude", "skills") },
    { label: "codex", dir: path.join(codexHome, "skills") },
    { label: "codex", dir: path.join(cwd, ".codex", "skills") },
    { label: "codemaker", dir: path.join(codemakerHome, "skills") },
    { label: "codemaker", dir: path.join(cwd, ".codemaker", "skills") },
  ];
}

// The marker file inside a directory-layout skill (case-insensitive on disk).
const SKILL_MD = "SKILL.md";

/** List all discoverable skills across every source, deduplicated by name. */
export async function listSkills(cwd: string): Promise<SkillEntry[]> {
  const out: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const { label, dir } of skillSearchPaths(cwd)) {
    if (!existsSync(dir)) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Directory layout (works for real dirs AND symlinked dirs — existsSync
      // follows symlinks, Dirent.isDirectory() does not).
      const skillMd = path.join(dir, e.name, SKILL_MD);
      if (existsSync(skillMd)) {
        if (seen.has(e.name)) continue;
        seen.add(e.name);
        out.push({ name: e.name, source: label, path: skillMd });
        continue;
      }
      // Flat layout: <name>.md (also via existsSync so symlinked files work).
      if (e.name.endsWith(".md") && e.name !== SKILL_MD && existsSync(path.join(dir, e.name))) {
        const name = e.name.slice(0, -3);
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, source: label, path: path.join(dir, e.name) });
      }
    }
  }
  return out;
}

/** Read a skill's content by name, scanning sources in priority order. */
export async function readSkill(name: string, cwd: string): Promise<ActiveSkill | null> {
  const safe = name.replace(/[\\/]/g, "");
  for (const sp of skillSearchPaths(cwd)) {
    const dir = sp.dir;
    // Flat first, then directory layout.
    const flat = path.join(dir, `${safe}.md`);
    if (existsSync(flat)) {
      try {
        return { name, content: await fs.readFile(flat, "utf-8") };
      } catch {
        /* try next */
      }
    }
    const dirSkill = path.join(dir, safe, SKILL_MD);
    if (existsSync(dirSkill)) {
      try {
        const body = await fs.readFile(dirSkill, "utf-8");
        // Append a pointer to the skill's directory so the agent can locate
        // sibling references/ or scripts/ the SKILL.md may mention.
        const skillDir = path.dirname(dirSkill);
        const footer = `\n\n---\n_skill directory: ${skillDir} (may contain references/ and scripts/ subdirs)_`;
        return { name, content: body + footer };
      } catch {
        /* try next */
      }
    }
  }
  return null;
}
