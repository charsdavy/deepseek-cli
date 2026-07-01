// DeepSeek model catalog. The API is OpenAI-compatible but DeepSeek supports
// a few specific model IDs. We keep the original list plus add documented ones.

export interface ModelInfo {
  id: string;
  label: string;
  description: string;
  thinking?: boolean;
}

export const MODELS: ModelInfo[] = [
  {
    id: "auto",
    label: "Auto",
    description: "Auto-select based on task complexity",
  },
  {
    id: "deepseek-v4-flash",
    label: "V4 Flash",
    description: "Fast lightweight model",
  },
  {
    id: "deepseek-v4-pro",
    label: "V4 Pro",
    description: "Flagship model",
    thinking: true,
  },
  {
    id: "deepseek-chat",
    label: "Chat",
    description: "General-purpose (deprecating 2026-07-24)",
  },
  {
    id: "deepseek-reasoner",
    label: "Reasoner",
    description: "Chain-of-thought reasoning (deprecating 2026-07-24)",
    thinking: true,
  },
];

export const DEFAULT_MODEL = "auto";

export const MODEL_IDS = MODELS.map((m) => m.id);

export function findModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export const BASE_URL = "https://api.deepseek.com";

// Reasoning models expose their chain-of-thought in `reasoning_content`.
export function isReasoningModel(id: string): boolean {
  if (id === "auto") return false; // resolved per-prompt by resolveAutoModel
  return findModel(id)?.thinking === true;
}

// ---- Auto model selection ----

/** Keywords that signal complex tasks → flagship model with reasoning. */
const COMPLEX_KW = [
  "实现", "修复", "重构", "编译", "构建", "架构", "设计", "优化", "分析",
  "重写", "创建", "添加", "修改", "提交", "调试", "部署", "迁移", "编写", "开发",
  "implement", "fix", "refactor", "build", "compile", "design", "optimize",
  "analyze", "rewrite", "create", "add", "modify", "commit", "debug", "deploy",
  "migrate", "architect", "write", "develop", "integrate", "test",
];

/** Keywords that signal simple/exploration tasks → fast lightweight model. */
const SIMPLE_KW = [
  "列出", "查看", "读取", "搜索", "查找", "什么", "哪个", "怎么", "解释", "总结",
  "list", "view", "read", "search", "find", "what", "which", "how", "explain",
  "summarize", "show", "tell", "status", "grep", "glob", "ls", "cat",
];

/**
 * Resolve the "auto" model to a concrete model ID + reasoning flag based on
 * the user's prompt. Simple/exploration tasks use the fast flash model;
 * complex tasks (coding, debugging, architecture) use the flagship pro model
 * with reasoning enabled. Ambiguous prompts default to pro without reasoning.
 */
export function resolveAutoModel(prompt: string): { model: string; reasoning: boolean } {
  const lower = prompt.toLowerCase();
  const isComplex = COMPLEX_KW.some((kw) => lower.includes(kw));
  const isSimple = SIMPLE_KW.some((kw) => lower.includes(kw));

  if (isComplex && !isSimple) {
    return { model: "deepseek-v4-pro", reasoning: true };
  }
  if (isSimple && !isComplex) {
    return { model: "deepseek-v4-flash", reasoning: false };
  }
  return { model: "deepseek-v4-pro", reasoning: false };
}
