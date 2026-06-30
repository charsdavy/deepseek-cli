// Simple animated spinner. No deps. Interval-based.

import { C, outputSilent, paint, symbol } from "./theme.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let active: { id: number; text: string; frame: number } | null = null;

function render(): void {
  if (!active || outputSilent) return;
  const frame = SPINNER_FRAMES[active.frame % SPINNER_FRAMES.length];
  // \r → col 0 · \x1b[0m reset · \x1b[K erase-to-end-of-line so leftover text
  // from the previous input row can never bleed into the spinner frame.
  process.stdout.write(`\r${C.reset}\x1b[K${paint.cyan(frame)} ${paint.gray(active.text)}`);
  active.frame++;
}

export const spinner = {
  start(text: string): void {
    if (outputSilent) return;
    if (active) this.stop();
    active = { id: 0, text, frame: 0 };
    render();
    active.id = setInterval(render, 80) as unknown as number;
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
    // Clear spinner line
    if (!outputSilent) process.stdout.write(`\r${C.reset}\x1b[K`);
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
