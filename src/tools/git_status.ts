// git_status tool — structured, read-only view of `git status` output.
//
// Returns porcelain v1 + the current branch/upstream line so the model can
// reason about the working-tree state without parsing raw `bash git status`
// prose. Read-only; never mutates the repo.

import type { Tool, ToolResult } from "./types.ts";
import { isGitRepo, resolveGitCwd, runGit } from "./git_helpers.ts";
import { cap, tag } from "../prompt/harness.ts";

const MAX_OUTPUT = 16_000;

export const gitStatusTool: Tool = {
  name: "git_status",
  description: [
    "Show the working-tree status of the current repository. Read-only.",
    "Returns a stable porcelain listing plus the branch/line-count summary.",
    "Prefer this over `bash git status` for structured, low-noise output.",
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
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Limit the status to these paths.",
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx): Promise<ToolResult> {
    const cwd = resolveGitCwd(args.workdir, ctx.cwd);

    if (!(await isGitRepo(cwd))) {
      return { ok: false, content: `Not a git repository: ${cwd}`, error: "not_a_repo" };
    }

    // --branch gives the "## branch...upstream" header line; porcelain keeps
    // machine-friendly XY+path rows.
    const argv: string[] = ["status", "--porcelain=v1", "--branch"];
    if (Array.isArray(args.paths) && args.paths.length > 0) {
      argv.push("--");
      for (const p of args.paths) argv.push(String(p));
    }

    const { stdout, stderr, code } = await runGit(argv, cwd);

    if (code !== 0) {
      return {
        ok: false,
        content: tag("git_status", { error: "git_error" }, `git ${argv.join(" ")} failed (exit ${code}):\n${stderr || stdout}`),
        error: "git_error",
        uiSummary: `git_status: exit ${code}`,
      };
    }

    const body = cap(stdout || "(clean working tree)", MAX_OUTPUT);
    const { branch, changed } = summarize(stdout);
    return {
      ok: true,
      content: tag("git_status", {}, body),
      uiSummary: `git_status: ${branch}${changed > 0 ? ` · ${changed} changed` : " · clean"}`,
    };
  },
};

function summarize(stdout: string): { branch: string; changed: number } {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  let branch = "(detached)";
  const first = lines[0] ?? "";
  if (first.startsWith("## ")) {
    branch = first.slice(3).split("...")[0].trim() || branch;
  }
  const changed = lines.filter((l) => !l.startsWith("## ")).length;
  return { branch, changed };
}
