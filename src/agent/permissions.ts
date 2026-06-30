// Permission manager — decides whether a dangerous tool call requires approval,
// and prompts the user when it does. Mirrors Claude Code's ask / auto modes.

import type { Tool } from "../tools/types.ts";
import { paint } from "../ui/theme.ts";
import { askYesNo, askQuestion } from "../ui/input.ts";
import { printBordered, writeLine } from "../ui/render.ts";

export type ApprovalMode = "ask" | "auto" | "yolo";

export interface PermissionDecision {
  allow: boolean;
  /** Carry the same decision for the rest of the session for similar calls? */
  persist?: boolean;
}

export interface PermissionOptions {
  mode: ApprovalMode;
  /** If true, the user already opted to allow all (e.g. --dangerously-skip-permissions). */
  skipAll?: boolean;
}

export class PermissionManager {
  private allowCache = new Set<string>();
  private denyCache = new Set<string>();
  /** Tools allowed for the whole session regardless of args (via /allow). */
  private allowedTools = new Set<string>();
  private opts: PermissionOptions;

  constructor(opts: PermissionOptions) {
    this.opts = opts;
  }

  get mode(): ApprovalMode {
    return this.opts.mode;
  }

  async check(tool: Tool, args: Record<string, unknown>): Promise<PermissionDecision> {
    if (this.opts.skipAll || this.opts.mode === "auto") {
      return { allow: true };
    }
    if (!tool.isDangerous) {
      return { allow: true };
    }
    // Per-tool session allow (e.g. /allow bash) wins over the per-signature cache.
    if (this.allowedTools.has(tool.name)) return { allow: true, persist: true };
    const key = signature(tool.name, args);
    if (this.allowCache.has(key)) return { allow: true };
    if (this.denyCache.has(key)) return { allow: false };

    return await this.prompt(tool, args, key);
  }

  /** Grant session-level always-allow for a whole tool (any args). */
  allowTool(name: string): void {
    this.allowedTools.add(name);
    this.denyCache.delete(name);
  }

  disallowTool(name: string): void {
    this.allowedTools.delete(name);
  }

  isToolAllowed(name: string): boolean {
    return this.allowedTools.has(name);
  }

  clearToolAllows(): void {
    this.allowedTools.clear();
  }

  private async prompt(
    tool: Tool,
    args: Record<string, unknown>,
    key: string,
  ): Promise<PermissionDecision> {
    const preview = renderPreview(tool, args);
    writeLine();
    printBordered(
      `approve ${tool.name}`,
      preview,
      "yellow",
    );
    writeLine();
    const ans = await askQuestion(
      `${paint.bold("Approve?")} ${paint.gray("[y]es / [n]o / [a]lways for this session")} `,
    ).catch(() => "n");

    const lower = ans.toLowerCase().trim();
    if (lower.startsWith("a") || lower === "always") {
      this.allowCache.add(key);
      return { allow: true, persist: true };
    }
    if (lower.startsWith("y") || lower === "yes" || lower === "") {
      return { allow: true };
    }
    this.denyCache.add(key);
    return { allow: false };
  }
}

function signature(toolName: string, args: Record<string, unknown>): string {
  const safe = { ...args };
  // Strip volatile content; key on stable identifiers (path, command)
  const keys = ["filePath", "path", "command", "workdir"].filter((k) => k in safe);
  const sig = keys.map((k) => `${k}=${String(safe[k])}`).join("|");
  return `${toolName}::${sig}`;
}

function renderPreview(tool: Tool, args: Record<string, unknown>): string {
  switch (tool.name) {
    case "write_file": {
      const p = String(args.filePath ?? "");
      const c = String(args.content ?? "");
      return `Path: ${p}\n${paint.gray("-- content --")}\n${truncate(c, 1000)}`;
    }
    case "edit_file": {
      const p = String(args.filePath ?? "");
      const o = String(args.oldString ?? "");
      const n = String(args.newString ?? "");
      return `Path: ${p}\n${paint.red(`- ${truncate(o, 400)}`)}\n${paint.green(`+ ${truncate(n, 400)}`)}`;
    }
    case "bash": {
      const c = String(args.command ?? "");
      const w = args.workdir ? String(args.workdir) : "(cwd)";
      return `Workdir: ${w}\n$ ${truncate(c, 800)}`;
    }
    default:
      return JSON.stringify(args, null, 2).slice(0, 1500);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…\n(truncated)";
}

// Convenience helper to ask a free-form yes/no without PermissionManager.
export async function confirmAction(prompt: string, def = false): Promise<boolean> {
  return await askYesNo(prompt, def);
}
