// JSONL session persistence: faster append-only write format for sessions.
// Compared to the full JSON file rewrite, JSONL appends each turn as a single
// line, avoiding the O(n) serialization cost on every save.
//
// Format (one line per entry):
//   {"type":"meta","id":"20260709-123456-abcd","model":"deepseek-chat",...}
//   {"type":"system","content":"You are..."}
//   {"type":"user","content":"..."}
//   {"type":"assistant","content":"...","tool_calls":[...]}
//   {"type":"tool","tool_call_id":"...","content":"..."}
//
// On load, lines are replayed to reconstruct the full conversation.
// On save, only new messages since the last save are appended.

import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import { sessionDir } from "../config/config.ts";
import type { ChatMessage } from "../api/client.ts";
import type { Session } from "./store.ts";
import { log } from "../log/logger.ts";

// ---- Write (append-only) ----

export interface JsonlEntry {
  type: "meta" | "message";
  // Meta fields.
  id?: string;
  model?: string;
  cwd?: string;
  createdAt?: string;
  promptVariant?: string;
  // Message fields.
  message?: ChatMessage;
}

export async function appendToJsonl(
  sessionId: string,
  entries: JsonlEntry[],
): Promise<void> {
  const dir = sessionDir();
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.session.jsonl`);
  const lines = entries.map((e) => JSON.stringify(e) + "\n").join("");
  await fsp.appendFile(filePath, lines, "utf-8");
}

/**
 * Incremental save: only writes new messages since last checkpoint.
 */
export async function saveNewMessages(
  sessionId: string,
  messages: ChatMessage[],
  lastSavedCount: number,
  meta?: { model: string; cwd: string; promptVariant?: string },
): Promise<number> {
  const newMessages = messages.slice(lastSavedCount);
  if (newMessages.length === 0) return lastSavedCount;

  const entries: JsonlEntry[] = [];
  // Write meta on first save.
  if (lastSavedCount === 0 && meta) {
    entries.push({
      type: "meta",
      id: sessionId,
      model: meta.model,
      cwd: meta.cwd,
      createdAt: new Date().toISOString(),
      promptVariant: meta.promptVariant,
    });
  }
  for (const msg of newMessages) {
    entries.push({ type: "message", message: msg });
  }
  await appendToJsonl(sessionId, entries);
  return messages.length;
}

// ---- Read (full replay) ----

export async function loadJsonlSession(id: string): Promise<Session | null> {
  const filePath = path.join(sessionDir(), `${id}.session.jsonl`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const meta: Partial<Session> = { id, messages: [] };
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonlEntry;
        if (entry.type === "meta") {
          if (entry.id) meta.id = entry.id;
          if (entry.model) meta.model = entry.model;
          if (entry.cwd) meta.cwd = entry.cwd;
          if (entry.createdAt) meta.createdAt = entry.createdAt;
          if (entry.promptVariant) meta.promptVariant = entry.promptVariant;
        } else if (entry.type === "message" && entry.message) {
          meta.messages!.push(entry.message);
        }
      } catch {
        // Skip corrupt lines.
      }
    }
    if (!meta.model || meta.messages!.length === 0) return null;
    return {
      id: meta.id!,
      createdAt: meta.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: meta.model,
      messages: meta.messages!,
      cwd: meta.cwd ?? process.cwd(),
      promptVariant: meta.promptVariant,
    };
  } catch (e) {
    log.warn("jsonl: load failed", { id, error: String(e) });
    return null;
  }
}

/**
 * Try JSONL first, then fall back to JSON.
 */
export async function loadSessionWithFallback(id: string): Promise<Session | null> {
  const jsonlSession = await loadJsonlSession(id);
  if (jsonlSession) return jsonlSession;
  const { loadSession } = await import("./store.ts");
  return loadSession(id);
}
