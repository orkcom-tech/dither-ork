/**
 * F-AN-01 — the clock.
 *
 * The assertions here are about the two things the rest of the module treats as
 * given: `t` never reaches 1, and `frame mod N` is a modulus rather than a
 * remainder. Both are one line of implementation and both are load-bearing — a
 * `t` that reached 1 would emit the first frame twice, and a negative wrap would
 * make a backwards scrub evaluate the whole document at a negative time.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { AnimationError } from "./errors";
import {
  MAX_FPS,
  MAX_FRAMES,
  loopClock,
  loopDuration,
  loopFrame,
  loopSeconds,
  loopTime,
} from "./clock";

beforeAll(() => {
  // Every rejection below logs an error by construction; the tests assert the
  // throw, not the console.
  setLevel("error");
});

const clock = loopClock({ frames: 60, fps: 30 });

describe("loopClock", () => {
  it("accepts a well-formed clock unchanged", () => {
    expect(loopClock({ frames: 24, fps: 12 })).toEqual({ frames: 24, fps: 12 });
  });

  it("refuses a frame count that is not a positive integer", () => {
    for (const frames of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => loopClock({ frames, fps: 30 })).toThrow(AnimationError);
    }
  });

  it("refuses a frame count past the ceiling", () => {
    expect(() => loopClock({ frames: MAX_FRAMES + 1, fps: 30 })).toThrow(/1 to 100000/);
    expect(loopClock({ frames: MAX_FRAMES, fps: 30 }).frames).toBe(MAX_FRAMES);
  });

  it("refuses an fps that cannot advance a loop", () => {
    for (const fps of [0, -1, Number.NaN, MAX_FPS + 1]) {
      expect(() => loopClock({ frames: 60, fps })).toThrow(AnimationError);
    }
  });

  it("accepts a one-frame loop, which is a still", () => {
    expect(loopClock({ frames: 1, fps: 1 }).frames).toBe(1);
  });
});

describe("loopFrame", () => {
  it("is the identity inside the loop", () => {
    expect(loopFrame(clock, 0)).toBe(0);
    expect(loopFrame(clock, 59)).toBe(59);
  });

  it("maps frame N onto frame 0 — the property everything else rests on", () => {
    expect(loopFrame(clock, 60)).toBe(0);
    expect(loopFrame(clock, 120)).toBe(0);
    expect(loopFrame(clock, 61)).toBe(1);
  });

  it("wraps backwards as a modulus, not as a remainder", () => {
    // JavaScript's % would give -1 here, and a negative frame index is what a
    // timeline produces when it is scrubbed left of zero.
    expect(loopFrame(clock, -1)).toBe(59);
    expect(loopFrame(clock, -60)).toBe(0);
    expect(loopFrame(clock, -61)).toBe(59);
  });

  it("refuses a fractional frame index", () => {
    expect(() => loopFrame(clock, 0.5)).toThrow(AnimationError);
  });
});

describe("loopTime", () => {
  it("starts at 0 and never reaches 1", () => {
    expect(loopTime(clock, 0)).toBe(0);
    expect(loopTime(clock, 59)).toBeCloseTo(59 / 60, 15);
    for (let frame = 0; frame < clock.frames; frame += 1) {
      const t = loopTime(clock, frame);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1);
    }
  });

  it("gives frame N the time of frame 0", () => {
    expect(loopTime(clock, 60)).toBe(loopTime(clock, 0));
  });
});

describe("seconds", () => {
  it("reports the loop's own length", () => {
    expect(loopDuration(clock)).toBe(2);
    expect(loopSeconds(clock, 15)).toBe(0.5);
    expect(loopSeconds(clock, 60)).toBe(0);
  });
});
