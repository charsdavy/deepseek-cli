// Hook system: PreToolUse / PostToolUse / PreCompact / PostCompact hooks.
// Inspired by codex's hook architecture — allows users to intercept tool
// execution with custom validation, rewriting, or side effects.
//
// Hook scripts are plain JavaScript/TypeScript functions or shell commands
// configured in ~/.deepseek-cli/hooks.json or .deepseek/hooks.json.
//
// Hook contract:
//   PreToolUse:  ({ tool, args, cwd }) => { allow, reason?, rewrite? }
//   PostToolUse: ({ tool, args, result, cwd, ms }) => void | { rewrite? }
//   PreCompact:  ({ messages, budget }) => { allow }
//   PostCompact: ({ summary, savedTokens }) => void

import type { Tool, ToolResult } from "../tools/types.ts";
import { log } from "../log/logger.ts";

// ---- Types ----

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "PostCompact";

export interface HookConfig {
  event: HookEvent;
  /** Shell command or path to JS/TS script. */
  command: string;
  /** Optional regex matcher for tool names (PreToolUse/PostToolUse only). */
  matcher?: string;
  /** Timeout in ms (default 30s). */
  timeout?: number;
}

export interface HookInput {
  tool: Pick<Tool, "name" | "category" | "isDangerous">;
  args: Record<string, unknown>;
  cwd: string;
}

export interface PreToolUseResult {
  allow: boolean;
  reason?: string;
  /** Rewritten tool arguments. */
  rewrite?: Record<string, unknown>;
}

export interface PostToolUseInput extends HookInput {
  result: ToolResult;
  ms: number;
}

// ---- Loader ----

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";

const GLOBAL_HOOKS_PATH = path.join(os.homedir(), ".deepseek-cli", "hooks.json");
const PROJECT_HOOKS_PATH = ".deepseek/hooks.json";

export async function loadHooks(cwd: string): Promise<HookConfig[]> {
  const hooks: HookConfig[] = [];
  // Project hooks (higher priority, loaded first so they execute first).
  const projectPath = path.join(cwd, PROJECT_HOOKS_PATH);
  if (existsSync(projectPath)) {
    try {
      const raw = await fsp.readFile(projectPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) hooks.push(...parsed);
    } catch (e) {
      log.warn("hooks: failed to load project hooks", { error: String(e) });
    }
  }
  // Global hooks.
  if (existsSync(GLOBAL_HOOKS_PATH)) {
    try {
      const raw = await fsp.readFile(GLOBAL_HOOKS_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) hooks.push(...parsed);
    } catch (e) {
      log.warn("hooks: failed to load global hooks", { error: String(e) });
    }
  }
  return hooks;
}

// ---- Runner ----

async function runHookScript(
  command: string,
  stdin: string,
  timeout: number,
): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DEEPSEEK_HOOK: "1" },
  });
  if (proc.stdin) {
    const w = proc.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const timer = setTimeout(() => {
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 2000);
  }, timeout);
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Hook exited ${exitCode}: ${err.slice(0, 200)}`);
  }
  return out.trim();
}

export async function runPreToolUseHooks(
  hooks: HookConfig[],
  input: HookInput,
): Promise<PreToolUseResult> {
  const matching = hooks.filter((h) => {
    if (h.event !== "PreToolUse") return false;
    if (h.matcher && !new RegExp(h.matcher).test(input.tool.name)) return false;
    return true;
  });
  if (matching.length === 0) return { allow: true };

  const payload = JSON.stringify(input);
  for (const hook of matching) {
    try {
      const raw = await runHookScript(hook.command, payload, hook.timeout ?? 30_000);
      if (!raw) continue;
      const result = JSON.parse(raw) as Partial<PreToolUseResult>;
      if (result.allow === false) {
        return { allow: false, reason: result.reason ?? `Blocked by hook` };
      }
      if (result.rewrite) {
        return { allow: true, rewrite: result.rewrite };
      }
    } catch (e) {
      log.warn("hooks: PreToolUse hook failed", {
        command: hook.command,
        error: String(e),
      });
    }
  }
  return { allow: true };
}

export async function runPostToolUseHooks(
  hooks: HookConfig[],
  input: PostToolUseInput,
): Promise<void> {
  const matching = hooks.filter((h) => {
    if (h.event !== "PostToolUse") return false;
    if (h.matcher && !new RegExp(h.matcher).test(input.tool.name)) return false;
    return true;
  });
  if (matching.length === 0) return;

  const payload = JSON.stringify(input);
  for (const hook of matching) {
    try {
      await runHookScript(hook.command, payload, hook.timeout ?? 30_000);
    } catch (e) {
      log.warn("hooks: PostToolUse hook failed", {
        command: hook.command,
        error: String(e),
      });
    }
  }
}
