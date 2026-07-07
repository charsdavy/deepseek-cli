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
//
// Token-economy architecture (inspired by Claude Code):
//   • System prompt = static blocks only (identity, tools, behavior, style, safety).
//     This keeps the system payload cacheable across turns and sessions.
//   • Dynamic context (cwd, git branch, date, model identity) is returned as
//     a separate envContext string for injection as a user message — one-shot
//     at conversation start, never re-sent. This saves ~300 tokens/turn.
//   • Project instructions (AGENTS.md etc.) are NO LONGER folded into the system
//     prompt. The caller (chat.ts) injects them as a dedicated user message
//     with clear override semantics so the model treats them as fresh input
//     rather than stale preamble.

import { execSync } from "node:child_process";
import type { ModelInfo } from "../api/models.ts";
import type { ActiveSkill } from "../skills/store.ts";

export const PROMPT_VARIANT = "v2";

export interface BuildPromptOptions {
  cwd: string;
  /** Resolved model object — used to detect reasoning variants. */
  modelInfo?: ModelInfo;
  /** Resolved model id shown in the identity block. */
  modelId?: string;
  /** Set true to force the reasoning addendum regardless of modelInfo. */
  isReasoning?: boolean;
  /** User-supplied -s/--system text. */
  userSystemPrompt?: string;
  /** @deprecated Project instructions are no longer folded into the system prompt.
   *  The caller should inject them as a separate user message instead. */
  projectInstructions?: string | null;
  /** Skills the user activated via /skill — folded in before project rules. */
  activeSkills?: ActiveSkill[];
  /** Output style — controls verbosity and tone. */
  outputStyle?: OutputStyle;
}

/** Output personality controlled via /style command. */
export type OutputStyle = "concise" | "explain" | "learning";

export interface BuiltPrompt {
  /** Static system prompt (no env, no project instructions — cacheable). */
  text: string;
  variant: string;
  /** Ordered block list (for inspection / tests). */
  blocks: string[];
  /** Environment context string for one-shot injection as a user message. */
  envContext: string;
}

// ---- Block definitions ---------------------------------------------------

function buildIdentity(modelId?: string): string {
  const modelLine = modelId
    ? `\nYou are powered by the model named ${modelId}.\nThe exact model ID is ${modelId}.`
    : "";
  return `## Identity
You are DeepSeek CLI, an agentic command-line AI coding assistant running
inside the user's terminal at their project working directory.${modelLine}`;
}

const TOOL_BLOCK = `## Tools
You have the following tools. Pick the most specific one for each job.

- read_file — inspect ONE file before editing. Read once with enough context
  rather than many tiny 30-line slices.
- read_files — BATCH-read 2+ files in one call. STRONGLY PREFERRED over issuing
  several read_file calls when you need multiple files: it collapses round-trips
  and is the single biggest latency win for "read code, then answer" tasks.
  Each file comes back in its own <file> section with the same line numbers.
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
- web_search — search the public web via DuckDuckGo. Use ON DEMAND only for
  fresh information beyond your training data (latest library versions,
  recent docs, release notes, news). Do NOT use for things you already know
  or can derive from local files — that wastes a network round-trip. Pairs
  with web_fetch: search to discover, then fetch the best hit for deeper
  reading.
- git_diff — read-only structured view of \`git diff\`. Prefer this over
  \`bash git diff\` for inspecting uncommitted or ref-to-ref changes.
- git_status — read-only structured view of \`git status\` (porcelain + branch).
  Prefer this over \`bash git status\` for working-tree state.
- task — launch a sub-agent for a self-contained subtask; returns its final
  answer. Issue multiple task calls together to parallelize independent work.
- todo_write — use proactively when the task has ≥3 steps; keep exactly one
  item in_progress at a time; update statuses as work progresses.

When a tool call returns, READ the result carefully before the next step —
do not blindly act on assumptions.

Only call tools by their EXACT registered names listed above. Inventing a
name — a placeholder, a guess, or a made-up token — returns \`unknown_tool\`
and burns a whole iteration for nothing. If you are unsure a tool fits,
re-read this list; if none of them does, answer in plain text. Do NOT
fabricate a tool call. If a call fails, read the error and fix the root
cause rather than re-issuing the same failing name.`;

const BEHAVIOR_BLOCK = `## Proactive behavior
- For non-trivial tasks (≥3 steps that change code), call todo_write FIRST to plan.
- For READ-ONLY tasks (read code, explain, propose a solution, answer a
  question) do NOT call todo_write — just read the relevant files and answer.
  Spawning a todo list for a pure "read and explain" task wastes an iteration.
- When asked to IMPLEMENT, FIX, or BUILD: pick up edit_file / write_file
  IMMEDIATELY. Do NOT re-explain the plan, re-summarize the approach, or
  narrate "I will now…" before editing. Analysis is done — implementation
  means writing code, not talking about writing code. A turn that ends with
  text but zero file edits is a failure mode when the user asked for changes.
- When you need 2+ files to answer, call read_files ONCE (batch) instead of
  several read_file calls across turns. This is the highest-leverage speed win.
- After editing code, run the project's lint + typecheck + tests before
  claiming success. NEVER say "done" without verifying.
- Mimic existing repo conventions: read neighbouring files and
  package/config files (package.json, tsconfig.json, AGENTS.md, …) before
  writing new code. NEVER assume a library is available without checking.
- When a tool fails, read the error carefully and fix the root cause. Do
  not retry the same call more than twice; if still failing, explain the
  situation to the user.
- For tasks larger than ~20 steps, write the full todo_write list FIRST,
  then execute ONE todo item per turn. Never attempt a big task as one
  unbounded run — hitting the iteration cap with the work unfinished (an
  empty final answer) is a failure. Split into phases, checkpoint between
  them, and let the user steer.
- In long conversations, keep this thread lean: locate code with grep/glob
  instead of whole-file read_file passes, and delegate self-contained
  investigations to the \`task\` sub-agent so their context stays out of the
  main loop. Re-reading a file already in context is wasted tokens.
- Never commit, amend, push, or create PRs unless explicitly asked.`;

const LATENCY_BLOCK = `## Iteration cost (very important)
Each tool-call turn costs several seconds of model reasoning before your
NEXT tool call can fire. A pattern of "one tool per iteration across many
iterations" is the dominant source of perceived slowness — flatten it:

- BATCH read-only investigation: when you need read_file A, grep B, list_dir
  C, and read_file D, emit ALL FOUR tool calls in the SAME turn. They run in
  parallel and the user gets all results after a single thinking pause.
- Don't split trivial inspection commands across bash turns. Chain related
  shell commands in ONE bash invocation:
  ` + "```" + `bash
  wc -l src/index.ts && file package.json && ls scripts/
  ` + "```" + `
  rather than three separate bash calls.
- Never call todo_write twice in one turn. Update it at most once per turn,
  and only when the high-level plan materially changes — not between every
  pair of file reads.
- Prefer read_files (one batch call) over many read_file calls when reading
  two or more files, even if you discovered the file list iteratively.
- If a sub-task is self-contained and would expand the main thread's
  context for nothing, delegate it to the ` + "`task`" + ` tool — the main loop
  continues while the sub-agent runs.

The model that follows these rules feels ~5–10× snappier to the user
without any other change.`;

const STYLE_CONCISE = `## Output style
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

const STYLE_EXPLAIN = `## Output style (explanatory mode)
- Provide educational insights about the codebase along the way.
- Explain WHY the code works the way it does, not just WHAT it does.
- Mention relevant design patterns, trade-offs, and alternative approaches.
- Keep the explanation focused — don't lecture. A 3-line insight is better
  than a 20-line essay.
- Reference code using \`path/to/file.ts:line_number\`.
- Format answers in Markdown: headings, lists, fenced code blocks.`;

const STYLE_LEARNING = `## Output style (learning mode)
- Act as a coding tutor. Pause and ask the user to write small pieces of
  code for hands-on practice before completing the full implementation.
- For each step: explain the concept, ask the user to write the code,
  then review and refine together.
- Start each teaching moment with a clear learning goal.
- Provide constructive feedback on the user's code — focus on one
  improvement at a time.
- Format answers in Markdown: headings, lists, fenced code blocks.`;

function buildStyleBlock(style?: OutputStyle): string {
  switch (style) {
    case "explain": return STYLE_EXPLAIN;
    case "learning": return STYLE_LEARNING;
    default: return STYLE_CONCISE;
  }
}

const CODE_STYLE_BLOCK = `## Code style
- Don't add features, refactor, or introduce abstractions beyond what the
  task requires. A bug fix doesn't need surrounding cleanup; a one-shot
  operation doesn't need a helper. Don't design for hypothetical future
  requirements. Three similar lines is better than a premature abstraction.
- Don't add error handling, fallbacks, or validation for scenarios that
  can't happen. Trust internal code and framework guarantees. Only validate
  at system boundaries (user input, external APIs).
- Default to writing no comments. Only add one when the WHY is non-obvious:
  a hidden constraint, a subtle invariant, a workaround for a specific bug,
  behavior that would surprise a reader. If removing the comment wouldn't
  confuse a future reader, don't write it.
- Don't explain WHAT the code does — well-named identifiers already do that.
- For UI or frontend changes, start the dev server and use the feature in a
  browser before reporting the task as complete. Type checking and test
  suites verify code correctness, not feature correctness — if you can't
  test the UI, say so explicitly.`;

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

// Sub-agent system prompt — a stripped-down sibling of the main identity
// block. Sub-agents run on a fast model with a bounded context/iteration
// budget, so the prompt is intentionally short: identity, tool latitude, and
// the single most important rule (return ONLY the result). Kept here so the
// harness vocabulary (## headings, terse imperatives) stays in one place.
export const SUBAGENT_SYSTEM_PROMPT = `## Identity
You are a focused DeepSeek sub-agent running inside a parent agent loop.

## Tools
You have the same file/code tools as the parent (read_file, read_files,
glob, grep, web_fetch, bash, write_file, edit_file). Use them exactly
as the parent would — batch read-only calls in one turn to reduce latency.

## Output
Complete the assigned subtask, then return ONLY the final result — no
preamble, no follow-up questions, no narration of what you did. Do NOT use
\`task\` or \`todo_write\` — you ARE the leaf worker, not the coordinator.`;

// ---- Environment context -------------------------------------------------

export function buildEnvironmentContext(cwd: string, modelInfo?: ModelInfo): string {
  const platform = process.platform;
  const osLabel =
    platform === "darwin" ? "macOS"
      : platform === "linux" ? "Linux"
        : platform === "win32" ? "Windows"
          : platform;
  const today = new Date().toISOString().slice(0, 10);
  const gitBranch = safeGit("rev-parse --abbrev-ref HEAD");
  const gitUrl = safeGit("config --get remote.origin.url");
  const gitCommit = safeGit("rev-parse HEAD")?.slice(0, 8);

  const lines: string[] = [
    "## Environment",
    `- Working directory: \`${cwd}\``,
    `- Platform: ${osLabel} (${platform}/${process.arch})`,
    `- Today's date: ${today}`,
  ];
  if (modelInfo) {
    lines.push(`- Model: ${modelInfo.label} (\`${modelInfo.id}\`)${modelInfo.thinking ? " (reasoning enabled)" : ""}`);
  }
  if (gitBranch) lines.push(`- Git branch: \`${gitBranch}\``);
  if (gitUrl) lines.push(`- Git remote: \`${gitUrl}\``);
  if (gitCommit) lines.push(`- Git commit: \`${gitCommit}\``);
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

// Section-level cache: avoids rebuilding identical system prompts across
// consecutive rebuildSystemPrompt() calls (e.g. model toggle back to the
// same model, skill activation no-op). Cache is bounded to 8 entries
// to prevent unbounded growth during long sessions with many skill switches.
const _promptCache = new Map<string, BuiltPrompt>();
const _MAX_CACHE_SIZE = 8;

function _cacheKey(opts: BuildPromptOptions): string {
  // Hash the options that affect the output — including cwd since
  // envContext depends on it (git branch/remote/commit vary by directory).
  const skillsHash = (opts.activeSkills ?? [])
    .map((s) => `${s.name}:${s.content.length}`)
    .join(",");
  return [
    opts.cwd,
    opts.modelId ?? opts.modelInfo?.id ?? "",
    opts.modelInfo?.thinking ?? false,
    opts.isReasoning ?? false,
    opts.userSystemPrompt ?? "",
    opts.projectInstructions ?? "",
    opts.outputStyle ?? "concise",
    skillsHash,
  ].join("|");
}

export function buildSystemPrompt(opts: BuildPromptOptions): BuiltPrompt {
  const key = _cacheKey(opts);
  const cached = _promptCache.get(key);
  if (cached) return cached;

  const isReasoning =
    opts.isReasoning === true || opts.modelInfo?.thinking === true;

  const envContext = buildEnvironmentContext(opts.cwd, opts.modelInfo);

  const blocks: string[] = [
    buildIdentity(opts.modelId ?? opts.modelInfo?.id),
    TOOL_BLOCK,
    BEHAVIOR_BLOCK,
    LATENCY_BLOCK,
    CODE_STYLE_BLOCK,
    SAFETY_BLOCK,
    buildStyleBlock(opts.outputStyle),
  ];

  if (isReasoning) blocks.push(REASONING_ADDENDUM);

  // Active skills: specialized instructions chosen by the user via /skill.
  // Per-skill content budget (≈ 500 tokens) prevents a single large skill
  // from bloating the system prompt past cacheability thresholds.
  if (opts.activeSkills && opts.activeSkills.length > 0) {
    const MAX_SKILL_CONTENT_CHARS = 2000;
    const body = opts.activeSkills
      .map((s) => {
        const trimmed = s.content.trim();
        if (trimmed.length <= MAX_SKILL_CONTENT_CHARS) {
          return `### skill: ${s.name}\n${trimmed}`;
        }
        const truncated = trimmed.slice(0, MAX_SKILL_CONTENT_CHARS);
        return `### skill: ${s.name}\n${truncated}\n... (truncated — ${trimmed.length - MAX_SKILL_CONTENT_CHARS} more chars omitted from skill body)`;
      })
      .join("\n\n");
    blocks.push(
      "## Active skills\nThe following skills are enabled. Prioritize their specialized instructions for the current task and all subsequent turns until deactivated.\n" +
        body,
    );
  }

  // Project instructions (AGENTS.md etc.) — kept for backward compatibility
  // but callers should prefer injecting them as a user message.
  if (opts.projectInstructions) {
    blocks.push(
      "## Project instructions (highest priority — overrides the defaults above)\n" +
        opts.projectInstructions,
    );
  }

  // User-supplied -s/--system last so it can refine everything above.
  if (opts.userSystemPrompt) {
    blocks.push("## User-supplied system prompt\n" + opts.userSystemPrompt);
  }

  const result: BuiltPrompt = {
    text: blocks.join("\n\n"),
    variant: PROMPT_VARIANT,
    blocks,
    envContext,
  };

  // Store in cache (LRU: evict oldest if full).
  if (_promptCache.size >= _MAX_CACHE_SIZE) {
    const first = _promptCache.keys().next().value;
    if (first !== undefined) _promptCache.delete(first);
  }
  _promptCache.set(key, result);

  return result;
}

/** Clear the prompt cache (useful for testing). */
export function clearPromptCache(): void {
  _promptCache.clear();
}
