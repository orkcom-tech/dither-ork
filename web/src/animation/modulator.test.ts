/**
 * F-AN-02 — the six shapes, and the one property they all have to have.
 *
 * The property is that **the loop closes**, and the test for it is not "frame N
 * equals frame 0" — that is true by construction because everything wraps
 * `frame mod N` first, so asserting it would check the wrap and nothing else.
 * The real assertion evaluates the **unwrapped extension** at frame N and
 * compares it with frame 0. For an integer cycle count those are the same phase.
 * For 2.5 they are half a turn apart, and the test below builds exactly that
 * case by casting past the constructor, because that is the only way a
 * non-integer count could ever reach a render.
 */

import { beforeAll, describe, expect, it } from "vitest";

import type { ModulatorShape } from "../types/document";
import { setLevel } from "../lib/log";
import { loopClock } from "./clock";
import type { CyclesPerLoop } from "./cycles";
import { cyclesPerLoop } from "./cycles";
import { AnimationError } from "./errors";
import type { ModulatorSpec } from "./modulator";
import {
  MODULATOR_SHAPES,
  SMOOTH_NOISE_LATTICE,
  STEPPED_RANDOM_STEPS,
  featuresPerCycle,
  featuresPerLoop,
  fract,
  modulatorPhase,
  modulatorUnit,
  normalisePhase,
  shapeAt,
  unwrappedPhase,
} from "./modulator";

beforeAll(() => setLevel("error"));

const clock = loopClock({ frames: 60, fps: 30 });

function spec(overrides: Partial<ModulatorSpec> = {}): ModulatorSpec {
  return {
    shape: "sine",
    cycles: cyclesPerLoop(1),
    phase: 0,
    bipolar: true,
    seed: 1234,
    ...overrides,
  };
}

describe("fract", () => {
  it("is Euclidean and collapses -0", () => {
    expect(fract(0.25)).toBeCloseTo(0.25, 15);
    expect(fract(1)).toBe(0);
    expect(fract(-0.25)).toBeCloseTo(0.75, 15);
    expect(Object.is(fract(-0), 0)).toBe(true);
    expect(Object.is(fract(2), 0)).toBe(true);
  });
});

describe("normalisePhase", () => {
  it("folds any number of turns into [0, 1)", () => {
    expect(normalisePhase(0)).toBe(0);
    expect(normalisePhase(3.25)).toBeCloseTo(0.25, 12);
    expect(normalisePhase(-0.75)).toBeCloseTo(0.25, 12);
  });

  it("refuses a phase that is not finite", () => {
    expect(() => normalisePhase(Number.NaN)).toThrow(AnimationError);
    expect(() => normalisePhase(Number.POSITIVE_INFINITY)).toThrow(AnimationError);
  });
});

describe("modulatorPhase", () => {
  it("is a pure function of frame mod N", () => {
    const s = spec({ cycles: cyclesPerLoop(3), phase: 0.125 });
    for (let frame = 0; frame < clock.frames; frame += 1) {
      expect(modulatorPhase(s, clock, frame + clock.frames)).toBe(
        modulatorPhase(s, clock, frame),
      );
      expect(modulatorPhase(s, clock, frame - clock.frames)).toBe(
        modulatorPhase(s, clock, frame),
      );
    }
  });

  it("starts at the binding's own phase", () => {
    expect(modulatorPhase(spec({ phase: 0.25 }), clock, 0)).toBeCloseTo(0.25, 15);
  });

  it("advances `cycles` whole turns over the loop", () => {
    const s = spec({ cycles: cyclesPerLoop(2) });
    // Half way through a two-cycle loop is a whole cycle: back to phase 0.
    expect(modulatorPhase(s, clock, 30)).toBe(0);
    expect(modulatorPhase(s, clock, 15)).toBeCloseTo(0.5, 15);
  });
});

describe("the unwrapped extension — what makes the seam check a measurement", () => {
  it("returns to the starting phase for every integer cycle count", () => {
    for (const cycles of [1, 2, 3, 7, 31]) {
      for (const phase of [0, 0.125, 0.5, 0.99]) {
        const s = spec({ cycles: cyclesPerLoop(cycles), phase });
        const start = modulatorPhase(s, clock, 0);
        const seam = unwrappedPhase(s, clock, clock.frames);
        expect(Math.min(Math.abs(seam - start), 1 - Math.abs(seam - start))).toBeLessThan(1e-9);
      }
    }
  });

  it("does not return for a fractional count — the case the type exists to prevent", () => {
    // The only route to this value is a cast; `cyclesPerLoop(2.5)` throws. The
    // test pins that the *measurement* would catch it if one ever appeared.
    const s = spec({ cycles: 2.5 as CyclesPerLoop });
    const start = modulatorPhase(s, clock, 0);
    const seam = unwrappedPhase(s, clock, clock.frames);
    expect(Math.abs(seam - start)).toBeCloseTo(0.5, 12);
  });
});

describe("the shapes", () => {
  it("stay inside [-1, 1] across a whole cycle", () => {
    for (const shape of MODULATOR_SHAPES) {
      for (let step = 0; step < 512; step += 1) {
        const value = shapeAt(shape, step / 512, 99);
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is periodic in the phase for every shape", () => {
    for (const shape of MODULATOR_SHAPES) {
      for (const phase of [0, 0.1, 0.37, 0.5, 0.99]) {
        expect(shapeAt(shape, phase + 1, 5)).toBeCloseTo(shapeAt(shape, phase, 5), 12);
        expect(shapeAt(shape, phase - 3, 5)).toBeCloseTo(shapeAt(shape, phase, 5), 12);
      }
    }
  });

  it("puts the sine and the triangle in the same phase", () => {
    expect(shapeAt("sine", 0, 0)).toBeCloseTo(0, 15);
    expect(shapeAt("triangle", 0, 0)).toBe(0);
    expect(shapeAt("sine", 0.25, 0)).toBeCloseTo(1, 15);
    expect(shapeAt("triangle", 0.25, 0)).toBeCloseTo(1, 15);
    expect(shapeAt("triangle", 0.75, 0)).toBeCloseTo(-1, 15);
  });

  it("puts the saw's jump and the square's edge on the loop seam", () => {
    // With cyclesPerLoop = 1 the discontinuity lands at phase 0, which is the
    // seam, which is where it is invisible.
    expect(shapeAt("saw", 0, 0)).toBe(-1);
    expect(shapeAt("saw", 0.5, 0)).toBe(0);
    expect(shapeAt("saw", 0.999_999, 0)).toBeGreaterThan(0.99);
    expect(shapeAt("square", 0, 0)).toBe(1);
    expect(shapeAt("square", 0.5, 0)).toBe(-1);
  });

  it("gives smooth noise no corner at the ring join", () => {
    // The lattice wraps, so the slope approaching phase 1 from below matches the
    // slope leaving phase 0 from above. A ring that did not wrap would show a
    // step here.
    const eps = 1e-4;
    const before = shapeAt("smooth-noise", 1 - eps, 7);
    const after = shapeAt("smooth-noise", eps, 7);
    const at = shapeAt("smooth-noise", 0, 7);
    expect(before).toBeCloseTo(at, 3);
    expect(after).toBeCloseTo(at, 3);
  });

  it("holds stepped random for a whole step and changes between steps", () => {
    const held = shapeAt("stepped-random", 0.01, 3);
    expect(shapeAt("stepped-random", 1 / STEPPED_RANDOM_STEPS - 0.001, 3)).toBe(held);
    expect(shapeAt("stepped-random", 1 / STEPPED_RANDOM_STEPS + 0.001, 3)).not.toBe(held);
  });

  it("gives different seeds different noise and the same seed the same noise", () => {
    for (const shape of ["smooth-noise", "stepped-random"] as const) {
      expect(shapeAt(shape, 0.3, 1)).not.toBe(shapeAt(shape, 0.3, 2));
      expect(shapeAt(shape, 0.3, 1)).toBe(shapeAt(shape, 0.3, 1));
    }
  });
});

describe("modulatorUnit", () => {
  it("maps unipolar as the bipolar output rescaled, not as a different shape", () => {
    for (const shape of MODULATOR_SHAPES) {
      for (let frame = 0; frame < clock.frames; frame += 1) {
        const bip = modulatorUnit(spec({ shape, bipolar: true }), clock, frame);
        const uni = modulatorUnit(spec({ shape, bipolar: false }), clock, frame);
        expect(uni).toBeCloseTo((bip + 1) / 2, 15);
        expect(uni).toBeGreaterThanOrEqual(0);
        expect(uni).toBeLessThanOrEqual(1);
      }
    }
  });

  it("gives frame N the value of frame 0, for every shape", () => {
    for (const shape of MODULATOR_SHAPES) {
      for (const cycles of [1, 2, 5]) {
        const s = spec({ shape, cycles: cyclesPerLoop(cycles), phase: 0.3 });
        expect(modulatorUnit(s, clock, clock.frames)).toBe(modulatorUnit(s, clock, 0));
      }
    }
  });
});

describe("featuresPerCycle", () => {
  it("counts what a Nyquist report has to count", () => {
    const expected: Record<ModulatorShape, number> = {
      sine: 2,
      triangle: 2,
      saw: 1,
      square: 2,
      "smooth-noise": SMOOTH_NOISE_LATTICE,
      "stepped-random": STEPPED_RANDOM_STEPS,
    };
    for (const shape of MODULATOR_SHAPES) {
      expect(featuresPerCycle(shape)).toBe(expected[shape]);
    }
  });

  it("scales with the cycle count", () => {
    expect(featuresPerLoop(spec({ shape: "sine", cycles: cyclesPerLoop(4) }))).toBe(8);
  });
});
