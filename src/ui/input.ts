// Interactive input helpers. Hidden password input uses raw-mode char reading
// with masking. Multi-line input supports `\\` continuation and ```-fenced blocks.

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { paint } from "./theme.ts";

let rl: readline.Interface | null = null;
let savedRawMode: boolean | null = null;

function getRl(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input, output, terminal: true });
    rl.on("close", () => {});
  }
  return rl;
}

export async function askQuestion(prompt: string): Promise<string> {
  const r = getRl();
  return (await r.question(prompt)).trim();
}

/** Read a single line, hiding the input (password-style). */
export async function askHidden(prompt: string): Promise<string> {
  output.write(prompt);
  const isTTY = (input as NodeJS.ReadStream & { isTTY?: boolean }).isTTY === true;
  if (!isTTY) {
    // Fallback: read a line without echo suppression.
    const r = readline.createInterface({ input, output: undefined, terminal: false });
    try {
      return await new Promise<string>((resolve) => {
        r.once("line", (line) => resolve(line.trim()));
      });
    } finally {
      r.close();
    }
  }
  // Raw-mode masked read
  return await new Promise<string>((resolve) => {
    savedRawMode = (input as NodeJS.ReadStream & { isRaw?: boolean }).isRaw ?? false;
    (input as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void }).setRawMode?.(true);
    input.resume();
    let acc = "";
    const onData = (buf: Buffer) => {
      for (const b of buf) {
        if (b === 0x0d || b === 0x0a) {
          output.write("\n");
          cleanup(true);
          resolve(acc);
          return;
        }
        if (b === 0x03) {
          // Ctrl-C
          output.write("\n");
          cleanup(true);
          resolve("");
          return;
        }
        if (b === 0x04) {
          // Ctrl-D
          cleanup(true);
          resolve(acc);
          return;
        }
        if (b === 0x7f || b === 0x08) {
          // Backspace / Delete
          if (acc.length > 0) {
            acc = acc.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        const ch = String.fromCharCode(b);
        acc += ch;
        output.write("*");
      }
    };
    const cleanup = (restoreRaw: boolean) => {
      input.off("data", onData);
      if (restoreRaw && savedRawMode !== null) {
        (input as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void }).setRawMode?.(savedRawMode);
        savedRawMode = null;
      }
    };
    input.on("data", onData);
  });
}

export async function askYesNo(prompt: string, defaultValue = false): Promise<boolean> {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  const ans = (await askQuestion(`${prompt} ${hint} `)).toLowerCase();
  if (!ans) return defaultValue;
  return ans === "y" || ans === "yes";
}

/** Read input that may span multiple lines via `\\` continuation or ``` fences. */
export async function askMultiline(prompt: string): Promise<string> {
  output.write(prompt);
  const r = getRl();

  return await new Promise<string>((resolve) => {
    let acc = "";
    let inFence = false;
    let promptShown = true;

    const onLine = (line: string) => {
      const trimmedEnd = line.replace(/\s+$/, "");
      const fenceMatch = trimmedEnd.match(/^```/);
      if (fenceMatch) {
        acc += trimmedEnd + "\n";
        if (inFence) {
          // Closing fence -> submit the whole block
          cleanup();
          resolve(acc.replace(/\s+$/, ""));
          return;
        }
        inFence = true;
        showPrompt();
        return;
      }
      if (inFence) {
        acc += line + "\n";
        showPrompt();
        return;
      }
      // Backslash continuation
      if (trimmedEnd.endsWith("\\")) {
        acc += trimmedEnd.slice(0, -1) + "\n";
        showPrompt();
        return;
      }
      // Single-line submission
      acc += line;
      cleanup();
      resolve(acc);
    };

    function showPrompt(): void {
      const cont = paint.gray("› ");
      output.write(cont);
      promptShown = true;
    }

    function cleanup(): void {
      r.off("line", onLine);
      void promptShown;
    }

    r.on("line", onLine);
  });
}

export function closeReadline(): void {
  rl?.close();
  rl = null;
}

// ---- Interactive arrow-key picker ----

export interface SelectOption {
  label: string;
  value: string;
}

/**
 * Render an interactive arrow-key selector. ↑/↓ (or j/k) move, Enter confirms,
 * Esc/Ctrl-C cancels. Returns the chosen value, or null when cancelled or when
 * stdin/stdout isn't a TTY (caller should fall back to a plain listing).
 */
export async function selectOption(
  title: string,
  options: SelectOption[],
  startAt = 0,
): Promise<string | null> {
  // input/output here are process.stdin/stdout (imported at top of file).
  const tty = input as NodeJS.ReadStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (m: boolean) => void };
  if (options.length === 0) return null;
  if (tty.isTTY !== true || output.isTTY !== true) return null;

  const savedRaw = tty.isRaw ?? false;
  tty.setRawMode?.(true);
  tty.resume();

  const N = options.length;
  let idx = Math.max(0, Math.min(startAt, N - 1));

  const lineFor = (i: number): string => {
    const sel = i === idx;
    const marker = sel ? "❯ " : "  ";
    const body = options[i].label;
    return sel ? `\x1b[36m\x1b[1m${marker}${body}\x1b[0m` : `\x1b[2m${marker}${body}\x1b[0m`;
  };

  const draw = (initial: boolean): void => {
    if (!initial) output.write(`\x1b[${N}A`); // move up to the first option line
    for (let i = 0; i < N; i++) {
      output.write(`\r\x1b[K${lineFor(i)}\n`);
    }
  };

  output.write(`${title}\n`);
  output.write(`\x1b[2m  ↑/↓ navigate · enter select · esc cancel\x1b[0m\n`);
  draw(true);

  return new Promise<string | null>((resolve) => {
    const cleanup = (): void => {
      tty.off("data", onData);
      tty.setRawMode?.(savedRaw);
      output.write("\x1b[0m");
    };
    const onData = (buf: Buffer): void => {
      const bytes = Array.from(buf.values());
      // Arrow keys arrive as ESC [ A / ESC [ B.
      if (bytes.length >= 3 && bytes[0] === 0x1b && bytes[1] === 0x5b) {
        if (bytes[2] === 0x41) { idx = (idx - 1 + N) % N; draw(false); return; }
        if (bytes[2] === 0x42) { idx = (idx + 1) % N; draw(false); return; }
        return; // ignore left/right and other CSI sequences
      }
      const b = bytes[0];
      if (b === 0x1b || b === 0x03) { cleanup(); resolve(null); return; } // esc / ctrl-c
      if (b === 0x0d || b === 0x0a) { cleanup(); resolve(options[idx].value); return; } // enter
      if (b === 0x6b) { idx = (idx - 1 + N) % N; draw(false); return; } // k
      if (b === 0x6a) { idx = (idx + 1) % N; draw(false); return; } // j
      if (b >= 0x31 && b <= 0x39) { // 1-9 quick-select
        const n = b - 0x31;
        if (n < N) { idx = n; draw(false); }
      }
    };
    tty.on("data", onData);
  });
}
