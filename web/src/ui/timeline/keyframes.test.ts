import { describe, expect, it } from "vitest";

import {
  EASINGS,
  addKey,
  easeUnit,
  isEasing,
  keyframeExtremes,
  keyframeValueAt,
  keysWithinLoop,
  moveKey,
  removeKey,
  setKeyEasing,
  setKeyValue,
  sortKeys,
  wrapFrame,
  type Keyframe,
} from "./keyframes";

const N = 60;

function keys(...entries: readonly Keyframe[]): readonly Keyframe[] {
  return sortKeys(entries);
}

describe("easeUnit", () => {
  it("pins both ends for every interpolation but hold", () => {
    for (const easing of EASINGS) {
      if (easing === "hold") continue;
      expect(easeUnit(easing, 0)).toBe(0);
      expect(easeUnit(easing, 1)).toBe(1);
    }
  });

  it("holds the outgoing value for the whole segment", () => {
    expect(easeUnit("hold", 0)).toBe(0);
    expect(easeUnit("hold", 0.5)).toBe(0);
    expect(easeUnit("hold", 0.999)).toBe(0);
  });

  it("eases in below the line and out above it", () => {
    expect(easeUnit("ease-in", 0.5)).toBeLessThan(0.5);
    expect(easeUnit("ease-out", 0.5)).toBeGreaterThan(0.5);
    expect(easeUnit("ease-in-out", 0.5)).toBeCloseTo(0.5, 10);
  });

  it("clamps a position outside the segment rather than extrapolating", () => {
    expect(easeUnit("linear", -1)).toBe(0);
    expect(easeUnit("linear", 2)).toBe(1);
  });

  it("recognises only the five interpolations F-AN-08 names", () => {
    expect(EASINGS).toHaveLength(5);
    expect(isEasing("linear")).toBe(true);
    expect(isEasing("bounce")).toBe(false);
  });
});

describe("wrapFrame", () => {
  it("is Euclidean, so scrubbing backwards lands inside the loop", () => {
    expect(wrapFrame(-1, N)).toBe(59);
    expect(wrapFrame(-60, N)).toBe(0);
    expect(wrapFrame(61, N)).toBe(1);
  });

  it("collapses -0, because a content hash can tell it from 0", () => {
    expect(Object.is(wrapFrame(-120, N), 0)).toBe(true);
  });

  it("refuses a fractional frame rather than rounding one", () => {
    expect(() => wrapFrame(1.5, N)).toThrow(/whole number/);
  });

  it("refuses a loop that cannot describe one", () => {
    expect(() => wrapFrame(0, 0)).toThrow(/at least 1/);
  });
});

describe("keyframeValueAt", () => {
  const track = keys(
    { frame: 0, value: 0, easing: "linear" },
    { frame: 30, value: 1, easing: "linear" },
  );

  it("interpolates within a segment", () => {
    expect(keyframeValueAt(track, N, 0)).toBe(0);
    expect(keyframeValueAt(track, N, 15)).toBeCloseTo(0.5, 12);
    expect(keyframeValueAt(track, N, 30)).toBe(1);
  });

  it("runs the last segment through the seam back to the first key", () => {
    // 30 frames from the key at 30 round to the key at 0.
    expect(keyframeValueAt(track, N, 45)).toBeCloseTo(0.5, 12);
    expect(keyframeValueAt(track, N, 59)).toBeCloseTo(1 / 30, 12);
  });

  it("F-AN-08: frame N is frame 0, the same number and not merely close", () => {
    const offset = keys(
      { frame: 7, value: -3.25, easing: "ease-in-out" },
      { frame: 41, value: 9.5, easing: "ease-out" },
      { frame: 52, value: 0.125, easing: "hold" },
    );
    for (const frame of [0, 1, 7, 23, 41, 52, 59]) {
      expect(Object.is(keyframeValueAt(offset, N, frame + N), keyframeValueAt(offset, N, frame))).toBe(
        true,
      );
      expect(
        Object.is(keyframeValueAt(offset, N, frame - N), keyframeValueAt(offset, N, frame)),
      ).toBe(true);
    }
  });

  it("holds the value for a hold segment and jumps at the next key", () => {
    const held = keys(
      { frame: 0, value: 2, easing: "hold" },
      { frame: 30, value: 8, easing: "hold" },
    );
    expect(keyframeValueAt(held, N, 0)).toBe(2);
    expect(keyframeValueAt(held, N, 29)).toBe(2);
    expect(keyframeValueAt(held, N, 30)).toBe(8);
    expect(keyframeValueAt(held, N, 59)).toBe(8);
  });

  it("is constant with one key", () => {
    const one = keys({ frame: 12, value: 4, easing: "linear" });
    expect(keyframeValueAt(one, N, 0)).toBe(4);
    expect(keyframeValueAt(one, N, 12)).toBe(4);
    expect(keyframeValueAt(one, N, 59)).toBe(4);
  });

  it("contributes nothing when it has no keys", () => {
    expect(keyframeValueAt([], N, 0)).toBeNull();
  });
});

describe("editing", () => {
  it("adds a key and keeps the list in frame order", () => {
    const list = addKey(
      addKey([], { frame: 30, value: 1, easing: "linear" }, N),
      { frame: 10, value: 0, easing: "hold" },
      N,
    );
    expect(list.map((key) => key.frame)).toEqual([10, 30]);
  });

  it("replaces rather than stacking two keys on one frame", () => {
    const list = addKey(
      addKey([], { frame: 10, value: 1, easing: "linear" }, N),
      { frame: 10, value: 5, easing: "hold" },
      N,
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.value).toBe(5);
    expect(list[0]?.easing).toBe("hold");
  });

  it("wraps a key added outside the loop", () => {
    const list = addKey([], { frame: 65, value: 1, easing: "linear" }, N);
    expect(list[0]?.frame).toBe(5);
  });

  it("moves a key, replacing whatever was on the target frame", () => {
    const start = keys(
      { frame: 0, value: 0, easing: "linear" },
      { frame: 30, value: 1, easing: "linear" },
    );
    const moved = moveKey(start, 0, 30, N);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toEqual({ frame: 30, value: 0, easing: "linear" });
  });

  it("leaves the list alone when the key being dragged is gone", () => {
    const start = keys({ frame: 0, value: 0, easing: "linear" });
    expect(moveKey(start, 12, 20, N)).toBe(start);
    expect(removeKey(start, 12, N)).toBe(start);
    expect(setKeyEasing(start, 12, "hold", N)).toBe(start);
    expect(setKeyValue(start, 12, 3, N)).toBe(start);
  });

  it("changes one key's easing and value without touching the others", () => {
    const start = keys(
      { frame: 0, value: 0, easing: "linear" },
      { frame: 30, value: 1, easing: "linear" },
    );
    const eased = setKeyEasing(start, 30, "ease-in", N);
    expect(eased[1]?.easing).toBe("ease-in");
    expect(eased[0]?.easing).toBe("linear");
    const valued = setKeyValue(eased, 0, -2, N);
    expect(valued[0]?.value).toBe(-2);
    expect(valued[1]?.value).toBe(1);
  });
});

describe("keysWithinLoop", () => {
  it("drops the keys a shortened loop no longer contains", () => {
    const start = keys(
      { frame: 0, value: 0, easing: "linear" },
      { frame: 40, value: 1, easing: "linear" },
    );
    expect(keysWithinLoop(start, 24).map((key) => key.frame)).toEqual([0]);
  });
});

describe("keyframeExtremes", () => {
  it("reports what the track actually reaches over the loop", () => {
    const track = keys(
      { frame: 0, value: -1, easing: "linear" },
      { frame: 30, value: 3, easing: "linear" },
    );
    expect(keyframeExtremes(track, N)).toEqual({ min: -1, max: 3 });
  });

  it("is null for a track with nothing on it", () => {
    expect(keyframeExtremes([], N)).toBeNull();
  });
});
