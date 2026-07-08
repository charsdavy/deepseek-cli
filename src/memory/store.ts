// Long-term memory system — cross-session knowledge persistence.
// Inspired by codex's layered memory (MEMORY.md, rollout_summaries, memory_summary.md).
//
// Architecture:
//   1. Session summaries: on session end, a flash-model call generates a
//      compact summary of key decisions and findings.
//   2. MEMORY.md: a structured long-term memory file containing:
//      - Key project knowledge (conventions, patterns, gotchas)
//      - Session summaries (recent, with expiration)
//      - Active context (what's currently being worked on)
//   3. Memory lifecycle: old summaries expire after 7 days; the memory is
//      loaded at session start and injected as project context.
//
// File layout (in ~/.deepseek-cli/):
//   memories/                    ← directory
//     <project-hash>/            ← per-project subdir (hash of cwd)
//       MEMORY.md                ← long-term structured memory
//       sessions/                ← per-session summaries
//         <session-id>.summary.md

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as crypto from "node:crypto";
import { CONFIG_DIR } from "../config/config.ts";
import type { ChatMessage } from "../api/client.ts";
import { log } from "../log/logger.ts";

const MEMORY_DIR = path.join(CONFIG_DIR, "memories");
const MAX_SESSION_SUMMARIES = 20;
const SESSION_SUMMARY_MAX_TOKENS = 800;
const MEMORY_MAX_CHARS = 24_000;

function projectHash(cwd: string): string {
  return crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

function projectMemoryDir(cwd: string): string {
  return path.join(MEMORY_DIR, projectHash(cwd));
}

function projectMemoryFile(cwd: string): string {
  return path.join(projectMemoryDir(cwd), "MEMORY.md");
}

function sessionSummariesDir(cwd: string): string {
  return path.join(projectMemoryDir(cwd), "sessions");
}

/** Generate a session summary via the flash model. */
export async function generateSessionSummary(
  apiKey: string,
  messages: ChatMessage[],
  cwd: string,
  baseUrl?: string,
  maxTokens = SESSION_SUMMARY_MAX_TOKENS,
): Promise<string | null> {
  const userMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (userMessages.length < 2) return null;

  const conversationText = userMessages
    .slice(-20)
    .map((m) => {
      const role = m.role;
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content.slice(0, 2000)}`;
    })
    .join("\n\n");

  const prompt = `## Session Summary
Summarize this coding session for long-term memory. Focus on what knowledge should persist across sessions. Include:

1. **Project context** — key files, conventions, gotchas discovered
2. **Decisions made** — architectural/design choices and rationale
3. **Work done** — what was completed (not step-by-step, just outcomes)
4. **Unfinished work** — what's in flight and needs continuation
5. **Key learnings** — bugs found, patterns identified, constraints

Project: ${cwd}
Format as bullet points. Be concise (~200 words).

${conversationText}

## Summary:`;

  try {
    const res = await fetch(`${baseUrl ?? "https://api.deepseek.com"}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      log.warn("memory summary api error", { status: res.status });
      return null;
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary || summary.length < 10) return null;

    log.info("memory summary generated", { cwd, len: summary.length });
    return summary;
  } catch (e) {
    log.warn("memory summary failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Persist a session summary to the memory store. */
export async function persistSessionSummary(
  sessionId: string,
  summary: string,
  cwd: string,
): Promise<void> {
  const dir = sessionSummariesDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.summary.md`);
  const content = [
    `# Session ${sessionId}`,
    `Date: ${new Date().toISOString()}`,
    "",
    summary,
  ].join("\n");
  await fs.writeFile(file, content, "utf-8");

  // Prune old summaries.
  await pruneSessionSummaries(cwd, MAX_SESSION_SUMMARIES);

  // Rebuild MEMORY.md with fresh summaries.
  await rebuildMemoryFile(cwd);
}

/** Load the aggregated memory context for a project. */
export async function loadMemoryContext(cwd: string): Promise<string | null> {
  const file = projectMemoryFile(cwd);
  if (!existsSync(file)) return null;
  try {
    const content = await fs.readFile(file, "utf-8");
    if (content.trim().length === 0) return null;
    return content.slice(0, MEMORY_MAX_CHARS);
  } catch {
    return null;
  }
}

/** Update a specific section in MEMORY.md programmatically. */
export async function updateMemorySection(
  cwd: string,
  section: string,
  content: string,
): Promise<void> {
  const file = projectMemoryFile(cwd);
  let existing = "";
  if (existsSync(file)) {
    try {
      existing = await fs.readFile(file, "utf-8");
    } catch { /* start fresh */ }
  }
  const marker = `## ${section}`;
  const nextMarker = "\n## ";
  const idx = existing.indexOf(marker);
  let newContent: string;
  if (idx >= 0) {
    const endIdx = existing.indexOf(nextMarker, idx + marker.length);
    const before = existing.slice(0, idx + marker.length + 1);
    const after = endIdx >= 0 ? existing.slice(endIdx) : "";
    newContent = before + content.trim() + "\n" + after;
  } else {
    const header = existing
      ? existing.trimEnd() + "\n\n"
      : `# Memory for ${path.basename(cwd)}\n\n`;
    newContent = header + `## ${section}\n${content.trim()}\n`;
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, newContent, "utf-8");
}

async function rebuildMemoryFile(cwd: string): Promise<void> {
  const dir = sessionSummariesDir(cwd);
  if (!existsSync(dir)) return;

  const files = await fs.readdir(dir);
  const summaries: { file: string; date: string; content: string }[] = [];
  for (const f of files) {
    if (!f.endsWith(".summary.md")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf-8");
      const dateLine = raw.split("\n").find((l) => l.startsWith("Date:"));
      const date = dateLine ? dateLine.replace("Date:", "").trim() : "";
      const body = raw.split("\n").slice(2).join("\n").trim();
      if (body) summaries.push({ file: f, date, content: body });
    } catch { /* skip */ }
  }

  summaries.sort((a, b) => b.date.localeCompare(a.date));
  const recent = summaries.slice(0, 10);
  const recentBlock = recent
    .map((s, i) => `### Session ${i + 1} (${s.date.slice(0, 10)})\n${s.content}`)
    .join("\n\n");

  const header = `# Memory for ${path.basename(cwd)}\nLast updated: ${new Date().toISOString()}\n`;
  const content = `${header}## Recent Sessions\n${recentBlock || "(no recent sessions)"}\n`;

  const file = projectMemoryFile(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf-8");
}

async function pruneSessionSummaries(cwd: string, maxCount: number): Promise<void> {
  const dir = sessionSummariesDir(cwd);
  if (!existsSync(dir)) return;
  const files = await fs.readdir(dir);
  if (files.length <= maxCount) return;

  const meta: { file: string; mtime: number }[] = [];
  for (const f of files) {
    if (!f.endsWith(".summary.md")) continue;
    try {
      const st = await fs.stat(path.join(dir, f));
      meta.push({ file: f, mtime: st.mtimeMs });
    } catch { /* skip */ }
  }

  const toDelete = meta
    .sort((a, b) => a.mtime - b.mtime)
    .slice(0, meta.length - maxCount);
  for (const m of toDelete) {
    await fs.unlink(path.join(dir, m.file)).catch(() => {});
  }
}
