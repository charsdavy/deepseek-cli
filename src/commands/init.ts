// init command — scaffold an AGENTS.md project-instructions file in the cwd.
//
// The agent folds AGENTS.md (and a few aliases) into the system prompt, so a
// starter file lets users encode repo-specific rules quickly. This command
// writes a sensible template only when one does not already exist, to avoid
// clobbering hand-written guidance.

import * as path from "node:path";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { paint } from "../ui/theme.ts";
import { blank, printError, printSystem, writeLine } from "../ui/render.ts";

const TEMPLATE = `# AGENTS.md

Project-specific guidance for the DeepSeek CLI agent. Everything here is
folded into the system prompt and overrides the built-in defaults.

## Stack
- Language:
- Runtime:
- Package manager:
- Build / test commands:
  - lint:
  - typecheck:
  - test:
  - build:

## Conventions
- Code style (formatting, naming):
- Where new code goes (folder layout):
- Import rules / path aliases:

## Rules
- Never add these dependencies:
- Never commit:
- Always run X before declaring a task done:

## Notes
- Anything else the agent should know about this repo.
`;

const CANDIDATES = ["AGENTS.md", "deepseek.md", ".deepseek", "CLAUDE.md", ".cursorrules"];

export async function runInitCommand(): Promise<void> {
  const cwd = process.cwd();
  const target = path.join(cwd, "AGENTS.md");

  if (existsSync(target)) {
    printSystem(`${target} already exists — leaving it untouched.`, "yellow");
    return;
  }

  const existing = CANDIDATES.filter((f) => existsSync(path.join(cwd, f)));
  if (existing.length > 0) {
    printSystem(
      `Found existing instructions file(s): ${existing.join(", ")}.`,
      "yellow",
    );
    printSystem("Delete them first if you want a fresh AGENTS.md scaffold.", "yellow");
    return;
  }

  try {
    await fs.writeFile(target, TEMPLATE, "utf-8");
    blank();
    printSystem(`${paint.green("✓")} created ${paint.gray(target)}`, "green");
    writeLine(paint.gray("Edit it to encode repo-specific rules; the agent reads it automatically."));
    blank();
  } catch (e) {
    printError(`failed to write ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
