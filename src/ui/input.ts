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
  // Ensure the cursor is visible — the spinner may have hidden it with
  // \x1b[?25l, and readline doesn't restore it on its own.
  process.stdout.write("\x1b[?25h");
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

/** Visible width of a string (ANSI stripped; emoji/CJK = 2, else 1). */
function visWidth(s: string): number {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of stripped) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20) continue;
    w += isWideChar(c) ? 2 : 1;
  }
  return w;
}

/** True for codepoints that occupy two terminal columns (emoji / CJK / Hangul /
 *  fullwidth). The 0x2000–0x2E7F block (General Punctuation, Arrows, Math, …)
 *  is explicitly narrow so symbols like U+203A `›` are not mis-counted. */
function isWideChar(c: number): boolean {
  if (c >= 0x1F000 || (c >= 0x2600 && c <= 0x27BF)) return true; // emoji-ish
  if (c >= 0x2000 && c < 0x2E80) return false; // punctuation / arrows / math — narrow
  return (
    (c >= 0x1100 && c < 0x2000) || // Hangul Jamo, etc.
    (c >= 0x2E80 && c <= 0xA4CF) || // CJK radicals → Yi
    (c >= 0xAC00 && c <= 0xD7A3) || // Hangul Syllables
    (c >= 0xF900 && c <= 0xFAFF) || // CJK Compatibility Ideographs
    (c >= 0xFE30 && c <= 0xFE4F) || // CJK Compatibility Forms
    (c >= 0xFF00 && c <= 0xFFE6)    // Fullwidth ASCII / signs
  );
}

/** Read input (single- or multi-line). When the current line starts with `/`,
 *  matching slash commands are listed LIVE below the prompt and updated as the
 *  user types. Tab completes to the common prefix; Up/Down recall history;
 *  backslash/```-fence continue across lines. */
export async function askMultiline(
  prompt: string,
  historySeed?: string[],
  suggest?: (line: string) => string[],
  initial?: string,
): Promise<string> {
  const tty = input as unknown as NodeJS.ReadStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (m: boolean) => void };
  const isTTY = tty.isTTY === true && output.isTTY === true;
  // Non-TTY (pipe/CI): fall back to a plain single-line read.
  if (!isTTY) {
    output.write(prompt);
    const lineRl = readline.createInterface({ input: tty, output: undefined as unknown as NodeJS.WritableStream, terminal: false });
    try {
      return await new Promise<string>((resolve) => {
        lineRl.once("line", (l: string) => resolve((initial ?? "") + l));
      });
    } finally {
      lineRl.close();
    }
  }

  const savedRaw = tty.isRaw ?? false;
  tty.setRawMode?.(true);
  tty.resume();

  const hist = historySeed ? historySeed.slice(0, 500) : [];
  let histIdx = -1; // -1 = not browsing history
  let buf = initial ?? "";
  let cur = buf.length;
  let curPrompt = prompt;
  let fence = false;
  let acc = "";
  let overlayRows = 0; // lines drawn below the current input row (suggestions)
  let resolved = false;

  const matches = (): string[] => {
    if (!buf.startsWith("/") || !suggest) return [];
    const m = suggest(buf);
    // Cap to keep the overlay on one row.
    return m.slice(0, 12);
  };

  const render = (): void => {
    // Clear the current line and everything below it (overlay), then redraw.
    output.write(`\r\x1b[J`);
    output.write(curPrompt + buf);
    const m = matches();
    if (m.length > 0) {
      output.write(`\n\x1b[K${paint.dim(m.join("  "))}`);
      overlayRows = 1;
      output.write(`\x1b[A`); // back up to the input row
    } else {
      overlayRows = 0;
    }
    // Position the cursor at cur on the input row.
    output.write(`\r`);
    const col = visWidth(curPrompt) + visWidth(buf.slice(0, cur));
    if (col > 0) output.write(`\x1b[${col}C`);
  };

  const cleanup = (): void => {
    tty.off("data", onData);
    if (overlayRows > 0) output.write(`\r\x1b[J`); // erase the suggestions row
    tty.setRawMode?.(savedRaw);
  };

  const tabComplete = (): void => {
    const m = matches();
    if (m.length === 0) return;
    // Extend buf to the longest common prefix of the matches.
    let p = m[0];
    for (const c of m) {
      while (!c.startsWith(p)) p = p.slice(0, -1);
    }
    if (p.length > buf.length) { buf = p; cur = buf.length; render(); }
  };

  const submitLine = (full: string): void => {
    if (resolved) return;
    resolved = true;
    cleanup();
    // Move to a fresh line so the user's typed input stays on its own row
    // and subsequent output (spinner / reasoning) does not overwrite it.
    output.write("\r\n");
    resolveFn(full);
  };

  let resolveFn!: (s: string) => void;
  const done = new Promise<string>((res) => { resolveFn = res; });

  const onData = (data: Buffer): void => {
    const b0 = data[0];
    // Escape sequences (arrows / delete / home / end).
    if (b0 === 0x1b) {
      if (data.length >= 3 && data[1] === 0x5b) {
        const c = data[2];
        if (c === 0x41 && !fence) { // up — history older
          if (hist.length && histIdx < hist.length - 1) { histIdx++; buf = hist[histIdx] ?? ""; cur = buf.length; }
        } else if (c === 0x42 && !fence) { // down — history newer
          if (histIdx > 0) { histIdx--; buf = hist[histIdx] ?? ""; cur = buf.length; }
          else { histIdx = -1; buf = ""; cur = 0; }
        } else if (c === 0x43) { cur = Math.min(buf.length, cur + 1); } // right
        else if (c === 0x44) { cur = Math.max(0, cur - 1); } // left
        else if (c === 0x48 || c === 0x46) { cur = c === 0x48 ? 0 : buf.length; } // home/end
      }
      render();
      return;
    }
    if (b0 === 0x0d || b0 === 0x0a) { // enter
      handleEnter();
      return;
    }
    if (b0 === 0x7f || b0 === 0x08) { // backspace
      if (cur > 0) { buf = buf.slice(0, cur - 1) + buf.slice(cur); cur--; }
      histIdx = -1;
      render();
      return;
    }
    if (b0 === 0x03) { submitLine(""); return; } // ctrl-c → empty (cancel line)
    if (b0 === 0x09) { tabComplete(); return; } // tab
    if (b0 < 0x20) { render(); return; } // other control: ignore
    // Printable (UTF-8 ok): insert at cursor.
    const s = data.toString("utf-8");
    buf = buf.slice(0, cur) + s + buf.slice(cur);
    cur += s.length;
    histIdx = -1;
    render();
  };

  const handleEnter = (): void => {
    const trimmedEnd = buf.replace(/\s+$/, "");
    const fenceMatch = trimmedEnd.match(/^```/);
    if (fenceMatch) {
      acc += trimmedEnd + "\n";
      if (fence) { submitLine(acc.replace(/\s+$/, "")); return; }
      fence = true;
      buf = ""; cur = 0;
      output.write("\n"); curPrompt = paint.gray("› "); render();
      return;
    }
    if (fence) { acc += buf + "\n"; buf = ""; cur = 0; output.write("\n"); curPrompt = paint.gray("› "); render(); return; }
    if (trimmedEnd.endsWith("\\")) {
      acc += trimmedEnd.slice(0, -1) + "\n";
      buf = ""; cur = 0;
      output.write("\n"); curPrompt = paint.gray("› "); render();
      return;
    }
    submitLine(acc + buf);
  };

  tty.on("data", onData);
  // Initial draw.
  render();
  return done;
}

// ---- Double-Esc turn abort ----
//
// During a running AI turn stdin is in cooked mode (askMultiline has restored
// it on submit), so a lone Escape key would be buffered until Enter. To let
// the user double-tap Esc to cancel a running turn we briefly take stdin into
// raw mode for the turn's lifetime and run a small state machine over the
// incoming bytes. The detection logic is split into a pure reducer so it can
// be unit-tested without a real TTY.

export const DOUBLE_ESC_WINDOW_MS = 1500;

/**
 * Pure reducer for double-Escape detection. Given the inbound bytes, the
 * previous Escape timestamp, the current time, and the detection window,
 * returns the next state: `lastEsc` (0 = disarmed) and `abort` (true when a
 * double-tap was recognized — caller should fire the abort).
 *
 * - A real Escape keypress arrives as a lone `0x1b` (or `0x1b` not followed by
 *   `[`); arrow keys arrive as `0x1b 0x5b …` (CSI) and are ignored so they
 *   don't arm the timer.
 * - First Escape arms the timer (returns `lastEsc = now`).
 * - Second Escape within the window fires `abort: true`.
 */
export function reduceEsc(
  bytes: Uint8Array,
  lastEsc: number,
  now: number,
  windowMs = DOUBLE_ESC_WINDOW_MS,
): { lastEsc: number; abort: boolean } {
  if (bytes.length === 0 || bytes[0] !== 0x1b) {
    return { lastEsc, abort: false };
  }
  // CSI sequence (arrows / home / end / delete): ESC [ … — not a real Esc.
  if (bytes.length >= 2 && bytes[1] === 0x5b) {
    return { lastEsc, abort: false };
  }
  // Real Escape keypress.
  if (lastEsc > 0 && now - lastEsc < windowMs) {
    return { lastEsc: 0, abort: true };
  }
  return { lastEsc: now, abort: false };
}

/**
 * Install a raw-mode stdin listener that watches for a double-Escape and
 * invokes `onAbort` when it fires. Returns a cleanup function that detaches
 * the listener and restores the prior raw mode. No-ops (returns a nop) when
 * stdin/stdout isn't a TTY, so non-interactive / CI runs are unaffected.
 */
export function watchDoubleEsc(onAbort: () => void): () => void {
  const tty = input as NodeJS.ReadStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (m: boolean) => void };
  if (tty.isTTY !== true || output.isTTY !== true) {
    return () => {};
  }
  const savedRaw = tty.isRaw ?? false;
  try {
    tty.setRawMode?.(true);
  } catch {
    return () => {};
  }
  tty.resume();

  let lastEsc = 0;
  let armed = true;

  const onData = (data: Buffer): void => {
    if (!armed) return;
    const next = reduceEsc(data, lastEsc, Date.now());
    lastEsc = next.lastEsc;
    if (next.abort) {
      armed = false;
      cleanup();
      onAbort();
    } else if (next.lastEsc > 0 && lastEsc === next.lastEsc) {
      // First tap registered — nudge the user with a one-liner on its own row
      // so they know a second tap will cancel. Kept minimal to avoid clobbering
      // streaming output; the spinner / renderer keep writing below it.
      output.write("\n" + paint.yellow("  (Esc again to cancel)") + "\n");
    }
  };

  const cleanup = (): void => {
    tty.off("data", onData);
    try {
      tty.setRawMode?.(savedRaw);
    } catch {
      /* ignore */
    }
  };

  tty.on("data", onData);
  return cleanup;
}

/**
 * Turn-input watcher: a superset of watchDoubleEsc that also captures
 * printable keystrokes so the user can type and queue prompts while the
 * AI is working. Typed text is shown live via the `onType` callback (the
 * caller typically updates the spinner text). When Enter is pressed the
 * line is queued via `onQueued` and the buffer is cleared.
 *
 * Returns a cleanup function that detaches the listener and restores the
 * prior raw mode. No-ops when stdin/stdout isn't a TTY.
 */
export function watchTurnInput(
  onAbort: () => void,
  onQueued: (text: string) => void,
  onType: (buffer: string, queuedCount: number) => void,
): () => void {
  const tty = input as NodeJS.ReadStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (m: boolean) => void };
  if (tty.isTTY !== true || output.isTTY !== true) {
    return () => {};
  }
  const savedRaw = tty.isRaw ?? false;
  try {
    tty.setRawMode?.(true);
  } catch {
    return () => {};
  }
  tty.resume();

  let lastEsc = 0;
  let armed = true;
  let buf = "";
  let queued = 0;

  const onData = (data: Buffer): void => {
    if (!armed) return;
    const b0 = data[0];

    // --- Escape handling (double-Esc abort) ---
    if (b0 === 0x1b) {
      // CSI sequence (arrows etc): not a real Esc
      if (data.length >= 2 && data[1] === 0x5b) return;
      const now = Date.now();
      if (lastEsc > 0 && now - lastEsc < DOUBLE_ESC_WINDOW_MS) {
        lastEsc = 0;
        armed = false;
        cleanup();
        onAbort();
        return;
      }
      lastEsc = now;
      output.write("\n" + paint.yellow("  (Esc again to cancel)") + "\n");
      return;
    }

    // --- Regular input ---
    // Enter — queue the line
    if (b0 === 0x0d || b0 === 0x0a) {
      if (buf.trim()) {
        queued++;
        onQueued(buf);
      }
      buf = "";
      onType(buf, queued);
      return;
    }

    // Backspace / Delete
    if (b0 === 0x7f || b0 === 0x08) {
      if (buf.length > 0) {
        buf = buf.slice(0, -1);
        onType(buf, queued);
      }
      return;
    }

    // Ctrl-C — abort like a double-Esc
    if (b0 === 0x03) {
      armed = false;
      cleanup();
      onAbort();
      return;
    }

    // Other control chars: ignore
    if (b0 < 0x20) return;

    // Printable (UTF-8 ok): append to buffer
    buf += data.toString("utf-8");
    onType(buf, queued);
  };

  const cleanup = (): void => {
    tty.off("data", onData);
    try {
      tty.setRawMode?.(savedRaw);
    } catch {
      /* ignore */
    }
  };

  tty.on("data", onData);
  return cleanup;
}

export function closeReadline(): void {
  rl?.close();
  rl = null;
}

/** Restore the terminal to cooked mode and stop reading stdin. Call before
 *  process.exit so the user's shell gets a sane TTY back. */
export function restoreTerminal(): void {
  const tty = input as unknown as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (m: boolean) => void };
  try { tty.setRawMode?.(false); } catch {
    /* ignore */
  }
  try { tty.pause(); } catch {
    /* ignore */
  }
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
