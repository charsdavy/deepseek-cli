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
