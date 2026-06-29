// Configuration: layered global config + project-level instructions.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { paint } from "../ui/theme.ts";
import { blank, printError, printSystem, writeLine } from "../ui/render.ts";
import { askYesNo, askHidden } from "../ui/input.ts";

export const CONFIG_DIR = path.join(os.homedir(), ".deepseek-cli");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const SESSION_DIR = path.join(CONFIG_DIR, "sessions");

export interface CliConfig {
  apiKey?: string;
  defaultModel?: string;
  approvalMode?: "ask" | "auto" | "deny-pure-shell";
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
}

export const DEFAULT_CONFIG: CliConfig = {
  defaultModel: "deepseek-chat",
  approvalMode: "ask",
  temperature: 0.7,
};

export async function ensureDirs(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.mkdir(SESSION_DIR, { recursive: true });
}

export async function loadConfig(): Promise<CliConfig> {
  // Env var takes precedence for API key
  const envKey = process.env.DEEPSEEK_API_KEY;
  const envBase = process.env.DEEPSEEK_BASE_URL;
  const envModel = process.env.DEEPSEEK_MODEL;

  let file: CliConfig = { ...DEFAULT_CONFIG };
  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = await fs.readFile(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      file = { ...DEFAULT_CONFIG, ...parsed };
      // Back-compat: legacy Python CLI stored the key as `api_key` (snake_case)
      if (!file.apiKey && typeof parsed.api_key === "string") {
        file.apiKey = parsed.api_key;
      }
    } catch (e) {
      printSystem(`Config file at ${CONFIG_FILE} is corrupted; ignoring.`, "yellow");
      void e;
    }
  }

  const merged: CliConfig = { ...file };
  if (envKey) merged.apiKey = envKey;
  if (envBase) merged.baseUrl = envBase;
  if (envModel) merged.defaultModel = envModel;
  return merged;
}

export async function saveConfig(cfg: CliConfig): Promise<void> {
  await ensureDirs();
  const safe: CliConfig = { ...cfg };
  await fs.writeFile(CONFIG_FILE, JSON.stringify(safe, null, 2), "utf-8");
  await fs.chmod(CONFIG_FILE, 0o600);
}

// ---- Auth ----

const DEEPSEEK_KEY_URL = "https://platform.deepseek.com/api_keys";

export async function getOrSetupApiKey(force = false, config?: CliConfig): Promise<string | null> {
  const cfg = config ?? (await loadConfig());
  if (!force && cfg.apiKey && cfg.apiKey.startsWith("sk-") && cfg.apiKey.length > 20) {
    return cfg.apiKey;
  }
  return await interactiveAuth(cfg);
}

async function openBrowserBestEffort(url: string): Promise<void> {
  try {
    const { exec } = await import("node:child_process");
    const platform = process.platform;
    const cmd = platform === "darwin"
      ? `open ${url}`
      : platform === "win32"
      ? `start ${url}`
      : `xdg-open ${url}`;
    exec(cmd, () => {});
  } catch {
    /* ignore */
  }
}

export async function interactiveAuth(current: CliConfig): Promise<string | null> {
  blank();
  printSystem(`${paint.bold("🔒 DeepSeek API Key configuration")}`, "magenta");
  printSystem("A DeepSeek API key is required. You can grab one from:", "blue");
  writeLine(`    ${paint.cyan(DEEPSEEK_KEY_URL)}`);
  blank();

  const openB = await askYesNo("Open the browser now?", true);
  if (openB) {
    await openBrowserBestEffort(DEEPSEEK_KEY_URL);
    printSystem("Waiting for you to grab the key…", "yellow");
  }

  while (true) {
    blank();
    const key = await askHidden("Paste your API key (input hidden):");
    if (!key) continue;
    if (!key.startsWith("sk-") || key.length <= 20) {
      printError("API key format looks wrong — DeepSeek keys usually start with 'sk-'. Try again.");
      continue;
    }
    current.apiKey = key;
    await saveConfig(current);
    blank();
    printSystem(`${paint.green("✓")} configuration saved to ${paint.gray(CONFIG_FILE)}`, "green");
    blank();
    return key;
  }
}
