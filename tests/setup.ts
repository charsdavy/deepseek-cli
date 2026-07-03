// Bun test preload — runs BEFORE any test file is imported, so it lands
// before `import { log } from "../src/log/logger.ts"` instantiates the
// global Logger singleton. Without this, every test that touches the agent
// loop / chat / prompt paths writes real log lines into the user's
// `~/.deepseek-cli/logs/` directory (observed in production logs after a
// test run: spurious "agent loop start" events with maxIterations=2 / ms=0).
//
// We redirect BOTH log dir and session dir into per-process temp paths so a
// test run never reads from or writes to the user's real CLI state.
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-test-"));
process.env.DEEPSEEK_LOG_DIR = path.join(root, "logs");
process.env.DEEPSEEK_SESSION_DIR = path.join(root, "sessions");
process.env.DEEPSEEK_HISTORY_FILE = path.join(root, "history");
process.env.DEEPSEEK_PROMPT_LOG_FILE = path.join(root, "prompts.jsonl");
process.env.DEEPSEEK_SKILLS_DIR = path.join(root, "skills");
process.env.DEEPSEEK_MCP_DIR = path.join(root, "mcp");
