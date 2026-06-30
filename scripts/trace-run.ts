#!/usr/bin/env bun
// trace-run.ts — extract a per-event timestamp trace for a single agent run
// from old-format logs (no streamMs/loopMs fields). Useful to diagnose where
// time went when only legacy logs exist.
//
// Usage:
//   bun run scripts/trace-run.ts [log-file] [--run <n>] [--last]
//
// Without --run, prints a one-line per-run summary (start, end, duration,
// iter count by surrogate, tool count) so you can pick the slowest run.
// With --run N, prints a per-event trace with deltas.

import * as path from "node:path";
import * as fs from "node:fs";
import { homedir } from "node:os";

interface E { ts: string; level: string; msg: string; [k: string]: unknown }

const argv = process.argv.slice(2);
let logFile = "";
let runFlag: number | undefined;
let last = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--run") runFlag = Number(argv[++i]);
  else if (a === "--last") last = true;
  else if (!a.startsWith("-")) logFile = a;
}
if (!logFile) {
  const dir = path.join(homedir(), ".deepseek-cli", "logs");
  const files = fs.readdirSync(dir).filter(f => /^deepseek-.*\.log$/.test(f)).sort().reverse();
  if (!files.length) { console.error("no logs"); process.exit(1); }
  logFile = path.join(dir, files[0]);
}

const raw = fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
const events: E[] = [];
for (const line of raw) { try { events.push(JSON.parse(line) as E); } catch {} }
events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

// Group into runs
const runs: E[][] = [];
let cur: E[] = [];
for (const e of events) {
  if (e.msg === "agent loop start") {
    if (cur.length) runs.push(cur);
    cur = [e];
  } else {
    cur.push(e);
  }
}
if (cur.length) runs.push(cur);

// newest first
runs.reverse();

interface RunSummary { idx: number; startTs: string; endTs: string; durMs: number; events: number; tools: number; iterations: number; model: string }
const summaries: RunSummary[] = runs.map((r, i) => {
  const start = new Date(r[0].ts).getTime();
  const lastEv = r[r.length - 1];
  const end = new Date(lastEv.ts).getTime();
  const tools = r.filter(e => e.msg === "tool").length;
  const iterations = r.filter(e => e.msg === "iteration").length || (r.some(e => e.msg === "agent loop end") ? Math.max(1, Number(r.find(e => e.msg === "agent loop end")?.iterations ?? 0)) : 0);
  return { idx: i + 1, startTs: r[0].ts, endTs: lastEv.ts, durMs: end - start, events: r.length, tools, iterations, model: String(r[0].model ?? "?") };
});

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

if (last && !runFlag) {
  // pick the slowest run that had at least one tool call
  const candidates = summaries.filter(s => s.tools > 0 && s.durMs > 0);
  candidates.sort((a, b) => b.durMs - a.durMs);
  if (candidates.length) runFlag = candidates[0].idx;
}

if (runFlag === undefined) {
  console.log(`\n${logFile} · ${runs.length} runs (slowest with tools first)\n`);
  const withTools = summaries.filter(s => s.tools > 0).sort((a, b) => b.durMs - a.durMs);
  console.log(`${"idx".padStart(4)}  ${"dur".padStart(9)}  ${"tools".padStart(5)}  ${"iter".padStart(4)}  ${"ev".padStart(4)}  model            start`);
  for (const s of withTools.slice(0, 20)) {
    console.log(`${String(s.idx).padStart(4)}  ${fmt(s.durMs).padStart(9)}  ${String(s.tools).padStart(5)}  ${String(s.iterations).padStart(4)}  ${String(s.events).padStart(4)}  ${s.model.padEnd(15)}  ${s.startTs.slice(11, 19)}`);
  }
  console.log(`\n=> run: bun run scripts/trace-run.ts ${logFile} --run <n>`);
  process.exit(0);
}

const r = runs[runFlag - 1];
if (!r) { console.error(`run ${runFlag} not found`); process.exit(1); }

console.log(`\nRun #${runFlag}  ${r[0].model}  ${r[0].ts}${r[0].reasoning ? "  (reasoning)" : ""}`);
const startT = new Date(r[0].ts).getTime();
console.log(`  events: ${r.length}  tools: ${r.filter(e => e.msg === "tool").length}\n`);

let prevT = startT;
for (const e of r) {
  const t = new Date(e.ts).getTime();
  const delta = t - prevT;
  prevT = t;
  const sinceStart = t - startT;
  // Compose a compact description of the event
  let desc = e.msg;
  if (e.msg === "tool") desc = `tool ${e.name}${e.ok ? "" : " FAIL"} ${String(e.summary ?? "").slice(0, 30)}`;
  else if (e.msg === "iteration") desc = `iter ${e.iteration}`;
  else if (e.msg === "agent loop end") desc = `loop end iter=${e.iterations}`;
  else if (e.msg === "api error" || e.msg === "api unauthorized") desc = `${e.msg} ${e.error ?? ""}`;
  console.log(`  +${fmt(delta).padStart(8)}  @${fmt(sinceStart).padStart(8)}  ${desc}`);
}
console.log("");
