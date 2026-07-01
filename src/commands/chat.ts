// Default chat command. Drives the agent loop for both one-shot prompts and
// the interactive REPL. Owns session lifecycle, tool/permission wiring, and
// the on-screen rendering of streaming output.

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ChatMessage } from "../api/client.ts";
import { DEFAULT_MODEL, findModel, isReasoningModel, MODELS, resolveAutoModel } from "../api/models.ts";
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
import { appendPromptLog, buildEntry, countPromptLog, loadPromptLog, searchPromptLog, clearPromptLog, promptLogFile, type PromptLogEntry } from "../session/promptLog.ts";
import { listSkills, readSkill } from "../skills/store.ts";
import { McpRegistry, loadMcpConfig } from "../mcp/registry.ts";
import type { McpServerConfig } from "../mcp/registry.ts";
import { parseAddArgs, addServerToConfig } from "./mcp.ts";
import { log } from "../log/logger.ts";
import { VERSION } from "../cli.ts";
import { paint, symbol } from "../ui/theme.ts";
import { blank, printBordered, printError, printSeparator, printSystem, printTip, setOutputSilent, writeLine } from "../ui/render.ts";
import { outputSilent } from "../ui/theme.ts";
import { askMultiline, closeReadline, restoreTerminal, selectOption, watchTurnInput } from "../ui/input.ts";
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
  noPromptLog?: boolean;
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
  // Prompt logging: default on (config), disabled by --no-prompt-log or config.
  let promptLogOn = args.noPromptLog !== true && cfg.promptLog !== false;
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
    // Persist the chosen model + its default reasoning so the next launch
    // uses the user's most recent selection. (The /reasoning command and the
    // model wizard's effort/context steps can still override reasoning/effort/
    // context afterward, and those persist too.) Fire-and-forget: the prompt
    // rebuild below is synchronous and is what the current turn needs.
    cfg.defaultModel = id;
    cfg.reasoning = reasoning;
    saveConfig(cfg).catch(() => {});
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

  // Toggle per-turn prompt logging (persisted as the default for future
  // sessions). The /promptlog slash command uses this.
  const setPromptLog = async (on: boolean): Promise<void> => {
    promptLogOn = on;
    cfg.promptLog = on;
    await saveConfig(cfg);
  };

  // Sub-agent spawner surfaced to the `task` tool. Runs a nested agent loop
  // silently with its own (small) context + iteration budget; multiple `task`
  // calls in one turn run in parallel via the parent loop's Promise.all.
  //
  // Sub-agents always run on the fast model (deepseek-v4-flash) with reasoning
  // OFF and a 60k context budget — they're typically read-only analysis tasks,
  // so inheriting the parent's flagship model + 1M context + max reasoning is
  // pure overhead that can turn a 5s subtask into a 120s one.
  //
  // After the sub-agent finishes, the file paths it read are extracted from
  // its tool-call history and appended to the returned text so the main
  // session knows which files are already explored (avoids re-reading them).
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
        model: DEFAULT_MODEL,            // fast model, not the parent's flagship
        reasoning: false,                // no chain-of-thought for sub-tasks
        reasoningEffort: undefined,
        maxContext: 60_000,              // bounded budget, not the parent's 1M
        temperature,
        maxTokens,
        maxIterations: 10,
        baseUrl,
        tools,
        permissions,
        cwd: opts?.cwd ?? cwd,
        spawnAgent, // allow further nesting up to the depth cap
      });
      // Collect file paths the sub-agent read, so the main session can reuse
      // them instead of re-reading the same files in a follow-up turn.
      const filesAccessed = extractReadFilePaths(r.messages);
      if (filesAccessed.length > 0) {
        return `${r.finalText}\n\n<files_accessed>\n${filesAccessed.join("\n")}\n</files_accessed>`;
      }
      return r.finalText;
    } finally {
      setOutputSilent(wasSilent);
      subagentDepth--;
    }
  };

  // `/btw <q>` side-turn driver. Runs a fresh, throwaway conversation with
  // the live model/tools/system-prompt(s) but does NOT touch the main
  // session's messages or token usage, and does NOT persist. So you can ask
  // a clarifying question mid-session and return to the main thread with the
  // context intact. Visible to the user (unlike spawnAgent, which is silent).
  const runSideTurn = async (prompt: string): Promise<void> => {
    printSeparator();
    printSystem(`${symbol.robot} btw — side question (main session untouched)`, "magenta");

    // Carry only the system-prompt messages; drop the user/assistant thread
    // so the model isn't biased by the running conversation.
    const sideMessages: ChatMessage[] = [
      ...session.messages.filter((m) => m.role === "system"),
      { role: "user", content: await expandFileRefs(prompt, cwd) },
    ];
    const sideSession: Session = {
      id: newSessionId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model,
      cwd: session.cwd,
      messages: sideMessages,
    };

    // Cap iterations so a runaway side turn can't dominate the REPL.
    const sideMaxIter = Math.min(maxIterations ?? 30, 10);
    const turn = beginTurn();
    try {
      await driveTurn(sideSession, {
        apiKey, model, reasoning, temperature, maxTokens,
        maxIterations: sideMaxIter,
        baseUrl, reasoningEffort, maxContext,
        tools, permissions, toolCtx,
        signal: turn.controller.signal,
        spawnAgent,
        promptLog: { get: () => false }, // side turns are throwaway; never logged
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      printError(`btw turn failed: ${msg}`);
    } finally {
      turn.stop();
    }
    printSystem("btw done — back to main session", "magenta");
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
  // MCP child processes are torn down on exit via `await mcp.close()` in the
  // finally blocks below.

  // Surface server enable/disable + per-server tools to the /mcp command.
  const mcpApi: McpApi = {
    servers: () => mcp.status().map((s) => ({ name: s.name, enabled: s.enabled, toolCount: s.toolCount, dangerous: s.dangerous === true, scope: s.scope })),
    toggle: (name: string) => mcp.toggleServer(name),
    toolsForServer: (name: string) => mcp.toolsForServer(name),
    add: async (parsed) => {
      try {
        await addServerToConfig(parsed, cwd); // persist to mcp.json (session cwd)
        const cfg: McpServerConfig = {
          command: parsed.command,
          args: parsed.args.length ? parsed.args : undefined,
          env: Object.keys(parsed.env).length ? parsed.env : undefined,
          isDangerous: parsed.isDangerous ? true : undefined,
          _scope: parsed.project ? "project" : "global",
        };
        const res = await mcp.addServer(parsed.name, cfg); // live connect
        if (res.ok) for (const t of mcp.toolsForServer(parsed.name)) tools.register(t);
        return { ok: res.ok, toolCount: res.toolCount, error: res.error };
      } catch (e) {
        return { ok: false, toolCount: 0, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };

  // Permission API for the /allow and /approve commands.
  const permsApi: PermsApi = {
    dangerousTools: () => tools.list().filter((t) => t.isDangerous).map((t) => t.name),
    isAllowed: (name: string) => permissions.isToolAllowed(name),
    allow: (name: string) => permissions.allowTool(name),
    clear: () => permissions.clearToolAllows(),
    approvalMode: () => permissions.mode,
    setApprovalMode: async (mode: "ask" | "auto") => {
      permissions.setMode(mode);
      cfg.approvalMode = mode;
      await saveConfig(cfg);
    },
  };

  const toolCtx: ToolContext = { cwd };

  // Per-turn abort holder. SIGINT aborts the active turn; a second SIGINT with
  // no active turn force-quits the process. A double-tap of Escape also aborts
  // the active turn (see watchTurnInput) — convenient when the user's hands
  // are on the home row and they want to bail back to the prompt.
  //
  // Input queue: while the AI is working, the user can type and press Enter
  // to queue follow-up prompts. When the turn ends, queued prompts are
  // auto-submitted one by one. Each queued prompt is displayed with a
  // [Queued] marker so the user knows it was typed mid-turn.
  const inputQueue: string[] = [];
  const turnAbort: { current: AbortController | null } = { current: null };
  let exitFlagged = false;
  const onSigInt = () => {
    if (turnAbort.current) {
      turnAbort.current.abort();
      return;
    }
    if (exitFlagged) {
      writeLine();
      restoreTerminal();
      process.exit(130);
    }
    exitFlagged = true;
    writeLine(paint.yellow("\n(interrupt — type /exit to quit, or Ctrl-C again to force)"));
  };
  process.on("SIGINT", onSigInt);

  // Begin a turn: create the AbortController, register it as the active
  // cancellable turn (so SIGINT can abort it), and arm the input watcher
  // that captures both double-Esc (abort) and regular typing (queue).
  // Returns the controller + a stop() that unarms everything and clears the
  // active slot. Call stop() in the turn's finally.
  const beginTurn = (): { controller: AbortController; stop: () => void } => {
    const controller = new AbortController();
    turnAbort.current = controller;
    const stopInput = watchTurnInput(
      () => controller.abort(),
      (text) => inputQueue.push(text),
      (buf, queuedCount) => {
        // Update the spinner to show what the user is typing + queued count.
        // The spinner is restarted each iteration, so we only update if it's
        // active (during the thinking/tool phase).
        const queuedTag = queuedCount > 0 ? paint.gray(` (${queuedCount} queued)`) : "";
        if (buf) {
          spinner.update(`thinking…${queuedTag} ${paint.dim("› " + buf)}`);
        } else if (queuedCount > 0) {
          spinner.update(`thinking…${queuedTag}`);
        }
      },
    );
    return {
      controller,
      stop: () => {
        stopInput();
        turnAbort.current = null;
      },
    };
  };

  // ---- One-shot mode ----
  if (args.prompt) {
    session.messages.push({ role: "user", content: await expandFileRefs(args.prompt, cwd) });
    const turn = beginTurn();
    try {
      if (args.outputFormat === "json") {
        await runJsonOneShot(session, {
          apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl, reasoningEffort, maxContext,
          tools, permissions, toolCtx, prompt: args.prompt, signal: turn.controller.signal, spawnAgent,
        });
      } else {
        await driveTurn(session, {
          apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl, reasoningEffort, maxContext,
          tools, permissions, toolCtx, signal: turn.controller.signal, spawnAgent,
          promptLog: { get: () => promptLogOn }, promptVariant: session.promptVariant,
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
      turn.stop();
      process.off("SIGINT", onSigInt);
      await mcp.close().catch(() => {});
      restoreTerminal();
      closeReadline();
      process.exit(0);
    }
    return;
  }

  // ---- Interactive REPL ----
  printWelcome(model, reasoning, skipAll, baseUrl);
  printTip("type /help for commands · type during AI turns to queue prompts · double-tap Esc to abort · /exit to quit · /fast ↔ /think to switch model");
  blank();

  let firstPrompt = true;
  const history = await loadHistory();
  // Pre-fill carrier between a slash command (e.g. /skill picker) and the next
  // prompt, so the chosen "/skillname " shows in the input area for inline task
  // entry.
  const prefillHolder: { value: string } = { value: "" };
  let prefill = "";
  try {
    while (true) {
      let input: string;
      // Check for queued input first (typed during the previous AI turn).
      // Queued prompts are auto-submitted with a [Queued] marker so the user
      // knows which prompts were typed mid-turn and are still pending.
      if (inputQueue.length > 0) {
        input = inputQueue.shift()!;
        if (!firstPrompt) printSeparator();
        firstPrompt = false;
        writeLine(`${paint.bold(paint.bright.cyan(`${symbol.user}`))} ${paint.gray("›")} ${paint.yellow("[Queued]")} ${input}`);
      } else {
        try {
          // A subtle rule between turns gives the REPL a Claude-Code-like rhythm.
          if (!firstPrompt) printSeparator();
          firstPrompt = false;
          input = await askMultiline(
            `${paint.bold(paint.bright.cyan(`${symbol.user}`))} ${paint.gray("›")} `,
            history,
            completeSlash, // live slash-command suggestions + Tab completion
            prefill || undefined,
          );
          prefill = "";
        } catch {
          break;
        }
      }
      exitFlagged = false;
      const trimmed = input.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("/")) {
        const lowerCmd = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase();
        // /<skillname> <task>  →  activate that skill, run <task> with it.
        // Slash commands (help/model/skill/…) take precedence so a skill can't
        // shadow them; everything else starting with "/" is tried as a skill id.
        const inv = parseSlashSkillInvocation(trimmed);
        if (inv) {
          const skillContent = await readSkill(inv.name, cwd);
          if (skillContent) {
            if (!activeSkills.has(inv.name)) {
              activeSkills.set(inv.name, skillContent.content);
              rebuildSystemPrompt();
            }
            if (!inv.task) {
              printSystem(`skill '${inv.name}' active — type your task`, "green");
              continue;
            }
            session.messages.push({ role: "user", content: await expandFileRefs(inv.task, cwd) });
            history.unshift(inv.task);
            if (history.length > 1000) history.length = 1000;
            appendHistory(inv.task).catch(() => {});
            const turn = beginTurn();
            try {
              await driveTurn(session, {
                apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl, reasoningEffort, maxContext,
                tools, permissions, toolCtx, signal: turn.controller.signal, spawnAgent,
                promptLog: { get: () => promptLogOn }, promptVariant: session.promptVariant,
              });
              await saveSession(session);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              printError(`turn failed: ${msg}`);
            } finally {
              turn.stop();
            }
            continue;
          }
          // Not a skill either: give a skill-aware hint.
          printError(`unknown command /${inv.name} (use /skill to pick one)`);
          continue;
        }
        if (lowerCmd === "retry") {
          const idx = lastUserIndex(session.messages);
          if (idx < 0) {
            printSystem("no previous prompt to retry", "yellow");
            continue;
          }
          // Drop everything after the last user message, then re-run the turn.
          session.messages.length = idx + 1;
          const turn = beginTurn();
          try {
            await driveTurn(session, {
              apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl, reasoningEffort, maxContext,
              tools, permissions, toolCtx, signal: turn.controller.signal, spawnAgent,
              promptLog: { get: () => promptLogOn }, promptVariant: session.promptVariant,
            });
            await saveSession(session);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            printError(`turn failed: ${msg}`);
          } finally {
            turn.stop();
          }
          continue;
        }
        const handled = await handleSlashCommand(trimmed, session, { apiKey, model, temperature, tools, setModel: applyModel, skills: skillsApi, mcp: mcpApi, reasoning: { get: () => reasoning, set: setReasoning }, effort: { get: () => reasoningEffort, set: setReasoningEffort }, context: { get: () => maxContext, set: setMaxContext }, promptLog: { get: () => promptLogOn, set: setPromptLog }, permissions: permsApi, prefillHolder, runSideTurn });
        if (prefillHolder.value) { prefill = prefillHolder.value; prefillHolder.value = ""; }
        if (handled === "exit") break;
        continue;
      }

      session.messages.push({ role: "user", content: await expandFileRefs(trimmed, cwd) });
      // Remember the prompt for Up/Down recall (newest-first) + persist.
      history.unshift(trimmed);
      if (history.length > 1000) history.length = 1000;
      appendHistory(trimmed).catch(() => {});
      const turn = beginTurn();
      try {
        await driveTurn(session, {
          apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl, reasoningEffort, maxContext,
          tools, permissions, toolCtx, signal: turn.controller.signal, spawnAgent,
          promptLog: { get: () => promptLogOn }, promptVariant: session.promptVariant,
        });
        await saveSession(session);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        printError(`turn failed: ${msg}`);
      } finally {
        turn.stop();
      }
    }
  } finally {
    process.off("SIGINT", onSigInt);
    await saveSession(session).catch(() => {});
    await mcp.close().catch(() => {});
    restoreTerminal();
    closeReadline();
    printSystem("Goodbye! 👋", "magenta");
    // Force-exit so lingering handles (logger writes, MCP child pipes) can't
    // keep the process alive and trap the user's terminal after /exit.
    process.exit(0);
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
  /** Whether per-turn prompt logging is enabled (runtime-toggleable). */
  promptLog?: { get: () => boolean };
  /** System-prompt variant tag to stamp on log entries. */
  promptVariant?: string;
}

async function driveTurn(session: Session, deps: TurnDeps): Promise<void> {
  // Resolve "auto" model based on the latest user prompt.
  let model = deps.model;
  let reasoning = deps.reasoning;
  if (model === "auto") {
    const lastUser = [...session.messages].reverse().find((m) => m.role === "user");
    const promptText = typeof lastUser?.content === "string" ? lastUser.content : "";
    const resolved = resolveAutoModel(promptText);
    model = resolved.model;
    reasoning = resolved.reasoning;
    printSystem(`auto → ${model}${reasoning ? " (reasoning)" : ""}`, "cyan");
  }
  const renderer = makeStreamRenderer({ showReasoning: reasoning === true, model });
  const turnStart = performance.now();
  // Collect tool names executed during the turn for the prompt log entry.
  const toolNames: string[] = [];
  let toolCallCount = 0;

  const onToolEnd = (name: string, result: ToolResult) => {
    toolCallCount++;
    if (!toolNames.includes(name)) toolNames.push(name);
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
      model,
      reasoning,
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
      onToolStart: () => { renderer.flush(); return true; },
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

  const durationMs = Math.round(performance.now() - turnStart);

  // Surface per-turn usage to the user, plus the elapsed duration when the
  // turn was non-trivial (>= 5s) so the user can perceive per-phase cost.
  const parts: string[] = [];
  if (result.usage && result.usage.totalTokens) {
    const u = result.usage;
    parts.push(
      `tokens: ${u.promptTokens ?? "?"} prompt → ${u.completionTokens ?? "?"} completion` +
        ` · session ${session.tokenUsage?.total ?? u.totalTokens} total`,
    );
  }
  if (durationMs >= 5000) {
    parts.push(`elapsed ${fmtDuration(durationMs)}`);
  }
  if (result.aborted) parts.push("interrupted");
  if (parts.length > 0) {
    writeLine(paint.gray("  " + parts.join(" · ")));
  } else if (result.aborted) {
    printSystem("turn interrupted", "yellow");
  }

  // Record the turn in the prompt log (if enabled) for retrospective
  // prompt/system-prompt optimization. Best-effort, fire-and-forget.
  if (deps.promptLog?.get() !== false) {
    const promptText = lastUserText(session.messages);
    if (promptText) {
      const turnIndex = countUserMessages(session.messages);
      appendPromptLog(buildEntry({
        sessionId: session.id,
        turn: turnIndex,
        prompt: promptText,
        model,
        promptVariant: deps.promptVariant ?? session.promptVariant,
        reasoning,
        reasoningEffort: deps.reasoningEffort,
        iterations: result.iterations,
        toolCalls: toolCallCount,
        tools: toolNames,
        usage: result.usage,
        finalTextLen: result.finalText.length,
        aborted: result.aborted,
        durationMs,
      })).catch(() => {});
    }
  }
}

/** Format a millisecond duration into a compact, human-readable string. */
function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem}s`;
}

/** Extract the last user message's text content (for the prompt log). */
function lastUserText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      return typeof m.content === "string" ? m.content : "";
    }
  }
  return null;
}

/** Count user messages in the conversation (= the turn index of the latest). */
function countUserMessages(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "user") n++;
  }
  return n;
}

/**
 * Extract unique file paths from read_file / read_files tool calls in a
 * sub-agent's message history. Lets the main session know which files were
 * already explored so it doesn't wastefully re-read them in a follow-up turn.
 */
export function extractReadFilePaths(messages: ChatMessage[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const fn = tc.function;
      if (!fn) continue;
      if (fn.name !== "read_file" && fn.name !== "read_files") continue;
      try {
        const args = JSON.parse(fn.arguments || "{}") as Record<string, unknown>;
      // read_file: single filePath; read_files: filePaths array
      const fp = args.filePath;
      const fps = args.filePaths;
      if (typeof fp === "string" && !seen.has(fp)) {
        seen.add(fp);
        paths.push(fp);
      }
      if (Array.isArray(fps)) {
        for (const p of fps) {
          if (typeof p === "string" && !seen.has(p)) {
            seen.add(p);
            paths.push(p);
          }
        }
      }
      } catch {
        /* skip malformed tool call args */
      }
    }
  }
  return paths;
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
  /** Per-turn prompt logging toggle (default on; off = no local recording). */
  promptLog: { get: () => boolean; set: (on: boolean) => Promise<void> };
  permissions: PermsApi;
  /** Lets a slash command (e.g. /skill picker) request the next prompt be
   *  pre-filled with the given text (e.g. "/skillname "). */
  prefillHolder: { value: string };
  /** `/btw <q>` — run a throwaway side turn with its own context; the
   *  main session's messages + token usage are not touched and nothing is
   *  persisted. The side turn renders to stdout so the user sees the answer. */
  runSideTurn: (prompt: string) => Promise<void>;
}

/** Permission API handed to the /allow and /approve slash commands. */
interface PermsApi {
  dangerousTools: () => string[];
  isAllowed: (name: string) => boolean;
  allow: (name: string) => void;
  clear: () => void;
  /** Current approval mode ("auto" = no prompts, "ask" = prompt each time). */
  approvalMode: () => "ask" | "auto" | "yolo" | "deny-pure-shell";
  setApprovalMode: (mode: "ask" | "auto") => Promise<void>;
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
  servers: () => { name: string; enabled: boolean; toolCount: number; dangerous: boolean; scope?: "global" | "project" }[];
  toggle: (name: string) => boolean;
  toolsForServer: (name: string) => Tool[];
  /** Add a server live: write config + spawn/connect + register tools.
   *  Returns { ok, toolCount, error? }. */
  add: (parsed: import("./mcp.ts").ParsedMcpAdd) => Promise<{ ok: boolean; toolCount: number; error?: string }>;
}

// /model setup wizard: a chained arrow-key flow that lets the user pick the
// model AND its reasoning effort + context budget in one go (Esc cancels the
// whole flow). Each step defaults to "(keep current)" so a user who only wants
// to change the model just presses Enter twice more.
type Picker = (title: string, options: { label: string; value: string }[], startAt?: number) => Promise<string | null>;

export async function runModelSetupFlow(ctx: SlashCtx, pick: Picker = selectOption): Promise<void> {
  // 1. model
  const modelOpts = MODELS.map((m) => ({ label: `${pad(m.id, 20)} ${paint.gray(m.description)}`, value: m.id }));
  const curModel = modelOpts.findIndex((o) => o.value === ctx.model);
  const modelId = await pick("Select model", modelOpts, Math.max(0, curModel));
  if (!modelId) { printSystem("model setup cancelled", "yellow"); return; }

  // 2. reasoning effort
  const curReasoning = ctx.reasoning.get();
  const curEffort = ctx.effort.get() ?? "high";
  const effortOpts = [
    { label: "(keep current)", value: "keep" },
    { label: "off (disable thinking)", value: "off" },
    { label: "high (default)", value: "high" },
    { label: "max (deepest)", value: "max" },
  ];
  let eIdx = 0;
  if (curReasoning && (curEffort === "high" || curEffort === "max")) {
    eIdx = effortOpts.findIndex((o) => o.value === curEffort);
  } else if (!curReasoning) {
    eIdx = effortOpts.findIndex((o) => o.value === "off");
  }
  const effort = await pick("Reasoning effort", effortOpts, Math.max(0, eIdx));
  if (effort === null) { printSystem("model setup cancelled", "yellow"); return; }

  // 3. context budget
  const curCtx = ctx.context.get() ?? 60000;
  const presets = [
    { label: "(keep current)", value: "keep" },
    { label: "60k (default)", value: "60000" },
    { label: "100k", value: "100000" },
    { label: "150k", value: "150000" },
    { label: "500k", value: "500000" },
    { label: "1M (max)", value: "1000000" },
  ];
  const cIdx = presets.findIndex((p) => p.value !== "keep" && Math.abs(Number(p.value) - curCtx) < 5000);
  const ctxPick = await pick("Context budget", presets, Math.max(0, cIdx));
  if (ctxPick === null) { printSystem("model setup cancelled", "yellow"); return; }

  // Apply (model is session-scoped; effort + context persist as defaults).
  // Note: setModel resets reasoning to the model's catalog default, so for the
  // "keep" branch we restore the pre-switch reasoning/effort captured above.
  ctx.setModel(modelId);
  if (effort === "off") {
    await ctx.reasoning.set(false);
  } else if (effort === "keep") {
    await ctx.reasoning.set(curReasoning);
    if (curEffort) await ctx.effort.set(curEffort);
  } else {
    await ctx.reasoning.set(true);
    await ctx.effort.set(effort as "high" | "max");
  }
  let finalContext = curCtx;
  if (ctxPick !== "keep") {
    finalContext = Number(ctxPick);
    await ctx.context.set(finalContext);
  }

  const eLabel = effort === "keep" ? (curReasoning ? curEffort : "off") : effort;
  // The summary must show the model the user actually picked (modelId), not
  // ctx.model — ctx is a snapshot taken when /model was invoked and its .model
  // field isn't updated by setModel (which mutates the closure variable).
  printSystem(`model ${modelId} · reasoning ${eLabel} · context ${fmtTokens(finalContext)}`, "green");
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  return `${Math.round(n / 1000)}k`;
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
    case "btw": {
      // /btw <question> — ask a throwaway side question without disturbing
      // the main session's history. runSideTurn drives its own context.
      const q = rest.join(" ").trim();
      if (!q) {
        printError("usage: /btw <question>  (ask a side question, keep main session intact)");
        return "continue";
      }
      await ctx.runSideTurn(q);
      return "continue";
    }
    case "fast": {
      // Exploration-phase shortcut: switch to the fastest non-thinking model
      // and disable reasoning. read_file/grep/list_dir round-trips become
      // seconds faster (no chain-of-thought before each tool call).
      ctx.setModel("deepseek-v4-flash");
      await ctx.reasoning.set(false);
      printSystem(`${symbol.bolt} fast mode — v4-flash, reasoning off (use /think to switch back)`, "green");
      return "continue";
    }
    case "think": {
      // Writing-code phase shortcut: switch to the reasoner + high effort.
      ctx.setModel("deepseek-v4-pro");
      await ctx.reasoning.set(true);
      await ctx.effort.set("high");
      printSystem(`${symbol.brain} think mode — v4-pro, reasoning high (use /fast for exploration)`, "magenta");
      return "continue";
    }
    case "model": {
      const target = rest[0];
      if (!target) {
        // Interactive setup wizard in a TTY: model → reasoning effort → context.
        const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
        if (isTTY) {
          await runModelSetupFlow(ctx);
          return "continue";
        }
        // Non-TTY fallback: plain listing.
        writeLine(paint.gray("available models:"));
        for (const m of MODELS) {
          const cur = m.id === ctx.model ? paint.green("← current") : "";
          writeLine(`  ${paint.cyan(pad(m.id, 20))} ${paint.gray(m.description)} ${cur}`);
        }
        writeLine(paint.gray("\n/model <name>  — switch (catalog name or any model id)"));
        return "continue";
      }
      // /model <id>: quick switch, keep current effort/context.
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
        // Interactive arrow-key picker in a TTY. Selecting a skill pre-fills
        // the next prompt with "/<skill> " so the user types the task inline;
        // submitting that line activates the skill and runs the task.
        const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
        if (isTTY) {
          const opts = [
            { label: paint.gray("(none — clear active skills)"), value: "__clear__" },
            ...entries.map((e) => ({
              label: `${active.has(e.name) ? paint.green("●") : paint.gray("○")} ${e.name} ${paint.gray(`[${e.source}]`)}${e.description ? paint.gray("  " + e.description) : ""}`,
              value: e.name,
            })),
          ];
          const picked = await selectOption("Select a skill, then type your task", opts, 1);
          if (picked === "__clear__") {
            ctx.skills.clear();
            printSystem("all skills deactivated", "yellow");
          } else if (picked) {
            // Pre-fill the input area with "/<skill> " for inline task entry.
            ctx.prefillHolder.value = `/${picked} `;
            printSystem(`skill '${picked}' — type your task after /${picked}`, "green");
          } else {
            printSystem("skill selection cancelled", "yellow");
          }
          return "continue";
        }
        // Non-TTY fallback: plain listing.
        writeLine(paint.gray("available skills:"));
        for (const e of entries) {
          const mark = active.has(e.name) ? paint.green("●") : paint.gray("○");
          const desc = e.description ? paint.gray(`  ${e.description}`) : "";
          writeLine(`  ${mark} ${pad(e.name, 20)} ${paint.gray(`[${e.source}]`)}${desc}`);
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
      // /mcp add <name> <command> [args...] [--env K=V] [--project]
      if (arg === "add") {
        const parsed = parseAddArgs(rest.slice(1));
        if (!parsed) {
          printError("usage: /mcp add <name> <command> [args...] [--env K=V ...] [--project] [--dangerous]");
          return "continue";
        }
        const res = await ctx.mcp.add(parsed);
        if (res.ok) {
          const scope = parsed.project ? "project (./.mcp.json)" : "global (~/.deepseek-cli/mcp.json)";
          printSystem(`mcp '${parsed.name}' connected — ${res.toolCount} tool${res.toolCount === 1 ? "" : "s"} (saved: ${scope})`, "green");
        } else {
          printError(`mcp '${parsed.name}' failed to connect: ${res.error ?? "unknown"} (config still saved; will retry next session)`);
        }
        return "continue";
      }
      const list = ctx.mcp.servers();
      if (list.length === 0) {
        writeLine(paint.gray("(no MCP servers connected)"));
        writeLine(paint.gray("add one: /mcp add <name> <command> [args...] [--env K=V]"));
        return "continue";
      }
      if (!arg) {
        writeLine(paint.gray("mcp servers:"));
        for (const s of list) {
          const mark = s.enabled ? paint.green("●") : paint.gray("○");
          const warn = s.dangerous ? paint.bright.yellow("⚠ ") : "";
          const scope = s.scope ? paint.gray(`[${s.scope}]`) : "";
          writeLine(`  ${mark} ${warn}${pad(s.name, 20)} ${scope} ${paint.gray(s.toolCount + " tool" + (s.toolCount === 1 ? "" : "s"))}`);
        }
        writeLine(paint.gray("\n/mcp <name> toggles · /mcp add … adds (--project for project scope)"));
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
    case "allow": {
      const arg = rest[0]?.toLowerCase();
      const dangerous = ctx.permissions.dangerousTools();
      if (!arg) {
        writeLine(paint.gray("dangerous tools (● = session-allowed, no prompt):"));
        for (const n of dangerous) {
          const mark = ctx.permissions.isAllowed(n) ? paint.green("●") : paint.gray("○");
          writeLine(`  ${mark} ${n}`);
        }
        writeLine(paint.gray("\n/allow bash · /allow all · /allow reset"));
        return "continue";
      }
      if (arg === "reset" || arg === "off" || arg === "clear") {
        ctx.permissions.clear();
        printSystem("per-tool allows cleared", "yellow");
        return "continue";
      }
      if (arg === "all") {
        for (const n of dangerous) ctx.permissions.allow(n);
        printSystem(`authorized all dangerous tools: ${dangerous.join(", ")}`, "green");
        return "continue";
      }
      if (!dangerous.includes(arg)) {
        printError(`'${arg}' is not a dangerous tool (try: ${dangerous.join(", ")})`);
        return "continue";
      }
      ctx.permissions.allow(arg);
      printSystem(`'${arg}' authorized for this session — no more prompts`, "green");
      return "continue";
    }
    case "approve": {
      const arg = rest[0]?.toLowerCase();
      if (!arg) {
        const mode = ctx.permissions.approvalMode();
        const state = mode === "auto" ? paint.green("auto (no prompts)") : paint.yellow("ask (prompt each time)");
        printSystem(`approval mode: ${state}`, mode === "auto" ? "green" : "yellow");
        writeLine(paint.gray("  /approve auto — no prompts · /approve ask — prompt each time"));
        return "continue";
      }
      if (arg === "auto" || arg === "on" || arg === "yes") {
        await ctx.permissions.setApprovalMode("auto");
        printSystem("approval mode: auto — bash commands run without prompting (saved as default)", "green");
        return "continue";
      }
      if (arg === "ask" || arg === "off" || arg === "no") {
        await ctx.permissions.setApprovalMode("ask");
        printSystem("approval mode: ask — each bash command prompts for approval (saved as default)", "yellow");
        return "continue";
      }
      printError("usage: /approve [auto|ask]  (auto = no prompts, ask = prompt each time)");
      return "continue";
    }
    case "log":
      printSystem(`log file: ${log.filePath}`, "blue");
      return "continue";
    case "promptlog": {
      const arg = rest[0]?.toLowerCase();
      if (!arg) {
        const state = ctx.promptLog.get() ? paint.green("on") : paint.yellow("off");
        const count = await countPromptLog();
        printSystem(`promptlog ${state} · ${count} entries · ${promptLogFile()}`, ctx.promptLog.get() ? "green" : "yellow");
        return "continue";
      }
      if (arg === "on" || arg === "true" || arg === "1") {
        await ctx.promptLog.set(true);
        printSystem("promptlog on (saved as default)", "green");
        return "continue";
      }
      if (arg === "off" || arg === "false" || arg === "0") {
        await ctx.promptLog.set(false);
        printSystem("promptlog off (saved as default) — no per-turn recording", "yellow");
        return "continue";
      }
      if (arg === "clear") {
        await clearPromptLog();
        printSystem("prompt log cleared", "yellow");
        return "continue";
      }
      if (arg === "recent" || arg === "list") {
        const n = rest[1] ? Number(rest[1]) : 10;
        const entries = await loadPromptLog(Number.isFinite(n) && n > 0 ? n : 10);
        if (entries.length === 0) {
          writeLine(paint.gray("(prompt log is empty)"));
        } else {
          for (const e of entries) renderPromptLogEntry(e);
        }
        return "continue";
      }
      if (arg === "search") {
        const q = rest.slice(1).join(" ").trim();
        if (!q) {
          printError("usage: /promptlog search <query>");
          return "continue";
        }
        const entries = await searchPromptLog(q, 20);
        if (entries.length === 0) {
          writeLine(paint.gray(`(no entries matching "${q}")`));
        } else {
          for (const e of entries) renderPromptLogEntry(e);
        }
        return "continue";
      }
      printError("usage: /promptlog [on|off|recent [n]|search <q>|clear]");
      return "continue";
    }
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

// Slash command names (incl. aliases) for Tab completion in the REPL.
export const SLASH_COMMANDS = [
  "help", "?", "exit", "quit", "q", "clear", "btw", "fast", "think", "model", "reasoning", "thinking",
  "context", "allow", "log", "promptlog", "new", "skill", "mcp", "tokens", "size", "tools",
  "system", "save", "undo", "retry", "export", "sessions", "history",
];

/** Return slash commands matching the given input line (empty unless /-prefixed). */
export function completeSlash(line: string): string[] {
  if (!line.startsWith("/")) return [];
  return SLASH_COMMANDS.map((c) => "/" + c).filter((c) => c.startsWith(line));
}

/**
 * Parse a "/<skillname> <task>" invocation line. Returns null when the line
 * isn't /-prefixed or the first token is a builtin slash command (so skills
 * can't shadow /model, /skill, …). Does NOT verify the skill exists — the
 * caller does that via readSkill(). Pure/testable.
 */
export function parseSlashSkillInvocation(input: string): { name: string; task: string } | null {
  if (!input.startsWith("/")) return null;
  const name = input.slice(1).split(/\s+/)[0] ?? "";
  if (!name) return null;
  if (SLASH_COMMANDS.includes(name.toLowerCase())) return null;
  const task = input.slice(("/" + name).length).trim();
  return { name, task };
}

function printSlashHelp(): void {
  blank();
  writeLine(paint.bold("Slash commands:"));
  const cmds: [string, string][] = [
    ["/help", "show this help"],
    ["/exit", "exit the session"],
    ["/clear", "wipe conversation history (keep system prompt)"],
    ["/btw <question>", "ask a side question without disturbing the main session"],
    ["/fast", "switch to deepseek-chat + reasoning off (exploration phase) "],
    ["/think", "switch to deepseek-reasoner + reasoning high (writing-code phase)"],
    ["/model [name]", "arrow-key model picker, or switch to a specific id"],
    ["/reasoning [on|off|effort high|max]", "show/set thinking default + intensity"],
    ["/context [tokens]", "show/set the context-trim budget"],
    ["/allow [tool|all|reset]", "one-key authorize a tool (e.g. bash) for the session"],
    ["/approve [auto|ask]", "bash approval mode (auto = no prompts, ask = prompt each time)"],
    ["/log", "show the log file path"],
    ["/promptlog [on|off|recent|search|clear]", "per-turn prompt logging for optimization"],
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
  // Display in stable A-Z order by command name.
  cmds.sort((a, b) => a[0].localeCompare(b[0]));
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

/** Render a single prompt-log entry (one line of context + the prompt). */
function renderPromptLogEntry(e: PromptLogEntry): void {
  const meta: string[] = [
    `${e.turn}`,
    fmtDuration(e.durationMs),
    `${e.iterations} iter`,
    `${e.toolCalls} tools` + (e.tools.length ? ` [${e.tools.join(",")}]` : ""),
  ];
  if (e.usage) meta.push(`${e.usage.total} tok`);
  const promptPreview = truncatePreview(e.prompt, 80);
  writeLine(
    `  ${paint.cyan(e.ts)} ${paint.gray(meta.join(" · "))}` +
      (e.aborted ? ` ${paint.yellow("interrupted")}` : ""),
  );
  writeLine(`    ${paint.gray(promptPreview)}`);
}

function truncatePreview(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= n) return one;
  return one.slice(0, n - 1) + "…";
}
