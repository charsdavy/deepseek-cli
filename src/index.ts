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
    log.error("uncaughtException", { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
  });
  process.on("unhandledRejection", (e) => {
    log.error("unhandledRejection", { error: e instanceof Error ? e.message : String(e) });
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
      });
      return;
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  printError(`fatal: ${msg}`);
  process.exit(1);
});
