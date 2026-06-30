import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { Logger, redactForLog } from "../src/log/logger.ts";

let tmp: string;
let logger: Logger;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-log-"));
  logger = new Logger(tmp);
  logger.init("debug", true);
});

afterEach(async () => {
  await logger.flush();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("redaction", () => {
  it("masks embedded sk- keys, keeping a short prefix/suffix", () => {
    const out = redactForLog("Authorization: sk-abcdef1234567890");
    expect(out).toContain("sk-***");
    expect(out).not.toContain("abcdef1234567890");
  });

  it("masks ghp_ tokens", () => {
    const out = redactForLog("token=ghp_xxxxxxxxxxxxxxxx");
    expect(out).toContain("***");
    expect(out).not.toContain("xxxxxxxxxxxxxxxx");
  });

  it("replaces secret-named fields with ***", () => {
    const out = redactForLog({ apiKey: "sk-secret", model: "v4-pro", env: { GITHUB_TOKEN: "ghp_yyy" } });
    // round-trips through JSON string
    const parsed = JSON.parse(out) as { apiKey: string; model: string; env: { GITHUB_TOKEN: string } };
    expect(parsed.apiKey).toBe("***");
    expect(parsed.model).toBe("v4-pro"); // non-secret preserved
    expect(parsed.env.GITHUB_TOKEN).toBe("***");
  });

  it("does not touch ordinary string content", () => {
    expect(redactForLog("just a normal message about tools")).toBe("just a normal message about tools");
  });
});

describe("Logger file output", () => {
  it("writes JSON lines to the day's file with the fields", async () => {
    logger.info("startup", { model: "deepseek-v4-pro", reasoning: true });
    await logger.flush();
    const files = await fs.readdir(tmp);
    const logFile = files.find((f) => f.endsWith(".log"));
    expect(logFile).toBeDefined();
    const data = await fs.readFile(path.join(tmp, logFile!), "utf-8");
    const entry = JSON.parse(data.trim()) as { msg: string; model: string; reasoning: boolean; level: string };
    expect(entry.msg).toBe("startup");
    expect(entry.model).toBe("deepseek-v4-pro");
    expect(entry.reasoning).toBe(true);
    expect(entry.level).toBe("info");
  });

  it("redacts secret fields when writing", async () => {
    logger.info("req", { apiKey: "sk-abcdef1234567890", url: "https://api.deepseek.com" });
    await logger.flush();
    const files = await fs.readdir(tmp);
    const logFile = files.find((f) => f.endsWith(".log"));
    const data = await fs.readFile(path.join(tmp, logFile!), "utf-8");
    expect(data).not.toContain("abcdef1234567890");
    expect(data).toContain("***");
  });

  it("respects log level (debug suppressed at info)", async () => {
    const l = new Logger(tmp);
    l.init("info", true);
    l.debug("noisy", { x: 1 });
    l.info("kept", { y: 2 });
    await l.flush();
    const files = await fs.readdir(tmp);
    const logFile = files.find((f) => f.endsWith(".log"))!;
    const data = await fs.readFile(path.join(tmp, logFile), "utf-8");
    expect(data).not.toContain("noisy");
    expect(data).toContain("kept");
  });
});
