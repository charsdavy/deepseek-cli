// Stdio transport for an MCP server: spawns the server process and frames
// JSON-RPC messages as newline-delimited JSON over its stdin/stdout.

import { spawn, type ChildProcess } from "node:child_process";
import type { McpTransport } from "./client.ts";
import type { McpServerConfig } from "./client.ts";

export class StdioMcpTransport implements McpTransport {
  private child: ChildProcess | null = null;
  private buffer = "";
  private lineCb: ((line: string) => void) | null = null;
  private server: McpServerConfig;

  constructor(server: McpServerConfig) {
    this.server = server;
  }

  async start(): Promise<void> {
    const { command, args = [], env, cwd } = this.server;
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...env },
      cwd,
    });
    this.child.stdout?.setEncoding("utf-8");
    this.child.stdout?.on("data", (chunk: string) => {
      // Frame on newlines; accumulate partial frames across data events.
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (this.lineCb) this.lineCb(line);
      }
    });
    this.child.on("error", () => {
      /* surfaced via send/close failures */
    });
  }

  async send(message: string): Promise<void> {
    if (!this.child?.stdin) throw new Error("MCP server stdin not available");
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin!.write(message + "\n", (e) => (e ? reject(e) : resolve()));
    });
  }

  onMessage(cb: (message: string) => void): void {
    this.lineCb = cb;
  }

  async close(): Promise<void> {
    const c = this.child;
    this.child = null;
    if (!c) return;
    try {
      c.stdin?.end();
    } catch {
      /* ignore */
    }
    if (c.exitCode === null && !c.killed) {
      c.kill("SIGTERM");
      // Give it a moment, then escalate.
      setTimeout(() => {
        if (!c.killed) c.kill("SIGKILL");
      }, 1500);
    }
  }
}
