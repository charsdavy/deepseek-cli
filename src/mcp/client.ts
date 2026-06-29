// MCP (Model Context Protocol) client — JSON-RPC 2.0 over a pluggable transport.
//
// Transport-agnostic so the handshake/call logic is unit-testable with a fake
// transport. The real stdio transport lives in stdio.ts. Each MCP server runs
// as a separate process; this client does initialize → tools/list → tools/call
// and exposes the server's tools uniformly to the agent's ToolRegistry.

export interface McpTransport {
  send(message: string): Promise<void>;
  onMessage(cb: (message: string) => void): void;
  close(): Promise<void>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

interface PendingReq {
  resolve: (result: unknown) => void;
  reject: (e: Error) => void;
}

const PROTOCOL_VERSION = "2024-11-05";

export class McpClient {
  private nextId = 1;
  private pending = new Map<number, PendingReq>();
  private transport: McpTransport;
  readonly serverName: string;
  private connected = false;

  constructor(serverName: string, transport: McpTransport) {
    this.serverName = serverName;
    this.transport = transport;
    this.transport.onMessage((msg) => this.handleLine(msg));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Run the initialize handshake so the server is ready for tool calls. */
  async connect(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "deepseek-cli", version: "0.3.2" },
    });
    // Acknowledge initialization (notification — no id, no response expected).
    await this.notify("notifications/initialized", {});
    this.connected = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpToolDef[] };
    return result?.tools ?? [];
  }

  /** Call a tool; returns the concatenated text content (best-effort). */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("\n");
    if (result?.isError) {
      throw new Error(`MCP tool '${name}' reported an error: ${text || "(no detail)"}`);
    }
    return text;
  }

  async close(): Promise<void> {
    // Best-effort shutdown, then close the transport.
    try {
      await this.notify("shutdown", {});
    } catch {
      /* ignore */
    }
    await this.transport.close();
    this.connected = false;
  }

  // ---- JSON-RPC plumbing ----

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP '${this.serverName}' request '${method}' timed out`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timeout);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });
      this.transport.send(payload).catch((e) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`MCP '${this.serverName}' send failed: ${e instanceof Error ? e.message : String(e)}`));
      });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    await this.transport.send(payload);
  }

  private handleLine(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON lines (server logs on stdout are noise)
    }
    if (typeof msg.id !== "number") return; // notifications are ignored
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message ?? "MCP error"));
    } else {
      pending.resolve(msg.result);
    }
  }
}
