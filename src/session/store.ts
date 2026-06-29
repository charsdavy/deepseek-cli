// Session store — persist conversations to ~/.deepseek-cli/sessions/.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { SESSION_DIR } from "../config/config.ts";
import type { ChatMessage } from "../api/client.ts";

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  cwd: string;
  /** Version of the assembled system prompt — useful for regression analysis. */
  promptVariant?: string;
  /** Cumulative real token usage reported by the API across turns. */
  tokenUsage?: {
    prompt: number;
    completion: number;
    total: number;
    turns: number;
  };
}

function sessionPath(id: string): string {
  return path.join(SESSION_DIR, `${id}.session.json`);
}

export async function saveSession(session: Session): Promise<void> {
  session.updatedAt = new Date().toISOString();
  await fs.mkdir(SESSION_DIR, { recursive: true });
  await fs.writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), "utf-8");
}

export async function loadSession(id: string): Promise<Session | null> {
  const p = sessionPath(id);
  if (!existsSync(p)) return null;
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export async function listSessions(limit = 30): Promise<Session[]> {
  if (!existsSync(SESSION_DIR)) return [];
  const files = await fs.readdir(SESSION_DIR);
  const sessions: Session[] = [];
  for (const f of files) {
    if (!f.endsWith(".session.json")) continue;
    try {
      const raw = await fs.readFile(path.join(SESSION_DIR, f), "utf-8");
      sessions.push(JSON.parse(raw) as Session);
    } catch {
      /* skip broken */
    }
  }
  return sessions
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, limit);
}

export async function deleteSession(id: string): Promise<boolean> {
  const p = sessionPath(id);
  if (!existsSync(p)) return false;
  await fs.unlink(p);
  return true;
}

export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  // Append a short random suffix so two sessions started in the same second
  // (e.g. concurrent one-shot invocations) never collide on disk.
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
}

export function newSession(model: string, systemPrompt?: string, cwd: string = process.cwd()): Session {
  const id = newSessionId();
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    model,
    systemPrompt,
    messages: [],
    cwd,
  };
}
