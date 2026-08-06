import { describe, expect, it } from "vitest";

import {
  PRECISION_FACTOR,
  VALUE_DRAG_SPAN,
  beginDrag,
  clamp,
  commitText,
  continueDrag,
  decimalsFor,
  decimalsOf,
  formatValue,
  keyStep,
  normalized,
  nudge,
  parseValue,
  precisionFor,
  quantize,
  type NumericSpec,
} from "./numeric";

/** A track 200px wide over [0, 1] in hundredths — the commonest shape here. */
const UNIT: NumericSpec = {
  min: 0,
  max: 1,
  step: 0.01,
  integer: false,
  span: 200,
};

const COUNT: NumericSpec = {
  min: 1,
  max: 16,
  step: undefined,
  integer: true,
  span: 200,
};

const CONTINUOUS: NumericSpec = {
  min: -180,
  max: 180,
  step: undefined,
  integer: false,
  span: 360,
};

describe("precisionFor", () => {
  it("maps shift to fine and alt to coarse", () => {
    expect(precisionFor({ shiftKey: true, altKey: false })).toBe("fine");
    expect(precisionFor({ shiftKey: false, altKey: true })).toBe("coarse");
    expect(precisionFor({ shiftKey: false, altKey: false })).toBe("normal");
  });

  it("gives shift priority when both are held", () => {
    expect(precisionFor({ shiftKey: true, altKey: true })).toBe("fine");
  });
});

describe("clamp", () => {
  it("holds a value inside its bounds", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe("decimalsOf", () => {
  it("counts the places a step is written with", () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.5)).toBe(1);
    expect(decimalsOf(0.01)).toBe(2);
    expect(decimalsOf(0.005)).toBe(3);
    expect(decimalsOf(0.001)).toBe(3);
  });

  it("handles a step JavaScript prints in exponent notation", () => {
    expect(decimalsOf(1e-7)).toBe(7);
  });
});

describe("decimalsFor", () => {
  it("is zero for an integer parameter regardless of step", () => {
    expect(decimalsFor(COUNT)).toBe(0);
  });

  it("follows the declared step", () => {
    expect(decimalsFor(UNIT)).toBe(2);
  });

  it("falls back to three places for a continuous parameter", () => {
    expect(decimalsFor(CONTINUOUS)).toBe(3);
  });
});

describe("quantize", () => {
  it("snaps to the declared step and clamps to the legal range", () => {
    expect(quantize(0.514, UNIT)).toBe(0.51);
    expect(quantize(2, UNIT)).toBe(1);
    expect(quantize(-2, UNIT)).toBe(0);
  });

  it("does not leave binary error in the result", () => {
    // 0.1 + 0.2 territory: the naive min + steps * step gives 0.30000000000000004.
    expect(quantize(0.3, UNIT)).toBe(0.3);
    expect(quantize(0.07, UNIT)).toBe(0.07);
  });

  it("keeps a parameter's own minimum reachable when it is not a multiple of the step", () => {
    const offset: NumericSpec = { min: 0.1, max: 2, step: 0.25, integer: false, span: 200 };
    expect(quantize(0.1, offset)).toBe(0.1);
    expect(quantize(0.12, offset)).toBe(0.1);
    expect(quantize(0.36, offset)).toBe(0.35);
  });

  it("rounds an integer parameter", () => {
    expect(quantize(7.4, COUNT)).toBe(7);
    expect(quantize(7.6, COUNT)).toBe(8);
    expect(quantize(99, COUNT)).toBe(16);
  });

  it("leaves a continuous parameter alone apart from clamping", () => {
    expect(quantize(12.3456, CONTINUOUS)).toBe(12.3456);
    expect(quantize(1000, CONTINUOUS)).toBe(180);
  });

  it("returns the minimum for a value that is not a number", () => {
    expect(quantize(Number.NaN, UNIT)).toBe(0);
  });
});

describe("normalized", () => {
  it("maps the range onto [0, 1]", () => {
    expect(normalized(0, UNIT)).toBe(0);
    expect(normalized(1, UNIT)).toBe(1);
    expect(normalized(-180, CONTINUOUS)).toBe(0);
    expect(normalized(0, CONTINUOUS)).toBe(0.5);
  });

  it("clamps rather than overflowing the track", () => {
    expect(normalized(9, UNIT)).toBe(1);
  });
});

describe("formatValue and parseValue", () => {
  it("prints the places the step declares, trailing zeros included", () => {
    expect(formatValue(0.5, UNIT)).toBe("0.50");
    expect(formatValue(1, UNIT)).toBe("1.00");
  });

  it("prints an integer parameter without a point", () => {
    expect(formatValue(8, COUNT)).toBe("8");
  });

  it("trims the places it guessed for a continuous parameter", () => {
    expect(formatValue(12.5, CONTINUOUS)).toBe("12.5");
    expect(formatValue(0, CONTINUOUS)).toBe("0");
    expect(formatValue(90, CONTINUOUS)).toBe("90");
  });

  it("reads a typed number and rejects anything else", () => {
    expect(parseValue(" 0.25 ")).toBe(0.25);
    expect(parseValue("-3")).toBe(-3);
    expect(parseValue("")).toBeNull();
    expect(parseValue("abc")).toBeNull();
    expect(parseValue("1/2")).toBeNull();
  });

  it("commits typed text through the same snapping the drag uses", () => {
    expect(commitText("0.517", UNIT)).toBe(0.52);
    expect(commitText("50", UNIT)).toBe(1);
    expect(commitText("nope", UNIT)).toBeNull();
  });

  it("round-trips: what it prints, it reads back unchanged", () => {
    for (const value of [0, 0.07, 0.3, 0.51, 1]) {
      expect(commitText(formatValue(value, UNIT), UNIT)).toBe(value);
    }
  });
});

describe("dragging a track", () => {
  const origin = 100;

  it("jumps to the pointer when grabbed without a modifier", () => {
    const { value } = beginDrag({
      x: origin + 100,
      current: 0,
      precision: "normal",
      absolute: true,
      origin,
      spec: UNIT,
    });
    expect(value).toBe(0.5);
  });

  it("does not jump when grabbed with a modifier held", () => {
    const { value } = beginDrag({
      x: origin + 100,
      current: 0.2,
      precision: "fine",
      absolute: true,
      origin,
      spec: UNIT,
    });
    expect(value).toBe(0.2);
  });

  it("tracks the pointer at normal precision", () => {
    const started = beginDrag({
      x: origin,
      current: 0,
      precision: "normal",
      absolute: true,
      origin,
      spec: UNIT,
    });
    const moved = continueDrag({
      state: started.state,
      x: origin + 150,
      precision: "normal",
      current: started.value,
      spec: UNIT,
    });
    expect(moved.value).toBe(0.75);
  });

  it("moves a tenth as far with shift held", () => {
    const started = beginDrag({
      x: origin,
      current: 0.5,
      precision: "fine",
      absolute: true,
      origin,
      spec: UNIT,
    });
    const moved = continueDrag({
      state: started.state,
      x: origin + 100,
      precision: "fine",
      current: started.value,
      spec: UNIT,
    });
    // 100px is half the track; a tenth of half of [0,1] is 0.05.
    expect(moved.value).toBe(0.55);
  });

  it("moves ten times as far with alt held", () => {
    const started = beginDrag({
      x: origin,
      current: 0.5,
      precision: "coarse",
      absolute: true,
      origin,
      spec: CONTINUOUS,
    });
    const moved = continueDrag({
      state: started.state,
      x: origin + 3.6,
      precision: "coarse",
      current: started.value,
      spec: CONTINUOUS,
    });
    // 3.6px of 360 is one hundredth of the range, times ten.
    expect(moved.value).toBeCloseTo(0.5 + 36, 6);
  });

  it("does not move the value when a modifier is pressed mid-drag", () => {
    const started = beginDrag({
      x: origin,
      current: 0,
      precision: "normal",
      absolute: true,
      origin,
      spec: UNIT,
    });
    const coarse = continueDrag({
      state: started.state,
      x: origin + 120,
      precision: "normal",
      current: started.value,
      spec: UNIT,
    });
    expect(coarse.value).toBe(0.6);

    // Same pointer position, shift now held: re-anchored, so the value stands.
    const held = continueDrag({
      state: coarse.state,
      x: origin + 120,
      precision: "fine",
      current: coarse.value,
      spec: UNIT,
    });
    expect(held.value).toBe(0.6);

    // And from there it moves at the fine rate.
    const nudged = continueDrag({
      state: held.state,
      x: origin + 140,
      precision: "fine",
      current: held.value,
      spec: UNIT,
    });
    expect(nudged.value).toBe(0.61);
  });

  it("returns to absolute tracking when the modifier is released", () => {
    const started = beginDrag({
      x: origin,
      current: 0,
      precision: "fine",
      absolute: true,
      origin,
      spec: UNIT,
    });
    const released = continueDrag({
      state: started.state,
      x: origin + 40,
      precision: "normal",
      current: started.value,
      spec: UNIT,
    });
    expect(released.value).toBe(0.2);
  });
});

describe("dragging a bare number", () => {
  it("is relative even without a modifier, because there is no track", () => {
    const spec: NumericSpec = { ...UNIT, span: VALUE_DRAG_SPAN };
    const started = beginDrag({
      x: 500,
      current: 0.4,
      precision: "normal",
      absolute: false,
      origin: 0,
      spec,
    });
    expect(started.value).toBe(0.4);
    const moved = continueDrag({
      state: started.state,
      x: 500 + VALUE_DRAG_SPAN / 2,
      precision: "normal",
      current: started.value,
      spec,
    });
    expect(moved.value).toBe(0.9);
  });
});

describe("keyboard", () => {
  it("steps by the declared quantum", () => {
    expect(keyStep(UNIT, "normal")).toBe(0.01);
    expect(nudge(0.5, 1, UNIT, "normal")).toBe(0.51);
    expect(nudge(0.5, -1, UNIT, "normal")).toBe(0.49);
  });

  it("scales the step by the precision", () => {
    expect(keyStep(UNIT, "coarse")).toBeCloseTo(0.1, 12);
    expect(nudge(0.5, 1, UNIT, "coarse")).toBe(0.6);
  });

  it("never steps an integer parameter by less than one", () => {
    expect(keyStep(COUNT, "fine")).toBe(1);
    expect(nudge(8, 1, COUNT, "fine")).toBe(9);
  });

  it("gives a continuous parameter one percent of its range", () => {
    expect(keyStep(CONTINUOUS, "normal")).toBeCloseTo(3.6, 12);
  });

  it("stops at the bounds", () => {
    expect(nudge(1, 1, UNIT, "normal")).toBe(1);
    expect(nudge(0, -1, UNIT, "normal")).toBe(0);
  });
});

describe("PRECISION_FACTOR", () => {
  it("is a tenth for fine and ten times for coarse", () => {
    expect(PRECISION_FACTOR.fine).toBeLessThan(PRECISION_FACTOR.normal);
    expect(PRECISION_FACTOR.coarse).toBeGreaterThan(PRECISION_FACTOR.normal);
  });
});
