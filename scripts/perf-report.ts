#!/usr/bin/env bun
// perf-report.ts — aggregate deepseek-cli JSON logs into a readable
// performance report. A "run" is one agent loop (agent loop start → end).
// Within a run, api stream / tool events are re-sequenced into iterations.
//
// Usage:
//   bun run scripts/perf-report.ts [log-file] [options]
//
// Options:
//   --run <n>     Show a per-iteration waterfall for run #n (1-indexed, newest first)
//   --tail <n>    Only consider the last n runs (default: all)
//   --help        Show this help
//
// If no log-file is given, uses the latest ~/.deepseek-cli/logs/deepseek-*.log.

import * as path from "node:path";
import * as fs from "node:fs";
import { homedir } from "node:os";

// ---------- types ----------

interface RawEntry {
  ts: string;
  level: string;
  msg: string;
  [k: string]: unknown;
}

interface ApiCall {
  reqId?: string;
  ts: string;
  model?: string;
  status?: number;
  fetchMs?: number;
  ttfbMs?: number;
  streamMs?: number;
  chunks?: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  failed: boolean;
  errorMsg?: string;
  aborted?: boolean;
}

interface ToolCall {
  ts: string;
  name: string;
  ok: boolean;
  error?: string;
  contentLen?: number;
  summary?: string;
  ms?: number;
}

interface Retry {
  ts: string;
  reason: string;
  attempt: number;
  delayMs?: number;
  succeeded: boolean;
  exhausted?: boolean;
}

interface Run {
  index: number;
  startTs: string;
  endTs?: string;
  model?: string;
  reasoning?: boolean;
  iterations?: number;
  maxIterations?: number;
  loopMs?: number;
  apiMs?: number;
  toolsMs?: number;
  apiSharePct?: number;
  toolsSharePct?: number;
  finalTextLen?: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  aborted?: boolean;
  errorMsg?: string;
  apiCalls: ApiCall[];
  tools: ToolCall[];
  retries: Retry[];
}

// ---------- helpers ----------

const USAGE = `perf-report.ts — aggregate deepseek-cli logs into a perf report.

Usage:
  bun run scripts/perf-report.ts [log-file] [options]

Options:
  --run <n>    Show per-iteration waterfall for run #n (1-indexed, newest first)
  --tail <n>   Only consider the last n runs (default: all)
  --help       Show this help

If no log-file given, uses the latest ~/.deepseek-cli/logs/deepseek-*.log.
`;

// ---------- arg parsing ----------

const argv = process.argv.slice(2);
let logFile = "";
let runFlag: number | undefined;
let tailN: number | undefined;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (a === "--run") {
    runFlag = Number(argv[++i]);
  } else if (a === "--tail") {
    tailN = Number(argv[++i]);
  } else if (!a.startsWith("-")) {
    logFile = a;
  }
}

if (!logFile) {
  const dir = path.join(homedir(), ".deepseek-cli", "logs");
  if (!fs.existsSync(dir)) {
    console.error(`No log file given and no ~/.deepseek-cli/logs/ directory found.`);
    process.exit(1);
  }
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith("deepseek-") && f.endsWith(".log"))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.error(`No deepseek-*.log files under ${dir}`);
    process.exit(1);
  }
  logFile = path.join(dir, files[0]);
}

if (!fs.existsSync(logFile)) {
  console.error(`Log file not found: ${logFile}`);
  process.exit(1);
}

// ---------- parsing ----------

const raw = fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
const entries: RawEntry[] = [];
for (const line of raw) {
  try {
    entries.push(JSON.parse(line) as RawEntry);
  } catch {
    // skip malformed
  }
}

// Sort by timestamp ascending (logs are append-only, but be safe).
entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

// Group events into runs. A run starts at "agent loop start" and ends at
// the next "agent loop start" OR one of: "agent loop end" / "agent loop aborted".
const runs: Run[] = [];
let current: Run | null = null;
let runCounter = 0;

for (const e of entries) {
  if (e.msg === "agent loop start") {
    if (current) runs.push(current);
    runCounter++;
    current = {
      index: runCounter,
      startTs: e.ts,
      model: str(e.model),
      reasoning: bool(e.reasoning),
      maxIterations: num(e.maxIterations),
      apiCalls: [],
      tools: [],
      retries: [],
    };
    continue;
  }
  if (!current) continue;

  switch (e.msg) {
    case "agent loop end":
      current.endTs = e.ts;
      current.iterations = num(e.iterations);
      current.loopMs = num(e.loopMs);
      current.apiMs = num(e.apiMs);
      current.toolsMs = num(e.toolsMs);
      current.apiSharePct = num(e.apiSharePct);
      current.toolsSharePct = num(e.toolsSharePct);
      current.finalTextLen = num(e.finalTextLen);
      current.usage = asUsage(e.usage);
      runs.push(current);
      current = null;
      break;
    case "agent loop aborted":
      current.endTs = e.ts;
      current.aborted = true;
      current.iterations = num(e.iterations);
      runs.push(current);
      current = null;
      break;
    case "api response":
    case "api request failed":
    case "api fetch failed":
    case "api stream error":
    case "api stream done":
    case "api stream aborted":
    case "api fetch aborted":
    case "api empty body": {
      // Merge into the most recent api call with same reqId, or push a new one.
      const rid = str(e.reqId);
      let call = rid ? current.apiCalls.find((c) => c.reqId === rid && !c.streamMs) : undefined;
      if (!call) {
        call = { ts: e.ts, failed: false };
        current.apiCalls.push(call);
      }
      if (rid) call.reqId = rid;
      if (e.model) call.model = str(e.model);
      if (e.msg === "api response") {
        call.status = num(e.status);
        call.fetchMs = num(e.fetchMs);
      } else if (e.msg === "api request failed") {
        call.failed = true;
        call.status = num(e.status);
        call.fetchMs = num(e.fetchMs);
      } else if (e.msg === "api fetch failed") {
        call.failed = true;
        call.fetchMs = num(e.fetchMs);
        call.errorMsg = str(e.error);
      } else if (e.msg === "api first chunk") {
        call.ttfbMs = num(e.ttfbMs);
      } else if (e.msg === "api stream done") {
        call.streamMs = num(e.streamMs);
        call.ttfbMs = num(e.ttfbMs) || call.ttfbMs;
        call.chunks = num(e.chunks);
        call.usage = asUsage(e.usage);
      } else if (e.msg === "api stream error") {
        call.failed = true;
        call.streamMs = num(e.streamMs);
        call.errorMsg = str(e.error);
      } else if (e.msg === "api stream aborted" || e.msg === "api fetch aborted") {
        call.aborted = true;
        call.streamMs = num(e.streamMs) || num(e.fetchMs);
      } else if (e.msg === "api empty body") {
        call.failed = true;
        call.errorMsg = "empty body";
      }
      break;
    }
    case "api unauthorized":
      // Most likely atermination; record against last api call
      if (current.apiCalls.length > 0) {
        const last = current.apiCalls[current.apiCalls.length - 1];
        last.failed = true;
        last.status = 401;
        last.errorMsg = "unauthorized";
        current.errorMsg = "unauthorized";
      }
      break;
    case "api error":
      current.errorMsg = str(e.error);
      if (current.apiCalls.length > 0) {
        const last = current.apiCalls[current.apiCalls.length - 1];
        last.failed = true;
        last.status = num(e.status);
        last.errorMsg = str(e.error);
      }
      break;
    case "tool":
      current.tools.push({
        ts: e.ts,
        name: str(e.name),
        ok: bool(e.ok),
        error: str(e.error),
        contentLen: num(e.contentLen),
        summary: str(e.summary),
        ms: num(e.ms),
      });
      break;
    case "tool exception":
      current.tools.push({
        ts: e.ts,
        name: str(e.name),
        ok: false,
        error: "exception",
        ms: num(e.ms),
      });
      break;
    case "api retry": {
      current.retries.push({
        ts: e.ts,
        reason: str(e.reason),
        attempt: num(e.attempt),
        delayMs: num(e.delayMs),
        succeeded: false,
      });
      break;
    }
    case "api retry succeeded": {
      // Mark the previous retry as succeeded.
      const last = current.retries[current.retries.length - 1];
      if (last) last.succeeded = true;
      break;
    }
    case "api retry exhausted": {
      const last = current.retries[current.retries.length - 1];
      if (last) {
        last.exhausted = true;
        last.reason = str(e.error);
      }
      break;
    }
  }
}
if (current) {
  // No "agent loop end" recorded — run was likely interrupted by process kill.
  current.endTs = current.startTs;
  runs.push(current);
}

// newest-first
runs.reverse();
for (let i = 0; i < runs.length; i++) runs[i].index = i + 1;

if (tailN !== undefined && runs.length > tailN) {
  runs.splice(tailN);
}

// ---------- helpers ----------

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function asUsage(v: unknown): { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  return {
    promptTokens: num(o.promptTokens) ?? num(o.prompt_tokens),
    completionTokens: num(o.completionTokens) ?? num(o.completion_tokens),
    totalTokens: num(o.totalTokens) ?? num(o.total_tokens),
  };
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
function fmtPct(p?: number): string {
  if (p === undefined) return "—";
  return `${String(p).padStart(2, "0")}%`;
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function shortTime(ts: string): string {
  // 2026-06-30T04:03:44.892Z → 04:03:44
  const m = ts.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : ts;
}

// ---------- if --run n, print waterfall ----------

if (runFlag !== undefined) {
  const run = runs.find((r) => r.index === runFlag);
  if (!run) {
    console.error(`Run #${runFlag} not found (have ${runs.length} runs).`);
    process.exit(1);
  }
  printWaterfall(run);
  process.exit(0);
}

// ---------- summary ----------

printSummary(runs);

// ---------- output ----------

function printSummary(rs: Run[]): void {
  console.log(`\nperf-report · ${path.basename(logFile)} · ${rs.length} run(s)\n`);

  if (rs.length === 0) return;

  const completed = rs.filter((r) => r.loopMs !== undefined);
  const totalLoop = completed.reduce((s, r) => s + (r.loopMs ?? 0), 0);
  const totalApi = completed.reduce((s, r) => s + (r.apiMs ?? 0), 0);
  const totalTools = completed.reduce((s, r) => s + (r.toolsMs ?? 0), 0);
  const totalIters = rs.reduce((s, r) => s + (r.iterations ?? 0), 0);

  console.log("Aggregate (completed runs only):");
  console.log(`  wall: ${fmtMs(totalLoop)}  api: ${fmtMs(totalApi)} (${fmtPct(pct(totalApi, totalLoop))})  tools: ${fmtMs(totalTools)} (${fmtPct(pct(totalTools, totalLoop))})  other: ${fmtMs(totalLoop - totalApi - totalTools)} (${fmtPct(pct(totalLoop - totalApi - totalTools, totalLoop))})`);
  console.log(`  iterations: ${totalIters}  |  runs completed: ${completed.length}/${rs.length}`);

  const aborted = rs.filter((r) => r.aborted).length;
  const failedRuns = rs.filter((r) => r.errorMsg && !r.aborted).length;
  const apiFails = rs.flatMap((r) => r.apiCalls).filter((c) => c.failed).length;
  const toolFails = rs.flatMap((r) => r.tools).filter((t) => !t.ok).length;
  const retries = rs.flatMap((r) => r.retries).length;
  const retriesExhausted = rs.flatMap((r) => r.retries).filter((x) => x.exhausted).length;

  console.log(`  aborts: ${aborted}  |  failed runs: ${failedRuns}  |  api failures: ${apiFails}  |  tool failures: ${toolFails}`);
  console.log(`  retries: ${retries}  |  retries exhausted: ${retriesExhausted}`);

  // Slowest runs
  console.log("\nSlowest runs:");
  const top = [...rs].filter((r) => r.loopMs !== undefined).sort((a, b) => (b.loopMs ?? 0) - (a.loopMs ?? 0)).slice(0, 5);
  for (const r of top) {
    const apiPct = fmtPct(r.apiSharePct);
    const toolsPct = fmtPct(r.toolsSharePct);
    console.log(`  #${pad(String(r.index), 2)} ${pad(fmtMs(r.loopMs), 9)}  api=${pad(fmtMs(r.apiMs), 8)}(${apiPct}) tools=${pad(fmtMs(r.toolsMs), 8)}(${toolsPct})  iter=${pad(String(r.iterations ?? "?"), 2)}  ${r.aborted ? "ABORT " : ""}${r.model ?? "?"}  ${shortTime(r.startTs)}`);
  }

  // Top slow tools
  const toolAgg = new Map<string, { count: number; totalMs: number; maxMs: number; fail: number }>();
  for (const t of rs.flatMap((r) => r.tools)) {
    const a = toolAgg.get(t.name) ?? { count: 0, totalMs: 0, maxMs: 0, fail: 0 };
    a.count++;
    if (typeof t.ms === "number") {
      a.totalMs += t.ms;
      a.maxMs = Math.max(a.maxMs, t.ms);
    }
    if (!t.ok) a.fail++;
    toolAgg.set(t.name, a);
  }
  if (toolAgg.size > 0) {
    console.log("\nTool breakdown:");
    const rows = [...toolAgg.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
    console.log(`  ${pad("name", 18)} ${pad("calls", 6)} ${pad("total", 9)} ${pad("avg", 9)} ${pad("max", 9)} ${pad("fail", 5)}`);
    for (const [name, a] of rows) {
      console.log(`  ${pad(name, 18)} ${pad(String(a.count), 6)} ${pad(fmtMs(a.totalMs), 9)} ${pad(fmtMs(a.count ? Math.round(a.totalMs / a.count) : 0), 9)} ${pad(fmtMs(a.maxMs), 9)} ${pad(String(a.fail), 5)}`);
    }
  }

  // Top slow api calls
  const calls = rs.flatMap((r) => r.apiCalls).filter((c) => c.streamMs !== undefined);
  if (calls.length > 0) {
    console.log("\nSlowest API calls (by streamMs):");
    const topc = [...calls].sort((a, b) => (b.streamMs ?? 0) - (a.streamMs ?? 0)).slice(0, 5);
    for (const c of topc) {
      console.log(`  ${pad(fmtMs(c.streamMs), 9)}  ttfb=${pad(fmtMs(c.ttfbMs), 8)}  chunks=${pad(String(c.chunks ?? "?"), 4)}  ${c.model ?? "?"}  ${shortTime(c.ts)}${c.failed ? "  FAIL" : ""}`);
    }
  }

  // Retries
  if (retries > 0) {
    console.log("\nRetries:");
    const byReason = new Map<string, { count: number }>();
    for (const r of rs.flatMap((r) => r.retries)) {
      const key = r.reason || "(unknown)";
      const v = byReason.get(key) ?? { count: 0 };
      v.count++;
      byReason.set(key, v);
    }
    for (const [reason, v] of byReason.entries()) {
      console.log(`  ${pad(reason.slice(0, 40), 42)} ${v.count}`);
    }
  }

  console.log("");
}

function printWaterfall(r: Run): void {
  console.log(`\nRun #${r.index}  ${r.model ?? "?"}  ${shortTime(r.startTs)}${r.aborted ? "  ABORTED" : ""}`);
  console.log(`  total=${fmtMs(r.loopMs ?? undefinedByFallbackCalc(r))}  api=${fmtMs(r.apiMs ?? sumApiMs(r))} (${fmtPct(r.apiSharePct ?? pct(sumApiMs(r), r.loopMs ?? sumLoopMs(r)))})  tools=${fmtMs(r.toolsMs ?? sumToolsMs(r))} (${fmtPct(r.toolsSharePct ?? pct(sumToolsMs(r), r.loopMs ?? sumLoopMs(r)))})  iterations=${r.iterations ?? "?"}`);
  console.log("");

  // Reconstruct iterations by walking apiCalls and tools in time order.
  // An "iteration" is a logical model turn — it may contain several retry
  // attempts that ultimately end in a terminal event (stream done / stream
  // error / stream aborted / retry exhausted). Non-terminal failed attempts
  // (e.g. 429, fetch failed) accumulate into the SAME iteration until the
  // terminal event arrives.
  type Ev = { t: "api"; c: ApiCall } | { t: "tool"; x: ToolCall };
  const events: Ev[] = [];
  for (const c of r.apiCalls) events.push({ t: "api", c });
  for (const x of r.tools) events.push({ t: "tool", x });
  events.sort((a, b) => {
    const ta = a.t === "api" ? a.c.ts : a.x.ts;
    const tb = b.t === "api" ? b.c.ts : b.x.ts;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  interface IterRow {
    n: number;
    api: ApiCall; // final/terminal attempt
    attempts: ApiCall[]; // all attempts (incl. failures before the terminal one)
    retries: Retry[];
    tools: ToolCall[];
  }

  const iterRows: IterRow[] = [];
  let currentTools: ToolCall[] = [];
  let iterCounter = 0;

  function isTerminal(c: ApiCall): boolean {
    if (c.streamMs !== undefined) return true; // success (api stream done)
    if (c.aborted) return true;
    if (c.errorMsg === "empty body") return true;
    // api stream error has streamMs set already; only fallthroughs here
    // are failed fetches / 429 / unauthorized — non-terminal UNLESS exhausted
    // (we'll let retry-exhausted close it separately).
    return false;
  }

  for (const ev of events) {
    if (ev.t === "tool") {
      if (iterRows.length === 0) {
        // Orphan tool (no preceding model turn) — invent an empty iter.
        iterRows.push({ n: ++iterCounter, api: { ts: ev.x.ts, failed: false }, attempts: [], retries: [], tools: [ev.x] });
      } else {
        currentTools.push(ev.x);
      }
      continue;
    }

    const c = ev.c;

    // An api event arrives. Decide: does it extend the current open iter, or
    // open a new one?
    let row: IterRow | undefined;
    if (iterRows.length > 0) {
      const last = iterRows[iterRows.length - 1];
      const lastIsClosed = last.api.streamMs !== undefined || last.aborted || last.api.errorMsg === "empty body";
      if (!lastIsClosed) {
        // Same iteration — this is another attempt (e.g., retry after 429).
        row = last;
        row.attempts.push(c);
        // The iteration's `.api` reflects the LATEST attempt (terminal or not):
        // terminal outcomes override, non-terminal attempts update progressively.
        row.api = c;
        if (isTerminal(c)) {
          row.tools = currentTools;
          currentTools = [];
        }
        continue;
      }
    }

    // Open a new iteration. Attach any tools collected since the last
    // iteration's terminal event to the PREVIOUS (now-closed) iteration.
    if (currentTools.length > 0 && iterRows.length > 0) {
      iterRows[iterRows.length - 1].tools = currentTools;
      currentTools = [];
    }

    row = { n: ++iterCounter, api: c, attempts: [c], retries: [], tools: [] };
    iterRows.push(row);
    if (isTerminal(c)) {
      row.tools = currentTools;
      currentTools = [];
    }
  }
  // Flush trailing tools to the last iteration.
  if (currentTools.length > 0 && iterRows.length > 0) {
    iterRows[iterRows.length - 1].tools = currentTools;
  }

  // Attach retries to iterations: a retry belongs to the iter whose
  // [firstAttempt.ts, terminal.ts] window contains the retry's timestamp.
  for (const retry of r.retries) {
    let best: IterRow | undefined;
    for (const row of iterRows) {
      const start = row.attempts[0]?.ts ?? row.api.ts;
      const end = row.api.ts;
      if (start <= retry.ts && retry.ts <= end) {
        best = row;
        break;
      }
    }
    if (!best) {
      // Fallback: most recent iter that started before the retry.
      for (const row of iterRows) {
        const start = row.attempts[0]?.ts ?? row.api.ts;
        if (start <= retry.ts) best = row;
      }
    }
    if (best) best.retries.push(retry);
  }

  for (const row of iterRows) {
    const apiMs = row.api.streamMs ?? row.api.fetchMs ?? 0;
    const toolsMs = row.tools.reduce((s, t) => s + (t.ms ?? 0), 0);
    const total = apiMs + toolsMs;
    const apiPct = pct(apiMs, total);
    const toolsPct = pct(toolsMs, total);
    let flag = "";
    if (row.api.failed) flag = " FAIL";
    if (row.api.aborted) flag = " ABORT";
    const attemptsSuffix = row.attempts.length > 1 ? `  attempts=${row.attempts.length}` : "";
    console.log(`  iter ${pad(String(row.n), 2)}  ${pad(fmtMs(total), 9)}  api=${pad(fmtMs(apiMs), 8)}(${fmtPct(apiPct)}) tools=${pad(fmtMs(toolsMs), 8)}(${fmtPct(toolsPct)})  chunks=${row.api.chunks ?? "?"}${attemptsSuffix}${flag}`);
    for (const t of row.tools) {
      console.log(`          ${pad(t.name, 16)} ${pad(fmtMs(t.ms), 8)}  ${t.ok ? "ok" : `FAIL(${t.error ?? "?"})`}  ${t.summary ? t.summary.slice(0, 40) : ""}`);
    }
    if (row.retries.length > 0) {
      const summary = row.retries.map((x) => `#${x.attempt} ${x.reason} delay=${fmtMs(x.delayMs)}${x.succeeded ? "→ok" : ""}${x.exhausted ? "→EXHAUSTED" : ""}`).join("  ");
      console.log(`          ${pad("retries:", 16)} ${summary}`);
    }
  }

  if (r.retries.length > 0 && iterRows.every((row) => row.retries.length === 0)) {
    console.log("\n  retries in this run:");
    for (const x of r.retries) {
      console.log(`    #${x.attempt}  ${x.reason}  delay=${fmtMs(x.delayMs)}${x.succeeded ? "  → succeeded" : ""}${x.exhausted ? "  → EXHAUSTED" : ""}`);
    }
  }
  console.log("");
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

// Fallbacks when loop-level aggregates weren't logged (older runs).
function sumApiMs(r: Run): number {
  return r.apiCalls.reduce((s, c) => s + (c.streamMs ?? c.fetchMs ?? 0), 0);
}
function sumToolsMs(r: Run): number {
  return r.tools.reduce((s, t) => s + (t.ms ?? 0), 0);
}
function sumLoopMs(r: Run): number {
  return sumApiMs(r) + sumToolsMs(r);
}
function undefinedByFallbackCalc(r: Run): number {
  return sumLoopMs(r);
}
