import { describe, it, expect } from "bun:test";
import { reduceEsc, reduceTurnInput, DOUBLE_ESC_WINDOW_MS, type TurnInputState } from "../src/ui/input.ts";

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

  it("DOUBLE_ESC_WINDOW_MS is wide enough for a human-paced second tap", () => {
    // Regression: previously 450ms, which was too tight for a user reading
    // "(Esc again to cancel)" and then reacting — the second tap re-armed
    // instead of aborting. 1.5s covers a comfortable read + react window.
    expect(DOUBLE_ESC_WINDOW_MS).toBeGreaterThanOrEqual(1500);
  });
});

// ---- reduceTurnInput ----

const initialState = (overrides: Partial<TurnInputState> = {}): TurnInputState => ({
  buf: "",
  queued: 0,
  lastEsc: 0,
  armed: true,
  ...overrides,
});

describe("reduceTurnInput", () => {
  it("queues a prompt on Enter", () => {
    const s = initialState({ buf: "hello world" });
    const r = reduceTurnInput(new Uint8Array([0x0d]), s, false, 1000);
    expect(r.queuedText).toBe("hello world");
    expect(r.state.buf).toBe("");
    expect(r.state.queued).toBe(1);
    expect(r.typeBuffer).toBe(""); // buffer cleared → onType("")
  });

  it("does NOT queue empty input on Enter", () => {
    const s = initialState({ buf: "   " });
    const r = reduceTurnInput(new Uint8Array([0x0d]), s, false, 1000);
    expect(r.queuedText).toBe(null);
    expect(r.state.queued).toBe(0);
  });

  it("appends printable chars to the type buffer", () => {
    const s = initialState({ buf: "hi" });
    const r = reduceTurnInput(new Uint8Array([0x21]), s, false, 1000); // '!'
    expect(r.state.buf).toBe("hi!");
    expect(r.typeBuffer).toBe("hi!");
    expect(r.queuedText).toBe(null);
  });

  it("removes the last char on backspace", () => {
    const s = initialState({ buf: "abc" });
    const r = reduceTurnInput(new Uint8Array([0x7f]), s, false, 1000);
    expect(r.state.buf).toBe("ab");
    expect(r.typeBuffer).toBe("ab");
  });

  it("does nothing on backspace when buffer is empty", () => {
    const s = initialState({ buf: "" });
    const r = reduceTurnInput(new Uint8Array([0x7f]), s, false, 1000);
    expect(r.state.buf).toBe("");
    expect(r.typeBuffer).toBe(null);
  });

  it("aborts on Ctrl-C", () => {
    const s = initialState();
    const r = reduceTurnInput(new Uint8Array([0x03]), s, false, 1000);
    expect(r.aborted).toBe(true);
    expect(r.state.armed).toBe(false);
  });

  it("aborts on double-Esc within the window", () => {
    const s = initialState({ lastEsc: 2000 });
    const r = reduceTurnInput(new Uint8Array([ESC]), s, false, 2500);
    expect(r.aborted).toBe(true);
    expect(r.state.armed).toBe(false);
  });

  it("shows escHint on first Esc", () => {
    const s = initialState({ lastEsc: 0 });
    const r = reduceTurnInput(new Uint8Array([ESC]), s, false, 1000);
    expect(r.escHint).toBe(true);
    expect(r.aborted).toBe(false);
    expect(r.state.lastEsc).toBe(1000);
  });

  it("ignores arrow keys (CSI sequences)", () => {
    const s = initialState();
    const r = reduceTurnInput(new Uint8Array([ESC, BRACKET, 0x41]), s, false, 1000);
    expect(r.queuedText).toBe(null);
    expect(r.typeBuffer).toBe(null);
    expect(r.aborted).toBe(false);
    expect(r.escHint).toBe(false);
  });

  it("ignores other control chars", () => {
    const s = initialState({ buf: "x" });
    const r = reduceTurnInput(new Uint8Array([0x01]), s, false, 1000); // Ctrl-A
    expect(r.state.buf).toBe("x"); // unchanged
    expect(r.typeBuffer).toBe(null);
  });

  it("does nothing when disarmed", () => {
    const s = initialState({ armed: false, buf: "text" });
    const r = reduceTurnInput(new Uint8Array([0x0d]), s, false, 1000);
    expect(r.queuedText).toBe(null);
    expect(r.typeBuffer).toBe(null);
    expect(r.aborted).toBe(false);
    expect(r.state.armed).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Bug: permission prompt keystrokes captured as [Queued] prompts.
  //
  // watchTurnInput keeps stdin in raw mode during AI turns. When a
  // permission prompt (askQuestion) appears, keystrokes went to the
  // watcher's onData (queued as [Queued] y / [Queued] a) instead of
  // readline. The fix: askQuestion calls pauseTurnInput() which sets
  // turnInputPaused=true; reduceTurnInput checks the paused flag and
  // returns idle (no queuing, no typing).
  // ═══════════════════════════════════════════════════════════════════
  it("ignores ALL input when paused (Bug: [Queued] on permission prompt)", () => {
    const s = initialState({ buf: "existing" });

    // 'y' keypress (would be the user answering "Approve? [y/n/a]")
    const r1 = reduceTurnInput(new Uint8Array([0x79]), s, true, 1000); // 'y', paused=true
    expect(r1.queuedText).toBe(null);
    expect(r1.typeBuffer).toBe(null);
    expect(r1.state.buf).toBe("existing"); // unchanged

    // Enter keypress (would be the user submitting "y" to readline)
    const r2 = reduceTurnInput(new Uint8Array([0x0d]), s, true, 1000); // Enter, paused=true
    expect(r2.queuedText).toBe(null);
    expect(r2.typeBuffer).toBe(null);
    expect(r2.state.queued).toBe(0); // NOT queued

    // 'a' keypress (would be the user choosing "always")
    const r3 = reduceTurnInput(new Uint8Array([0x61]), s, true, 1000); // 'a', paused=true
    expect(r3.queuedText).toBe(null);
    expect(r3.typeBuffer).toBe(null);
    expect(r3.state.buf).toBe("existing"); // unchanged

    // Ctrl-C while paused — should NOT abort (let readline handle it)
    const r4 = reduceTurnInput(new Uint8Array([0x03]), s, true, 1000);
    expect(r4.aborted).toBe(false);
    expect(r4.state.armed).toBe(true); // still armed
  });

  it("resumes processing after pause is lifted", () => {
    const s = initialState({ buf: "" });

    // Paused — input ignored
    const r1 = reduceTurnInput(new Uint8Array([0x79, 0x0d]), s, true, 1000);
    expect(r1.queuedText).toBe(null);

    // Unpaused — input processed
    const r2 = reduceTurnInput(new Uint8Array([0x68, 0x69]), r1.state, false, 1000); // "hi"
    expect(r2.state.buf).toBe("hi");
    expect(r2.typeBuffer).toBe("hi");

    const r3 = reduceTurnInput(new Uint8Array([0x0d]), r2.state, false, 1000); // Enter
    expect(r3.queuedText).toBe("hi");
    expect(r3.state.queued).toBe(1);
  });
});
