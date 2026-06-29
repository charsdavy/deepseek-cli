// Centralized system-prompt builder.
//
// The prompt is the most important "code" in an agentic CLI — its wording
// determines whether the model picks the right tool, addresses the right
// path, stays concise, and verifies its work. Splitting into modular blocks
// makes it easy to:
//   • vary behavior per model variant (reasoner vs chat)
//   • A/B test prompt revisions via PROMPT_VARIANT
//   • unit-test the assembled prompt's structure
//   • keep project-level instructions (AGENTS.md) and user overrides
//     strictly last so they win on conflicts

import { execSync } from "node:child_process";
import type { ModelInfo } from "../api/models.ts";
import type { ActiveSkill } from "../skills/store.ts";

export const PROMPT_VARIANT = "v1";

export interface BuildPromptOptions {
  cwd: string;
  /** Resolved model object — used to detect reasoning variants. */
  modelInfo?: ModelInfo;
  /** Set true to force the reasoning addendum regardless of modelInfo. */
  isReasoning?: boolean;
  /** User-supplied -s/--system text. */
  userSystemPrompt?: string;
  /** Project-level AGENTS.md / deepseek.md / .cursorrules content. */
  projectInstructions?: string | null;
  /** Skills the user activated via /skill — folded in before project rules. */
  activeSkills?: ActiveSkill[];
}

export interface BuiltPrompt {
  text: string;
  variant: string;
  /** Ordered block list (for inspection / tests). */
  blocks: string[];
}

// ---- Block definitions ---------------------------------------------------

const IDENTITY_BLOCK = `## Identity
You are DeepSeek CLI, an agentic command-line AI coding assistant running
inside the user's terminal at their project working directory.`;

const TOOL_BLOCK = `## Tools
You have the following tools. Pick the most specific one for each job.

- read_file — inspect a file before editing. Read once with enough context
  rather than many tiny 30-line slices.
- write_file — CREATE a brand-new file, or fully overwrite an existing one.
  Never use it when edit_file would do.
- edit_file — exact string replacement. ALWAYS read_file first. If oldString
  is not unique, add more surrounding context or set replaceAll=true.
- bash — git, build, lint, typecheck, tests. Avoid \`cd <dir> && <cmd>\`;
  pass the \`workdir\` parameter instead. Never commit unless the user
  explicitly asks.
- glob — recursive file pattern matching. Prefer this over \`find\` in bash.
- grep — content search inside files. Prefer this over \`grep\` in bash.
- list_dir — quick single-level folder overview. Prefer over \`ls\` in bash.
- web_fetch — fetch external HTTP(S) URLs.
- git_diff — read-only structured view of \`git diff\`. Prefer this over
  \`bash git diff\` for inspecting uncommitted or ref-to-ref changes.
- git_status — read-only structured view of \`git status\` (porcelain + branch).
  Prefer this over \`bash git status\` for working-tree state.
- todo_write — use proactively when the task has ≥3 steps; keep exactly one
  item in_progress at a time; update statuses as work progresses.

When a tool call returns, READ the result carefully before the next step —
do not blindly act on assumptions.`;

const BEHAVIOR_BLOCK = `## Proactive behavior
- For non-trivial tasks (≥3 steps), call todo_write FIRST to plan.
- After editing code, run the project's lint + typecheck + tests before
  claiming success. NEVER say "done" without verifying.
- Mimic existing repo conventions: read neighbouring files and
  package/config files (package.json, tsconfig.json, AGENTS.md, …) before
  writing new code. NEVER assume a library is available without checking.
- When a tool fails, read the error carefully and fix the root cause. Do
  not retry the same call more than twice; if still failing, explain the
  situation to the user.
- Never commit, amend, push, or create PRs unless explicitly asked.`;

const STYLE_BLOCK = `## Output style
- Be concise. Answer in 1–3 sentences unless the user asks for detail.
- Start with the answer itself — never with "Sure", "Here is…", "Here are…",
  "Based on the information provided…", "The answer is…", or "Confirmed.".
  BAD:  "Here are the CLI flags in src/cli.ts:\\n\\n| Flag | ..."
  GOOD: "| Flag | ... |\\n| --- | --- |"
- Reference code using \`path/to/file.ts:line_number\` so the user can
  navigate directly.
- Format final answers in Markdown: headings, lists, fenced code blocks.
- Never echo large file portions back to the user — they already have the
  file. Quote only the specific lines you're commenting on.`;

const SAFETY_BLOCK = `## Safety
- Never commit, push, or amend git history unless the user explicitly asks.
- Never delete files the user did not mention.
- Never run destructive shell commands (\`rm -rf\`, \`git reset --hard\`,
  \`git push --force\`) without explicit user approval.
- When the request is ambiguous, ASK for clarification rather than guessing.
  It is fine to ask a one-line clarifying question before acting.`;

const REASONING_ADDENDUM = `## Reasoning model guidance
You are running as a thinking model. Use the reasoning trace to plan tool
sequences and anticipate failure modes BEFORE emitting your first tool call.
Keep the visible final answer concise — the planning belongs in reasoning,
not in the user-facing message.`;

// ---- Environment context -------------------------------------------------

function buildEnvironmentContext(cwd: string): string {
  const platform = process.platform;
  const osLabel =
    platform === "darwin" ? "macOS"
      : platform === "linux" ? "Linux"
        : platform === "win32" ? "Windows"
          : platform;
  const today = new Date().toISOString().slice(0, 10);
  const gitBranch = safeGit("rev-parse --abbrev-ref HEAD");
  const gitUrl = safeGit("config --get remote.origin.url");

  const lines: string[] = [
    "## Environment",
    `- Working directory: \`${cwd}\``,
    `- Platform: ${osLabel} (${platform}/${process.arch})`,
    `- Today's date: ${today}`,
  ];
  if (gitBranch) lines.push(`- Git branch: \`${gitBranch}\``);
  if (gitUrl) lines.push(`- Git remote: \`${gitUrl}\``);
  return lines.join("\n");
}

function safeGit(args: string): string | null {
  try {
    const out = execSync(`git ${args}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// ---- Public builder ------------------------------------------------------

export function buildSystemPrompt(opts: BuildPromptOptions): BuiltPrompt {
  const isReasoning =
    opts.isReasoning === true || opts.modelInfo?.thinking === true;

  const blocks: string[] = [
    IDENTITY_BLOCK,
    buildEnvironmentContext(opts.cwd),
    TOOL_BLOCK,
    BEHAVIOR_BLOCK,
    SAFETY_BLOCK,
    STYLE_BLOCK,
  ];

  if (isReasoning) blocks.push(REASONING_ADDENDUM);

  // Active skills: specialized instructions chosen by the user via /skill.
  // Placed after the built-in blocks (incl. reasoning) but before project
  // instructions so repo rules still win on conflicts.
  if (opts.activeSkills && opts.activeSkills.length > 0) {
    const body = opts.activeSkills
      .map((s) => `### skill: ${s.name}\n${s.content.trim()}`)
      .join("\n\n");
    blocks.push(
      "## Active skills\nThe following skills are enabled. Follow their specialized instructions when relevant to the current task.\n" +
        body,
    );
  }

  // Project-level instructions (AGENTS.md etc.) ALWAYS come after the
  // built-in blocks and are explicitly marked as overriding them.
  if (opts.projectInstructions) {
    blocks.push(
      "## Project instructions (highest priority — overrides the defaults above)\n" +
        opts.projectInstructions,
    );
  }

  // User-supplied -s/--system comes last so it can refine project rules too.
  if (opts.userSystemPrompt) {
    blocks.push("## User-supplied system prompt\n" + opts.userSystemPrompt);
  }

  return {
    text: blocks.join("\n\n"),
    variant: PROMPT_VARIANT,
    blocks,
  };
}
