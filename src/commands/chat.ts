// Default chat command. Drives the agent loop for both one-shot prompts and
// the interactive REPL. Owns session lifecycle, tool/permission wiring, and
// the on-screen rendering of streaming output.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ChatMessage } from "../api/client.ts";
import { DEFAULT_MODEL, findModel, isReasoningModel, MODELS } from "../api/models.ts";
import { estimateConversationTokens } from "../api/tokens.ts";
import { ensureDirs, getOrSetupApiKey, loadConfig, saveConfig } from "../config/config.ts";
import { loadProjectInstructions } from "../config/instructions.ts";
import { buildSystemPrompt } from "../prompt/builder.ts";
import { makeStreamRenderer, runAgentLoop } from "../agent/loop.ts";
import { PermissionManager } from "../agent/permissions.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { Tool, ToolContext, ToolResult } from "../tools/types.ts";
import { newSession, newSessionId, loadSession, listSessions, searchSessions, saveSession, type Session } from "../session/store.ts";
import { loadHistory, appendHistory } from "../session/history.ts";
import { listSkills, readSkill } from "../skills/store.ts";
import { McpRegistry, loadMcpConfig } from "../mcp/registry.ts";
import { log } from "../log/logger.ts";
import { VERSION } from "../cli.ts";
import { paint, symbol } from "../ui/theme.ts";
import { blank, printBordered, printError, printSeparator, printSystem, printTip, setOutputSilent, writeLine } from "../ui/render.ts";
import { outputSilent } from "../ui/theme.ts";
import { askMultiline, closeReadline, selectOption } from "../ui/input.ts";
import { spinner } from "../ui/spinner.ts";

export interface ChatArgs {
  prompt?: string;
  model?: string;
  system?: string;
  reasoning?: boolean;
  continueLast?: boolean;
  resume?: string;
  yolo?: boolean;
  approvalMode?: "ask" | "auto" | "yolo";
  maxIterations?: number;
  baseUrl?: string;
  cwd?: string;
  temperature?: number;
  maxTokens?: number;
  outputFormat?: "text" | "json";
  noMcp?: boolean;
  reasoningEffort?: "high" | "max";
  maxContext?: number;
  mcpArgs?: string[];
  skillArgs?: string[];
  verbose?: boolean;
}

export async function runChat(args: ChatArgs): Promise<void> {
  await ensureDirs();
  const cfg = await loadConfig();
  const apiKey = await getOrSetupApiKey(false, cfg);
  if (!apiKey) {
    printError("No API key configured. Run `deepseek auth` to set it up.");
    return;
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
  let model = pickModel(args.model ?? cfg.defaultModel ?? DEFAULT_MODEL);
  let modelInfo = findModel(model);
  let reasoning = args.reasoning ?? cfg.reasoning ?? isReasoningModel(model);
  const temperature = args.temperature ?? cfg.temperature;
  const maxTokens = args.maxTokens ?? cfg.maxTokens;
  // Thinking intensity + context budget: CLI flag wins, else config, else defaults.
  let reasoningEffort = args.reasoningEffort ?? cfg.reasoningEffort;
  let maxContext = args.maxContext ?? cfg.maxContext;
  // CLI base-url override wins over config; falls back to config's baseUrl.
  const baseUrl = args.baseUrl ?? cfg.baseUrl;
  // Resolve the permission mode. `--yolo` is shorthand for --approval-mode yolo.
  const approvalMode = args.yolo ? "yolo" : (args.approvalMode ?? cfg.approvalMode ?? "ask");
  const skipAll = approvalMode === "auto" || approvalMode === "yolo";
  const maxIterations = args.maxIterations;

  // Session resolution
  let session: Session;
  if (args.resume) {
    const loaded = await loadSession(args.resume);
    if (!loaded) {
      printError(`Session ${args.resume} not found.`);
      return;
    }
    session = loaded;
  } else if (args.continueLast) {
    const last = (await listSessions(1))[0];
    if (!last) {
      printError("No previous session to continue.");
      return;
    }
    session = last;
    printSystem(`resumed session ${session.id} (${session.messages.length} msgs)`, "cyan");
  } else {
    session = newSession(model, args.system, cwd);
  }

  // System prompt assembly — modular builder, project instructions win.
  const instructions = await loadProjectInstructions(cwd);
  // Active skills: name → content, toggled via /skill. Folded into the prompt
  // before project instructions so repo rules still win on conflicts.
  let activeSkills = new Map<string, string>();

  const rebuildSystemPrompt = (): void => {
    const rebuilt = buildSystemPrompt({
      cwd,
      modelInfo,
      isReasoning: reasoning,
      userSystemPrompt: args.system,
      projectInstructions: instructions,
      activeSkills: Array.from(activeSkills.entries()).map(([name, content]) => ({ name, content })),
    });
    session.promptVariant = rebuilt.variant;
    ensureSystemPrefix(session.messages, rebuilt.text);
  };
  rebuildSystemPrompt();

  // Switch the active model mid-session: updates the closure vars that
  // subsequent turns read, and rebuilds the system prompt so the reasoning
  // addendum reflects the new model. Used by the /model slash command.
  const applyModel = (id: string): void => {
    model = id;
    session.model = id;
    modelInfo = findModel(id);
    reasoning = isReasoningModel(id);
    rebuildSystemPrompt();
  };

  // Toggle reasoning (thinking) for the session AND persist it as the default
  // for future sessions. Keeps `thinking:{type:"enabled"}` in client.ts; only
  // the local reasoning flag (which gates that param + the trace display) flips.
  const setReasoning = async (on: boolean): Promise<void> => {
    reasoning = on;
    cfg.reasoning = on;
    await saveConfig(cfg);
    rebuildSystemPrompt();
  };

  // Thinking intensity ("high"|"max") and operational context-trim budget.
  const setReasoningEffort = async (e: "high" | "max"): Promise<void> => {
    reasoningEffort = e;
    cfg.reasoningEffort = e;
    await saveConfig(cfg);
  };
  const setMaxContext = async (n: number): Promise<void> => {
    maxContext = n;
    cfg.maxContext = n;
    await saveConfig(cfg);
  };

  // Sub-agent spawner surfaced to the `task` tool. Runs a nested agent loop
  // silently with its own (small) context + iteration budget; multiple `task`
  // calls in one turn run in parallel via the parent loop's Promise.all.
  let subagentDepth = 0;
  const spawnAgent = async (
    prompt: string,
    opts?: { description?: string; cwd?: string },
  ): Promise<string> => {
    if (subagentDepth >= 3) throw new Error("max sub-agent depth (3) reached");
    subagentDepth++;
    const wasSilent = outputSilent;
    setOutputSilent(true);
    try {
      const subMessages: ChatMessage[] = [
        {
          role: "system",
          content:
            "You are a focused DeepSeek sub-agent. Complete the assigned subtask with the available tools, then return ONLY the final result — no preamble, no follow-up questions.",
        },
        { role: "user", content: prompt },
      ];
      const r = await runAgentLoop(subMessages, {
        apiKey,
        model,
        reasoning,
        reasoningEffort,
        maxContext,
        temperature,
        maxTokens,
        maxIterations: 10,
        baseUrl,
        tools,
        permissions,
        cwd: opts?.cwd ?? cwd,
        spawnAgent, // allow further nesting up to the depth cap
      });
      return r.finalText;
    } finally {
      setOutputSilent(wasSilent);
      subagentDepth--;
    }
  };

  // Skills API handed to the /skill slash command — encapsulates discovery,
  // activation, and prompt rebuild so the handler stays self-contained.
  const skillsApi = {
    list: () => listSkills(cwd),
    active: () => [...activeSkills.keys()],
    toggle: async (name: string): Promise<boolean> => {
      if (activeSkills.has(name)) {
        activeSkills.delete(name);
        rebuildSystemPrompt();
        return false; // now inactive
      }
      const s = await readSkill(name, cwd);
      if (!s) throw new Error(`skill '${name}' not found`);
      activeSkills.set(name, s.content);
      rebuildSystemPrompt();
      return true; // now active
    },
    clear: () => {
      activeSkills = new Map();
      rebuildSystemPrompt();
    },
  };

  // Tools + permissions
  const tools = new ToolRegistry();
  const permissions = new PermissionManager({
    mode: skipAll ? "auto" : "ask",
    skipAll,
  });

  log.info("startup", {
    version: VERSION,
    model,
    reasoning,
    reasoningEffort,
    maxContext,
    cwd,
    yolo: skipAll,
    resume: args.resume ?? args.continueLast,
  });

  // MCP servers (stdio transport). Best-effort: a failed server is skipped
  // without crashing the session. --no-mcp disables the whole subsystem.
  const mcp = new McpRegistry();
  if (args.noMcp !== true) {
    const mcpConfig = await loadMcpConfig(cwd);
    const serverCount = Object.keys(mcpConfig.mcpServers).length;
    if (serverCount > 0) {
      printSystem(`mcp: connecting ${serverCount} server${serverCount === 1 ? "" : "s"}…`, "blue");
      await mcp.load(mcpConfig);
      for (const t of mcp.toTools()) tools.register(t);
    }
  }
  // Ensure MCP child processes are torn down on exit.
  const closeMcp = () => { mcp.close().catch(() => {}); };

  // Surface server enable/disable + per-server tools to the /mcp command.
  const mcpApi: McpApi = {
    servers: () => mcp.status().map((s) => ({ name: s.name, enabled: s.enabled, toolCount: s.toolCount })),
    toggle: (name: string) => mcp.toggleServer(name),
    toolsForServer: (name: string) => mcp.toolsForServer(name),
  };

  const toolCtx: ToolContext = { cwd };

  // Per-turn abort holder. SIGINT aborts the active turn; a second SIGINT with
  // no active turn force-quits the process.
  const turnAbort: { current: AbortController | null } = { current: null };
  let exitFlagged = false;
  const onSigInt = () => {
    if (turnAbort.current) {
      turnAbort.current.abort();
      return;
    }
    if (exitFlagged) {
      writeLine();
      process.exit(130);
    }
    exitFlagged = true;
    writeLine(paint.yellow("\n(interrupt — type /exit to quit, or Ctrl-C again to force)"));
  };
  process.on("SIGINT", onSigInt);

  // ---- One-shot mode ----
  if (args.prompt) {
    session.messages.push({ role: "user", content: await expandFileRefs(args.prompt, cwd) });
    const controller = new AbortController();
    turnAbort.current = controller;
    try {
      if (args.outputFormat === "json") {
        await runJsonOneShot(session, {
          apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl, reasoningEffort, maxContext,
          tools, permissions, toolCtx, prompt: args.prompt, signal: controller.signal, spawnAgent,
        });
      } else {
        await driveTurn(session, {
          apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl, reasoningEffort, maxContext,
          tools, permissions, toolCtx, signal: controller.signal, spawnAgent,
        });
      }
      await saveSession(session);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (args.outputFormat === "json") {
        process.stdout.write(JSON.stringify({ ok: false, error: msg, prompt: args.prompt }) + "\n");
      } else {
        printError(`turn failed: ${msg}`);
      }
    } finally {
      turnAbort.current = null;
      process.off("SIGINT", onSigInt);
      closeMcp();
      closeReadline();
    }
    return;
  }

  // ---- Interactive REPL ----
  printWelcome(model, reasoning, skipAll, baseUrl);
  printTip("type /help for commands, /exit to quit, Ctrl-C to abort a turn");
  blank();

  let firstPrompt = true;
  const history = await loadHistory();
  try {
    while (true) {
      let input: string;
      try {
        // A subtle rule between turns gives the REPL a Claude-Code-like rhythm.
        if (!firstPrompt) printSeparator();
        firstPrompt = false;
        input = await askMultiline(`${paint.bold(paint.bright.cyan(`${symbol.user}`))} ${paint.gray("›")} `, history);
      } catch {
        break;
      }
      exitFlagged = false;
      const trimmed = input.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("/")) {
        const lowerCmd = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase();
        if (lowerCmd === "retry") {
          const idx = lastUserIndex(session.messages);
          if (idx < 0) {
            printSystem("no previous prompt to retry", "yellow");
            continue;
          }
          // Drop everything after the last user message, then re-run the turn.
          session.messages.length = idx + 1;
          const controller = new AbortController();
          turnAbort.current = controller;
          try {
            await driveTurn(session, {
              apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl, reasoningEffort, maxContext,
              tools, permissions, toolCtx, signal: controller.signal, spawnAgent,
            });
            await saveSession(session);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            printError(`turn failed: ${msg}`);
          } finally {
            turnAbort.current = null;
          }
          continue;
        }
        const handled = await handleSlashCommand(trimmed, session, { apiKey, model, temperature, tools, setModel: applyModel, skills: skillsApi, mcp: mcpApi, reasoning: { get: () => reasoning, set: setReasoning }, effort: { get: () => reasoningEffort, set: setReasoningEffort }, context: { get: () => maxContext, set: setMaxContext } });
        if (handled === "exit") break;
        continue;
      }

      session.messages.push({ role: "user", content: await expandFileRefs(trimmed, cwd) });
      // Remember the prompt for Up/Down recall (newest-first) + persist.
      history.unshift(trimmed);
      if (history.length > 1000) history.length = 1000;
      appendHistory(trimmed).catch(() => {});
      const controller = new AbortController();
      turnAbort.current = controller;
      try {
        await driveTurn(session, {
          apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl, reasoningEffort, maxContext,
          tools, permissions, toolCtx, signal: controller.signal, spawnAgent,
        });
        await saveSession(session);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        printError(`turn failed: ${msg}`);
      } finally {
        turnAbort.current = null;
      }
    }
  } finally {
    process.off("SIGINT", onSigInt);
    await saveSession(session).catch(() => {});
    closeMcp();
    closeReadline();
    printSystem("Goodbye! 👋", "magenta");
  }
}

interface TurnDeps {
  apiKey: string;
  model: string;
  reasoning?: boolean;
  reasoningEffort?: "high" | "max";
  maxContext?: number;
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  baseUrl?: string;
  tools: ToolRegistry;
  permissions: PermissionManager;
  toolCtx: ToolContext;
  signal?: AbortSignal;
  spawnAgent?: (prompt: string, opts?: { description?: string; cwd?: string }) => Promise<string>;
}

async function driveTurn(session: Session, deps: TurnDeps): Promise<void> {
  const renderer = makeStreamRenderer({ showReasoning: deps.reasoning === true, model: deps.model });

  const onToolEnd = (name: string, result: ToolResult) => {
    void name;
    if (result.uiSummary) {
      writeLine(`  ${paint.gray(result.uiSummary)}`);
    }
    if (!result.ok) {
      writeLine(`  ${paint.yellow("tool reported non-zero exit / error")}`);
    }
  };

  spinner.start("thinking…");
  let result;
  try {
    result = await runAgentLoop(session.messages, {
      apiKey: deps.apiKey,
      model: deps.model,
      reasoning: deps.reasoning,
      reasoningEffort: deps.reasoningEffort,
      maxContext: deps.maxContext,
      temperature: deps.temperature,
      maxTokens: deps.maxTokens,
      maxIterations: deps.maxIterations,
      baseUrl: deps.baseUrl,
      tools: deps.tools,
      permissions: deps.permissions,
      cwd: session.cwd,
      signal: deps.signal,
      spawnAgent: deps.spawnAgent,
      onContentDelta: (d) => renderer.onContentDelta(d),
      onReasoningDelta: (d) => renderer.onReasoningDelta(d),
      onToolStart: () => true,
      onToolEnd,
    });
  } catch (e) {
    spinner.stop();
    renderer.end();
    throw e;
  }
  spinner.stop();
  renderer.end();
  session.messages = result.messages;

  // Track real token usage from the API on the session, if reported.
  if (result.usage && (result.usage.promptTokens || result.usage.completionTokens)) {
    session.tokenUsage = accumulateUsage(session.tokenUsage, result.usage);
  }

  // Surface per-turn usage to the user.
  if (result.usage && result.usage.totalTokens) {
    const u = result.usage;
    writeLine(
      paint.gray(
        `  tokens: ${u.promptTokens ?? "?"} prompt → ${u.completionTokens ?? "?"} completion` +
          ` · session ${session.tokenUsage?.total ?? u.totalTokens} total` +
          (result.aborted ? " · interrupted" : ""),
      ),
    );
  } else if (result.aborted) {
    printSystem("turn interrupted", "yellow");
  }
}

function accumulateUsage(
  prev: Session["tokenUsage"],
  delta: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
): NonNullable<Session["tokenUsage"]> {
  const base = prev ?? { prompt: 0, completion: 0, total: 0, turns: 0 };
  return {
    prompt: base.prompt + (delta.promptTokens ?? 0),
    completion: base.completion + (delta.completionTokens ?? 0),
    total: base.total + (delta.totalTokens ?? 0),
    turns: base.turns + 1,
  };
}

// ---- JSON pipe mode ----
// Runs the agent loop with all stdout side effects suppressed, then prints a
// single structured JSON result. Designed for scripting / CI consumption:
//   deepseek --output-format json --yolo "summarize src/"
interface JsonOneShotDeps {
  apiKey: string;
  model: string;
  reasoning?: boolean;
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  baseUrl?: string;
  tools: ToolRegistry;
  permissions: PermissionManager;
  toolCtx: ToolContext;
  prompt: string;
  signal?: AbortSignal;
  reasoningEffort?: "high" | "max";
  maxContext?: number;
  spawnAgent?: (prompt: string, opts?: { description?: string; cwd?: string }) => Promise<string>;
}

export async function runJsonOneShot(session: Session, deps: JsonOneShotDeps): Promise<void> {
  setOutputSilent(true);
  let result;
  try {
    result = await runAgentLoop(session.messages, {
      apiKey: deps.apiKey,
      model: deps.model,
      reasoning: deps.reasoning,
      reasoningEffort: deps.reasoningEffort,
      maxContext: deps.maxContext,
      temperature: deps.temperature,
      maxTokens: deps.maxTokens,
      maxIterations: deps.maxIterations,
      baseUrl: deps.baseUrl,
      tools: deps.tools,
      permissions: deps.permissions,
      cwd: session.cwd,
      signal: deps.signal,
      spawnAgent: deps.spawnAgent,
      // No streaming callbacks in JSON mode — we only emit the final blob.
    });
  } finally {
    setOutputSilent(false);
  }
  session.messages = result.messages;
  if (result.usage && (result.usage.promptTokens || result.usage.completionTokens)) {
    session.tokenUsage = accumulateUsage(session.tokenUsage, result.usage);
  }
  const payload = {
    ok: !result.aborted,
    aborted: result.aborted ?? false,
    model: deps.model,
    prompt: deps.prompt,
    finalText: result.finalText,
    iterations: result.iterations,
    messageCount: result.messages.length,
    usage: result.usage ?? null,
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function pickModel(name: string): string {
  if (findModel(name)) return name;
  printSystem(`Unknown model '${name}' — defaulting to ${DEFAULT_MODEL}`, "yellow");
  return DEFAULT_MODEL;
}

function ensureSystemPrefix(messages: ChatMessage[], systemPrompt: string): void {
  if (messages.length === 0 || messages[0].role !== "system") {
    messages.unshift({ role: "system", content: systemPrompt });
    return;
  }
  messages[0].content = systemPrompt;
}

function printWelcome(model: string, reasoning: boolean, yolo: boolean, baseUrl?: string): void {
  const lines: string[] = [];
  lines.push(
    `${paint.gray("model:")} ${paint.cyan(model)}` +
      `${reasoning ? ` ${paint.gray("· reasoning on")}` : ""}` +
      `${yolo ? ` ${paint.bright.yellow("· yolo")}` : ""}`,
  );
  lines.push(`${paint.gray("cwd:")}   ${paint.gray(process.cwd())}`);
  if (baseUrl) lines.push(`${paint.gray("api:")}   ${paint.gray(baseUrl)}`);
  printBordered(`${symbol.rocket} DeepSeek CLI`, lines.join("\n"), "magenta");
}

export interface SlashCtx {
  apiKey: string;
  model: string;
  temperature?: number;
  tools: ToolRegistry;
  setModel: (id: string) => void;
  skills: SkillsApi;
  mcp: McpApi;
  reasoning: { get: () => boolean; set: (on: boolean) => Promise<void> };
  effort: { get: () => "high" | "max" | undefined; set: (e: "high" | "max") => Promise<void> };
  context: { get: () => number | undefined; set: (n: number) => Promise<void> };
}

/** Skills API handed to the slash handler (built in runChat). */
interface SkillsApi {
  list: () => Promise<import("../skills/store.ts").SkillEntry[]>;
  active: () => string[];
  toggle: (name: string) => Promise<boolean>;
  clear: () => void;
}

/** MCP API handed to the /mcp slash handler. */
interface McpApi {
  servers: () => { name: string; enabled: boolean; toolCount: number }[];
  toggle: (name: string) => boolean;
  toolsForServer: (name: string) => Tool[];
}

export async function handleSlashCommand(input: string, session: Session, ctx: SlashCtx): Promise<"exit" | "continue"> {
  const trimmed = input.slice(1).trim();
  const [cmd, ...rest] = trimmed.split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "help":
    case "?":
      printSlashHelp();
      return "continue";
    case "exit":
    case "quit":
    case "q":
      return "exit";
    case "clear":
      session.messages = session.messages.filter((m) => m.role === "system");
      printSystem(`${symbol.trash} context cleared`, "yellow");
      return "continue";
    case "model": {
      const target = rest[0];
      if (!target) {
        // Interactive arrow-key picker when a TTY is available; otherwise list.
        const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
        if (isTTY) {
          const opts = MODELS.map((m) => ({
            label: `${pad(m.id, 20)} ${paint.gray(m.description)}`,
            value: m.id,
          }));
          const cur = opts.findIndex((o) => o.value === session.model);
          const picked = await selectOption("Select model", opts, Math.max(0, cur));
          if (picked) {
            ctx.setModel(picked);
            const note = isReasoningModel(picked) ? " (reasoning on)" : "";
            printSystem(`switched model to ${picked}${note}`, "green");
          } else {
            printSystem("model switch cancelled", "yellow");
          }
          return "continue";
        }
        // Non-TTY fallback: plain listing.
        writeLine(paint.gray("available models:"));
        for (const m of MODELS) {
          const cur = m.id === session.model ? paint.green("← current") : "";
          writeLine(`  ${paint.cyan(pad(m.id, 20))} ${paint.gray(m.description)} ${cur}`);
        }
        writeLine(paint.gray("\n/model <name>  — switch (catalog name or any model id)"));
        return "continue";
      }
      const known = findModel(target);
      ctx.setModel(target);
      if (known) {
        const note = known.thinking ? " (reasoning on)" : isReasoningModel(target) ? " (reasoning on)" : "";
        printSystem(`switched model to ${target}${note}`, "green");
      } else {
        printSystem(`switched model to ${target} (non-catalog; reasoning defaults off)`, "yellow");
      }
      return "continue";
    }
    case "new": {
      // Start a fresh session: new id, cleared context, kept model/cwd.
      const oldId = session.id;
      session.id = newSessionId();
      session.createdAt = new Date().toISOString();
      session.updatedAt = session.createdAt;
      session.messages = session.messages.filter((m) => m.role === "system");
      session.tokenUsage = undefined;
      printSystem(`${symbol.trash} new session started (was ${oldId}) — context cleared`, "yellow");
      return "continue";
    }
    case "skill": {
      const arg = rest[0];
      if (!arg) {
        const entries = await ctx.skills.list();
        const active = new Set(ctx.skills.active());
        if (entries.length === 0) {
          writeLine(paint.gray("(no skills found)"));
          writeLine(paint.gray("create one: deepseek skill create <name>"));
          return "continue";
        }
        // Interactive arrow-key picker in a TTY: selecting a skill activates it
        // so subsequent turns prioritize its instructions.
        const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
        if (isTTY) {
          const opts = [
            { label: paint.gray("(none — clear active skills)"), value: "__clear__" },
            ...entries.map((e) => ({
              label: `${active.has(e.name) ? paint.green("●") : paint.gray("○")} ${e.name} ${paint.gray(`[${e.source}]`)}`,
              value: e.name,
            })),
          ];
          const picked = await selectOption("Select a skill to activate", opts, 1);
          if (picked === "__clear__") {
            ctx.skills.clear();
            printSystem("all skills deactivated", "yellow");
          } else if (picked) {
            if (active.has(picked)) {
              printSystem(`skill '${picked}' already active`, "green");
            } else {
              await ctx.skills.toggle(picked);
              printSystem(`skill '${picked}' activated — prioritized for upcoming turns`, "green");
            }
          } else {
            printSystem("skill selection cancelled", "yellow");
          }
          return "continue";
        }
        // Non-TTY fallback: plain listing.
        writeLine(paint.gray("available skills:"));
        for (const e of entries) {
          const mark = active.has(e.name) ? paint.green("●") : paint.gray("○");
          writeLine(`  ${mark} ${pad(e.name, 20)} ${paint.gray(`[${e.source}]`)}`);
        }
        writeLine(paint.gray("\n/skill <name> toggles · /skill clear deactivates all"));
        return "continue";
      }
      if (arg === "clear" || arg === "off") {
        ctx.skills.clear();
        printSystem("all skills deactivated", "yellow");
        return "continue";
      }
      try {
        const on = await ctx.skills.toggle(arg);
        printSystem(on ? `skill '${arg}' activated` : `skill '${arg}' deactivated`, on ? "green" : "yellow");
      } catch (e) {
        printError(e instanceof Error ? e.message : String(e));
      }
      return "continue";
    }
    case "mcp": {
      const arg = rest[0];
      const list = ctx.mcp.servers();
      if (list.length === 0) {
        writeLine(paint.gray("(no MCP servers connected; configure ~/.deepseek-cli/mcp.json or ./.mcp.json)"));
        return "continue";
      }
      if (!arg) {
        writeLine(paint.gray("mcp servers:"));
        for (const s of list) {
          const mark = s.enabled ? paint.green("●") : paint.gray("○");
          writeLine(`  ${mark} ${pad(s.name, 20)} ${paint.gray(s.toolCount + " tool" + (s.toolCount === 1 ? "" : "s"))}`);
        }
        writeLine(paint.gray("\n/mcp <name> toggles a server's tools on/off"));
        return "continue";
      }
      const target = list.find((s) => s.name === arg);
      if (!target) {
        printError(`unknown mcp server '${arg}'`);
        return "continue";
      }
      const nowEnabled = ctx.mcp.toggle(arg);
      if (nowEnabled) {
        for (const t of ctx.mcp.toolsForServer(arg)) ctx.tools.register(t);
        printSystem(`mcp '${arg}' enabled (${target.toolCount} tools)`, "green");
      } else {
        for (const t of ctx.mcp.toolsForServer(arg)) ctx.tools.unregister(t.name);
        printSystem(`mcp '${arg}' disabled`, "yellow");
      }
      return "continue";
    }
    case "reasoning":
    case "thinking": {
      const arg = rest[0]?.toLowerCase();
      if (!arg) {
        const state = ctx.reasoning.get() ? paint.green("on") : paint.yellow("off");
        const effort = ctx.effort.get() ?? "high";
        printSystem(`reasoning ${state} · effort ${effort}`, ctx.reasoning.get() ? "green" : "yellow");
        return "continue";
      }
      if (arg === "on" || arg === "true" || arg === "1") {
        await ctx.reasoning.set(true);
        printSystem("reasoning on (saved as default)", "green");
        return "continue";
      }
      if (arg === "off" || arg === "false" || arg === "0") {
        await ctx.reasoning.set(false);
        printSystem("reasoning off (saved as default)", "yellow");
        return "continue";
      }
      if (arg === "effort" || arg === "intensity") {
        const e = rest[1]?.toLowerCase();
        if (e !== "high" && e !== "max") {
          printError("usage: /reasoning effort high|max");
          return "continue";
        }
        await ctx.effort.set(e as "high" | "max");
        printSystem(`reasoning effort set to ${e} (saved)`, "green");
        return "continue";
      }
      printError("usage: /reasoning on|off|effort high|max");
      return "continue";
    }
    case "log":
      printSystem(`log file: ${log.filePath}`, "blue");
      return "continue";
    case "context": {
      const arg = rest[0];
      if (!arg) {
        printSystem(`context budget: ${ctx.context.get() ?? 60000} tokens`, "blue");
        return "continue";
      }
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 4000) {
        printError("usage: /context <tokens>  (minimum 4000)");
        return "continue";
      }
      await ctx.context.set(n);
      printSystem(`context budget set to ${n} tokens (saved)`, "green");
      return "continue";
    }
    case "tokens":
    case "size": {
      const t = estimateConversationTokens(session.messages);
      writeLine(paint.gray(`conversation: ${session.messages.length} messages, ~${t} tokens (estimate)`));
      if (session.tokenUsage) {
        const u = session.tokenUsage;
        writeLine(
          paint.gray(
            `real usage: ${u.prompt} prompt + ${u.completion} completion = ${u.total} total` +
              ` over ${u.turns} turn(s)`,
          ),
        );
      }
      return "continue";
    }
    case "save": {
      await saveSession(session);
      printSystem(`saved session ${session.id}`, "green");
      return "continue";
    }
    case "undo": {
      const idx = lastUserIndex(session.messages);
      if (idx <= 0) {
        printSystem("nothing to undo", "yellow");
        return "continue";
      }
      const removed = session.messages.length - idx;
      session.messages.length = idx;
      printSystem(`undid last turn (${removed} message(s) removed)`, "yellow");
      return "continue";
    }
    case "export": {
      const target = rest[0];
      const md = exportTranscript(session);
      if (target) {
        try {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(target, md, "utf-8");
          printSystem(`exported ${session.messages.length} messages to ${target}`, "green");
        } catch (e) {
          printError(`failed to write ${target}: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        writeLine(md);
      }
      return "continue";
    }
    case "sessions": {
      const query = rest.join(" ").trim();
      const list = query ? await searchSessions(query, 10) : await listSessions(10);
      if (list.length === 0) {
        writeLine(paint.gray(query ? `(no sessions matching "${query}")` : "(no saved sessions)"));
      } else {
        for (const s of list) writeLine(`${paint.cyan(s.id)}  ${paint.gray(s.updatedAt)}  ${s.messages.length} msgs`);
      }
      return "continue";
    }
    case "tools": {
      writeLine(paint.gray("registered tools:"));
      for (const t of ctx.tools.list()) {
        writeLine(`  ${pad(t.name, 16)} ${paint.gray(t.description.split(".")[0])}`);
      }
      return "continue";
    }
    case "system": {
      const sys = session.messages.find((m) => m.role === "system");
      const text = typeof sys?.content === "string" ? sys.content : "(no system prompt)";
      writeLine(paint.gray(text));
      return "continue";
    }
    case "yolo":
      printSystem("yolo is a startup flag — restart with --yolo to enable", "yellow");
      return "continue";
    default:
      printError(`unknown command /${cmd}. Try /help.`);
      return "continue";
  }
}

function printSlashHelp(): void {
  blank();
  writeLine(paint.bold("Slash commands:"));
  const cmds: [string, string][] = [
    ["/help", "show this help"],
    ["/exit", "exit the session"],
    ["/clear", "wipe conversation history (keep system prompt)"],
    ["/model [name]", "arrow-key model picker, or switch to a specific id"],
    ["/reasoning [on|off|effort high|max]", "show/set thinking default + intensity"],
    ["/context [tokens]", "show/set the context-trim budget"],
    ["/log", "show the log file path"],
    ["/new", "start a fresh session, clearing context"],
    ["/skill [name]", "list skills, or toggle a skill on/off"],
    ["/mcp [name]", "list MCP servers, or toggle a server's tools"],
    ["/tokens", "show token usage (estimate + real)"],
    ["/tools", "list registered tools"],
    ["/system", "show the active system prompt"],
    ["/save", "save session now"],
    ["/undo", "drop the last turn (user + reply messages)"],
    ["/retry", "re-run the last user prompt (drops the previous reply)"],
    ["/export [path]", "dump the transcript to stdout or a file"],
    ["/sessions [query]", "list recent sessions (or search by keyword)"],
  ];
  for (const [cmd, desc] of cmds) {
    writeLine(`  ${paint.cyan(pad(cmd, 18))} ${paint.gray(desc)}`);
  }
  writeLine(paint.gray("\nmulti-line: end a line with '\\' or wrap a block in ``` to continue"));
  blank();
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/**
 * Expand @path references in the user's prompt: any `@<path>` token (not an
 * email) is resolved relative to cwd; the file's contents are appended in a
 * <referenced_files> block so the model sees the text inline. Missing/non-file
 * paths are annotated rather than dropped.
 */
export async function expandFileRefs(text: string, cwd: string): Promise<string> {
  // Match @path tokens, but not emails (require start-of-line or whitespace
  // before @, and no @ inside the path).
  const re = /(^|\s)@([^\s@]+)/g;
  const paths: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[2];
    if (seen.has(raw)) continue;
    seen.add(raw);
    paths.push(raw);
  }
  if (paths.length === 0) return text;
  const blocks: string[] = [];
  let attached = 0;
  for (const raw of paths) {
    const p = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    try {
      const st = await fs.stat(p);
      if (!st.isFile()) {
        blocks.push(`<file path="${raw}">(not a file — use list_dir/glob to inspect)`);
        continue;
      }
      if (st.size > 200_000) {
        blocks.push(`<file path="${raw}">(file too large: ${st.size} bytes — use read_file with offset/limit)`);
        continue;
      }
      const content = await fs.readFile(p, "utf-8");
      blocks.push(`<file path="${raw}">\n${content}\n</file>`);
      attached++;
    } catch {
      blocks.push(`<file path="${raw}">(not found)`);
    }
  }
  const anyUseful = blocks.some((b) => !b.includes("(not found)") && !b.includes("(not a file"));
  if (attached === 0 && !anyUseful) {
    return text; // nothing useful to attach; leave prompt untouched
  }
  return `${text}\n\n<referenced_files>\n${blocks.join("\n")}\n</referenced_files>`;
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function exportTranscript(session: Session): string {
  const out: string[] = [];
  out.push(`# DeepSeek CLI — session ${session.id}`);
  out.push(`model: ${session.model} · cwd: ${session.cwd} · ${session.createdAt}`);
  out.push("");
  for (const m of session.messages) {
    if (m.role === "system") continue;
    const who = m.role === "user" ? "You" : m.role === "assistant" ? "DeepSeek" : m.role;
    const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    out.push(`## ${who}`);
    out.push(body || "(empty)");
    out.push("");
  }
  if (session.tokenUsage) {
    const u = session.tokenUsage;
    out.push(`---\n_tokens: ${u.prompt} prompt + ${u.completion} completion = ${u.total} over ${u.turns} turns_`);
  }
  return out.join("\n");
}
