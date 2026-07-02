#!/usr/bin/env bun
// Entry point — dispatches subcommands based on parsed argv.

import { ArgError, parseArgs, printHelp, printVersion } from "./cli.ts";
import { runAuthCommand } from "./commands/auth.ts";
import { runInitCommand } from "./commands/init.ts";
import { runMcpCommand } from "./commands/mcp.ts";
import { runSkillCommand } from "./commands/skill.ts";
import { runSessionsCommand } from "./commands/sessions.ts";
import { runConfigCommand } from "./commands/config.ts";
import { runChat } from "./commands/chat.ts";
import { printError } from "./ui/render.ts";
import { log, type LogLevel } from "./log/logger.ts";

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    if (e instanceof ArgError) {
      printError(e.message);
      printHelp();
      process.exit(2);
    }
    throw e;
  }

  // File logging: `--verbose` raises to debug; `--log-level` overrides;
  // `--no-log` disables. Initialized before dispatch so every subcommand logs.
  const level: LogLevel =
    args.logLevel ?? (args.verbose ? "debug" : "info");
  log.init(level, args.noLog !== true);

  // Capture crashes so users can find them in the log file.
  process.on("uncaughtException", (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    // EPIPE: the output pipe (stdout) went away — e.g. the user piped output
    // to `head`/another process that exited, or the terminal detached. readline
    // keeps trying to refresh its prompt line and throws EPIPE on every write,
    // which would otherwise loop the handler forever. There's nothing useful
    // to write once the pipe is gone, so log once and exit cleanly.
    if (msg.includes("EPIPE")) {
      log.error("uncaughtException", { error: msg, note: "output pipe closed — exiting" });
      process.exit(0);
    }
    log.error("uncaughtException", { error: msg, stack: e instanceof Error ? e.stack : undefined });
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    log.error("unhandledRejection", { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });

  switch (args.command) {
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
    case "auth":
      await runAuthCommand();
      return;
    case "init":
      await runInitCommand();
      return;
    case "mcp":
      await runMcpCommand(args.mcpArgs ?? []);
      return;
    case "skill":
      await runSkillCommand(args.skillArgs ?? []);
      return;
    case "sessions":
      await runSessionsCommand();
      return;
    case "config":
      await runConfigCommand();
      return;
    case "chat":
      await runChat({
        prompt: args.prompt,
        model: args.model,
        system: args.system,
        reasoning: args.reasoning,
        continueLast: args.continueLast,
        resume: args.resume,
        yolo: args.yolo,
        approvalMode: args.approvalMode,
        maxIterations: args.maxIterations,
        baseUrl: args.baseUrl,
        cwd: args.cwd,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
        outputFormat: args.outputFormat,
        noMcp: args.noMcp,
        reasoningEffort: args.reasoningEffort,
        maxContext: args.maxContext,
        verbose: args.verbose,
        noPromptLog: args.noPromptLog,
      });
      return;
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  printError(`fatal: ${msg}`);
  process.exit(1);
});
