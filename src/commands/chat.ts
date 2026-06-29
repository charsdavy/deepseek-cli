// Default chat command. Drives the agent loop for both one-shot prompts and
// the interactive REPL. Owns session lifecycle, tool/permission wiring, and
// the on-screen rendering of streaming output.

import * as path from "node:path";
import type { ChatMessage } from "../api/client.ts";
import { DEFAULT_MODEL, findModel, isReasoningModel, MODELS } from "../api/models.ts";
import { estimateConversationTokens } from "../api/tokens.ts";
import { ensureDirs, getOrSetupApiKey, loadConfig } from "../config/config.ts";
import { loadProjectInstructions } from "../config/instructions.ts";
import { buildSystemPrompt } from "../prompt/builder.ts";
import { makeStreamRenderer, runAgentLoop } from "../agent/loop.ts";
import { PermissionManager } from "../agent/permissions.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext, ToolResult } from "../tools/types.ts";
import { newSession, loadSession, listSessions, searchSessions, saveSession, type Session } from "../session/store.ts";
import { paint, symbol } from "../ui/theme.ts";
import { blank, printError, printSystem, printTip, setOutputSilent, writeLine } from "../ui/render.ts";
import { askMultiline, closeReadline } from "../ui/input.ts";
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
  const model = pickModel(args.model ?? cfg.defaultModel ?? DEFAULT_MODEL);
  const modelInfo = findModel(model);
  const reasoning = args.reasoning ?? isReasoningModel(model);
  const temperature = args.temperature ?? cfg.temperature;
  const maxTokens = args.maxTokens ?? cfg.maxTokens;
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
  const built = buildSystemPrompt({
    cwd,
    modelInfo,
    isReasoning: reasoning,
    userSystemPrompt: args.system,
    projectInstructions: instructions,
  });
  session.promptVariant = built.variant;
  const systemPromptText = built.text;

  // Ensure messages have the system prompt prepended
  ensureSystemPrefix(session.messages, systemPromptText);

  // Tools + permissions
  const tools = new ToolRegistry();
  const permissions = new PermissionManager({
    mode: skipAll ? "auto" : "ask",
    skipAll,
  });

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
    session.messages.push({ role: "user", content: args.prompt });
    const controller = new AbortController();
    turnAbort.current = controller;
    try {
      if (args.outputFormat === "json") {
        await runJsonOneShot(session, {
          apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl,
          tools, permissions, toolCtx, prompt: args.prompt, signal: controller.signal,
        });
      } else {
        await driveTurn(session, {
          apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl,
          tools, permissions, toolCtx, signal: controller.signal,
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
      closeReadline();
    }
    return;
  }

  // ---- Interactive REPL ----
  printWelcome(model, reasoning, skipAll);
  if (baseUrl) writeLine(`  ${paint.gray("endpoint:")} ${paint.gray(baseUrl)}`);
  printTip("type /help for commands, /exit to quit, Ctrl-C to abort a turn");
  blank();

  try {
    while (true) {
      let input: string;
      try {
        input = await askMultiline(`${paint.bold(paint.bright.cyan(`${symbol.user} You`))} ${paint.gray("›")} `);
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
              apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl,
              tools, permissions, toolCtx, signal: controller.signal,
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
        const handled = await handleSlashCommand(trimmed, session, { apiKey, model, temperature, tools });
        if (handled === "exit") break;
        continue;
      }

      session.messages.push({ role: "user", content: trimmed });
      const controller = new AbortController();
      turnAbort.current = controller;
      try {
        await driveTurn(session, {
          apiKey, model, reasoning, temperature, maxTokens, maxIterations, baseUrl,
          tools, permissions, toolCtx, signal: controller.signal,
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
    closeReadline();
    printSystem("Goodbye! 👋", "magenta");
  }
}

interface TurnDeps {
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
  signal?: AbortSignal;
}

async function driveTurn(session: Session, deps: TurnDeps): Promise<void> {
  const renderer = makeStreamRenderer({ showReasoning: deps.reasoning === true });

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
      temperature: deps.temperature,
      maxTokens: deps.maxTokens,
      maxIterations: deps.maxIterations,
      baseUrl: deps.baseUrl,
      tools: deps.tools,
      permissions: deps.permissions,
      cwd: session.cwd,
      signal: deps.signal,
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
}

export async function runJsonOneShot(session: Session, deps: JsonOneShotDeps): Promise<void> {
  setOutputSilent(true);
  let result;
  try {
    result = await runAgentLoop(session.messages, {
      apiKey: deps.apiKey,
      model: deps.model,
      reasoning: deps.reasoning,
      temperature: deps.temperature,
      maxTokens: deps.maxTokens,
      maxIterations: deps.maxIterations,
      baseUrl: deps.baseUrl,
      tools: deps.tools,
      permissions: deps.permissions,
      cwd: session.cwd,
      signal: deps.signal,
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

function printWelcome(model: string, reasoning: boolean, yolo: boolean): void {
  writeLine(`${paint.magenta(paint.bold(`${symbol.rocket} DeepSeek CLI`))}`);
  writeLine(`  ${paint.gray("model:")} ${paint.cyan(model)}${reasoning ? ` ${paint.gray("· reasoning on")}` : ""}${yolo ? ` ${paint.bright.yellow("· yolo")}` : ""}`);
  writeLine(`  ${paint.gray("cwd:")}   ${paint.gray(process.cwd())}`);
}

interface SlashCtx {
  apiKey: string;
  model: string;
  temperature?: number;
  tools: ToolRegistry;
}

async function handleSlashCommand(input: string, session: Session, ctx: SlashCtx): Promise<"exit" | "continue"> {
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
        writeLine(paint.gray("available models:"));
        for (const m of MODELS) {
          const cur = m.id === session.model ? paint.green("← current") : "";
          writeLine(`  ${pad(m.id, 20)} ${paint.gray(m.description)} ${cur}`);
        }
        return "continue";
      }
      if (!findModel(target)) {
        printError(`unknown model '${target}'`);
        return "continue";
      }
      session.model = target;
      printSystem(`switched model to ${target}`, "green");
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
    ["/model [name]", "show or switch models"],
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
