// git_diff tool — structured, read-only view of `git diff` output.
//
// Lets the model inspect working-tree or ref-to-ref changes without resorting
// to raw `bash git diff`, so the result is consistently framed and truncated
// to a sane size. Read-only: never mutates the repo, so it is not dangerous.

import type { Tool, ToolResult } from "./types.ts";
import { isGitRepo, resolveGitCwd, runGit } from "./git_helpers.ts";
import { cap, tag } from "../prompt/harness.ts";

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
    const cwd = resolveGitCwd(args.workdir, ctx.cwd);

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
      return {
        ok: false,
        content: tag("git_diff", { error: "git_error" }, `git ${argv.join(" ")} failed (exit ${code}):\n${stderr || stdout}`),
        error: "git_error",
        uiSummary: `git_diff: exit ${code}`,
      };
    }

    const raw = stdout || "(no changes)";
    const body = cap(raw, MAX_OUTPUT);
    const summary = args.stat ? "git diff --stat" : "git diff";
    return {
      ok: true,
      content: tag("git_diff", {}, body),
      uiSummary: `${summary} → ${summarizeStat(stdout)}`,
    };
  },
};

function summarizeStat(stdout: string): string {
  const m = stdout.match(/(\d+) files? changed/i);
  return m ? `${m[1]} changed` : (stdout ? "diff" : "clean");
}

