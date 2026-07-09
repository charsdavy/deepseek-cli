import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { parseFrontmatter, agentDirs, discoverAgents } from "../src/agent/agents.ts";

// ---- Frontmatter parser ----

describe("parseFrontmatter", () => {
  it("extracts model and tools from frontmatter", () => {
    const raw = `---
model: deepseek-v4-pro
tools: [read_file, grep, glob]
---
You are a code reviewer.`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.model).toBe("deepseek-v4-pro");
    expect(frontmatter.tools).toEqual(["read_file", "grep", "glob"]);
    expect(body).toBe("You are a code reviewer.");
  });

  it("returns empty frontmatter when no --- block exists", () => {
    const { frontmatter, body } = parseFrontmatter("Just some markdown text.");
    expect(frontmatter.model).toBeUndefined();
    expect(frontmatter.tools).toBeUndefined();
    expect(body).toBe("Just some markdown text.");
  });

  it("handles empty tools array", () => {
    const raw = `---
tools: []
---
No tools allowed.`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.tools).toEqual([]);
    expect(body).toBe("No tools allowed.");
  });

  it("handles model only", () => {
    const raw = `---
model: deepseek-v4-flash
---
Fast agent.`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.model).toBe("deepseek-v4-flash");
    expect(frontmatter.tools).toBeUndefined();
    expect(body).toBe("Fast agent.");
  });

  it("strips quotes from string values", () => {
    const raw = `---
model: "deepseek-v4-pro"
tools: ["read_file", "grep"]
---
Body.`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.model).toBe("deepseek-v4-pro");
    expect(frontmatter.tools).toEqual(["read_file", "grep"]);
  });

  it("ignores comments in frontmatter", () => {
    const raw = `---
# This is a comment
model: deepseek-chat
# tools line
tools: [grep]
---
Body.`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.model).toBe("deepseek-chat");
    expect(frontmatter.tools).toEqual(["grep"]);
  });
});

// ---- Agent discovery ----

describe("agentDirs", () => {
  it("includes project-level agents dir first", () => {
    const dirs = agentDirs("/home/user/project");
    expect(dirs[0]).toBe(path.join("/home/user/project", "agents"));
  });

  it("includes global agents dir", () => {
    const home = process.env.HOME ?? "~";
    const dirs = agentDirs("/tmp");
    expect(dirs[1]).toBe(path.join(home, ".deepseek-cli", "agents"));
  });
});

describe("discoverAgents", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-agents-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns empty map when no agents dir exists", async () => {
    const agents = await discoverAgents(tmp);
    expect(agents.size).toBe(0);
  });

  it("discovers agents from agents/*.md files", async () => {
    const agentsDir = path.join(tmp, "agents");
    await fs.mkdir(agentsDir);
    await fs.writeFile(
      path.join(agentsDir, "reviewer.md"),
      `---
tools: [read_file, grep]
---
You are a reviewer. Find bugs and style issues.`,
    );
    await fs.writeFile(
      path.join(agentsDir, "tester.md"),
      `---
model: deepseek-chat
---
You are a tester. Run tests and report results.`,
    );

    const agents = await discoverAgents(tmp);
    expect(agents.size).toBe(2);

    const reviewer = agents.get("reviewer")!;
    expect(reviewer).toBeDefined();
    expect(reviewer.tools).toEqual(["read_file", "grep"]);
    expect(reviewer.systemPrompt).toContain("Find bugs");

    const tester = agents.get("tester")!;
    expect(tester).toBeDefined();
    expect(tester.model).toBe("deepseek-chat");
    expect(tester.tools).toBeUndefined();
    expect(tester.systemPrompt).toContain("Run tests");
  });

  it("ignores non-.md files in agents dir", async () => {
    const agentsDir = path.join(tmp, "agents");
    await fs.mkdir(agentsDir);
    await fs.writeFile(path.join(agentsDir, "notes.txt"), "not an agent");
    await fs.writeFile(
      path.join(agentsDir, "real.md"),
      `Real agent body.`,
    );

    const agents = await discoverAgents(tmp);
    expect(agents.size).toBe(1);
    expect(agents.has("real")).toBe(true);
  });

  it("skips agents with empty body", async () => {
    const agentsDir = path.join(tmp, "agents");
    await fs.mkdir(agentsDir);
    await fs.writeFile(path.join(agentsDir, "empty.md"), `---
model: deepseek-chat
---
   
`);

    const agents = await discoverAgents(tmp);
    expect(agents.size).toBe(0);
  });

  it("sources agent locations for debugging", async () => {
    const agentsDir = path.join(tmp, "agents");
    await fs.mkdir(agentsDir);
    await fs.writeFile(path.join(agentsDir, "helper.md"), "Helpful agent.");

    const agents = await discoverAgents(tmp);
    const helper = agents.get("helper")!;
    expect(helper.source).toContain("agents/helper.md");
  });
});
