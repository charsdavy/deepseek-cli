// Session store — persist conversations to ~/.deepseek-cli/sessions/.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { sessionDir } from "../config/config.ts";
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
  return path.join(sessionDir(), `${id}.session.json`);
}

export async function saveSession(session: Session): Promise<void> {
  session.updatedAt = new Date().toISOString();
  await fs.mkdir(sessionDir(), { recursive: true });
  await fs.writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), "utf-8");
  // Opportunistic disk hygiene — prune oldest beyond the cap. Best-effort.
  pruneSessions(200).catch(() => {});
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
  const dir = sessionDir();
  if (!existsSync(dir)) return [];
  const files = await fs.readdir(dir);
  const sessions: Session[] = [];
  for (const f of files) {
    if (!f.endsWith(".session.json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf-8");
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

/**
 * Search saved sessions for a keyword (case-insensitive) across user/assistant
 * message content. Returns matches sorted by updatedAt desc.
 */
export async function searchSessions(query: string, limit = 30): Promise<Session[]> {
  const needle = query.toLowerCase();
  if (!needle) return listSessions(limit);
  const dir = sessionDir();
  if (!existsSync(dir)) return [];
  const files = await fs.readdir(dir);
  const hits: Session[] = [];
  for (const f of files) {
    if (!f.endsWith(".session.json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf-8");
      const s = JSON.parse(raw) as Session;
      const hay = s.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join(" ")
        .toLowerCase();
      if (hay.includes(needle)) hits.push(s);
    } catch {
      /* skip broken */
    }
  }
  return hits
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, limit);
}

/**
 * Prune old sessions to bound disk usage. Keeps the most recent `maxCount`
 * sessions and deletes the rest. Called opportunistically on save.
 */
export async function pruneSessions(maxCount = 200): Promise<number> {
  const dir = sessionDir();
  if (!existsSync(dir)) return 0;
  const files = await fs.readdir(dir);
  const meta: { file: string; mtime: number }[] = [];
  for (const f of files) {
    if (!f.endsWith(".session.json")) continue;
    try {
      const st = await fs.stat(path.join(dir, f));
      meta.push({ file: f, mtime: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
  if (meta.length <= maxCount) return 0;
  const toDelete = meta.sort((a, b) => a.mtime - b.mtime).slice(0, meta.length - maxCount);
  let removed = 0;
  for (const m of toDelete) {
    try {
      await fs.unlink(path.join(dir, m.file));
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
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
