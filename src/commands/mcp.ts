// mcp command — manage MCP servers in mcp.json (add / list / remove).
//
// Writes to the global config (~/.deepseek-cli/mcp.json) by default, or the
// project file (./.mcp.json) with --project. The file uses the standard
// { "mcpServers": { name: { command, args, env } } } shape that the agent
// loads at session start.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { paint } from "../ui/theme.ts";
import { blank, printError, printSystem, writeLine } from "../ui/render.ts";

export function globalMcpFile(): string {
  const dir = process.env.DEEPSEEK_MCP_GLOBAL ?? path.join(os.homedir(), ".deepseek-cli");
  return path.join(dir, "mcp.json");
}

function projectMcpFile(): string {
  return path.join(process.cwd(), ".mcp.json");
}

interface ServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  isDangerous?: boolean;
}

type McpFile = { mcpServers: Record<string, ServerEntry> };

async function readMcpFile(file: string): Promise<McpFile> {
  if (!existsSync(file)) return { mcpServers: {} };
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as Partial<McpFile>;
    if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
      return { mcpServers: parsed.mcpServers as Record<string, ServerEntry> };
    }
  } catch {
    /* fall through to empty */
  }
  return { mcpServers: {} };
}

async function writeMcpFile(file: string, data: McpFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fs.chmod(file, 0o600);
}

export async function runMcpCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":
      return addServer(rest);
    case "list":
    case "ls":
      return listServers();
    case "remove":
    case "rm":
      return removeServer(rest);
    default:
      blank();
      writeLine(paint.bold("deepseek mcp — manage MCP servers"));
      writeLine(paint.gray("  deepseek mcp add <name> <command> [args...] [--env K=V ...] [--project] [--dangerous]"));
      writeLine(paint.gray("  deepseek mcp list"));
      writeLine(paint.gray("  deepseek mcp remove <name> [--project]"));
      blank();
  }
}

export interface ParsedMcpAdd {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  project: boolean;
  /** Mark this server's tools as dangerous (require per-call approval). */
  isDangerous?: boolean;
}

/** Parse `mcp add <name> <command> [args...] [--env K=V ...] [--project] [--dangerous]` args. */
export function parseAddArgs(args: string[]): ParsedMcpAdd | null {
  let project = false;
  let isDangerous = false;
  const env: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project") { project = true; continue; }
    if (a === "--dangerous" || a === "--require-approval") { isDangerous = true; continue; }
    if (a === "--env" || a === "-e") {
      const kv = args[++i];
      if (!kv || !kv.includes("=")) return null;
      const eq = kv.indexOf("=");
      env[kv.slice(0, eq)] = kv.slice(eq + 1);
      continue;
    }
    positional.push(a);
  }
  const name = positional[0];
  const command = positional[1];
  if (!name || !command) return null;
  return { name, command, args: positional.slice(2), env, project, isDangerous: isDangerous || undefined };
}

/** Write a server entry into the (global or project) mcp.json. */
export async function addServerToConfig(parsed: ParsedMcpAdd): Promise<string> {
  const file = parsed.project ? projectMcpFile() : globalMcpFile();
  const data = await readMcpFile(file);
  data.mcpServers[parsed.name] = {
    command: parsed.command,
    args: parsed.args.length ? parsed.args : undefined,
    env: Object.keys(parsed.env).length ? parsed.env : undefined,
    isDangerous: parsed.isDangerous ? true : undefined,
  };
  await writeMcpFile(file, data);
  return file;
}

async function addServer(args: string[]): Promise<void> {
  const parsed = parseAddArgs(args);
  if (!parsed) {
    printError("usage: deepseek mcp add <name> <command> [args...] [--env K=V ...] [--project] [--dangerous]");
    return;
  }

  const file = await addServerToConfig(parsed);

  blank();
  const where = parsed.project ? paint.cyan(file) : paint.cyan("~/.deepseek-cli/mcp.json");
  printSystem(`${paint.green("✓")} added server '${parsed.name}' to ${where}`, "green");
  writeLine(paint.gray(`  ${parsed.command} ${parsed.args.join(" ")}${parsed.project ? "  (project)" : ""}`));
  blank();
}

async function listServers(): Promise<void> {
  const files = [
    { file: globalMcpFile(), label: "global" },
    { file: projectMcpFile(), label: "project" },
  ];
  blank();
  let total = 0;
  for (const { file, label } of files) {
    if (!existsSync(file)) continue;
    const { mcpServers } = await readMcpFile(file);
    const names = Object.keys(mcpServers);
    if (names.length === 0) continue;
    writeLine(paint.bold(`${label} (${file}):`));
    for (const name of names) {
      const s = mcpServers[name];
      writeLine(`  ${paint.cyan(name)}  ${paint.gray(s.command + (s.args?.length ? " " + s.args.join(" ") : ""))}`);
      total++;
    }
  }
  if (total === 0) printSystem("No MCP servers configured. Try: deepseek mcp add fs npx -y @modelcontextprotocol/server-filesystem /abs/path", "yellow");
  blank();
}

async function removeServer(args: string[]): Promise<void> {
  let project = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--project") { project = true; continue; }
    positional.push(a);
  }
  const name = positional[0];
  if (!name) {
    printError("usage: deepseek mcp remove <name> [--project]");
    return;
  }
  const file = project ? projectMcpFile() : globalMcpFile();
  const data = await readMcpFile(file);
  if (!(name in data.mcpServers)) {
    printSystem(`server '${name}' not found in ${file}`, "yellow");
    return;
  }
  delete data.mcpServers[name];
  await writeMcpFile(file, data);
  blank();
  printSystem(`${paint.green("✓")} removed server '${name}' from ${file}`, "green");
  blank();
}
