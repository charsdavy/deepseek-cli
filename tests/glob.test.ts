import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { expandBraces, manualGlob } from "../src/tools/glob.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-glob-test-"));
  // Tree:
  //   a.ts, a.tsx, b.js, c.json
  //   sub/x.ts, sub/x.tsx, sub/y.md
  //   sub/deep/z.ts
  await fs.writeFile(path.join(tmp, "a.ts"), "");
  await fs.writeFile(path.join(tmp, "a.tsx"), "");
  await fs.writeFile(path.join(tmp, "b.js"), "");
  await fs.writeFile(path.join(tmp, "c.json"), "");
  await fs.mkdir(path.join(tmp, "sub", "deep"), { recursive: true });
  await fs.writeFile(path.join(tmp, "sub", "x.ts"), "");
  await fs.writeFile(path.join(tmp, "sub", "x.tsx"), "");
  await fs.writeFile(path.join(tmp, "sub", "y.md"), "");
  await fs.writeFile(path.join(tmp, "sub", "deep", "z.ts"), "");
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const m of gen) out.push(m);
  return out.sort();
}

describe("expandBraces", () => {
  it("expands a single brace group", () => {
    expect(expandBraces("*.{ts,tsx}").sort()).toEqual(["*.ts", "*.tsx"]);
  });

  it("passes through patterns without braces", () => {
    expect(expandBraces("**/*.ts")).toEqual(["**/*.ts"]);
  });

  it("expands nested suffix after the brace", () => {
    expect(expandBraces("src/*.{test,spec}.ts").sort()).toEqual(["src/*.spec.ts", "src/*.test.ts"]);
  });
});

describe("manualGlob (pure-JS fallback matcher)", () => {
  it("matches a brace pattern across the tree", async () => {
    const matches = await collect(manualGlob("**/*.{ts,tsx}", tmp));
    // a.ts, a.tsx, sub/x.ts, sub/x.tsx, sub/deep/z.ts
    expect(matches).toContain("a.ts");
    expect(matches).toContain("a.tsx");
    expect(matches).toContain("sub/x.ts");
    expect(matches).toContain("sub/x.tsx");
    expect(matches).toContain("sub/deep/z.ts");
    expect(matches).not.toContain("b.js");
    expect(matches).not.toContain("c.json");
  });

  it("matches a single-segment star at the root", async () => {
    const matches = await collect(manualGlob("*.ts", tmp));
    expect(matches).toEqual(["a.ts"]);
  });

  it("matches a fixed subpath", async () => {
    const matches = await collect(manualGlob("sub/*.md", tmp));
    expect(matches).toEqual(["sub/y.md"]);
  });

  it("returns no matches for an absent pattern", async () => {
    const matches = await collect(manualGlob("**/*.py", tmp));
    expect(matches).toEqual([]);
  });
});
