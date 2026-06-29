// git_diff tool — structured, read-only view of `git diff` output.
//
// Lets the model inspect working-tree or ref-to-ref changes without resorting
// to raw `bash git diff`, so the result is consistently framed and truncated
// to a sane size. Read-only: never mutates the repo, so it is not dangerous.

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { Tool, ToolResult } from "./types.ts";

const MAX_OUTPUT = 64_000;

export const gitDiffTool: Tool = {
  name: "git_diff",
  description: [
    "Show git diff output for the current repository. Read-only.",
    "Use this to inspect uncommitted changes or compare two refs/branches.",
    "By default shows the unstaged working-tree diff; set staged=true for",
    "changes added to the index, or provide base/head (e.g. base=\"main\")",
    "to compare refs. Set stat=true for a compact file-change summary.",
  ].join(" "),
  category: "git",
  isDangerous: false,
  parameters: {
    type: "object",
    properties: {
      workdir: {
        type: "string",
        description: "Repository root. Defaults to the current working directory.",
      },
      staged: {
        type: "boolean",
        description: "Show staged (cached) changes instead of the working tree.",
      },
      base: {
        type: "string",
        description: "Base ref for a ref-to-ref diff (e.g. \"main\", \"HEAD~1\").",
      },
      head: {
        type: "string",
        description: "Head ref for a ref-to-ref diff. Defaults to the current working tree.",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Limit the diff to these paths.",
      },
      stat: {
        type: "boolean",
        description: "Return a compact --stat summary (files changed, insertions, deletions).",
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx): Promise<ToolResult> {
    const cwd = resolveCwd(args.workdir, ctx.cwd);

    if (!(await isGitRepo(cwd))) {
      return { ok: false, content: `Not a git repository: ${cwd}`, error: "not_a_repo" };
    }

    const argv: string[] = ["diff", "--no-color"];
    if (args.stat) argv.push("--stat");
    if (args.base) {
      const base = String(args.base);
      const head = args.head ? String(args.head) : "";
      argv.push(`${base}..${head || "HEAD"}`);
    } else if (args.staged) {
      argv.push("--cached");
    }
    if (Array.isArray(args.paths) && args.paths.length > 0) {
      argv.push("--");
      for (const p of args.paths) argv.push(String(p));
    }

    const { stdout, stderr, code } = await runGit(argv, cwd);

    if (code !== 0 && code !== 1) {
      // git diff returns 1 when there are differences (with --exit-code) but we
      // don't pass --exit-code, so non-zero usually means a real error.
      return {
        ok: false,
        content: `git ${argv.join(" ")} failed (exit ${code}):\n${stderr || stdout}`,
        error: "git_error",
        uiSummary: `git_diff: exit ${code}`,
      };
    }

    const body = truncate(stdout || "(no changes)");
    const summary = args.stat ? "git diff --stat" : "git diff";
    return {
      ok: true,
      content: body,
      uiSummary: `${summary} → ${summarizeStat(stdout)}`,
    };
  },
};

function resolveCwd(workdir: unknown, fallback: string): string {
  if (typeof workdir === "string" && workdir.length > 0) {
    return path.isAbsolute(workdir) ? workdir : path.resolve(fallback, workdir);
  }
  return fallback;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const { code } = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return code === 0;
}

function runGit(argv: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
      if (stdout.length > MAX_OUTPUT * 2) stdout = stdout.slice(0, MAX_OUTPUT * 2);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    child.on("error", () => resolve({ stdout: "", stderr: "git binary not found", code: -1 }));
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 }));
  });
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n…(truncated, ${s.length - MAX_OUTPUT} more chars)`;
}

function summarizeStat(stdout: string): string {
  // Look for the trailing N files changed summary line.
  const m = stdout.match(/(\d+) files? changed/i);
  return m ? `${m[1]} changed` : (stdout ? "diff" : "clean");
}
