/**
 * F-AN-03 — cycles per loop, enforced in the type.
 *
 * The point of these tests is not that a validator rejects 2.5. It is that
 * **there is no other way in**: `CyclesPerLoop` is branded, the constructor is
 * the only thing that mints one, and it refuses rather than rounds. A rounding
 * constructor would give a document that closes and is not the document that was
 * saved, which is the same class of silent rewrite the render path refuses
 * everywhere else.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { AnimationError } from "./errors";
import {
  MAX_CYCLES_PER_LOOP,
  MAX_GLOBAL_SPEED,
  cyclesPerLoop,
  globalSpeed,
  isCyclesPerLoop,
  isGlobalSpeed,
  positiveInteger,
  scaleCycles,
  wholeNumber,
} from "./cycles";

beforeAll(() => setLevel("error"));

describe("cyclesPerLoop", () => {
  it("accepts positive integers up to the ceiling", () => {
    expect(cyclesPerLoop(1)).toBe(1);
    expect(cyclesPerLoop(7)).toBe(7);
    expect(cyclesPerLoop(MAX_CYCLES_PER_LOOP)).toBe(MAX_CYCLES_PER_LOOP);
  });

  it("refuses anything that would leave the loop open", () => {
    for (const value of [0, -1, 0.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => cyclesPerLoop(value)).toThrow(AnimationError);
    }
  });

  it("refuses rather than rounding", () => {
    // 2.5 does not become 2 or 3. The document said 2.5 and 2.5 does not close.
    let thrown: unknown;
    try {
      cyclesPerLoop(2.5);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AnimationError);
    expect((thrown as AnimationError).code).toBe("invalid-cycles");
    expect((thrown as AnimationError).message).toContain("refused rather than rounded");
  });

  it("refuses past the ceiling that keeps the phase arithmetic exact", () => {
    expect(() => cyclesPerLoop(MAX_CYCLES_PER_LOOP + 1)).toThrow(AnimationError);
  });

  it("agrees with its own predicate", () => {
    for (const value of [-1, 0, 0.5, 1, 4096, 4097]) {
      const ok = isCyclesPerLoop(value);
      if (ok) expect(cyclesPerLoop(value)).toBe(value);
      else expect(() => cyclesPerLoop(value)).toThrow();
    }
  });
});

describe("globalSpeed", () => {
  it("accepts positive integers only", () => {
    expect(globalSpeed(1)).toBe(1);
    expect(globalSpeed(MAX_GLOBAL_SPEED)).toBe(MAX_GLOBAL_SPEED);
    for (const value of [0, 0.5, -2, MAX_GLOBAL_SPEED + 1]) {
      expect(() => globalSpeed(value)).toThrow(AnimationError);
    }
  });

  it("names the reason a half-speed control is not offered", () => {
    expect(() => globalSpeed(0.5)).toThrow(/raise the frame count/);
    expect(isGlobalSpeed(0.5)).toBe(false);
  });
});

describe("scaleCycles", () => {
  it("keeps the product an integer, which is the whole reason speed is one", () => {
    expect(scaleCycles(cyclesPerLoop(3), globalSpeed(2))).toBe(6);
    expect(scaleCycles(cyclesPerLoop(1), globalSpeed(1))).toBe(1);
  });

  it("reports rather than clamps when the product leaves the range", () => {
    expect(() => scaleCycles(cyclesPerLoop(4096), globalSpeed(2))).toThrow(AnimationError);
  });
});

describe("the integer helpers the temporal settings use", () => {
  it("positiveInteger refuses zero and fractions", () => {
    expect(positiveInteger(4, "hold")).toBe(4);
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => positiveInteger(value, "hold")).toThrow(AnimationError);
    }
  });

  it("wholeNumber accepts a signed integer and refuses a fraction", () => {
    expect(wholeNumber(-3, "turns")).toBe(-3);
    expect(wholeNumber(0, "turns")).toBe(0);
    expect(() => wholeNumber(1.5, "turns")).toThrow(AnimationError);
  });
});
