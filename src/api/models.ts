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

export const DEFAULT_MODEL = "deepseek-v4-flash";

export const MODEL_IDS = MODELS.map((m) => m.id);

export function findModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export const BASE_URL = "https://api.deepseek.com";

// Reasoning models expose their chain-of-thought in `reasoning_content`.
export function isReasoningModel(id: string): boolean {
  return findModel(id)?.thinking === true;
}
