// skill command — scaffold a new skill file (codex-cli-styled template).
//
// A skill is a markdown file whose body gets folded into the system prompt when
// active. This writes a starter template so users don't begin from a blank
// page. Default target is the global skills dir; --project writes into the
// repo's .deepseek/skills for sharing via git.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { skillDirs } from "../skills/store.ts";
import { paint } from "../ui/theme.ts";
import { blank, printError, printSystem, writeLine } from "../ui/render.ts";

export async function runSkillCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "create") return createSkill(rest);
  blank();
  writeLine(paint.bold("deepseek skill — manage skills"));
  writeLine(paint.gray("  deepseek skill create <name> [--project]"));
  blank();
}

function template(name: string): string {
  return `---
name: ${name}
description: One-line summary of what this skill makes the agent do.
---

# ${name}

## When to use
Describe the situations or task types where this skill should guide the work.
Be specific so the agent knows when these instructions take priority.

## Instructions
Step-by-step guidance the agent follows while this skill is active. Write in
the imperative and keep each step concrete:
1. First, do X.
2. Then, verify Y before proceeding.
3. Prefer tool Z over alternatives when available.

## Examples
\`\`\`
<input or scenario>
→ expected behavior / output
\`\`\`

## Constraints
Anything the agent must avoid while this skill is active (banned deps, file
locations not to touch, commands not to run, etc).
`;
}

async function createSkill(args: string[]): Promise<void> {
  let project = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--project") { project = true; continue; }
    positional.push(a);
  }
  const name = positional[0];
  if (!name || !/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
    printError("usage: deepseek skill create <name> [--project]  (name: letters/digits/-/_)");
    return;
  }
  const { global: globalDir, project: projectDir } = skillDirs(process.cwd());
  const dir = project ? projectDir : globalDir;
  const file = path.join(dir, `${name}.md`);
  if (existsSync(file)) {
    printSystem(`skill '${name}' already exists at ${file}`, "yellow");
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, template(name), "utf-8");

  blank();
  printSystem(`${paint.green("✓")} created skill '${name}'`, "green");
  writeLine(paint.gray(`  ${file}`));
  writeLine(paint.gray("  edit it, then activate in the REPL via /skill"));
  blank();
}
