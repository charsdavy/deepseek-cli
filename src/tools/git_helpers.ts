// Shared git helpers for the structured git tools. Spawn-based (no shell) so
// argument values are never interpreted by a shell. Read-only operations only.
import { spawn } from "node:child_process";
import * as path from "node:path";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function resolveGitCwd(workdir: unknown, fallback: string): string {
  if (typeof workdir === "string" && workdir.length > 0) {
    return path.isAbsolute(workdir) ? workdir : path.resolve(fallback, workdir);
  }
  return fallback;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const { code } = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return code === 0;
}

export function runGit(argv: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    child.on("error", () => resolve({ stdout: "", stderr: "git binary not found", code: -1 }));
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 }));
  });
}
