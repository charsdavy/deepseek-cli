// Sessions command — list and inspect persisted sessions.

import * as path from "node:path";
import { listSessions, deleteSession } from "../session/store.ts";
import { paint } from "../ui/theme.ts";
import { blank, printSystem, writeLine } from "../ui/render.ts";
import { askYesNo } from "../ui/input.ts";

export async function runSessionsCommand(): Promise<void> {
  const sessions = await listSessions(30);
  if (sessions.length === 0) {
    blank();
    printSystem("No saved sessions yet. They are saved automatically in interactive mode.", "yellow");
    blank();
    return;
  }
  blank();
  writeLine(paint.bold("Saved sessions:"));
  for (const s of sessions) {
    writeLine(
      `  ${paint.cyan(s.id)}  ${paint.gray(s.updatedAt)}  ${paint.gray("(" + (s.messages.length) + " msgs, " + s.model + ")")}  ${s.systemPrompt ? paint.gray("· " + truncate(s.systemPrompt, 40)) : ""}`,
    );
  }
  blank();
  if (await askYesNo("Delete a session?", false)) {
    const { askQuestion } = await import("../ui/input.ts");
    const id = (await askQuestion("Session id to delete: ")).trim();
    if (id) {
      const ok = await deleteSession(id);
      printSystem(ok ? `Deleted ${id}` : `Session ${id} not found`, ok ? "green" : "yellow");
    }
  }
  void path;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
