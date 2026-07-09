// MCP registry: discovers mcp.json (global + project), spawns servers, and
// exposes their tools as agent Tool objects so the agent loop treats MCP tools
// uniformly alongside the built-ins.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { McpClient, type McpConfig, type McpServerConfig, type McpToolDef } from "./client.ts";
import { StdioMcpTransport } from "./stdio.ts";
import type { Tool, ToolResult, ToolContext } from "../tools/types.ts";
import { printSystem } from "../ui/render.ts";
import { log } from "../log/logger.ts";

const GLOBAL_MCP_DIR = path.join(os.homedir(), ".deepseek-cli");

export interface LoadedServer {
  name: string;
  toolCount: number;
  ok: boolean;
  enabled: boolean;
  /** True if this server's tools require per-call approval. */
  dangerous?: boolean;
  /** Whether this server was configured globally or in the project's .mcp.json. */
  scope?: "global" | "project";
  error?: string;
}

/** Merge global + project mcp.json into a single server map (project wins).
 *  Each server is tagged with its scope so the /mcp listing can show origin. */
export async function loadMcpConfig(cwd: string): Promise<McpConfig> {
  const files: { path: string; scope: "global" | "project" }[] = [];
  const override = process.env.DEEPSEEK_MCP_FILE;
  if (override) {
    files.push({ path: override, scope: "global" });
  } else {
    // Global dir honors DEEPSEEK_MCP_GLOBAL so tests can relocate it.
    const globalDir = process.env.DEEPSEEK_MCP_GLOBAL ?? GLOBAL_MCP_DIR;
    files.push({ path: path.join(globalDir, "mcp.json"), scope: "global" });
    files.push({ path: path.join(cwd, ".mcp.json"), scope: "project" });
  }
  const merged: Record<string, McpServerConfig> = {};
  for (const { path: f, scope } of files) {
    if (!existsSync(f)) continue;
    try {
      const raw = await fs.readFile(f, "utf-8");
      const parsed = JSON.parse(raw) as Partial<McpConfig>;
      if (parsed?.mcpServers && typeof parsed.mcpServers === "object") {
        for (const [k, v] of Object.entries(parsed.mcpServers)) {
          if (v && typeof v.command === "string") {
            merged[k] = { ...v, _scope: scope };
          }
        }
      }
    } catch {
      /* ignore malformed mcp.json */
    }
  }
  return { mcpServers: merged };
}

interface BoundTool {
  serverName: string;
  toolDef: McpToolDef;
  /** Whether this server's tools require per-call approval (config.isDangerous). */
  dangerous: boolean;
}

export class McpRegistry {
  private clients = new Map<string, McpClient>();
  private bound: BoundTool[] = [];
  /** Dangerous-flag per server (for /mcp listing + status). */
  private dangerous = new Map<string, boolean>();
  /** Disabled servers stay connected but their tools are hidden from the model. */
  private disabled = new Set<string>();
  /** Scope (global/project) per server, for the /mcp listing. */
  private scopes = new Map<string, "global" | "project">();

  /** Spawn + initialize all servers, collecting their tools. Best-effort. */
  async load(config: McpConfig): Promise<LoadedServer[]> {
    const results: LoadedServer[] = [];
    for (const [name, serverCfg] of Object.entries(config.mcpServers)) {
      const dangerous = serverCfg.isDangerous === true;
      const scope = serverCfg._scope;
      this.dangerous.set(name, dangerous);
      if (scope) this.scopes.set(name, scope);
      try {
        const transport = new StdioMcpTransport(serverCfg);
        await transport.start();
        const client = new McpClient(name, transport);
        await client.connect();
        const tools = await client.listTools();
        this.clients.set(name, client);
        for (const t of tools) this.bound.push({ serverName: name, toolDef: t, dangerous });
        results.push({ name, toolCount: tools.length, ok: true, enabled: true, dangerous, scope });
        log.info("mcp connected", { server: name, tools: tools.length, scope });
        printSystem(`mcp: ${name} connected (${tools.length} tool${tools.length === 1 ? "" : "s"})`, "green");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ name, toolCount: 0, ok: false, enabled: false, dangerous, scope, error: msg });
        log.error("mcp connect failed", { server: name, error: msg });
        printSystem(`mcp: ${name} failed to start — ${msg}`, "yellow");
      }
    }
    return results;
  }

  /** Spawn + connect one server live (mid-session), bind its tools. */
  async addServer(name: string, serverCfg: McpServerConfig): Promise<LoadedServer> {
    const dangerous = serverCfg.isDangerous === true;
    const scope = serverCfg._scope;
    this.dangerous.set(name, dangerous);
    if (scope) this.scopes.set(name, scope);
    // If already connected, close the old instance first.
    if (this.clients.has(name)) {
      await this.clients.get(name)!.close().catch(() => {});
      this.clients.delete(name);
      this.bound = this.bound.filter((b) => b.serverName !== name);
      this.disabled.delete(name);
    }
    try {
      const transport = new StdioMcpTransport(serverCfg);
      await transport.start();
      const client = new McpClient(name, transport);
      await client.connect();
      const tools = await client.listTools();
      this.clients.set(name, client);
      for (const t of tools) this.bound.push({ serverName: name, toolDef: t, dangerous: serverCfg.isDangerous === true });
      log.info("mcp connected", { server: name, tools: tools.length, scope });
      printSystem(`mcp: ${name} connected (${tools.length} tool${tools.length === 1 ? "" : "s"})`, "green");
      return { name, toolCount: tools.length, ok: true, enabled: true, dangerous, scope };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("mcp connect failed", { server: name, error: msg });
      printSystem(`mcp: ${name} failed to start — ${msg}`, "yellow");
      return { name, toolCount: 0, ok: false, enabled: false, dangerous, error: msg };
    }
  }

  /** All bound tools for enabled servers only (disabled servers are hidden). */
  toTools(): Tool[] {
    return this.buildTools((b) => !this.disabled.has(b.serverName));
  }

  /** Per-server Tool objects (re-used to (re)register when toggling back on). */
  toolsForServer(serverName: string): Tool[] {
    return this.buildTools((b) => b.serverName === serverName);
  }

  private buildTools(filter: (b: BoundTool) => boolean): Tool[] {
    const self = this;
    return this.bound
      .filter(filter)
      .map(({ serverName, toolDef, dangerous }) => {
        const name = `mcp_${serverName}_${toolDef.name}`;
        return {
          name,
          description: toolDef.description ?? `MCP tool ${toolDef.name} from ${serverName}`,
          category: "network" as const,
          isDangerous: dangerous,
          parameters: (toolDef.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
            try {
              const client = self.clients.get(serverName);
              if (!client) return { ok: false, content: `MCP server '${serverName}' is not connected.`, error: "mcp_not_connected" };
              const text = await client.callTool(toolDef.name, args);
              return { ok: true, content: text || "(empty result)", uiSummary: `mcp/${serverName}/${toolDef.name}` };
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              return { ok: false, content: `MCP call failed: ${msg}`, error: "mcp_call_error" };
            }
          },
        } satisfies Tool;
      });
  }

  isEnabled(name: string): boolean {
    return this.clients.has(name) && !this.disabled.has(name);
  }

  /** Toggle a server's enabled state. Returns the new enabled state. */
  toggleServer(name: string): boolean {
    if (!this.clients.has(name)) return false;
    if (this.disabled.has(name)) {
      this.disabled.delete(name);
      return true;
    }
    this.disabled.add(name);
    return false;
  }

  /** Listing for the /mcp slash command. */
  status(): LoadedServer[] {
    return Array.from(this.clients.entries()).map(([name]) => ({
      name,
      toolCount: this.bound.filter((b) => b.serverName === name).length,
      ok: true,
      enabled: !this.disabled.has(name),
      dangerous: this.dangerous.get(name) === true,
      scope: this.scopes.get(name),
    }));
  }

  async close(): Promise<void> {
    const closes = Array.from(this.clients.values()).map((c) => c.close().catch(() => {}));
    await Promise.all(closes);
    this.clients.clear();
    this.bound = [];
    this.disabled.clear();
    this.dangerous.clear();
    this.scopes.clear();
  }
}

// Re-export key types for callers.
export type { McpClient, McpConfig, McpServerConfig, McpToolDef } from "./client.ts";
