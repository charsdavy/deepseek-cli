import { describe, it, expect } from "bun:test";
import { reduceEsc, reduceTurnInput, computeVisualLayout, DOUBLE_ESC_WINDOW_MS, type TurnInputState } from "../src/ui/input.ts";

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

// ═══════════════════════════════════════════════════════════════════
// computeVisualLayout — visual line counting with terminal wrapping.
//
// Bug: when a user types a long line (especially CJK text where each
// character is 2 terminal columns), the line wraps across multiple
// terminal rows. The old render() tracked displayLines as logical
// newlines only (buf.split("\n").length), staying at 1 even though the
// text occupied 3+ visual rows. The cursor-up before redraw didn't move
// far enough, so old wrapped content was never cleared — each keystroke
// wrote a fresh copy of the entire prompt + text below the stale content,
// filling the screen with duplicates.
// ═══════════════════════════════════════════════════════════════════
describe("computeVisualLayout", () => {
  it("returns 1 line for empty buffer", () => {
    const r = computeVisualLayout("", 0, 5, 80);
    expect(r.totalLines).toBe(1);
    expect(r.cursorVisualLine).toBe(0);
    expect(r.cursorCol).toBe(5); // prompt width
  });

  it("returns 1 line for short text that fits", () => {
    const r = computeVisualLayout("hello", 5, 5, 80);
    expect(r.totalLines).toBe(1);
    expect(r.cursorVisualLine).toBe(0);
    expect(r.cursorCol).toBe(10); // 5 prompt + 5 text
  });

  it("counts 2 visual lines when text wraps past terminal width", () => {
    // prompt=5, text=76 cols → total 81 → ceil(81/80) = 2 lines
    const text = "a".repeat(76);
    const r = computeVisualLayout(text, 76, 5, 80);
    expect(r.totalLines).toBe(2);
    // cursor at end: 81 cols → floor(81/80)=1, col=81%80=1
    expect(r.cursorVisualLine).toBe(1);
    expect(r.cursorCol).toBe(1);
  });

  it("counts 3 visual lines for long CJK text (regression: was 1)", () => {
    // Each CJK char = 2 cols. prompt=5 (👤=2 + space=1 + ›=1 + space=1).
    // 40 CJK chars = 80 cols. Total = 85. ceil(85/40) = 3 lines on a 40-col terminal.
    const text = "　".repeat(40); // fullwidth space (U+3000), width=2
    const r = computeVisualLayout(text, 40, 5, 40);
    expect(r.totalLines).toBe(3);
    // cursor at end: 85 cols → floor(85/40)=2, col=85%40=5
    expect(r.cursorVisualLine).toBe(2);
    expect(r.cursorCol).toBe(5);
  });

  it("places cursor on the correct visual line when mid-text", () => {
    // prompt=5, 80-col terminal. Text = 80 chars (80 cols).
    // Total = 85 → 2 visual lines. Cursor at char 40 (45 cols from left).
    // floor(45/80) = 0 → cursor on visual line 0, col 45.
    const text = "a".repeat(80);
    const r = computeVisualLayout(text, 40, 5, 80);
    expect(r.totalLines).toBe(2); // ceil(85/80) = 2
    expect(r.cursorVisualLine).toBe(0);
    expect(r.cursorCol).toBe(45); // 5 + 40
  });

  it("handles logical newlines plus wrapping", () => {
    // Two logical lines: "aaa…"(50 chars) and "bbb…"(50 chars)
    // Line 0: prompt=5 + 50 = 55 → ceil(55/80)=1 visual line
    // Line 1: 50 → ceil(50/80)=1 visual line
    // Total = 2 visual lines. Cursor at end of line 1.
    const buf = "a".repeat(50) + "\n" + "b".repeat(50);
    const r = computeVisualLayout(buf, buf.length, 5, 80);
    expect(r.totalLines).toBe(2);
    expect(r.cursorVisualLine).toBe(1);
    expect(r.cursorCol).toBe(50);
  });

  it("handles multiple logical lines where each wraps", () => {
    // Two logical lines, each wrapping on a 40-col terminal.
    // Line 0: prompt=5 + 79 chars = 84 → ceil(84/40)=3 visual lines
    // Line 1: 79 chars = 79 → ceil(79/40)=2 visual lines
    // Total = 5. Cursor at end: floor(79/40)=1 → line 3+1=4, col 79%40=39.
    const buf = "a".repeat(79) + "\n" + "b".repeat(79);
    const r = computeVisualLayout(buf, buf.length, 5, 40);
    expect(r.totalLines).toBe(5);
    expect(r.cursorVisualLine).toBe(4);
    expect(r.cursorCol).toBe(39);
  });

  it("treats cols=0 as 1 to avoid division by zero", () => {
    const r = computeVisualLayout("hello", 5, 5, 0);
    expect(r.totalLines).toBe(10); // ceil(10/1) = 10
  });
});
