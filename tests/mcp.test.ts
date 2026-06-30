import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { McpClient, type McpTransport } from "../src/mcp/client.ts";
import { loadMcpConfig, McpRegistry } from "../src/mcp/registry.ts";

// ---- Fake transport ----
// Auto-responds to each request method with a scripted result via a microtask,
// so the client's await chain proceeds without test-side pumping.

class FakeTransport implements McpTransport {
  private cb: ((m: string) => void) | null = null;
  sent: { id: number; method: string; params: unknown }[] = [];
  scripted: Record<string, unknown> = {};
  async send(msg: string): Promise<void> {
    const m = JSON.parse(msg) as { id?: number; method: string; params?: unknown };
    if (typeof m.id === "number") {
      this.sent.push({ id: m.id, method: m.method, params: m.params });
      const result = this.scripted[m.method];
      queueMicrotask(() => {
        this.cb?.(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
    }
  }
  onMessage(cb: (message: string) => void): void {
    this.cb = cb;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("McpClient", () => {
  it("runs the initialize handshake then lists tools", async () => {
    const t = new FakeTransport();
    t.scripted["initialize"] = { protocolVersion: "2024-11-05", serverInfo: { name: "fake" } };
    t.scripted["tools/list"] = {
      tools: [
        { name: "search", description: "search the web", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
        { name: "echo", description: "echo back" },
      ],
    };
    const client = new McpClient("fake", t);
    await client.connect();
    expect(t.sent[0].method).toBe("initialize");
    const tools = await client.listTools();
    expect(t.sent.some((s) => s.method === "tools/list")).toBe(true);
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe("search");
    expect(tools[1].description).toBe("echo back");
    expect(client.isConnected).toBe(true);
  });

  it("calls a tool and concatenates text content", async () => {
    const t = new FakeTransport();
    t.scripted["initialize"] = {};
    t.scripted["tools/list"] = { tools: [{ name: "echo" }] };
    t.scripted["tools/call"] = { content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] };
    const client = new McpClient("fake", t);
    await client.connect();
    const text = await client.callTool("echo", { msg: "hi" });
    expect(text).toBe("hello\nworld");
    // The call params carried the tool name + arguments.
    const callReq = t.sent.find((s) => s.method === "tools/call")!;
    expect((callReq.params as { name: string }).name).toBe("echo");
    expect((callReq.params as { arguments: { msg: string } }).arguments.msg).toBe("hi");
  });

  it("throws when a tool reports isError", async () => {
    const t = new FakeTransport();
    t.scripted["initialize"] = {};
    t.scripted["tools/list"] = { tools: [{ name: "boom" }] };
    t.scripted["tools/call"] = { content: [{ type: "text", text: "kaboom" }], isError: true };
    const client = new McpClient("fake", t);
    await client.connect();
    await expect(client.callTool("boom", {})).rejects.toThrow("kaboom");
  });
});

describe("loadMcpConfig merge", () => {
  let globalDir: string;
  let projectDir: string;
  const origGlobal = process.env.DEEPSEEK_MCP_GLOBAL;
  const origFile = process.env.DEEPSEEK_MCP_FILE;

  beforeEach(async () => {
    globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcp-global-"));
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcp-proj-"));
    process.env.DEEPSEEK_MCP_GLOBAL = globalDir;
    delete process.env.DEEPSEEK_MCP_FILE;
  });

  afterEach(async () => {
    if (origGlobal === undefined) delete process.env.DEEPSEEK_MCP_GLOBAL;
    else process.env.DEEPSEEK_MCP_GLOBAL = origGlobal;
    if (origFile === undefined) delete process.env.DEEPSEEK_MCP_FILE;
    else process.env.DEEPSEEK_MCP_FILE = origFile;
    await fs.rm(globalDir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("merges global + project servers (project wins on name clash)", async () => {
    await fs.writeFile(
      path.join(globalDir, "mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "global-bin" }, g: { command: "g-bin" } } }),
    );
    await fs.writeFile(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "project-bin" }, p: { command: "p-bin" } } }),
    );
    const cfg = await loadMcpConfig(projectDir);
    const names = Object.keys(cfg.mcpServers).sort();
    expect(names).toEqual(["g", "p", "shared"]);
    expect(cfg.mcpServers.shared.command).toBe("project-bin"); // project wins
  });

  it("ignores malformed mcp.json entries", async () => {
    await fs.writeFile(
      path.join(globalDir, "mcp.json"),
      JSON.stringify({ mcpServers: { bad: { args: ["x"] }, ok: { command: "ok-bin" } } }),
    );
    const cfg = await loadMcpConfig(projectDir);
    expect(Object.keys(cfg.mcpServers)).toEqual(["ok"]);
  });
});

describe("McpRegistry toTools + toggle", () => {
  it("exposes tools with mcp_<server>_<tool> names and toggles per server", () => {
    // McpRegistry.load requires real servers; we exercise the tool-building
    // by injecting state via a tiny subclass that bypasses spawning.
    class FakeRegistry extends McpRegistry {
      seed(serverName: string, tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[], dangerous = false) {
        (this as unknown as { bound: unknown[] }).bound.push(
          ...tools.map((t) => ({ serverName, toolDef: t, dangerous })),
        );
        // mark connected
        (this as unknown as { clients: Map<string, unknown> }).clients.set(serverName, {});
        (this as unknown as { dangerous: Map<string, boolean> }).dangerous.set(serverName, dangerous);
      }
    }
    const reg = new FakeRegistry();
    reg.seed("fs", [{ name: "read", description: "read a file" }]);
    reg.seed("net", [{ name: "fetch", description: "fetch url" }], true);

    const all = reg.toTools();
    expect(all.map((t) => t.name).sort()).toEqual(["mcp_fs_read", "mcp_net_fetch"]);
    // The dangerous server's tools are flagged; the safe one isn't.
    expect(all.find((t) => t.name === "mcp_net_fetch")!.isDangerous).toBe(true);
    expect(all.find((t) => t.name === "mcp_fs_read")!.isDangerous).toBe(false);

    // Toggle net off → its tools disappear.
    expect(reg.toggleServer("net")).toBe(false); // now disabled
    expect(reg.toTools().map((t) => t.name)).toEqual(["mcp_fs_read"]);
    expect(reg.isEnabled("net")).toBe(false);

    // Toggle net back on.
    expect(reg.toggleServer("net")).toBe(true);
    expect(reg.toTools().map((t) => t.name).sort()).toEqual(["mcp_fs_read", "mcp_net_fetch"]);

    // Per-server tools.
    expect(reg.toolsForServer("fs").map((t) => t.name)).toEqual(["mcp_fs_read"]);
  });
});
