# deepseek-cli

[![CI](https://github.com/charsdavy/deepseek-cli/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/charsdavy/deepseek-cli/actions/workflows/ci.yml)
[![Release](https://github.com/charsdavy/deepseek-cli/actions/workflows/release.yml/badge.svg)](https://github.com/charsdavy/deepseek-cli/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An **agentic** command-line AI coding assistant powered by [DeepSeek](https://www.deepseek.com/). Written in TypeScript, distributed as a single binary via [Bun](https://bun.sh).

The CLI pairs streaming chat completions with **tool calling** — the model can read files, run shell commands, edit code, search the repo, and fetch the web to actually complete tasks, not just talk about them.

---

## Highlights

- **Agentic tool loop** — model drives the work: read → edit → bash → grep until the task is done.
- **Streaming** chat with reasoning trace support (`deepseek-reasoner`).
- **9 built-in tools**: `read_file`, `write_file`, `edit_file`, `bash`, `glob`, `grep`, `web_fetch`, `git_diff`, `todo_write`.
- **Parallel tool execution** — multiple independent tool calls in one turn run concurrently.
- **Permission system** — dangerous tools (writes, shell) ask for `y/n` approval; `--yolo` / `--approval-mode` skip prompts.
- **Interruptible** — Ctrl-C aborts the in-flight turn cleanly (a second Ctrl-C force-quits).
- **Real token usage** — per-turn + cumulative session token totals captured from the API and shown via `/tokens`.
- **Session persistence** — every interactive turn is auto-saved to `~/.deepseek-cli/sessions/`; resume with `-c` or `--resume <id>`.
- **Context window management** — old turns are auto-trimmed, and oversized tool results are capped to fit the model budget.
- **Project instructions** — automatically loads `AGENTS.md` / `deepseek.md` / `.cursorrules` into the system prompt.
- **Truly zero runtime deps** — API client is raw `fetch` + SSE; single binary ships ~60 MB.
- **Zero-dependency terminal UI** — ANSI colors, fenced code blocks, box-drawing panels, masked password input.

## Install

### Homebrew

```bash
brew tap charsdavy/tap
brew install deepseek
```

### Build from source (requires Bun ≥ 1.1)

```bash
git clone https://github.com/charsdavy/deepseek-cli.git
cd deepseek-cli
bun install
bun run build           # → ./dist/deepseek
```

Copy the `./dist/deepseek` binary somewhere on your `PATH`.

## Quick start

```bash
deepseek auth                                   # one-time API key setup
deepseek                                        # interactive REPL
deepseek "look at src/ and summarize the architecture"
deepseek -m deepseek-reasoner "prove that 7 is prime"
deepseek --yolo "fix the failing tests"         # auto-approve tool calls
deepseek --approval-mode auto "reformat src/"  # same as --yolo, explicit
deepseek --max-iterations 50 "long refactor"    # raise the agent loop cap
deepseek --base-url https://proxy.example.com "task"  # self-hosted / proxy endpoint
deepseek -c                                     # resume last session
deepseek sessions                               # list saved sessions
deepseek config                                 # show merged config
```

## Slash commands (interactive mode)

| Command          | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `/help`          | Show available commands                                  |
| `/exit`          | Quit the session                                         |
| `/clear`         | Wipe conversation history (system prompt retained)      |
| `/model [id]`    | Show or switch the active model                          |
| `/tokens`        | Show token usage (estimate + real API totals)           |
| `/tools`         | List registered tools                                    |
| `/system`        | Show the active system prompt                            |
| `/save`          | Save the session immediately                             |
| `/undo`          | Drop the last turn (user + reply messages)              |
| `/retry`         | Re-run the last user prompt (drops the previous reply)  |
| `/export [path]` | Dump the transcript to stdout, or to a file             |
| `/sessions`      | List recent sessions                                     |

**Multi-line input**: end a line with `\` for continuation, or wrap a block in triple-backticks (```…```) to submit a multi-line paste.

## Configuration

Configuration is read from `~/.deepseek-cli/config.json` (file mode `0600`). Environment variables override the file:

| Variable             | Purpose                                   |
| -------------------- | ----------------------------------------- |
| `DEEPSEEK_API_KEY`   | API key (preferred over the file)         |
| `DEEPSEEK_BASE_URL`  | Override the API base URL                 |
| `DEEPSEEK_MODEL`     | Default model id                          |

### CLI flags

| Flag                              | Purpose                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `-m, --model <name>`              | Model id (default `deepseek-chat`)                                 |
| `-s, --system <text>`             | Override the system prompt                                         |
| `-r, --reasoning`                 | Force reasoning mode                                               |
| `-c, --continue`                  | Resume the most recent session                                     |
| `--resume <id>`                   | Resume a specific session by id                                    |
| `--yolo`                          | Skip all permission prompts (shorthand for `--approval-mode yolo`) |
| `--approval-mode <ask\|auto\|yolo>` | Permission mode: `ask` prompts; `auto`/`yolo` skip prompts       |
| `--max-iterations <n>`            | Cap the agent loop iterations (default 30)                         |
| `--base-url <url>`                | Override the API base URL (wins over config/env)                   |
| `--cwd <path>`                    | Working directory (defaults to `$PWD`)                             |
| `--temperature <n>`               | Sampling temperature (default 0.7)                                 |
| `--max-tokens <n>`                | Max output tokens per response                                     |

> During a turn, **Ctrl-C** aborts the in-flight request cleanly; a second Ctrl-C force-quits.

### Project-level instructions

Drop one of these into your repo root and the agent will fold its contents into the system prompt:

- `AGENTS.md`
- `deepseek.md`
- `.deepseek`
- `CLAUDE.md`
- `.cursorrules`

## Architecture

```
src/
├── index.ts              # entry point, dispatches subcommands
├── cli.ts                # argv parser (zero-dep)
├── api/
│   ├── client.ts         # fetch + SSE streaming + tool-call delta accumulation
│   ├── models.ts         # model catalog
│   └── tokens.ts         # rough token estimator (CJK-aware)
├── agent/
│   ├── loop.ts           # agentic loop: stream → execute tools → stream → …
│   ├── context.ts        # sliding-window context trimming
│   └── permissions.ts    # per-call y/n approval system
├── tools/                # each tool is its own module
│   ├── types.ts          # Tool interface, OpenAI-schema mapping
│   ├── registry.ts       # registry + executor
│   ├── read_file.ts      # line-numbered file reader
│   ├── write_file.ts     # create/overwrite
│   ├── edit_file.ts      # exact-string replacement, replaceAll support
│   ├── bash.ts           # shell with workdir + timeout + truncation
│   ├── glob.ts           # Bun.Glob-backed fast matcher
│   ├── grep.ts           # ripgrep with Node fallback
│   ├── web_fetch.ts      # URL fetch with HTML → Markdown conversion
│   ├── git_diff.ts       # read-only structured `git diff` (staged/ref-to-ref/stat)
│   └── todo.ts           # in-memory task list the agent can read/update
├── ui/
│   ├── theme.ts          # ANSI color helpers, zero dep
│   ├── render.ts         # markdown, code blocks, panels, system messages
│   ├── input.ts          # masked password, multi-line, y/n prompts
│   └── spinner.ts        # interval-based animated spinner
├── session/
│   └── store.ts          # session save / load / list / delete
├── config/
│   ├── config.ts         # layered config + auth flow
│   └── instructions.ts   # AGENTS.md / .cursorrules loader
└── commands/
    ├── chat.ts           # default chat command (one-shot + REPL + slash cmds)
    ├── auth.ts           # auth subcommand
    ├── sessions.ts       # session listing subcommand
    └── config.ts         # config inspection subcommand
```

## Development

```bash
bun install
bun run typecheck        # tsc --noEmit
bun run lint            # static-analysis gate (tsc)
bun test                 # bun test runner
bun run coverage        # tests with coverage report
bun run dev              # watch mode for development
bun run build            # compile single binary to ./dist/deepseek
```

## Releasing & Homebrew

Releases are automated through GitHub Actions (`.github/workflows/release.yml`):

1. Tag a release — `git tag v0.3.1 && git push origin v0.3.1`.
2. The workflow cross-compiles four binaries (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`) using `bun build --compile --target=bun-<os>-<arch>`.
3. Each binary is gzipped-tarred (containing just `deepseek`) and uploaded to a GitHub Release.
4. The same workflow regenerates `Formula/deepseek.rb` in the [`charsdavy/homebrew-tap`](https://github.com/charsdavy/homebrew-tap) repo with fresh SHA256s and pushes the commit.

### One-time maintainer setup

- Create an empty repo named `homebrew-tap` under your GitHub user (so the path resolves to `charsdavy/homebrew-tap`). The folder `Formula/` will be created automatically on first release.
- Generate a Personal Access Token (classic, with `repo` scope) and add it as a repository secret named `HOMEBREW_TAP_TOKEN` on `charsdavy/deepseek-cli`.
- Users then install via:

  ```bash
  brew tap charsdavy/tap
  brew install deepseek
  brew upgrade deepseek    # to pull future updates
  ```

The formula template lives at [`.github/scripts/formula.rb.tpl`](./.github/scripts/formula.rb.tpl); edit it there to change bottle/livecheck/caveats behavior.

## License

MIT © [Chars](./LICENSE)

## Reference

[DeepSeek API Doc](https://api-docs.deepseek.com/zh-cn/)
