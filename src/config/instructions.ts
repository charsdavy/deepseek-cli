// Project-level instruction files (AGENTS.md / deepseek.md)
// Injected into the system prompt so the agent understands repo conventions.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";

export const INSTRUCTION_FILES = [
  "AGENTS.md",
  "deepseek.md",
  ".deepseek",
  "CLAUDE.md",
  ".cursorrules",
];

const MAX_INSTRUCTION_BYTES = 16_000;

export async function loadProjectInstructions(cwd: string = process.cwd()): Promise<string | null> {
  for (const name of INSTRUCTION_FILES) {
    const p = path.join(cwd, name);
    if (existsSync(p)) {
      try {
        const txt = await fs.readFile(p, "utf-8");
        return truncate(txt, MAX_INSTRUCTION_BYTES);
      } catch {
        /* ignore unreadable file */
      }
    }
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n... (truncated)";
}
