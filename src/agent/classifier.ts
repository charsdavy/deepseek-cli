// Agent classifier: analyzes the user's intent and maps it to a task category
// with targeted behavior adjustments (model selection, reasoning effort,
// tool priorities, temperature). Inspired by claude's agent classification
// system that matches different agent types to task profiles.
//
// Categories:
//   - code_review: Read-only analysis, pattern discovery, quality checks
//   - implementation: Writing code, editing files, building features
//   - exploration: Searching codebase, finding patterns, understanding code
//   - debug: Diagnosing issues, root-cause analysis, fixing bugs
//   - planning: Architecture design, roadmap creation, research
//   - general: Catch-all for mixed or unclassifiable prompts

export type TaskCategory = "code_review" | "implementation" | "exploration" | "debug" | "planning" | "general";

export interface ClassificationResult {
  category: TaskCategory;
  confidence: number;
  /** Recommended behavior adjustments for this task type. */
  hints: ClassificationHints;
}

export interface ClassificationHints {
  /** Should the model use chain-of-thought reasoning? */
  recommendReasoning: boolean;
  /** Preferred reasoning effort level. */
  reasoningEffort?: "high" | "max";
  /** Whether to emphasize read-only tool usage. */
  readOnlyTools: boolean;
  /** Whether to use lower temperature for more deterministic output. */
  deterministic: boolean;
  /** Tool categories to prioritize in the prompt. */
  toolPriority: ("fs-read" | "fs-write" | "bash" | "network")[];
}

const CATEGORY_KEYWORDS: Record<
  TaskCategory,
  { strong: string[]; weak: string[] }
> = {
  code_review: {
    strong: ["review", "audit", "code quality", "refactor", "clean up", "improve"],
    weak: ["check", "look at", "examine", "inspect something"],
  },
  implementation: {
    strong: ["implement", "create", "build", "add", "write", "develop", "make",
      "实现", "构建", "创建", "添加", "编写", "开发"],
    weak: ["modify", "change", "update", "edit", "rewrite",
      "修改", "更改", "更新"],
  },
  exploration: {
    strong: ["find", "search", "locate", "list", "show", "grep",
      "查找", "搜索", "列出", "查看"],
    weak: ["what", "which", "where", "how does", "tell me about",
      "什么", "哪个", "怎么"],
  },
  debug: {
    strong: ["debug", "fix", "bug", "error", "crash", "broken", "not working", "resolve",
      "修复", "调试", "错误", "崩溃"],
    weak: ["why is", "issue", "problem", "unexpected",
      "为什么", "问题"],
  },
  planning: {
    strong: ["design", "architecture", "plan", "roadmap", "strategy", "proposal",
      "设计", "架构", "规划", "方案"],
    weak: ["should we", "what approach", "recommend", "suggest something"],
  },
  general: {
    strong: [],
    weak: [],
  },
};

const CATEGORY_SCORE_WEIGHTS = {
  strong: 3,
  weak: 1,
};

export function classify(prompt: string): ClassificationResult {
  const lower = prompt.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [cat, kw] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const w of kw.strong) {
      if (lower.includes(w)) score += CATEGORY_SCORE_WEIGHTS.strong;
    }
    for (const w of kw.weak) {
      if (lower.includes(w)) score += CATEGORY_SCORE_WEIGHTS.weak;
    }
    scores[cat] = score;
  }

  const entries = Object.entries(scores) as [TaskCategory, number][];
  entries.sort((a, b) => b[1] - a[1]);
  const [topCat, topScore] = entries[0];

  if (topScore === 0) {
    return {
      category: "general",
      confidence: 1,
      hints: HINTS_MAP.general,
    };
  }

  const confidence = topScore / (topScore + 1);
  return {
    category: topCat,
    confidence: Math.min(confidence, 0.95),
    hints: HINTS_MAP[topCat],
  };
}

const HINTS_MAP: Record<TaskCategory, ClassificationHints> = {
  code_review: {
    recommendReasoning: true,
    reasoningEffort: "high",
    readOnlyTools: true,
    deterministic: false,
    toolPriority: ["fs-read", "network"],
  },
  implementation: {
    recommendReasoning: true,
    reasoningEffort: "max",
    readOnlyTools: false,
    deterministic: true,
    toolPriority: ["fs-write", "bash", "fs-read"],
  },
  exploration: {
    recommendReasoning: false,
    readOnlyTools: true,
    deterministic: true,
    toolPriority: ["fs-read", "network"],
  },
  debug: {
    recommendReasoning: true,
    reasoningEffort: "max",
    readOnlyTools: false,
    deterministic: false,
    toolPriority: ["fs-read", "bash", "fs-write"],
  },
  planning: {
    recommendReasoning: true,
    reasoningEffort: "high",
    readOnlyTools: true,
    deterministic: false,
    toolPriority: ["fs-read", "network"],
  },
  general: {
    recommendReasoning: false,
    readOnlyTools: false,
    deterministic: false,
    toolPriority: ["fs-read", "fs-write", "bash", "network"],
  },
};

/** Generate a targeted behavior prompt block based on task classification. */
export function classificationPromptBlock(result: ClassificationResult): string {
  const { category, hints } = result;
  const blocks: Record<TaskCategory, string> = {
    code_review: `## Task: Code Review
This is a code review / analysis task. Prioritize thorough reading over fast
answers. Document patterns, anti-patterns, and specific suggestions. Use
grep/glob for broad searches, read_file for deep dives. Do NOT edit files
unless explicitly asked.`,

    implementation: `## Task: Implementation
This is an implementation task. Move quickly from analysis to action. After
reading the relevant files, use edit_file / write_file immediately — don't
narrate the plan, just execute it. Batch read-only investigation calls in
one turn to minimize latency. Verify with lint/tests after each change.`,

    exploration: `## Task: Exploration
This is an exploration / research task. Use grep, glob, and list_dir to survey
the codebase efficiently. Batch multiple search calls in one turn. When you
find what you're looking for, present a clear summary. Don't edit files.`,

    debug: `## Task: Debug
This is a debugging task. Start by reproducing the error understanding.
Use grep to find related code, bash to run tests, and read_file to trace
execution paths. Focus on root cause — don't just patch symptoms. After
diagnosing, fix the issue with minimal changes. Verify the fix with tests.`,

    planning: `## Task: Planning
This is a planning / design task. Survey the codebase to understand the current
state, then propose a clear architecture. Consider trade-offs and alternatives.
Produce a structured plan before any implementation. Consult documentation and
existing patterns.`,

    general: "",
  };

  const categoryBlock = blocks[category] ?? blocks.general;
  if (!categoryBlock) return "";

  // Add tool priority hints.
  const toolLines = [
    "",
    "## Tool Priority",
    `Primary: ${hints.toolPriority.join(", ")}`,
    hints.readOnlyTools ? "READ-ONLY mode: do not use write_file, edit_file, or bash write operations." : "",
  ].filter(Boolean);

  return [categoryBlock, ...toolLines].join("\n");
}

/**
 * Auto-detect the best sub-agent type for a given task prompt.
 * This is used by the `task` tool to automatically select the right agent
 * type when the caller doesn't specify one, reducing user friction.
 * Inspired by claude's agent classifier.
 */
export type SubAgentType = "explore" | "general" | "plan" | "fork";

const SUBAGENT_KEYWORDS: Record<SubAgentType, string[]> = {
  explore: [
    "find", "search", "locate", "list", "show", "grep", "what files",
    "where is", "how does", "explore", "look at", "examine", "inspect",
    "查找", "搜索", "列出", "查看", "探索", "找到",
  ],
  plan: [
    "design", "architecture", "plan", "roadmap", "strategy", "proposal",
    "should we", "what approach", "recommend approach", "trade-off",
    "设计", "架构", "规划", "方案", "建议",
  ],
  fork: [
    "what if", "hypothetical", "branch", "alternative", "consider if",
    "如果", "假设",
  ],
  general: [
    "implement", "create", "build", "add", "write", "develop", "make",
    "fix", "debug", "edit", "modify", "change", "update",
    "实现", "构建", "创建", "添加", "编写", "修复", "修改",
  ],
};

export function detectSubAgentType(prompt: string): SubAgentType {
  const lower = prompt.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [type, keywords] of Object.entries(SUBAGENT_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    scores[type] = score;
  }

  const entries = Object.entries(scores) as [SubAgentType, number][];
  entries.sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = entries[0];

  // Default to "explore" for simple queries, "general" for complex ones.
  if (topScore === 0) {
    return prompt.length > 200 ? "general" : "explore";
  }
  return topType;
}
