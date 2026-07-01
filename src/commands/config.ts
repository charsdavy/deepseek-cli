// Config command — show the merged configuration (redacting the API key).

import { loadConfig } from "../config/config.ts";
import { paint } from "../ui/theme.ts";
import { blank, printBordered } from "../ui/render.ts";

export async function runConfigCommand(): Promise<void> {
  const cfg = await loadConfig();
  const safe = {
    defaultModel: cfg.defaultModel ?? "(unset)",
    approvalMode: cfg.approvalMode ?? "ask",
    temperature: cfg.temperature ?? 0.7,
    maxTokens: cfg.maxTokens ?? "(unset)",
    baseUrl: cfg.baseUrl ?? "https://api.deepseek.com",
    apiKey: cfg.apiKey ? redact(cfg.apiKey) : paint.gray("(unset) — run `deepseek auth`"),
    promptLog: cfg.promptLog === false ? paint.yellow("off") : paint.green("on"),
  };
  blank();
  const body = Object.entries(safe)
    .map(([k, v]) => `${paint.gray(pad(k) + ":")} ${v}`)
    .join("\n");
  printBordered("configuration", body, "cyan");
  blank();
}

function redact(s: string): string {
  if (s.length <= 8) return "sk-***";
  return s.slice(0, 5) + "…" + "•".repeat(8) + s.slice(-4);
}

function pad(k: string): string {
  return k.padEnd(13, " ");
}
