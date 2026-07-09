// Stdio transport for an MCP server: spawns the server process and frames
// JSON-RPC messages as newline-delimited JSON over its stdin/stdout.

import { spawn, type ChildProcess } from "node:child_process";
import type { McpTransport } from "./client.ts";
import type { McpServerConfig } from "./client.ts";
import { log } from "../log/logger.ts";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export class StdioMcpTransport implements McpTransport {
  private child: ChildProcess | null = null;
  private buffer = "";
  private lineCb: ((line: string) => void) | null = null;
  private server: McpServerConfig;
  private lastError: string | null = null;
  private exited = false;
  private exitCb: (() => void) | null = null;

  constructor(server: McpServerConfig) {
    this.server = server;
  }

  onExit(cb: () => void): void {
    this.exitCb = cb;
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
      this.buffer += chunk;
      if (this.buffer.length > MAX_BUFFER_BYTES) {
        log.warn("mcp stdio: buffer overflow, truncating", { server: this.server.command, bytes: this.buffer.length });
        this.buffer = this.buffer.slice(-MAX_BUFFER_BYTES);
      }
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (this.lineCb) this.lineCb(line);
      }
    });
    this.child.on("error", (err: Error) => {
      this.lastError = err.message;
      log.error("mcp stdio: spawn error", { server: this.server.command, error: err.message });
    });
    this.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exited = true;
      this.lastError = `MCP server exited (code=${code}, signal=${signal ?? "none"})`;
      log.warn("mcp stdio: process exited", { server: this.server.command, code, signal });
      if (this.exitCb) this.exitCb();
    });
  }

  async send(message: string): Promise<void> {
    if (this.exited) throw new Error(this.lastError ?? "MCP server process has exited");
    if (!this.child?.stdin) throw new Error(this.lastError ?? "MCP server stdin not available");
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
      const timer = setTimeout(() => {
        if (!c.killed) c.kill("SIGKILL");
      }, 1500);
      timer.unref?.();
    }
  }
}
