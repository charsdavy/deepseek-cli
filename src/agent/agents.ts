// Agent definition system: discovers and parses custom agent definitions
// from agents/*.md files in project and global config directories.
//
// Format (YAML frontmatter + Markdown body):
//   ---
//   model: deepseek-v4-flash
//   tools: [read_file, grep, glob, list_dir]
//   ---
//   You are a code reviewer. Analyze code for bugs, style issues...

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import { log } from "../log/logger.ts";

// ---- Types ----

export interface AgentDefinition {
  /** The agent type name used in subagent_type parameter. */
  name: string;
  /** Model override (optional — defaults to sub-agent model). */
  model?: string;
  /** Tool allowlist. If absent, all tools are available. */
  tools?: string[];
  /** The system prompt body (markdown content after frontmatter). */
  systemPrompt: string;
  /** Source location for debugging. */
  source: string;
}

// ---- YAML frontmatter parser (minimal, zero-dep) ----

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

interface Frontmatter {
  model?: string;
  tools?: string[];
}

export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: raw };
  const yamlBlock = m[1];
  const body = raw.slice(m[0].length);
  const fm: Frontmatter = {};
  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    switch (key) {
      case "model":
        fm.model = value.replace(/^["']|["']$/g, "");
        break;
      case "tools": {
        const inner = value.replace(/^\[|\]$/g, "").trim();
        if (inner) {
          fm.tools = inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
        } else {
          fm.tools = [];
        }
        break;
      }
    }
  }
  return { frontmatter: fm, body };
}

// ---- Discovery ----

/**
 * Agent discovery directories in priority order (project wins over global).
 */
export function agentDirs(cwd: string): string[] {
  const dirs: string[] = [];
  dirs.push(path.join(cwd, "agents"));
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  dirs.push(path.join(home, ".deepseek-cli", "agents"));
  return dirs;
}

async function readAgentFile(filePath: string, name: string): Promise<AgentDefinition | null> {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const prompt = body.trim();
    if (!prompt) {
      log.warn("agents: empty body", { file: filePath });
      return null;
    }
    return {
      name,
      model: frontmatter.model,
      tools: frontmatter.tools,
      systemPrompt: prompt,
      source: filePath,
    };
  } catch (e) {
    log.warn("agents: read failed", { file: filePath, error: String(e) });
    return null;
  }
}

/**
 * Discover and load all custom agent definitions asynchronously.
 * Project agents override global agents with the same name.
 */
export async function discoverAgents(cwd: string): Promise<Map<string, AgentDefinition>> {
  const agents = new Map<string, AgentDefinition>();
  const dirs = agentDirs(cwd);

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: { isFile(): boolean; name: string }[];
    try {
      entries = (await fsp.readdir(dir, { withFileTypes: true })) as unknown as { isFile(): boolean; name: string }[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !String(entry.name).endsWith(".md")) continue;
      const name = String(entry.name).slice(0, -3);
      const filePath = path.join(dir, String(entry.name));
      const def = await readAgentFile(filePath, name);
      if (def) agents.set(name, def);
    }
  }

  return agents;
}
