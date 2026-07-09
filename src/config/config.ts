// Configuration: layered global config + project-level instructions.
// Config resolution order: env vars > CLI flags > project config > global config > defaults.
// Inspired by codex's MDM → System → Enterprise → User → Project → SessionFlags layering.

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
export const PROJECT_CONFIG_DIR = ".deepseek";
export const PROJECT_CONFIG_FILE = path.join(PROJECT_CONFIG_DIR, "config.json");

/**
 * Resolve the session storage directory. Honors DEEPSEEK_SESSION_DIR so tests
 * (and power users) can point it at an isolated tmp dir without touching the
 * real ~/.deepseek-cli/sessions.
 */
export function sessionDir(): string {
  return process.env.DEEPSEEK_SESSION_DIR ?? SESSION_DIR;
}

export interface CliConfig {
  apiKey?: string;
  defaultModel?: string;
  approvalMode?: "ask" | "auto" | "yolo" | "deny-pure-shell";
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  reasoning?: boolean;
  reasoningEffort?: "high" | "max";
  maxContext?: number;
  promptLog?: boolean;
  /** Prompt variant ("v2" default, "v3" experimental). */
  promptVariant?: string;
  /** Enable LLM-driven context compaction (default true). */
  compaction?: boolean;
  /** Enable long-term memory generation (default true). */
  memoryGeneration?: boolean;
  /** Workspace restriction mode. */
  workspaceMode?: "off" | "workspace" | "readonly";
  /** Use JSONL persistence (append-only, faster writes). */
  jsonlPersistence?: boolean;
  /** Enable hook system. */
  hooks?: boolean;
  /** Token usage display after each turn. */
  showTokenUsage?: boolean;
}

export const DEFAULT_CONFIG: CliConfig = {
  defaultModel: "deepseek-chat",
  approvalMode: "auto",
  temperature: 0.7,
  promptLog: true,
};

export async function ensureDirs(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.mkdir(SESSION_DIR, { recursive: true });
}

export async function loadConfig(cwd?: string): Promise<CliConfig> {
  // Env var takes precedence for API key
  const envKey = process.env.DEEPSEEK_API_KEY;
  const envBase = process.env.DEEPSEEK_BASE_URL;
  const envModel = process.env.DEEPSEEK_MODEL;

  let file: CliConfig = { ...DEFAULT_CONFIG };
  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = await fs.readFile(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      file = { ...file, ...normalizeConfig(parsed) };
      // Back-compat: legacy Python CLI stored the key as `api_key` (snake_case)
      if (!file.apiKey && typeof parsed.api_key === "string") {
        file.apiKey = parsed.api_key;
      }
    } catch (e) {
      printSystem(`Config file at ${CONFIG_FILE} is corrupted; ignoring.`, "yellow");
      void e;
    }
  }

  // Project-level config (overrides global, under env/cli).
  if (cwd) {
    file = { ...file, ...(await loadProjectConfig(cwd)) };
  }

  const merged: CliConfig = { ...file };
  if (envKey) merged.apiKey = envKey;
  if (envBase) merged.baseUrl = envBase;
  if (envModel) merged.defaultModel = envModel;
  return merged;
}

/**
 * Load project-level config from .deepseek/config.json.
 * Walks up from cwd to find the nearest .deepseek/config.json.
 */
export async function loadProjectConfig(cwd: string): Promise<Partial<CliConfig>> {
  const projectFile = path.join(cwd, PROJECT_CONFIG_FILE);
  if (!existsSync(projectFile)) return {};
  try {
    const raw = await fs.readFile(projectFile, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cfg = normalizeConfig(parsed);
    if (Object.keys(cfg).length > 0) {
      logConfig(`project config loaded from ${projectFile}`);
    }
    return cfg;
  } catch (e) {
    printSystem(`Project config at ${projectFile} is corrupted; ignoring.`, "yellow");
    void e;
    return {};
  }
}

function logConfig(msg: string): void {
  // Lazy import to avoid circular deps.
  try {
    const { log } = require("../log/logger.ts");
    log.info("config", { msg });
  } catch {
    /* logger not available yet */
  }
}

/**
 * Validate + coerce the raw config object. Unknown or malformed fields are
 * dropped (with a one-line warning) so a corrupted file can't silently feed
 * bad values into the API client or agent loop.
 */
function normalizeConfig(raw: Record<string, unknown>): Partial<CliConfig> {
  const out: Partial<CliConfig> = {};
  const dropped: string[] = [];

  if (typeof raw.apiKey === "string") out.apiKey = raw.apiKey;
  else if (raw.apiKey !== undefined) dropped.push("apiKey");

  if (typeof raw.defaultModel === "string" && raw.defaultModel.length > 0) {
    out.defaultModel = raw.defaultModel;
  } else if (raw.defaultModel !== undefined) dropped.push("defaultModel");

  if (typeof raw.temperature === "number" && Number.isFinite(raw.temperature)) {
    // Clamp to a sane sampling range.
    out.temperature = Math.max(0, Math.min(2, raw.temperature));
  } else if (raw.temperature !== undefined) dropped.push("temperature");

  if (typeof raw.maxTokens === "number" && Number.isInteger(raw.maxTokens) && raw.maxTokens > 0) {
    out.maxTokens = raw.maxTokens;
  } else if (raw.maxTokens !== undefined) dropped.push("maxTokens");

  if (typeof raw.baseUrl === "string" && /^https?:\/\//i.test(raw.baseUrl)) {
    out.baseUrl = raw.baseUrl;
  } else if (raw.baseUrl !== undefined) dropped.push("baseUrl");

  if (typeof raw.approvalMode === "string") {
    const v = raw.approvalMode;
    if (v === "ask" || v === "auto" || v === "yolo" || v === "deny-pure-shell") {
      out.approvalMode = v as CliConfig["approvalMode"];
    } else {
      dropped.push("approvalMode");
    }
  } else if (raw.approvalMode !== undefined) dropped.push("approvalMode");

  if (typeof raw.reasoning === "boolean") {
    out.reasoning = raw.reasoning;
  } else if (raw.reasoning !== undefined) dropped.push("reasoning");

  if (typeof raw.reasoningEffort === "string") {
    const v = raw.reasoningEffort;
    if (v === "high" || v === "max") {
      out.reasoningEffort = v as "high" | "max";
    } else {
      dropped.push("reasoningEffort");
    }
  } else if (raw.reasoningEffort !== undefined) dropped.push("reasoningEffort");

  if (typeof raw.maxContext === "number" && Number.isInteger(raw.maxContext) && raw.maxContext >= 4000) {
    out.maxContext = raw.maxContext;
  } else if (raw.maxContext !== undefined) dropped.push("maxContext");

  if (typeof raw.promptLog === "boolean") {
    out.promptLog = raw.promptLog;
  } else if (raw.promptLog !== undefined) dropped.push("promptLog");

  if (typeof raw.promptVariant === "string" && raw.promptVariant.length > 0) {
    out.promptVariant = raw.promptVariant;
  } else if (raw.promptVariant !== undefined) dropped.push("promptVariant");

  if (typeof raw.compaction === "boolean") {
    out.compaction = raw.compaction;
  } else if (raw.compaction !== undefined) dropped.push("compaction");

  if (typeof raw.memoryGeneration === "boolean") {
    out.memoryGeneration = raw.memoryGeneration;
  } else if (raw.memoryGeneration !== undefined) dropped.push("memoryGeneration");

  if (typeof raw.workspaceMode === "string") {
    const v = raw.workspaceMode;
    if (v === "off" || v === "workspace" || v === "readonly") {
      out.workspaceMode = v;
    } else {
      dropped.push("workspaceMode");
    }
  } else if (raw.workspaceMode !== undefined) dropped.push("workspaceMode");

  if (typeof raw.jsonlPersistence === "boolean") {
    out.jsonlPersistence = raw.jsonlPersistence;
  } else if (raw.jsonlPersistence !== undefined) dropped.push("jsonlPersistence");

  if (typeof raw.hooks === "boolean") {
    out.hooks = raw.hooks;
  } else if (raw.hooks !== undefined) dropped.push("hooks");

  if (typeof raw.showTokenUsage === "boolean") {
    out.showTokenUsage = raw.showTokenUsage;
  } else if (raw.showTokenUsage !== undefined) dropped.push("showTokenUsage");

  if (dropped.length > 0) {
    printSystem(`Config: ignoring invalid field(s): ${dropped.join(", ")}`, "yellow");
  }
  return out;
}

export async function saveConfig(cfg: CliConfig): Promise<void> {
  await ensureDirs();
  const safe: CliConfig = { ...cfg };
  const tmp = `${CONFIG_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(safe, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, CONFIG_FILE);
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
