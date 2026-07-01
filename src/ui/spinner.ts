// Simple animated spinner. No deps. Interval-based.
// Shows elapsed seconds inline once a phase runs ≥ 5s, so the user can
// perceive how long "thinking…" or "running tool…" has been going.
//
// Two frame modes:
//   • braille (default) — the spinning dots for "thinking…"
//   • dot-blink — ⏺ alternating with a space, for tool execution

import { C, outputSilent, paint, symbol } from "./theme.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DOT_BLINK_FRAMES = [paint.bright.cyan("⏺"), paint.gray("⏺")];

// \x1b[?25l hides the terminal cursor; \x1b[?25h shows it. Hiding during
// the spinner avoids the blinking caret sitting mid-line after the frame
// text, which looks like the cursor is "stuck" off col 0.
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

interface ActiveSpinner {
  id: number;
  text: string;
  frame: number;
  startMs: number;
  frames: string[];
  /** If true, stop() preserves the last frame as a permanent line (for tool headers). */
  keepOnStop: boolean;
}

let active: ActiveSpinner | null = null;

/** Format seconds into a compact suffix: "5s", "45s", "2m3s". */
function elapsedSuffix(startMs: number): string {
  const s = Math.floor((performance.now() - startMs) / 1000);
  if (s < 5) return "";
  if (s < 60) return paint.gray(` ${s}s`);
  const m = Math.floor(s / 60);
  return paint.gray(` ${m}m${s - m * 60}s`);
}

function render(): void {
  if (!active || outputSilent) return;
  const frame = active.frames[active.frame % active.frames.length];
  // \r → col 0 · \x1b[0m reset · \x1b[K erase-to-end-of-line so leftover text
  // from the previous input row can never bleed into the spinner frame.
  process.stdout.write(`\r${C.reset}\x1b[K${frame} ${paint.gray(active.text)}${elapsedSuffix(active.startMs)}`);
  active.frame++;
}

export const spinner = {
  start(text: string): void {
    if (outputSilent) return;
    if (active) this.stop();
    active = { id: 0, text, frame: 0, startMs: performance.now(), frames: SPINNER_FRAMES, keepOnStop: false };
    process.stdout.write(HIDE_CURSOR);
    render();
    active.id = setInterval(render, 80) as unknown as number;
  },

  /** Start with a blinking ⏺ frame (for tool execution). When stopped, the
   *  last rendered frame is preserved as a permanent line. */
  startTool(text: string): void {
    if (outputSilent) return;
    if (active) this.stop();
    active = { id: 0, text, frame: 0, startMs: performance.now(), frames: DOT_BLINK_FRAMES, keepOnStop: true };
    process.stdout.write(HIDE_CURSOR);
    render();
    // Blink at ~2Hz (every 270ms) — slower than the braille spinner since a
    // 10-frame rotation at 80ms would be too fast for a simple on/off dot.
    active.id = setInterval(render, 270) as unknown as number;
  },

  update(text: string): void {
    if (outputSilent) return;
    if (!active) {
      this.start(text);
      return;
    }
    active.text = text;
  },

  stop(finalText?: string): void {
    if (!active) {
      if (finalText !== undefined && !outputSilent) {
        process.stdout.write(`\r${C.reset}${finalText}\n`);
      }
      return;
    }
    clearInterval(active.id);
    if (!outputSilent) {
      if (active.keepOnStop) {
        // Render one final static frame (bright ⏺) and move to a new line,
        // preserving the tool header as a permanent record.
        active.frame = 0; // force bright ⏺
        render();
        process.stdout.write("\n");
      } else {
        // Clear the spinner line.
        process.stdout.write(`\r${C.reset}\x1b[K`);
      }
      process.stdout.write(SHOW_CURSOR);
    }
    active = null;
    if (finalText !== undefined && !outputSilent) {
      process.stdout.write(`${finalText}\n`);
    }
  },
};

export function withSpinner<T>(text: string, fn: (update: (s: string) => void) => Promise<T>): Promise<T> {
  spinner.start(text);
  return fn((s) => spinner.update(s)).finally(() => spinner.stop());
}

// Suppress unused symbol warning — kept for future use
void symbol;
