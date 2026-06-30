import { describe, it, expect } from "bun:test";
import { reduceEsc, DOUBLE_ESC_WINDOW_MS } from "../src/ui/input.ts";

const ESC = 0x1b;
const BRACKET = 0x5b; // "[" — the CSI introducer for arrow keys

describe("reduceEsc", () => {
  it("ignores empty input", () => {
    const r = reduceEsc(new Uint8Array([]), 0, 1000);
    expect(r.abort).toBe(false);
    expect(r.lastEsc).toBe(0);
  });

  it("ignores bytes that don't start with Esc", () => {
    const r = reduceEsc(new Uint8Array([0x61 /*a*/]), 0, 1000); // was 500
    expect(r.abort).toBe(false);
    expect(r.lastEsc).toBe(0);
  });

  it("ignores arrow keys (Esc [ …) so they don't arm the timer", () => {
    // Up arrow = Esc [ A
    const r = reduceEsc(new Uint8Array([ESC, BRACKET, 0x41]), 0, 1000);
    expect(r.abort).toBe(false);
    expect(r.lastEsc).toBe(0);
  });

  it("arms the timer on the first lone Esc", () => {
    const now = 2000;
    const r = reduceEsc(new Uint8Array([ESC]), 0, now);
    expect(r.abort).toBe(false);
    expect(r.lastEsc).toBe(now);
  });

  it("aborts on a second lone Esc within the window", () => {
    const first = 2000;
    const second = first + (DOUBLE_ESC_WINDOW_MS - 50);
    const armed = reduceEsc(new Uint8Array([ESC]), 0, first);
    expect(armed.lastEsc).toBe(first);
    const fired = reduceEsc(new Uint8Array([ESC]), armed.lastEsc, second);
    expect(fired.abort).toBe(true);
    expect(fired.lastEsc).toBe(0);
  });

  it("does NOT abort when the second Esc is outside the window", () => {
    const first = 2000;
    const second = first + DOUBLE_ESC_WINDOW_MS + 50;
    const armed = reduceEsc(new Uint8Array([ESC]), 0, first);
    expect(armed.lastEsc).toBe(first);
    const r = reduceEsc(new Uint8Array([ESC]), armed.lastEsc, second);
    expect(r.abort).toBe(false);
    // Re-arms from the late second tap.
    expect(r.lastEsc).toBe(second);
  });

  it("respects a custom window", () => {
    const first = 5000;
    const armed = reduceEsc(new Uint8Array([ESC]), 0, first, 1000);
    expect(armed.abort).toBe(false);
    expect(armed.lastEsc).toBe(first);
    // 800ms later, custom window 1000 → should fire.
    const fired = reduceEsc(new Uint8Array([ESC]), armed.lastEsc, first + 800, 1000);
    expect(fired.abort).toBe(true);
  });

  it("a non-Esc byte between two Escs does not consume the arming", () => {
    const first = 3000;
    const armed = reduceEsc(new Uint8Array([ESC]), 0, first);
    // Stray 'a' keystroke shouldn't reset the timer.
    const between = reduceEsc(new Uint8Array([0x61]), armed.lastEsc, first + 50);
    expect(between.abort).toBe(false);
    expect(between.lastEsc).toBe(first);
    const fired = reduceEsc(new Uint8Array([ESC]), between.lastEsc, first + 100);
    expect(fired.abort).toBe(true);
  });
});
