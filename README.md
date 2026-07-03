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
- **14 built-in tools**: `read_file`, `read_files`, `write_file`, `edit_file`, `bash`, `glob`, `grep`, `web_fetch`, `web_search`, `git_diff`, `git_status`, `list_dir`, `task`, `todo_write`.
- **Sub-agents** — the `task` tool spawns nested agent loops; independent subtasks run in **parallel** when issued together.
- **MCP support** — connect Model Context Protocol servers (stdio) and use their tools alongside the built-ins; toggle servers per-session with `/mcp`.
- **Skills** — load specialized instruction packs from deepseek **and** Claude Code / Codex skill dirs (both flat `<name>.md` and directory `<name>/SKILL.md` layouts, incl. symlinked); pick which are active with `/skill`.
- **`@file` references** — mention `@path/to/file` in a prompt and its contents are attached inline.
- **Prompt history** — Up/Down recalls previous prompts (persisted across sessions).
- **Parallel tool execution** — multiple independent tool calls in one turn run concurrently.
- **Permission system** — dangerous tools (writes, shell) ask for `y/n` approval; `--yolo` / `--approval-mode` skip prompts.
- **Interruptible** — Ctrl-C aborts the in-flight turn cleanly (a second Ctrl-C force-quits).
- **Real token usage** — per-turn + cumulative session token totals captured from the API and shown via `/tokens`.
- **Session persistence** — every interactive turn is auto-saved to `~/.deepseek-cli/sessions/`; resume with `-c` or `--resume <id>`.
- **Context window management** — old turns are auto-trimmed, and oversized tool results are capped to fit the model budget.
- **Wrap-up summaries** — when the agent hits the iteration cap with no final answer, it makes one more tool-free request to produce a concise progress summary (done / in-flight / remaining) instead of returning a blank turn.
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

## Upgrade

### Homebrew

```bash
brew update
brew upgrade deepseek    # to pull future updates
```

## Quick start

```bash
deepseek auth                                   # one-time API key setup
deepseek                                        # interactive REPL
deepseek "look at src/ and summarize the architecture"
deepseek -m deepseek-v4-pro "prove that 7 is prime"
deepseek --yolo "fix the failing tests"         # auto-approve tool calls
deepseek --approval-mode auto "reformat src/"  # same as --yolo, explicit
deepseek --max-iterations 50 "long refactor"    # raise the agent loop cap
deepseek --base-url https://proxy.example.com "task"  # self-hosted / proxy endpoint
deepseek --output-format json --yolo "summarize src/" # machine-readable result for CI
deepseek init                                   # scaffold an AGENTS.md template
deepseek mcp add fs npx -y @modelcontextprotocol/server-filesystem /abs  # add an MCP server
deepseek skill create tdd                       # scaffold a codex-style skill file
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
| `/btw <question>`| Ask a throwaway side question; main session is untouched and nothing is saved |
| `/fast`          | Switch to `deepseek-chat` + reasoning off — exploration phase latency drops |
| `/think`         | Switch to `deepseek-reasoner` + reasoning high — writing-code phase |
| `/model [name]`  | Setup wizard: model → effort → context (or `/model <id>` quick switch) |
| `/reasoning [on|off\|effort high\|max]` | Show/set thinking default + intensity                          |
| `/context [tokens]` | Show/set the context-trim budget                              |
| `/allow [tool\|all\|reset]` | One-key authorize a tool (e.g. `bash`) for the session |
| `/approve [auto\|ask]`    | Toggle bash approval mode (auto = skip prompts, ask = prompt each time) |
| `/log`           | Show the log file path                                  |
| `/promptlog [on\|off\|recent\|search\|clear]` | Per-turn prompt logging for retrospective optimization |
| `/new`           | Start a fresh session — clears context, new id         |
| `/skill [name]`  | Picker → pre-fills `/<skill> ` for inline task entry    |
| `/mcp [name]`    | List MCP servers, or toggle a server's tools           |
| `/tokens`        | Show token usage (estimate + real API totals)          |
| `/tools`         | List registered tools                                    |
| `/system`        | Show the active system prompt                            |
| `/save`          | Save the session immediately                             |
| `/undo`          | Drop the last turn (user + reply messages)              |
| `/retry`         | Re-run the last user prompt (drops the previous reply)  |
| `/export [path]` | Dump the transcript to stdout, or to a file             |
| `/sessions [query]` | List recent sessions (or search by keyword)          |

**Multi-line input**: end a line with `\` for continuation, or wrap a block in triple-backticks (```…```) to submit a multi-line paste. **Tab** completes slash commands (type `/m` → `/model`/`/mcp`; ambiguous Tab lists matches).

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
| `-m, --model <name>`              | Model id (default `auto`)                                         |
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
| `--output-format <text\|json>`    | One-shot only: emit a single JSON result (no streaming/ANSI)       |
| `--no-mcp`                       | Do not load MCP servers this session                              |
| `--reasoning-effort <high\|max>` | Thinking intensity (default high; max = deeper/costlier)          |
| `--max-context <tokens>`         | Operational context-trim budget (default 60000)                   |
| `--log-level <debug\|info\|warn\|error>` | File log level (default info; --verbose=debug)            |
| `--no-log`                       | Disable file logging entirely                              |
| `--no-prompt-log`                | Disable per-turn prompt logging this session              |
| `--verbose`                      | Verbose logging                                                    |

> During a turn, **Ctrl-C** aborts the in-flight request cleanly; a second Ctrl-C force-quits.

### Models

| Model id            | Notes                                            |
| ------------------- | ------------------------------------------------ |
| `auto`              | Auto-select based on task complexity (default)   |
| `deepseek-v4-flash` | Fast/lightweight; non-thinking                   |
| `deepseek-v4-pro`   | Flagship; thinking default                       |
| `deepseek-chat`     | Legacy; **deprecating 2026-07-24**                |
| `deepseek-reasoner` | Legacy reasoning; **deprecating 2026-07-24**      |

`/model` launches an **arrow-key setup wizard** (↑/↓ · enter · esc) in a TTY: pick the model, then reasoning effort (`off/high/max`), then a context budget preset (`60k…1M`) — each step defaults to "keep current" so you can change only what you want. `/model <id>` switches the model directly (useful with `--base-url` for other providers). `thinking:{type:"enabled"}` is sent when reasoning is on; effort/context can also be tuned separately via `/reasoning effort` and `/context`.

### Project-level instructions

Drop one of these into your repo root and the agent will fold its contents into the system prompt:

- `AGENTS.md`
- `deepseek.md`
- `.deepseek`
- `CLAUDE.md`
- `.cursorrules`

### Skills

Skills are reusable instruction packs (markdown files) that specialize the agent for a task domain. When a skill is **active**, its contents are appended to the system prompt before your project instructions (so repo rules still win). Activate them per-session with the `/skill` command.

Skill files are discovered from the deepseek, Claude Code, and Codex directories (global + project each), supporting **both layouts**: flat `<name>.md` (what `deepseek skill create` writes) and the directory form `<name>/SKILL.md` used by Claude Code/Codex (symlinked skill dirs are followed). On a name clash the deepseek copy wins. Global dirs honor each tool's relocation env: `DEEPSEEK_SKILLS_DIR`, `CLAUDE_CONFIG_DIR` (→ `~/.claude`), `CODEX_HOME` (→ `~/.codex`).

| Location                                  | Scope/source    |
| ----------------------------------------- | --------------- |
| `~/.deepseek-cli/skills/<name>.md`        | deepseek (user) |
| `<repo>/.deepseek/skills/<name>.md`       | deepseek (repo) |
| `~/.claude/skills/<name>/SKILL.md`        | Claude Code     |
| `<repo>/.claude/skills/<name>/SKILL.md`   | Claude Code     |
| `~/.codex/skills/<name>/SKILL.md`         | Codex           |
| `<repo>/.codex/skills/<name>/SKILL.md`    | Codex           |

```bash
# scaffold a skill (codex-style template: frontmatter + When/Instructions/Examples/Constraints)
deepseek skill create tdd
# then inside the REPL:
/skill            # arrow-key picker (↑/↓ · enter); selecting a skill PRE-FILLS
                  # the input with "/<skill> " — type your task after it and Enter
 /tdd write a failing test for X, then implement   # /<skill> <task> invocation
/skill tdd        # toggle a skill on/off directly
/skill clear      # deactivate all skills
```

Two ways to use a skill: `/skill` → pick → the prompt pre-fills `/<skill> ` so you continue typing the task inline; or type `/<skill> <task>` directly. On submit the skill is activated (folded into the system prompt for the turn) and the task runs under it. Builtin slash commands (`/model`, `/skill`, …) are never shadowed by a same-named skill.

### `/btw` — side question without disturbing the main thread

Mid-session you often want to ask a quick clarifying question ("what's the syntax for X again?") without polluting the conversation that's actually solving your task. `/btw <question>` spawns a fresh side conversation that carries the live system prompt(s) but starts from a clean message list. The answer renders inline below a `btw — side question` marker; when it finishes, control returns to the main REPL with the original messages and token counts untouched. Side turns are capped at 10 iterations and never persist to a session file. Double-tap Esc still aborts them.

> `deepseek init` scaffolds an `AGENTS.md` template (repo-level instructions); skills are the per-session, toggleable complement.

### MCP (Model Context Protocol)

Connect external MCP servers over stdio; their tools are exposed to the agent as `mcp_<server>_<tool>` and called like any built-in. Configure servers in an `mcp.json` (Claude-Code-compatible shape). Manage it from the CLI — no hand-editing required:

```bash
deepseek mcp add fs npx -y @modelcontextprotocol/server-filesystem /abs/path
deepseek mcp add gh npx -y @modelcontextprotocol/server-github --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx
deepseek mcp add shell bash --dangerous   # mark this server's tools as requiring per-call approval
deepseek mcp list                       # show configured servers
deepseek mcp remove gh                  # remove a server
# add --project to write into <repo>/.mcp.json instead of the global file
```

A server entry may set `"isDangerous": true` (or pass `--dangerous` to add) so each of its tool calls prompts for `y/n` approval (skippable via `/allow <server>` or `--yolo`). `/mcp` marks such servers with ⚠.

The equivalent JSON (for reference):

| Location                       | Scope           |
| ------------------------------ | --------------- |
| `~/.deepseek-cli/mcp.json`     | global (user)   |
| `<repo>/.mcp.json`             | project-specific |

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/abs/path"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    }
  }
}
```

Servers start when a session begins (best-effort — a failed server is skipped, not fatal). Manage them live in the REPL:

```bash
/mcp                 # list servers with active state (● = tools loaded)
/mcp filesystem      # toggle that server's tools off (stays connected)
/mcp filesystem      # …and back on
```

Use `--no-mcp` to skip loading servers for a session (e.g. `deepseek --no-mcp`).

### @file references & prompt history

Reference files inline with `@path` (relative to cwd); their contents are attached to the prompt automatically:

```bash
👤 › explain the bug in @src/auth.ts and @src/api/client.ts
# → the model sees your text plus both files' contents in a <referenced_files> block
```

The REPL keeps prompt history in `~/.deepseek-cli/history`; press **Up/Down** at an empty prompt to recall previous inputs across sessions. `/reasoning on|off` toggles the thinking default and persists it for future sessions.

### Web search (on-demand)

`web_search` queries the public web via DuckDuckGo's no-JS HTML endpoint — **no API key required, zero config**. It returns up to N results with title/url/snippet in a model-friendly envelope:

```
<web_search query="deepseek api model names" count="3">
1. Lists Models | DeepSeek API Docs
   https://api-docs.deepseek.com/api/list-models/
   Lists the currently available models, and provides basic information …
2. …
</web_search>
```

The system prompt only invokes it when the model genuinely needs fresh information beyond its training data (latest library versions, recent docs, release notes, news). For things the model could already know, or could derive from local files, the prompt deliberately says "do NOT use web_search — that wastes a network round-trip". The natural pairing is `web_search → web_fetch`: discover the right URL first, then fetch the best hit for deeper reading.

## Logging & troubleshooting

Diagnostic events are written as JSON lines to `~/.deepseek-cli/logs/deepseek-YYYY-MM-DD.log` (daily rotation, 7-day retention, 5 MB size cap). This is the first place to look when a turn errors, an MCP server won't connect, or the agent loops. **Sensitive data is redacted** before write — API keys (`sk-…`/`ghp_…`) are masked and secret-named fields (`apiKey`/`token`/`Authorization`/…) become `***`.

```bash
deepseek                    # logs at info by default
deepseek --verbose "…"      # debug level (request sizes, per-iteration trace)
deepseek --log-level debug  # explicit
deepseek --no-log           # disable file logging
tail -f ~/.deepseek-cli/logs/deepseek-*.log
# inside the REPL:
/log                        # prints the current log file path
```

What's logged (info): startup (model/cwd/flags), each agent-loop start/end + token usage, every tool call (name/ok/length/summary/ms — not full args), API errors (status + message), MCP connect/fail, and uncaught crashes. Attach the day's log to a bug report — it's safe to share.

What's logged (debug, `--verbose`): per-iteration totals (`iterMs`/content/reasoning/toolCalls), API timing (`fetchMs`/`ttfbMs`/`streamMs`/`chunks`/`usage`, correlated by `reqId`), and retry attempts (`reason`/`attempt`/`delayMs`). These are the inputs for the perf report below.

### Prompt log (prompt optimization)

Every turn is also recorded as a single JSONL line in `~/.deepseek-cli/prompt-log.jsonl` — a lightweight, cross-session index focused on **prompt → outcome** correlation for retrospective prompt and system-prompt optimization. One line per turn, bounded to the most recent 2000 entries (oldest pruned automatically). Enabled by default; turn it off with `/promptlog off` (persists across sessions) or `--no-prompt-log` (this session only).

Each entry records: the user's prompt text, the model + system-prompt variant used, reasoning mode/effort, iteration count, tool names invoked + count, real token usage, final-text length, whether the turn was aborted, and the wall-clock duration. The owning `sessionId` lets you load the full transcript from the session store if you need the complete conversation.

```bash
# inside the REPL:
/promptlog                  # status: on/off, entry count, file path
/promptlog recent 20        # show the 20 most recent entries
/promptlog search refactor  # find turns whose prompt mentions "refactor"
/promptlog off              # disable (saved as default for future sessions)
/promptlog clear            # wipe the log file
```

Per-turn timing: turns that take **5s or more** also surface an `elapsed Xs` marker inline after the token-usage line, so you can perceive per-phase cost without digging into the log. Shorter turns stay clean.

### Performance report

`scripts/perf-report.ts` aggregates a day's log into a quick perf summary — where time is going, which tools are slow, which API calls are slow, and retry/failure hotspots.

### Latency: exploration phase vs writing-code phase

The dominant source of perceived slowness is **per-iteration model reasoning time**, not the tools themselves. A reasoner-class model (`deepseek-reasoner` / `deepseek-v4-pro`) spends several seconds thinking before emitting each batch of tool calls; on long exploration flows (many `read_file`/`grep`/`list_dir` calls across iterations) those seconds stack into minutes. Three mitigations ship:

1. **`/fast` ↔ `/think`** — one-keystroke model switching. Run `/fast` when you start exploring (jumps to `deepseek-chat` + reasoning off, ~5–10× snappier per iteration); run `/think` when you're ready to actually write code (back to `deepseek-reasoner` + reasoning high). The REPL startup tip reminds you this exists.
2. **System-prompt guidance** — `## Iteration cost (very important)` tells the model to batch read-only tools in a single turn, prefer `read_files` (batch) over multiple `read_file` calls, avoid chaining `bash echo "==="` style inspection across iterations, and only update `todo_write` when the plan materially changes. This is the single largest lever on round-trip count.
3. **Automatic exploration-phase hint** — when the agent loop detects ≥3 consecutive iterations where every emitted tool was read-only AND you're running under a reasoner, it prints a one-shot tip pointing at `/fast`. It fires at most once per turn so it never gets chatty; emits nothing if you're already on `deepseek-chat`.
4. **Automatic reasoning-effort downgrade** — during long read-only exploration runs under `max` effort, the loop auto-downgrades to `high` to reduce per-iteration thinking overhead. Restored to `max` as soon as the model resumes writing code (edit/write/bash).

```bash
bun run scripts/perf-report.ts          # today's log, summary mode
bun run scripts/perf-report.ts path.log # a specific file
bun run scripts/perf-report.ts --tail 20   # only the last 20 runs
bun run scripts/perf-report.ts --run 3     # per-iteration waterfall for run #3
```

Sample summary output:

```
perf-report · deepseek-2026-06-30.log · 2 run(s)

Aggregate (completed runs only):
  wall: 17.54s  api: 16.70s (95%)  tools: 657ms (04%)  other: 183ms (01%)
  iterations: 3  |  runs completed: 2/2
  aborts: 0  |  failed runs: 0  |  api failures: 1  |  tool failures: 1
  retries: 1  |  retries exhausted: 0

Slowest runs:
  #2  14.01s     api=13.70s  (98%) tools=192ms   (01%)  iter=2   deepseek-reasoner  10:00:00
  ...

Slowest API calls (by streamMs):
  6.00s      ttfb=2.00s     chunks=120   deepseek-reasoner  10:00:01
  ...
```

The `--run N` waterfall re-sequences API + tool events back into per-iteration rows, folding retries (`attempts=n`) into the iteration they belong to:

```
Run #2  deepseek-reasoner  10:00:00
  total=14.01s  api=13.70s (98%)  tools=192ms (01%)  iterations=2

  iter 1   6.19s      api=6.00s   (97%) tools=192ms   (03%)  chunks=120
          bash             180ms     ok  ls /tmp
          read_file        12ms      ok  /tmp/a.txt
  iter 2   4.60s      api=4.60s   (100%) tools=0ms     (00%)  chunks=90  attempts=2
          retries:         #1 rate_limit delay=2.00s→ok
```

## Architecture

```
src/
├── index.ts              # entry point, dispatches subcommands
├── cli.ts                # argv parser (zero-dep)
├── api/
│   ├── client.ts         # fetch + SSE streaming + tool-call delta accumulation
│   ├── models.ts         # model catalog (incl. auto-select)
│   └── tokens.ts         # rough token estimator (CJK-aware)
├── agent/
│   ├── loop.ts           # agentic loop: stream → execute tools → stream → …
│   ├── context.ts        # sliding-window context trimming
│   └── permissions.ts    # per-call y/n approval system
├── tools/                # each tool is its own module
│   ├── types.ts          # Tool interface, OpenAI-schema mapping
│   ├── registry.ts       # registry + executor
│   ├── read_file.ts      # line-numbered file reader (single file)
│   ├── read_files.ts     # batch file reader (multiple files in one call)
│   ├── write_file.ts     # create/overwrite
│   ├── edit_file.ts      # exact string replacement, replaceAll support
│   ├── bash.ts           # shell with workdir + timeout + truncation
│   ├── glob.ts           # Bun.Glob-backed matcher + pure-JS brace-aware fallback
│   ├── grep.ts           # ripgrep with Node fallback
│   ├── web_fetch.ts      # URL fetch with HTML → Markdown conversion
│   ├── web_search.ts     # DuckDuckGo search (no API key) → title/url/snippet
│   ├── git_helpers.ts    # shared spawn-based git runner (no shell)
│   ├── git_diff.ts       # read-only structured `git diff`
│   ├── git_status.ts     # read-only structured `git status` (porcelain + branch)
│   ├── list_dir.ts      # single-level directory listing
│   ├── task.ts          # launch a sub-agent (nested agent loop) for a subtask
│   └── todo.ts          # in-memory task list the agent can read/update
├── prompt/
│   ├── builder.ts        # modular system-prompt builder (identity/tools/behavior/style/safety)
│   └── harness.ts        # harness + truncation helpers for prompt content
├── ui/
│   ├── theme.ts          # ANSI color helpers, zero dep
│   ├── render.ts         # markdown, code blocks, panels, system messages
│   ├── input.ts          # masked password, multi-line, y/n prompts, visual line wrapping
│   └── spinner.ts        # interval-based animated spinner
├── session/
│   ├── store.ts          # session save / load / list / delete / search / prune
│   ├── history.ts        # prompt history (Up/Down recall, persisted)
│   └── promptLog.ts      # per-turn prompt→outcome JSONL log (prompt optimization)
├── skills/
│   └── store.ts          # skill discovery + reading (global + project .md files)
├── mcp/
│   ├── client.ts         # JSON-RPC 2.0 MCP client (transport-agnostic)
│   ├── stdio.ts          # stdio transport: spawn server, newline-delimited JSON
│   └── registry.ts       # mcp.json config load + server lifecycle + tool export
├── config/
│   ├── config.ts         # layered config + auth flow
│   └── instructions.ts   # AGENTS.md / .cursorrules loader
├── log/
│   └── logger.ts         # file logger w/ daily rotation + secret redaction
└── commands/
    ├── chat.ts           # default chat command (one-shot + REPL + slash cmds + json mode)
    ├── auth.ts           # auth subcommand
    ├── init.ts           # scaffolds an AGENTS.md project-instructions file
    ├── mcp.ts            # mcp subcommand (add/list/remove servers)
    ├── skill.ts          # skill subcommand (create/scaffold skills)
    ├── sessions.ts       # session listing subcommand
    └── config.ts         # config inspection subcommand
```

## Development

```bash
bun install
bun run typecheck        # tsc --noEmit
bun run lint            # tsc --noEmit + biome check
bun test                 # bun test runner
bun run coverage        # tests with coverage report
bun run dev              # watch mode for development
bun run build            # compile single binary to ./dist/deepseek
```

## Releasing & Homebrew

Releases are automated through GitHub Actions (`.github/workflows/release.yml`):

1. Tag a release — `git tag v0.4.1 && git push origin v0.4.1`.
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
  brew update
  brew upgrade deepseek    # to pull future updates
  ```

The formula template lives at [`.github/scripts/formula.rb.tpl`](./.github/scripts/formula.rb.tpl); edit it there to change bottle/livecheck/caveats behavior.

## Reference

[DeepSeek API Doc](https://api-docs.deepseek.com/zh-cn/)
