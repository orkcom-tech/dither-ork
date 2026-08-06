import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPARE,
  comparePlan,
  setHolding,
  setMode,
  setSplit,
  toggleSplit,
} from "./compare";

describe("compare state", () => {
  it("opens with the split off and the divider in the middle", () => {
    expect(DEFAULT_COMPARE).toEqual({ mode: "off", split: 0.5, holding: false });
  });

  it("toggles the split on and off", () => {
    const on = toggleSplit(DEFAULT_COMPARE);
    expect(on.mode).toBe("split");
    expect(toggleSplit(on).mode).toBe("off");
  });

  it("clamps the divider to the viewport", () => {
    expect(setSplit(DEFAULT_COMPARE, -1).split).toBe(0);
    expect(setSplit(DEFAULT_COMPARE, 2).split).toBe(1);
    expect(setSplit(DEFAULT_COMPARE, 0.25).split).toBe(0.25);
  });

  it("ignores a non-finite divider rather than losing the picture", () => {
    expect(setSplit(DEFAULT_COMPARE, Number.NaN).split).toBe(0.5);
  });

  it("returns the same object when nothing changes, so a listener sees no event", () => {
    expect(setMode(DEFAULT_COMPARE, "off")).toBe(DEFAULT_COMPARE);
    expect(setSplit(DEFAULT_COMPARE, 0.5)).toBe(DEFAULT_COMPARE);
    expect(setHolding(DEFAULT_COMPARE, false)).toBe(DEFAULT_COMPARE);
  });

  it("keeps the split position across a hold, so releasing restores it", () => {
    const split = setSplit(toggleSplit(DEFAULT_COMPARE), 0.3);
    const held = setHolding(split, true);
    const released = setHolding(held, false);
    expect(released.mode).toBe("split");
    expect(released.split).toBe(0.3);
  });
});

describe("comparePlan", () => {
  it("shows only the result when compare is off", () => {
    expect(comparePlan(DEFAULT_COMPARE, true).reference).toBe("none");
  });

  it("shows the reference on the left of the divider in split mode", () => {
    const plan = comparePlan(setSplit(toggleSplit(DEFAULT_COMPARE), 0.4), true);
    expect(plan.reference).toBe("left");
    expect(plan.split).toBe(0.4);
  });

  it("shows the reference everywhere while held, whatever the mode", () => {
    expect(comparePlan(setHolding(DEFAULT_COMPARE, true), true).reference).toBe("all");
    expect(
      comparePlan(setHolding(toggleSplit(DEFAULT_COMPARE), true), true).reference,
    ).toBe("all");
  });

  it("shows nothing to compare against when there is no reference frame", () => {
    const held = setHolding(toggleSplit(DEFAULT_COMPARE), true);
    expect(comparePlan(held, false).reference).toBe("none");
  });
});
