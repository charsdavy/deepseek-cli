// Per-turn prompt log — a lightweight, append-only JSONL record of each user
// prompt and its outcome, for retrospective prompt/system-prompt optimization.
//
// Distinct from the full Session store (which persists every message): this is
// a single cross-session index focused on prompt→outcome correlation. One line
// per turn, bounded in size, easy to grep/analyze.
//
// Stored at ~/.deepseek-cli/prompt-log.jsonl. Honors DEEPSEEK_PROMPT_LOG_FILE
// so tests can isolate the file. Disabled when config.promptLog === false or
// --no-prompt-log is passed; the caller checks before calling append.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { CONFIG_DIR } from "../config/config.ts";

const MAX_ENTRIES = 2000;
const PROMPT_TEXT_CAP = 8000;

export const PROMPT_LOG_FILE = path.join(CONFIG_DIR, "prompt-log.jsonl");

let writeQueue: Promise<void> = Promise.resolve();

export function promptLogFile(): string {
  return process.env.DEEPSEEK_PROMPT_LOG_FILE ?? PROMPT_LOG_FILE;
}

export interface PromptLogEntry {
  /** Owning session id (load the full transcript via the session store). */
  sessionId: string;
  /** Turn index within the session (1-based). */
  turn: number;
  /** ISO timestamp when the turn was recorded. */
  ts: string;
  /** The user's prompt text (capped to PROMPT_TEXT_CAP). */
  prompt: string;
  /** Model used for this turn. */
  model: string;
  /** System-prompt variant tag (from builder.ts). */
  promptVariant?: string;
  /** Whether reasoning/thinking was enabled. */
  reasoning?: boolean;
  /** Thinking intensity. */
  reasoningEffort?: "high" | "max";
  /** Number of agent-loop iterations the turn took. */
  iterations: number;
  /** Count of tool calls executed during the turn. */
  toolCalls: number;
  /** Unique tool names invoked (capped). */
  tools: string[];
  /** Real token usage reported by the API for the turn. */
  usage?: {
    prompt: number;
    completion: number;
    total: number;
  };
  /** Length of the assistant's final text. */
  finalTextLen: number;
  /** True if the turn was aborted by the user. */
  aborted?: boolean;
  /** Turn wall-clock duration in ms. */
  durationMs: number;
}

export function buildEntry(init: {
  sessionId: string;
  turn: number;
  prompt: string;
  model: string;
  promptVariant?: string;
  reasoning?: boolean;
  reasoningEffort?: "high" | "max";
  iterations: number;
  toolCalls: number;
  tools: string[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  finalTextLen: number;
  aborted?: boolean;
  durationMs: number;
}): PromptLogEntry {
  return {
    sessionId: init.sessionId,
    turn: init.turn,
    ts: new Date().toISOString(),
    prompt: init.prompt.length > PROMPT_TEXT_CAP
      ? init.prompt.slice(0, PROMPT_TEXT_CAP - 1) + "…"
      : init.prompt,
    model: init.model,
    promptVariant: init.promptVariant,
    reasoning: init.reasoning,
    reasoningEffort: init.reasoningEffort,
    iterations: init.iterations,
    toolCalls: init.toolCalls,
    tools: init.tools.slice(0, 32),
    usage: init.usage && (init.usage.promptTokens || init.usage.completionTokens || init.usage.totalTokens)
      ? {
          prompt: init.usage.promptTokens ?? 0,
          completion: init.usage.completionTokens ?? 0,
          total: init.usage.totalTokens ?? 0,
        }
      : undefined,
    finalTextLen: init.finalTextLen,
    aborted: init.aborted,
    durationMs: init.durationMs,
  };
}

/** Append a single entry. Best-effort: failures are swallowed. Serialized via a write queue to prevent prune/append races. */
export async function appendPromptLog(entry: PromptLogEntry): Promise<void> {
  const f = promptLogFile();
  writeQueue = writeQueue
    .then(async () => {
      try {
        await fs.mkdir(path.dirname(f), { recursive: true });
        await fs.appendFile(f, JSON.stringify(entry) + "\n", "utf-8");
        await prunePromptLog(MAX_ENTRIES);
      } catch {
        /* logging never throws */
      }
    })
    .catch(() => {});
  return writeQueue;
}

/** Load recent entries (newest-first). Returns [] if the file is absent. */
export async function loadPromptLog(limit = 30): Promise<PromptLogEntry[]> {
  const f = promptLogFile();
  if (!existsSync(f)) return [];
  try {
    const data = await fs.readFile(f, "utf-8");
    const lines = data.split("\n").filter((l) => l.length > 0);
    const entries: PromptLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as PromptLogEntry);
      } catch {
        /* skip broken line */
      }
    }
    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}

/** Search entries for a keyword (case-insensitive) across the prompt text. */
export async function searchPromptLog(query: string, limit = 30): Promise<PromptLogEntry[]> {
  const needle = query.toLowerCase();
  if (!needle) return loadPromptLog(limit);
  const f = promptLogFile();
  if (!existsSync(f)) return [];
  try {
    const data = await fs.readFile(f, "utf-8");
    const lines = data.split("\n").filter((l) => l.length > 0);
    const hits: PromptLogEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as PromptLogEntry;
        if (e.prompt.toLowerCase().includes(needle)) hits.push(e);
      } catch {
        /* skip */
      }
    }
    return hits.slice(-limit).reverse();
  } catch {
    return [];
  }
}

/** Count entries in the log file (without loading all into memory). */
export async function countPromptLog(): Promise<number> {
  const f = promptLogFile();
  if (!existsSync(f)) return 0;
  try {
    const data = await fs.readFile(f, "utf-8");
    return data.split("\n").filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

/** Wipe the prompt log file. */
export async function clearPromptLog(): Promise<void> {
  const f = promptLogFile();
  if (!existsSync(f)) return;
  await fs.writeFile(f, "", "utf-8");
}

/**
 * Prune old entries to bound disk usage. Keeps the most recent `maxCount`
 * JSONL lines. Called opportunistically on append.
 */
export async function prunePromptLog(maxCount = MAX_ENTRIES): Promise<number> {
  const f = promptLogFile();
  if (!existsSync(f)) return 0;
  try {
    const data = await fs.readFile(f, "utf-8");
    const lines = data.split("\n").filter((l) => l.length > 0);
    if (lines.length <= maxCount) return 0;
    const kept = lines.slice(-maxCount);
    await fs.writeFile(f, kept.join("\n") + "\n", "utf-8");
    return lines.length - kept.length;
  } catch {
    return 0;
  }
}
