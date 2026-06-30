import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { runMcpCommand, globalMcpFile } from "../src/commands/mcp.ts";

const ORIG = process.env.DEEPSEEK_MCP_GLOBAL;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-mcpcmd-"));
  process.env.DEEPSEEK_MCP_GLOBAL = tmp;
});

afterEach(async () => {
  if (ORIG === undefined) delete process.env.DEEPSEEK_MCP_GLOBAL;
  else process.env.DEEPSEEK_MCP_GLOBAL = ORIG;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function readServers(): Promise<Record<string, { command: string; args?: string[]; env?: Record<string, string> }>> {
  const raw = await fs.readFile(globalMcpFile(), "utf-8");
  return (JSON.parse(raw) as { mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> }).mcpServers;
}

describe("deepseek mcp command", () => {
  it("add writes a server with command/args/env", async () => {
    await runMcpCommand(["add", "fs", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/abs", "--env", "FOO=bar"]);
    const servers = await readServers();
    expect(servers.fs).toBeDefined();
    expect(servers.fs.command).toBe("npx");
    expect(servers.fs.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/abs"]);
    expect(servers.fs.env?.FOO).toBe("bar");
  });

  it("remove deletes the server entry", async () => {
    await runMcpCommand(["add", "gh", "npx", "-y", "@mcp/server-github"]);
    expect((await readServers()).gh).toBeDefined();
    await runMcpCommand(["remove", "gh"]);
    expect((await readServers()).gh).toBeUndefined();
  });

  it("add without name+command writes nothing (usage error)", async () => {
    await runMcpCommand(["add"]);
    expect(existsSync(globalMcpFile())).toBe(false);
  });

  it("list runs without error when no config exists", async () => {
    await runMcpCommand(["list"]);
    expect(existsSync(globalMcpFile())).toBe(false);
  });
});
