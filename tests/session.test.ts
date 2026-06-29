import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import { saveSession, loadSession, listSessions, deleteSession, newSession } from "../src/session/store.ts";

const ORIG_DIR = process.env.DEEPSEEK_SESSION_DIR;
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-session-test-"));
  process.env.DEEPSEEK_SESSION_DIR = tmp;
});

afterEach(async () => {
  if (ORIG_DIR === undefined) delete process.env.DEEPSEEK_SESSION_DIR;
  else process.env.DEEPSEEK_SESSION_DIR = ORIG_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("session store", () => {
  it("round-trips a session via save + load", async () => {
    const s = newSession("deepseek-chat", "sys", "/repo");
    s.messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    await saveSession(s);
    const loaded = await loadSession(s.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.model).toBe("deepseek-chat");
    expect(loaded?.cwd).toBe("/repo");
    expect(loaded?.messages.length).toBe(2);
    expect(loaded?.messages[1].content).toBe("hi");
  });

  it("returns null for a missing session", async () => {
    const loaded = await loadSession("does-not-exist-12345");
    expect(loaded).toBeNull();
  });

  it("lists saved sessions sorted by updatedAt desc", async () => {
    const a = newSession("deepseek-chat", undefined, "/a");
    const b = newSession("deepseek-chat", undefined, "/b");
    a.updatedAt = "2025-01-01T00:00:00.000Z";
    b.updatedAt = "2025-06-01T00:00:00.000Z";
    await saveSession(a);
    await saveSession(b);
    const list = await listSessions(10);
    expect(list.length).toBe(2);
    // b is newer → first.
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });

  it("listSessions returns [] when the dir does not exist", async () => {
    process.env.DEEPSEEK_SESSION_DIR = path.join(tmp, "nope");
    const list = await listSessions();
    expect(list).toEqual([]);
  });

  it("deleteSession removes the file and returns true; false if absent", async () => {
    const s = newSession("deepseek-chat", undefined, "/x");
    await saveSession(s);
    expect(existsSync(path.join(tmp, `${s.id}.session.json`))).toBe(true);
    const ok = await deleteSession(s.id);
    expect(ok).toBe(true);
    expect(existsSync(path.join(tmp, `${s.id}.session.json`))).toBe(false);
    const again = await deleteSession(s.id);
    expect(again).toBe(false);
  });

  it("persists tokenUsage across save/load", async () => {
    const s = newSession("deepseek-chat", undefined, "/t");
    s.tokenUsage = { prompt: 10, completion: 5, total: 15, turns: 1 };
    await saveSession(s);
    const loaded = await loadSession(s.id);
    expect(loaded?.tokenUsage?.total).toBe(15);
    expect(loaded?.tokenUsage?.turns).toBe(1);
  });

  it("newSessionId has a random suffix to avoid same-second collisions", () => {
    // Re-imported indirectly via newSession; check the id shape.
    const a = newSession("m", undefined, "/");
    const b = newSession("m", undefined, "/");
    // Even when created in the same second, the suffix differs.
    expect(a.id).not.toBe(b.id);
    expect(a.id.includes("-")).toBe(true);
  });
});
