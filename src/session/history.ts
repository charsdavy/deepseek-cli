// Prompt history — persisted to ~/.deepseek-cli/history so the REPL can recall
// previous prompts with Up/Down (via the readline interface's native history).
//
// File format: one prompt per line, oldest→newest (append order). In memory we
// keep newest-first because that's what readline's `rl.history` expects.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { CONFIG_DIR } from "../config/config.ts";

const MAX = 1000;

let historyQueue: Promise<void> = Promise.resolve();

export function historyFile(): string {
  return process.env.DEEPSEEK_HISTORY_FILE ?? path.join(CONFIG_DIR, "history");
}

/** Newest-first list of past prompts. */
export async function loadHistory(): Promise<string[]> {
  const f = historyFile();
  if (!existsSync(f)) return [];
  try {
    const data = await fs.readFile(f, "utf-8");
    const lines = data.split("\n");
    // Exclude a possible trailing empty line from the final newline.
    const real = lines.filter((l) => l.length > 0);
    return real.slice(-MAX).reverse();
  } catch {
    return [];
  }
}

/** Append a prompt; trim the file to the last MAX entries to bound size. Serialized to prevent concurrent append/trim races. */
export async function appendHistory(line: string): Promise<void> {
  if (!line) return;
  const f = historyFile();
  historyQueue = historyQueue
    .then(async () => {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.appendFile(f, line + "\n", "utf-8");
      try {
        const data = await fs.readFile(f, "utf-8");
        const lines = data.split("\n").filter((l) => l.length > 0);
        if (lines.length > MAX) {
          await fs.writeFile(f, lines.slice(-MAX).join("\n") + "\n", "utf-8");
        }
      } catch {
        /* ignore trim failure */
      }
    })
    .catch(() => {});
  return historyQueue;
}
