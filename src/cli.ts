// Lightweight argv parser. No commander dependency — keeps the binary lean
// and the surface area easy to read. Supports long/short flags, sub-commands,
// and a positional prompt argument.

import pkg from "../package.json" with { type: "json" };

export const VERSION = (pkg as { version?: string }).version ?? "0.3.0";

export interface ParsedArgs {
  command: "chat" | "auth" | "sessions" | "config" | "help" | "version" | "init";
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

const HELP = `deepseek — an agentic AI coding CLI powered by DeepSeek.

Usage:
  deepseek [options] [prompt]            Start an interactive session, or run a single prompt
  deepseek auth                          Configure or refresh your DeepSeek API key
  deepseek init                          Scaffold an AGENTS.md project-instructions file
  deepseek sessions                      List saved sessions
  deepseek config                        Show current configuration

Options:
  -m, --model <name>                     Model: deepseek-chat | deepseek-reasoner
                                         (default: deepseek-chat)
  -s, --system <text>                    Override the system prompt
  -r, --reasoning                        Enable reasoning mode (for thinking models)
  -c, --continue                         Resume the most recent session
      --resume <id>                      Resume a specific session by id
      --yolo                             Skip all permission prompts (auto-approve)
      --approval-mode <ask|auto|yolo>    Permission mode (ask=prompt, auto/yolo=skip)
      --max-iterations <n>               Cap agent loop iterations (default 30)
      --base-url <url>                   Override the API base URL
      --cwd <path>                       Working directory (defaults to $PWD)
      --temperature <n>                  Sampling temperature (default 0.7)
      --max-tokens <n>                   Max output tokens per response
      --output-format <text|json>        One-shot only: emit a single JSON result
                                         (no streaming/ANSI) for scripting / CI
      --verbose                          Verbose logging
  -h, --help                             Show this help
  -V, --version                          Print version

Examples:
  deepseek                                # interactive REPL
  deepseek "what files are here?"        # one-shot prompt
  deepseek -m deepseek-reasoner "prove 2+2=4"
  deepseek --yolo "fix the failing tests"  # auto-approve tool calls
  deepseek -c                            # resume last session
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const out: ParsedArgs = { command: "chat", reasoning: false };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    switch (a) {
      case "auth":
      case "sessions":
      case "config":
      case "init":
        out.command = a;
        return out;
      case "-h":
      case "--help":
        out.command = "help";
        return out;
      case "-V":
      case "--version":
        out.command = "version";
        return out;

      case "-m":
      case "--model":
        out.model = args[++i];
        break;
      case "-s":
      case "--system":
        out.system = args[++i];
        break;
      case "-r":
      case "--reasoning":
        out.reasoning = true;
        break;
      case "-c":
      case "--continue":
        out.continueLast = true;
        break;
      case "--resume":
        out.resume = args[++i];
        break;
      case "--yolo":
        out.yolo = true;
        break;
      case "--approval-mode": {
        const v = args[++i] as string;
        if (v !== "ask" && v !== "auto" && v !== "yolo") {
          throw new ArgError(`--approval-mode must be ask|auto|yolo, got: ${v}`);
        }
        out.approvalMode = v;
        break;
      }
      case "--max-iterations":
        out.maxIterations = Number(args[++i]);
        break;
      case "--base-url":
        out.baseUrl = args[++i];
        break;
      case "--cwd":
        out.cwd = args[++i];
        break;
      case "--output-format": {
        const v = args[++i] as string;
        if (v !== "text" && v !== "json") {
          throw new ArgError(`--output-format must be text|json, got: ${v}`);
        }
        out.outputFormat = v;
        break;
      }
      case "--temperature":
        out.temperature = Number(args[++i]);
        break;
      case "--max-tokens":
        out.maxTokens = Number(args[++i]);
        break;
      case "--verbose":
        out.verbose = true;
        break;

      default:
        if (a.startsWith("-")) {
          throw new ArgError(`unknown option: ${a}`);
        }
        if (out.prompt) {
          throw new ArgError(`unexpected extra argument: ${a}`);
        }
        out.prompt = a;
        break;
    }
    i++;
  }
  return out;
}

export class ArgError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

export function printHelp(): void {
  process.stdout.write(HELP);
}

export function printVersion(): void {
  process.stdout.write(`deepseek ${VERSION}\n`);
}
