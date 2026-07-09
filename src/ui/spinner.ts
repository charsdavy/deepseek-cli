// Simple animated spinner. No deps. Interval-based.
// Shows elapsed seconds inline once a phase runs ≥ 5s, so the user can
// perceive how long "thinking…" or "running tool…" has been going.
//
// Two frame modes:
//   • braille (default) — the spinning dots for "thinking…"
//   • dot-blink — ⏺ alternating with a space, for tool execution

import { C, outputSilent, paint, symbol } from "./theme.ts";
import { safeStdoutWrite, isStdoutBroken } from "./render.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DOT_BLINK_FRAMES = [paint.bright.cyan("⏺"), paint.gray("⏺")];

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
  const suffix = elapsedSuffix(active.startMs);
  // The spinner occupies one line; the cursor sits on the EMPTY line below
  // it at col 0, so the user can type queued input while the AI works.
  //
  // First frame: just write the frame + move down to the empty line.
  // Subsequent frames: move up (\x1b[A), clear, rewrite, move back down.
  // \n moves the cursor down one line; \r goes to col 0.
  if (active.frame > 0) {
    safeStdoutWrite(`\x1b[A`);
  }
  safeStdoutWrite(`\r${C.reset}\x1b[K${frame} ${paint.gray(active.text)}${suffix}\r\n`);
  active.frame++;
}

export const spinner = {
  start(text: string): void {
    if (outputSilent) return;
    if (active) this.stop();
    active = { id: 0, text, frame: 0, startMs: performance.now(), frames: SPINNER_FRAMES, keepOnStop: false };
    render();
    active.id = setInterval(render, 80) as unknown as number;
  },

  /** Start with a blinking ⏺ frame (for tool execution). When stopped, the
   *  last rendered frame is preserved as a permanent line. */
  startTool(text: string): void {
    if (outputSilent) return;
    if (active) this.stop();
    active = { id: 0, text, frame: 0, startMs: performance.now(), frames: DOT_BLINK_FRAMES, keepOnStop: true };
    render();
    active.id = setInterval(render, 270) as unknown as number;
  },

  update(text: string): void {
    if (outputSilent) return;
    // Do NOT restart the spinner if it was stopped. During content/reasoning
    // output, onContentDelta/onReasoningDelta stop the spinner to write text
    // to stdout. If the user types during that window, watchTurnInput's onType
    // calls update() — restarting the spinner here would clobber the text being
    // written (its 80ms render() clears lines with \x1b[A\r\x1b[K). The user's
    // typing is still captured by watchTurnInput's buffer and queued on Enter;
    // it just won't be reflected in the spinner until it restarts next iteration.
    if (!active) return;
    active.text = text;
  },

  stop(finalText?: string): void {
    if (!active) {
      if (finalText !== undefined && !outputSilent) {
        safeStdoutWrite(`\r${C.reset}${finalText}\r\n`);
      }
      return;
    }
    clearInterval(active.id);
    if (!outputSilent && !isStdoutBroken()) {
      if (active.keepOnStop) {
        const frame = active.frames[0];
        safeStdoutWrite(`\x1b[A\r${C.reset}\x1b[K${frame} ${paint.gray(active.text)}\r\n`);
      } else {
        safeStdoutWrite(`\x1b[A\r${C.reset}\x1b[K`);
      }
    }
    active = null;
    if (finalText !== undefined && !outputSilent) {
      safeStdoutWrite(`${finalText}\r\n`);
    }
  },

  /** Exposed for tests: true when the spinner is running (interval active). */
  isActive(): boolean {
    return active !== null;
  },
};

export function withSpinner<T>(text: string, fn: (update: (s: string) => void) => Promise<T>): Promise<T> {
  spinner.start(text);
  return fn((s) => spinner.update(s)).finally(() => spinner.stop());
}

// Suppress unused symbol warning — kept for future use
void symbol;
