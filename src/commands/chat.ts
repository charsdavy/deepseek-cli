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
import { newSession, loadSession, listSessions, saveSession, type Session } from "../session/store.ts";
import { paint, symbol } from "../ui/theme.ts";
import { blank, printError, printSystem, printTip, writeLine } from "../ui/render.ts";
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
  cwd?: string;
  temperature?: number;
  maxTokens?: number;
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
    mode: "ask",
    skipAll: args.yolo === true,
  });

  const toolCtx: ToolContext = { cwd };

  // ---- One-shot mode ----
  if (args.prompt) {
    session.messages.push({ role: "user", content: args.prompt });
    try {
      await driveTurn(session, { apiKey, model, reasoning, temperature, maxTokens, tools, permissions, toolCtx });
      await saveSession(session);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      printError(`turn failed: ${msg}`);
    } finally {
      closeReadline();
    }
    return;
  }

  // ---- Interactive REPL ----
  printWelcome(model, reasoning, args.yolo === true);
  printTip("type /help for commands, /exit to quit, Ctrl-C to abort");
  blank();

  let aborted = false;
  const onSigInt = () => {
    if (aborted) {
      writeLine();
      process.exit(130);
    }
    aborted = true;
    writeLine(paint.yellow("\n(interrupt — type /exit to quit)"));
  };
  process.on("SIGINT", onSigInt);

  try {
    while (true) {
      let input: string;
      try {
        input = await askMultiline(`${paint.bold(paint.bright.cyan(`${symbol.user} You`))} ${paint.gray("›")} `);
      } catch {
        break;
      }
      aborted = false;
      const trimmed = input.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("/")) {
        const handled = await handleSlashCommand(trimmed, session, { apiKey, model, temperature, tools });
        if (handled === "exit") break;
        continue;
      }

      session.messages.push({ role: "user", content: trimmed });
      try {
        await driveTurn(session, { apiKey, model, reasoning, temperature, maxTokens, tools, permissions, toolCtx });
        await saveSession(session);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        printError(`turn failed: ${msg}`);
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
  tools: ToolRegistry;
  permissions: PermissionManager;
  toolCtx: ToolContext;
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
  try {
    const result = await runAgentLoop(session.messages, {
      apiKey: deps.apiKey,
      model: deps.model,
      reasoning: deps.reasoning,
      temperature: deps.temperature,
      maxTokens: deps.maxTokens,
      tools: deps.tools,
      permissions: deps.permissions,
      cwd: session.cwd,
      onContentDelta: (d) => renderer.onContentDelta(d),
      onReasoningDelta: (d) => renderer.onReasoningDelta(d),
      onToolStart: () => true,
      onToolEnd,
    });
    renderer.end();
    session.messages = result.messages;
  } catch (e) {
    spinner.stop();
    renderer.end();
    throw e;
  }
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
      writeLine(paint.gray(`conversation: ${session.messages.length} messages, ~${t} tokens`));
      return "continue";
    }
    case "save": {
      await saveSession(session);
      printSystem(`saved session ${session.id}`, "green");
      return "continue";
    }
    case "sessions": {
      const list = await listSessions(10);
      if (list.length === 0) {
        writeLine(paint.gray("(no saved sessions)"));
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
    ["/tokens", "show estimated token usage"],
    ["/tools", "list registered tools"],
    ["/system", "show the active system prompt"],
    ["/save", "save session now"],
    ["/sessions", "list recent sessions"],
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
