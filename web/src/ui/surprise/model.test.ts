import { describe, expect, it } from "vitest";

import { NO_LOCKS } from "../../surprise";
import {
  CHAOS_STEP,
  DEFAULT_CHAOS,
  LOCK_KEYS,
  chaosLabel,
  clampChaos,
  describeStack,
  lockHint,
  lockLabel,
  lockedCount,
  readiness,
  toggleLock,
} from "./model";

describe("locks (F-SM-06)", () => {
  it("toggles one lock without touching the others", () => {
    const next = toggleLock(NO_LOCKS, "palette");
    expect(next.palette).toBe(true);
    expect(next.stack).toBe(false);
    expect(next.params).toBe(false);
    expect(next.animation).toBe(false);
    expect(toggleLock(next, "palette").palette).toBe(false);
  });

  it("counts what is locked", () => {
    expect(lockedCount(NO_LOCKS)).toBe(0);
    expect(lockedCount({ palette: true, stack: true, params: false, animation: false })).toBe(2);
  });

  it("gives every lock a label and a hint", () => {
    for (const key of LOCK_KEYS) {
      expect(lockLabel(key).length).toBeGreaterThan(0);
      expect(lockHint(key).length).toBeGreaterThan(0);
    }
  });

  it("names all four the spec lists", () => {
    expect([...LOCK_KEYS].sort()).toEqual(["animation", "palette", "params", "stack"].sort());
  });
});

describe("chaos (F-SM-07)", () => {
  it("clamps and snaps to the slider's quantum", () => {
    expect(clampChaos(0.5)).toBe(0.5);
    expect(clampChaos(2)).toBe(1);
    expect(clampChaos(-1)).toBe(0);
    expect(clampChaos(0.51)).toBeCloseTo(0.5, 10);
    expect(clampChaos(0.53)).toBeCloseTo(0.55, 10);
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(clampChaos(Number.NaN)).toBe(DEFAULT_CHAOS);
    expect(clampChaos(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CHAOS);
  });

  it("starts somewhere on the grid", () => {
    expect(clampChaos(DEFAULT_CHAOS)).toBeCloseTo(DEFAULT_CHAOS, 10);
    expect(CHAOS_STEP).toBeGreaterThan(0);
  });

  it("gives the number a word, across the whole range", () => {
    const words = new Set<string>();
    for (let c = 0; c <= 1.0001; c += CHAOS_STEP) words.add(chaosLabel(c));
    expect(words.size).toBeGreaterThanOrEqual(4);
    expect(chaosLabel(0)).toBe("tame");
    expect(chaosLabel(1)).toBe("feral");
  });
});

describe("readiness", () => {
  it("is ready when the image and the library are both there", () => {
    expect(
      readiness({ hasSource: true, libraryReady: true, libraryFailure: null }),
    ).toEqual({ ready: true });
  });

  it("names the missing image first, because that is what a person fixes", () => {
    const verdict = readiness({ hasSource: false, libraryReady: true, libraryFailure: null });
    expect(verdict.ready).toBe(false);
    if (verdict.ready) return;
    expect(verdict.reason).toContain("image");
  });

  /**
   * The library is not optional and this is why: F-SM-05 draws the palette mode
   * from three, and a mode drawn and then found unavailable would have to fall
   * back — making one seed mean two palettes depending on whether the library
   * had finished loading, which is the one promise F-SM-02 makes.
   */
  it("waits for the palette library rather than using two of the three modes", () => {
    const verdict = readiness({ hasSource: true, libraryReady: false, libraryFailure: null });
    expect(verdict.ready).toBe(false);
    if (verdict.ready) return;
    expect(verdict.reason).toContain("library");
  });

  it("reports a library failure rather than saying it is still loading", () => {
    const verdict = readiness({
      hasSource: true,
      libraryReady: false,
      libraryFailure: "the core would not load",
    });
    expect(verdict.ready).toBe(false);
    if (verdict.ready) return;
    expect(verdict.reason).toContain("the core would not load");
  });
});

describe("describeStack", () => {
  it("reads as a pipeline", () => {
    expect(describeStack(["Blur", "Atkinson"])).toBe("Blur → Atkinson");
  });

  it("says so when there is nothing rather than showing an empty string", () => {
    expect(describeStack([])).toBe("empty stack");
  });
});
