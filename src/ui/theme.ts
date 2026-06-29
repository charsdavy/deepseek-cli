// ANSI escape helpers — zero-dependency terminal styling.

const isTTY = process.stdout.isTTY;
const envNoColor = process.env.NO_COLOR !== undefined;
const envForceColor = process.env.FORCE_COLOR;
const enabled =
  isTTY && !envNoColor && envForceColor !== "0" && envForceColor !== "false";

export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  strikethrough: "\x1b[9m",
  inverse: "\x1b[7m",
  bgRed: "\x1b[41m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
};

export type ColorName = keyof typeof C;

function wrap(code: string, text: string): string {
  if (!enabled) return text;
  return `${code}${text}${C.reset}`;
}

export const paint = {
  bold: (t: string) => wrap(C.bold, t),
  dim: (t: string) => wrap(C.dim, t),
  italic: (t: string) => wrap(C.italic, t),
  underline: (t: string) => wrap(C.underline, t),
  strikethrough: (t: string) => wrap(C.strikethrough, t),
  inverse: (t: string) => wrap(C.inverse, t),
  red: (t: string) => wrap(C.red, t),
  green: (t: string) => wrap(C.green, t),
  yellow: (t: string) => wrap(C.yellow, t),
  blue: (t: string) => wrap(C.blue, t),
  magenta: (t: string) => wrap(C.magenta, t),
  cyan: (t: string) => wrap(C.cyan, t),
  gray: (t: string) => wrap(C.gray, t),
  bgRed: (t: string) => wrap(C.bgRed, t),
  bright: {
    red: (t: string) => wrap(C.brightRed, t),
    green: (t: string) => wrap(C.brightGreen, t),
    yellow: (t: string) => wrap(C.brightYellow, t),
    blue: (t: string) => wrap(C.brightBlue, t),
    magenta: (t: string) => wrap(C.brightMagenta, t),
    cyan: (t: string) => wrap(C.brightCyan, t),
  },
};

/**
 * Compose multiple colorizers — e.g. `combine(paint.bold, paint.magenta)(text)`
 * yields bold magenta text. Used as a lightweight alternative to method chaining.
 */
export function combine(...fns: Array<(t: string) => string>): (t: string) => string {
  return (text: string) => fns.reduceRight((acc, fn) => fn(acc), text);
}

export const symbol = {
  ok: "✓",
  err: "✗",
  bullet: "•",
  arrow: "→",
  prompt: "❯",
  star: "★",
  robot: "🤖",
  user: "👤",
  lock: "🔒",
  brain: "🧠",
  trash: "🧹",
  rocket: "🚀",
  tip: "💡",
};

export const enabledColors = enabled;

// ---- Silent mode (for --output-format json / pipe mode) ----
// When true, every noisy stdout side effect (streaming text, spinner, panels,
// tool headers, system messages) is suppressed so the program can emit a
// single structured JSON blob to stdout for scripting / CI consumption.
export let outputSilent = false;

export function setOutputSilent(v: boolean): void {
  outputSilent = v;
}
