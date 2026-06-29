/**
 * Local tool self-check — runs every tool with realistic inputs and prints
 * a per-tool pass/fail report. No API key, no network required (except the
 * web_fetch path which is optional and skipped offline).
 *
 *   bun run scripts/self-check.ts
 */
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

import { ToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext, ToolResult } from "../src/tools/types.ts";
import { PermissionManager } from "../src/agent/permissions.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-selfcheck-"));
const ctx: ToolContext = { cwd: tmp };
const tools = new ToolRegistry();
const perms = new PermissionManager({ mode: "auto", skipAll: true });

type Case = { name: string; args: Record<string, unknown>; expectOk: boolean };
const cases: Case[] = [
  // write_file — create a file, then re-read
  { name: "write_file", args: { filePath: path.join(tmp, "a.txt"), content: "alpha\nbeta\ngamma\n" }, expectOk: true },
  { name: "write_file", args: { filePath: path.join(tmp, "sub", "deep", "b.txt"), content: "nested" }, expectOk: true },
  // read_file — verify line numbering + truncation
  { name: "read_file", args: { filePath: path.join(tmp, "a.txt") }, expectOk: true },
  { name: "read_file", args: { filePath: path.join(tmp, "a.txt"), offset: 2, limit: 1 }, expectOk: true },
  { name: "read_file", args: { filePath: tmp }, expectOk: false }, // directory
  // edit_file — replace + multi-match error + replaceAll
  { name: "edit_file", args: { filePath: path.join(tmp, "a.txt"), oldString: "beta", newString: "BETA" }, expectOk: true },
  { name: "edit_file", args: { filePath: path.join(tmp, "a.txt"), oldString: "a", newString: "X" }, expectOk: false }, // multiple matches
  // bash — echo + non-zero exit
  { name: "bash", args: { command: "echo hi && pwd", workdir: tmp }, expectOk: true },
  { name: "bash", args: { command: "exit 7" }, expectOk: false },
  // glob — pattern
  { name: "glob", args: { pattern: "**/*.txt", path: tmp }, expectOk: true },
  // grep — search
  { name: "grep", args: { pattern: "alpha|BETA", path: tmp }, expectOk: true },
  // todo_write — store + retrieve
  {
    name: "todo_write",
    args: {
      todos: [
        { content: "first task", status: "completed", priority: "high" },
        { content: "second task", status: "in_progress", priority: "medium" },
      ],
    },
    expectOk: true,
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const tool = tools.get(c.name);
  if (!tool) {
    console.log(`✗ ${c.name.padEnd(12)} tool not registered`);
    fail++;
    continue;
  }
  const decision = await perms.check(tool, c.args);
  if (!decision.allow) {
    console.log(`✗ ${c.name.padEnd(12)} permission denied`);
    fail++;
    continue;
  }
  let res: ToolResult;
  try {
    res = await tools.execute(c.name, c.args, ctx);
  } catch (e) {
    res = { ok: false, content: `threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  const ok = res.ok === c.expectOk;
  const marker = ok ? "✓" : "✗";
  console.log(`${marker} ${c.name.padEnd(12)} ok=${res.ok} expected=${c.expectOk} ${res.uiSummary ?? ""}`);
  if (ok) pass++; else fail++;
  // Show first 200 chars of the tool result for visibility
  console.log(`              → ${(res.content ?? "").slice(0, 200).replace(/\n/g, " ⏎ ")}\n`);
}

// Optional web_fetch (skipped if no network)
try {
  const res = await tools.execute("web_fetch", { url: "https://example.com" }, ctx);
  console.log(`✓ web_fetch    ok=${res.ok} ${(res.uiSummary ?? "")}`);
  pass++;
} catch {
  console.log(`⊘ web_fetch    skipped (offline)`);
}

await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${pass} pass  ${fail} fail  ${cases.length + 1} total`);
process.exit(fail === 0 ? 0 : 1);
