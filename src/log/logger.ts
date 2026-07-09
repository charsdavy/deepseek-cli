// Lightweight file logger for troubleshooting. Writes JSON lines to
// ~/.deepseek-cli/logs/deepseek-YYYY-MM-DD.log (daily rotation, 7-day
// retention, 5MB size cap per day). Sensitive data is redacted before write:
//   • secret-named fields (apiKey/token/secret/password/Authorization/…) → "***"
//   • embedded API keys (sk-/ghp_/gho_/xox[pb]-) → first 3 + "***" + last 2
//
// Logging never goes to stdout (that's the UI's job) — only the log file, so a
// user can `tail -f` it or attach it to a bug report safely.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { CONFIG_DIR } from "../config/config.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const RETENTION_DAYS = 7;

const SECRET_KEYWORDS = ["key", "token", "secret", "password", "authorization", "passwd", "cred", "apikey"];

function isSecretKey(k: string): boolean {
  const lower = k.toLowerCase();
  return SECRET_KEYWORDS.some((kw) => lower.includes(kw));
}

const EMBEDDED_KEY_RE = /(sk-[A-Za-z0-9]{8,}|gh[po]_[A-Za-z0-9]{8,}|xox[bp]-[A-Za-z0-9]{8,})/g;

function redactString(s: string): string {
  return s.replace(EMBEDDED_KEY_RE, (m) => `${m.slice(0, 3)}***${m.slice(-2)}`);
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? "***" : redactDeep(v);
    }
    return out;
  }
  return value;
}

export function redact(value: unknown): string {
  // For preview strings: redact embedded keys but keep the value a string.
  if (typeof value === "string") return redactString(value);
  try {
    return JSON.stringify(redactDeep(value));
  } catch {
    return redactString(String(value));
  }
}

export class Logger {
  private dir: string;
  private level: LogLevel = "info";
  private enabled = true;
  private writeQueue: Promise<void> = Promise.resolve();
  private currentFile = "";

  constructor(dir?: string) {
    this.dir = dir ?? process.env.DEEPSEEK_LOG_DIR ?? path.join(CONFIG_DIR, "logs");
  }

  init(level: LogLevel = "info", enabled = true): void {
    this.level = level;
    this.enabled = enabled;
    if (!enabled) return;
    // Best-effort setup + retention; failures are silent (logging must never
    // crash the app).
    fs.mkdir(this.dir, { recursive: true }).then(() => {
      this.currentFile = this.dayFile();
      this.pruneOld().catch(() => {});
    }).catch(() => {});
  }

  get minLevel(): number {
    return LEVEL_ORDER[this.level];
  }

  private dayFile(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return path.join(this.dir, `deepseek-${stamp}.log`);
  }

  private async pruneOld(): Promise<void> {
    if (!existsSync(this.dir)) return;
    const files = await fs.readdir(this.dir).catch(() => [] as string[]);
    const now = Date.now();
    const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of files) {
      if (!f.startsWith("deepseek-") || !f.endsWith(".log")) continue;
      const full = path.join(this.dir, f);
      try {
        const st = await fs.stat(full);
        if (st.mtimeMs < cutoff) await fs.unlink(full).catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (!this.enabled || LEVEL_ORDER[level] < this.minLevel) return;
    const fieldsRedacted = redactDeep(fields ?? {}) as Record<string, unknown>;
    const msgRedacted = redactString(msg);
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: msgRedacted, ...fieldsRedacted });
    // Serialize appends so order is preserved and a crash mid-write is bounded.
    this.writeQueue = this.writeQueue
      .then(async () => {
        const file = this.dayFile();
        this.currentFile = file;
        try {
          // Size cap: if the day's file is huge, roll to .1 and start fresh.
          if (existsSync(file)) {
            const st = await fs.stat(file);
            if (st.size > MAX_FILE_BYTES) {
              await fs.rename(file, file.replace(/\.log$/, ".1.log")).catch(() => {});
            }
          }
          await fs.appendFile(file, line + "\n", "utf-8");
        } catch {
          /* logging never throws */
        }
      })
      .catch(() => {});
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.write("debug", msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.write("info", msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.write("warn", msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.write("error", msg, fields); }

  /** Current log file path (for /log or diagnostics display). */
  get filePath(): string {
    return this.currentFile || this.dayFile();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

export const log = new Logger();
export { redact as redactForLog };
