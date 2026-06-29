// bash tool — run a shell command with a working directory and timeout.

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Tool, ToolResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

export const bashTool: Tool = {
  name: "bash",
  description: [
    "Executes a shell command on the user's machine. Use this for git, build, test, and inspection tasks.",
    "Avoid `cd <dir> && <cmd>` patterns — use the `workdir` parameter instead.",
    "Quote paths containing spaces with double quotes.",
    "Capture stdout, stderr, and exit code, and return them to the model.",
    "Recommended: run lint and typecheck commands before declaring a task done.",
    "NEVER commit changes unless the user explicitly asks.",
  ].join(" "),
  category: "bash",
  isDangerous: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      workdir: {
        type: "string",
        description: "Working directory. Defaults to the current working directory.",
      },
      timeout: {
        type: "integer",
        description: `Max execution time in ms. Defaults to ${DEFAULT_TIMEOUT_MS}ms.`,
        minimum: 0,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const command = String(args.command ?? "");
    if (!command) {
      return { ok: false, content: "Missing required parameter: command.", error: "missing_arg" };
    }
    const workdir = args.workdir ? String(args.workdir) : undefined;
    const timeout = clamp(Number(args.timeout ?? DEFAULT_TIMEOUT_MS), 1000, 1_800_000);
    const cwd = workdir ? (path.isAbsolute(workdir) ? workdir : path.resolve(process.cwd(), workdir)) : process.cwd();

    try {
      const { stdout, stderr, code, durationMs, timedOut } = await runShell(command, cwd, timeout);
      const parts: string[] = [];
      parts.push(`$ ${command}`);
      parts.push(`(cwd: ${cwd})`);
      if (stdout) parts.push(`stdout:\n${stdout}`);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      if (timedOut) {
        parts.push(`(timed out after ${timeout}ms)`);
      }
      parts.push(`(exit ${code}, ${durationMs}ms)`);
      return {
        ok: code === 0,
        content: parts.join("\n"),
        uiSummary: `bash: ${truncate(command, 60)} → exit ${code}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `Failed to spawn '${command}': ${msg}`, error: "spawn_error" };
    }
  },
};

interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
  timedOut: boolean;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.env.SHELL ?? "bash", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
      if (stdout.length > 512_000) stdout = stdout.slice(-512_000);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
      if (stderr.length > 256_000) stderr = stderr.slice(-256_000);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: code ?? -1,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: -1,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.max(min, Math.min(max, n));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
