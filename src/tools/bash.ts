// bash tool — run a shell command with a working directory, timeout,
// and output byte cap (inspired by codex's outputBytesCap for token safety).

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Tool, ToolResult } from "./types.ts";
import { tag, trunc } from "../prompt/harness.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const STDOUT_CAP = 512_000;
const STDERR_CAP = 256_000;
const OUTPUT_BYTES_CAP = 100_000;

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
      outputBytesCap: {
        type: "integer",
        description: `Max combined stdout+stderr bytes. Exceeding this terminates the process early. Defaults to ${OUTPUT_BYTES_CAP}.`,
        minimum: 1000,
        maximum: 1_000_000,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },

  async execute(args, ctx): Promise<ToolResult> {
    const command = String(args.command ?? "");
    if (!command) {
      return { ok: false, content: "Missing required parameter: command.", error: "missing_arg" };
    }
    const workdir = args.workdir ? String(args.workdir) : undefined;
    const timeout = clamp(Number(args.timeout ?? DEFAULT_TIMEOUT_MS), 1000, 1_800_000);
    const outputCap = clamp(Number(args.outputBytesCap ?? OUTPUT_BYTES_CAP), 1000, 1_000_000);
    const cwd = workdir ? (path.isAbsolute(workdir) ? workdir : path.resolve(ctx.cwd, workdir)) : ctx.cwd;

    try {
      const { stdout, stderr, code, durationMs, timedOut, stdoutOmitted, stderrOmitted, outputCapped } = await runShell(command, cwd, timeout, outputCap);
      const parts: string[] = [];
      parts.push(`$ ${command}`);
      parts.push(`(cwd: ${cwd})`);
      if (stdout) {
        parts.push(`stdout:\n${stdout}`);
        if (stdoutOmitted > 0) parts.push(trunc(stdoutOmitted, "chars (tail kept)"));
      }
      if (stderr) {
        parts.push(`stderr:\n${stderr}`);
        if (stderrOmitted > 0) parts.push(trunc(stderrOmitted, "chars (tail kept)"));
      }
      if (timedOut) {
        parts.push(`(timed out after ${timeout}ms)`);
      }
      if (outputCapped) {
        parts.push(`(output capped at ${outputCap} bytes — process was terminated)`);
      }
      parts.push(`(exit ${code}, ${durationMs}ms)`);
      return {
        ok: code === 0,
        content: tag("bash", { command, exit: code }, parts.join("\n")),
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
  stdoutOmitted: number;
  stderrOmitted: number;
  code: number;
  durationMs: number;
  timedOut: boolean;
  outputCapped: boolean;
}

function runShell(command: string, cwd: string, timeoutMs: number, outputCap: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.env.SHELL ?? "bash", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutOmitted = 0;
    let stderrOmitted = 0;
    let timedOut = false;
    let outputCapped = false;
    let totalBytes = 0;

    const checkOutputCap = (): boolean => {
      totalBytes = stdout.length + stderr.length;
      if (totalBytes >= outputCap) {
        outputCapped = true;
        child.kill("SIGKILL");
        return true;
      }
      return false;
    };

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
      if (stdout.length > STDOUT_CAP) {
        stdoutOmitted += stdout.length - STDOUT_CAP;
        stdout = stdout.slice(-STDOUT_CAP);
      }
      checkOutputCap();
    });

    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
      if (stderr.length > STDERR_CAP) {
        stderrOmitted += stderr.length - STDERR_CAP;
        stderr = stderr.slice(-STDERR_CAP);
      }
      checkOutputCap();
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
        stdoutOmitted,
        stderrOmitted,
        code: code ?? -1,
        durationMs: Date.now() - start,
        timedOut,
        outputCapped,
      });
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        stdoutOmitted,
        stderrOmitted,
        code: -1,
        durationMs: Date.now() - start,
        timedOut,
        outputCapped,
      });
    });
  });
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
