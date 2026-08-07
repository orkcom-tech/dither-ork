/**
 * The open/close timing — every clause of F-UI-13's "it must not fight the
 * user", stated as a test.
 *
 * The reducer takes its clock as an argument, so all of this runs in a few
 * microseconds and none of it needs a fake timer, a DOM or a sleep. The
 * behaviours that are easy to get wrong — a bubbled `pointerover` restarting the
 * dwell, a gap between two adjacent controls closing the panel, Escape being
 * undone by the pointer standing still — each have a test whose failure names
 * the symptom.
 */

import { describe, expect, it } from "vitest";

import {
  CLOSE_GRACE_MS,
  DEFAULT_TIMING,
  DWELL_MS,
  IDLE_DWELL,
  isHelpOpen,
  nextDeadline,
  reduceDwell,
  shownToken,
  type DwellEvent,
  type DwellState,
} from "./dwell";

const A = { key: "a", token: "effect:blur" } as const;
const B = { key: "b", token: "effect:invert" } as const;

function run(events: readonly DwellEvent[], from: DwellState = IDLE_DWELL): DwellState {
  return events.reduce((state, event) => reduceDwell(state, event), from);
}

function armed(at = 0): DwellState {
  return reduceDwell(IDLE_DWELL, { kind: "enter", ...A, at });
}

function open(at = DWELL_MS): DwellState {
  return reduceDwell(armed(0), { kind: "tick", at });
}

describe("opening", () => {
  it("does not open before the dwell has elapsed", () => {
    const state = reduceDwell(armed(0), { kind: "tick", at: DWELL_MS - 1 });
    expect(state.phase).toBe("arming");
    expect(isHelpOpen(state)).toBe(false);
  });

  it("opens once the dwell has elapsed", () => {
    const state = open();
    expect(state.phase).toBe("open");
    expect(shownToken(state)).toBe(A.token);
  });

  it("re-entering the same control does not restart the dwell", () => {
    // `pointerover` bubbles: crossing a node row fires once per child element
    // inside it. Restarting on each would mean help never opens on any control
    // that has children — which is all of them.
    let state = armed(0);
    for (let at = 10; at < DWELL_MS; at += 10) {
      state = reduceDwell(state, { kind: "enter", ...A, at });
    }
    expect(state.since).toBe(0);
    expect(reduceDwell(state, { kind: "tick", at: DWELL_MS }).phase).toBe("open");
  });

  it("returns the identical state object when nothing changed", () => {
    // The controller renders on identity. A `pointerover` per descendant must
    // not become a React render per descendant.
    const state = armed(0);
    expect(reduceDwell(state, { kind: "enter", ...A, at: 50 })).toBe(state);
    expect(reduceDwell(state, { kind: "tick", at: 50 })).toBe(state);
  });

  it("restarts the dwell when the pointer moves to a different control first", () => {
    const state = run([
      { kind: "enter", ...A, at: 0 },
      { kind: "enter", ...B, at: 400 },
    ]);
    expect(state.phase).toBe("arming");
    expect(state.key).toBe(B.key);
    expect(reduceDwell(state, { kind: "tick", at: 400 + DWELL_MS - 1 }).phase).toBe("arming");
  });

  it("opens immediately when asked explicitly", () => {
    const state = reduceDwell(IDLE_DWELL, { kind: "reveal", ...A, at: 0 });
    expect(state.phase).toBe("open");
  });
});

describe("moving between adjacent controls", () => {
  it("switches content instantly, without closing", () => {
    const state = reduceDwell(open(), { kind: "enter", ...B, at: DWELL_MS + 1 });
    expect(state.phase).toBe("open");
    expect(shownToken(state)).toBe(B.token);
  });

  it("survives the gap between two controls", () => {
    // Leaving the first control before entering the second is what a gutter
    // between two stacked sliders looks like. Closing and reopening across it
    // is exactly the flicker F-UI-13 rules out.
    const state = run(
      [
        { kind: "leave", at: DWELL_MS },
        { kind: "enter", ...B, at: DWELL_MS + CLOSE_GRACE_MS - 1 },
      ],
      open(),
    );
    expect(state.phase).toBe("open");
    expect(shownToken(state)).toBe(B.token);
  });

  it("stays up while the pointer is on the panel itself", () => {
    const state = run(
      [
        { kind: "leave", at: DWELL_MS },
        { kind: "hold", at: DWELL_MS + 50 },
        { kind: "tick", at: DWELL_MS + 50 + CLOSE_GRACE_MS + 1 },
      ],
      open(),
    );
    // The hold restarted the grace, so the tick that would have closed the
    // original one finds an open panel instead.
    expect(state.phase).toBe("open");
  });
});

describe("closing", () => {
  it("moving away closes it, after the grace", () => {
    const left = reduceDwell(open(), { kind: "leave", at: DWELL_MS });
    expect(left.phase).toBe("closing");
    expect(isHelpOpen(left)).toBe(true);
    const closed = reduceDwell(left, { kind: "tick", at: DWELL_MS + CLOSE_GRACE_MS });
    expect(closed).toEqual(IDLE_DWELL);
  });

  it("moving away during the dwell cancels it outright", () => {
    const state = reduceDwell(armed(0), { kind: "leave", at: 100 });
    expect(state).toEqual(IDLE_DWELL);
  });

  it("Escape closes it", () => {
    expect(reduceDwell(open(), { kind: "dismiss", at: 1 }).phase).toBe("idle");
  });

  it("Escape is not undone by the pointer standing still", () => {
    // The controller re-sends `enter` on any pointer movement over the control,
    // and a still pointer over a re-rendered control produces one too. Without
    // suppression the panel would reopen a moment after being dismissed, which
    // reads as the panel refusing to go away.
    const dismissed = reduceDwell(open(), { kind: "dismiss", at: 1 });
    const state = run(
      [
        { kind: "enter", ...A, at: 2 },
        { kind: "tick", at: 2 + DWELL_MS },
        { kind: "enter", ...A, at: 3 + DWELL_MS },
      ],
      dismissed,
    );
    expect(state.phase).toBe("idle");
  });

  it("suppression lifts as soon as the pointer leaves the control", () => {
    const dismissed = reduceDwell(open(), { kind: "dismiss", at: 1 });
    const state = run(
      [
        { kind: "leave", at: 2 },
        { kind: "enter", ...A, at: 3 },
        { kind: "tick", at: 3 + DWELL_MS },
      ],
      dismissed,
    );
    expect(state.phase).toBe("open");
  });

  it("suppression does not spread to a neighbouring control", () => {
    const dismissed = reduceDwell(open(), { kind: "dismiss", at: 1 });
    const state = run(
      [
        { kind: "enter", ...B, at: 2 },
        { kind: "tick", at: 2 + DWELL_MS },
      ],
      dismissed,
    );
    expect(state.phase).toBe("open");
    expect(shownToken(state)).toBe(B.token);
  });

  it("an explicit reveal overrides a suppression", () => {
    const dismissed = reduceDwell(open(), { kind: "dismiss", at: 1 });
    expect(reduceDwell(dismissed, { kind: "reveal", ...A, at: 2 }).phase).toBe("open");
  });
});

describe("nextDeadline", () => {
  it("is the dwell while arming and the grace while closing", () => {
    expect(nextDeadline(armed(120))).toBe(120 + DEFAULT_TIMING.dwellMs);
    const closing = reduceDwell(open(), { kind: "leave", at: 900 });
    expect(nextDeadline(closing)).toBe(900 + DEFAULT_TIMING.graceMs);
  });

  it("is null when no clock is running, so no timer is scheduled", () => {
    expect(nextDeadline(IDLE_DWELL)).toBeNull();
    expect(nextDeadline(open())).toBeNull();
  });
});

describe("timing", () => {
  it("honours a caller's dwell and grace", () => {
    const timing = { dwellMs: 50, graceMs: 10 };
    const state = reduceDwell(
      reduceDwell(IDLE_DWELL, { kind: "enter", ...A, at: 0 }, timing),
      { kind: "tick", at: 50 },
      timing,
    );
    expect(state.phase).toBe("open");
  });

  it("defaults to the ~700 ms F-UI-13 asks for", () => {
    expect(DEFAULT_TIMING.dwellMs).toBe(700);
  });
});
