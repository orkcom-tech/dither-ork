/**
 * Parameter defaults, validation and coercion.
 *
 * Registry validation checks that a *descriptor* is well formed; this checks
 * what happens to the *values* a descriptor describes. Both matter to the same
 * moment — a `.dork` file written by an older build, opened by a newer one.
 *
 * The distinction the module draws is the thing worth locking down. Loading a
 * document asks "is this file what it claims to be", and the answer is reported.
 * Rendering asks "what value does this node actually use", and the answer is
 * always legal *and always logged*. A value silently snapped to a bound is a
 * document that no longer round-trips, with the user the last to find out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLevel } from "../lib/log";
import type {
  BoolParam,
  ColorParam,
  CurveParam,
  EffectDescriptor,
  EnumParam,
  FloatParam,
  IntParam,
  ParamDescriptor,
  SeedParam,
} from "../types/registry";
import { SEED_RANGE } from "../types/registry";
import { coerceParams, defaultParams, validateParams } from "./params";

setLevel("error");

// Coercion warns on every adjustment, deliberately — it has to be visible
// without turning verbose logging on. That is asserted through the returned
// `adjustments`, so the console itself is silenced here.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const FLOAT: FloatParam = {
  key: "spread",
  label: "Spread",
  type: "float",
  animatable: true,
  legal: [0, 2],
  default: 1,
  step: 0.5,
  surprise: { range: [0.4, 1.2], distribution: { kind: "uniform" }, weight: 1 },
};

const INT: IntParam = {
  key: "levels",
  label: "Levels",
  type: "int",
  animatable: true,
  legal: [2, 256],
  default: 4,
  surprise: { range: [2, 16], distribution: { kind: "log" }, weight: 1 },
};

const BOOL: BoolParam = {
  key: "serpentine",
  label: "Serpentine",
  type: "bool",
  animatable: false,
  default: true,
  surprise: { trueProbability: 0.9, weight: 0.5 },
};

const ENUM: EnumParam = {
  key: "shape",
  label: "Dot shape",
  type: "enum",
  animatable: false,
  values: [
    { value: "round", label: "Round" },
    { value: "square", label: "Square" },
  ],
  default: "round",
  surprise: { values: [{ value: "round", weight: 1 }], weight: 0.7 },
};

const COLOR: ColorParam = {
  key: "tint",
  label: "Tint",
  type: "color",
  animatable: true,
  default: [255, 0, 128],
  surprise: { lightness: [0.4, 0.9], chroma: [0.02, 0.2], hue: [300, 60], weight: 0.4 },
};

const SEED: SeedParam = {
  key: "jitterSeed",
  label: "Jitter seed",
  type: "seed",
  animatable: false,
  default: 0,
  surprise: { weight: 0.3 },
};

const CURVE: CurveParam = {
  key: "transfer",
  label: "Transfer",
  type: "curve",
  animatable: false,
  default: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  surprise: {
    archetypes: [{ value: "linear", weight: 1 }],
    jitter: 0.1,
    weight: 0.6,
  },
};

function effect(params: readonly ParamDescriptor[]): EffectDescriptor {
  return {
    id: "test-effect",
    name: "Test effect",
    requirement: "F-OD-02",
    slot: "dither",
    family: "ordered",
    execution: "gpu",
    params,
    surpriseWeight: 1,
    producesIndexMap: false,
    requiresIndexMap: false,
  };
}

const EVERY_KIND = effect([FLOAT, INT, BOOL, ENUM, COLOR, SEED, CURVE]);

describe("defaultParams", () => {
  it("gives every declared parameter a value", () => {
    const values = defaultParams(EVERY_KIND);
    expect(Object.keys(values).sort()).toEqual(
      EVERY_KIND.params.map((param) => param.key).sort(),
    );
    expect(validateParams(EVERY_KIND, values).ok).toBe(true);
  });

  it("copies composite defaults instead of sharing the descriptor's", () => {
    // One descriptor is the default for every instance of that effect in every
    // open document. Handing out its array would let one node's edit rewrite the
    // default for all of them.
    const first = defaultParams(EVERY_KIND);
    const second = defaultParams(EVERY_KIND);

    expect(first["tint"]).toEqual([255, 0, 128]);
    expect(first["tint"]).not.toBe(COLOR.default);
    expect(first["tint"]).not.toBe(second["tint"]);
    expect(first["transfer"]).not.toBe(CURVE.default);
    expect(first["transfer"]).not.toBe(second["transfer"]);

    // The declared value type is a readonly union, and the property under test
    // is that what came back is a fresh array — which only a write can show.
    const tint = first["tint"] as unknown as number[];
    tint[0] = 0;
    expect(COLOR.default[0]).toBe(255);
    expect(second["tint"]).toEqual([255, 0, 128]);
  });
});

describe("validateParams", () => {
  it("accepts a legal set", () => {
    expect(validateParams(EVERY_KIND, defaultParams(EVERY_KIND))).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("reports a missing parameter", () => {
    const issues = validateParams(effect([FLOAT]), {}).issues;
    expect(issues.map((issue) => issue.code)).toEqual(["missing"]);
    expect(issues[0]?.key).toBe("spread");
  });

  it("reports a key the effect does not declare", () => {
    const issues = validateParams(effect([FLOAT]), { spread: 1, contrast: 2 }).issues;
    expect(issues.map((issue) => issue.code)).toEqual(["unknown-key"]);
  });

  it("reports the wrong kind of value", () => {
    expect(validateParams(effect([FLOAT]), { spread: "1" }).issues[0]?.code).toBe("wrong-type");
    expect(validateParams(effect([BOOL]), { serpentine: 1 }).issues[0]?.code).toBe("wrong-type");
    expect(validateParams(effect([ENUM]), { shape: 3 }).issues[0]?.code).toBe("wrong-type");
    expect(validateParams(effect([FLOAT]), { spread: Number.NaN }).issues[0]?.code).toBe(
      "wrong-type",
    );
  });

  it("reports a value outside the legal range", () => {
    expect(validateParams(effect([FLOAT]), { spread: 3 }).issues[0]?.code).toBe(
      "out-of-legal-range",
    );
    expect(validateParams(effect([SEED]), { jitterSeed: -1 }).issues[0]?.code).toBe(
      "out-of-legal-range",
    );
  });

  it("reports a fraction where an integer is required", () => {
    expect(validateParams(effect([INT]), { levels: 4.5 }).issues[0]?.code).toBe("non-integer");
  });

  it("reports an option the effect does not offer", () => {
    expect(validateParams(effect([ENUM]), { shape: "hexagon" }).issues[0]?.code).toBe(
      "unknown-option",
    );
  });

  it("reports a malformed colour or curve", () => {
    expect(validateParams(effect([COLOR]), { tint: [255, 0] }).issues[0]?.code).toBe("malformed");
    expect(
      validateParams(effect([CURVE]), { transfer: [{ x: 0.2, y: 0 }, { x: 1, y: 1 }] }).issues[0]
        ?.code,
    ).toBe("malformed");
  });

  it("does not repair anything it reports", () => {
    // Reporting and repairing are different questions with different callers.
    const params = { spread: 99 };
    validateParams(effect([FLOAT]), params);
    expect(params.spread).toBe(99);
  });
});

describe("coerceParams", () => {
  it("passes a legal set through untouched", () => {
    const values = defaultParams(EVERY_KIND);
    const result = coerceParams(EVERY_KIND, values);
    expect(result.adjustments).toEqual([]);
    expect(result.values).toEqual(values);
  });

  it("always produces a set that passes validation", () => {
    // The stated postcondition, and what lets the graph treat coerced parameters
    // as a precondition rather than re-checking them per node execution.
    const wreckage = {
      spread: "very",
      levels: 1e9,
      serpentine: "yes",
      shape: "hexagon",
      tint: "#ff0080",
      jitterSeed: -1,
      transfer: [],
      leftover: 3,
    };
    const result = coerceParams(EVERY_KIND, wreckage);
    expect(validateParams(EVERY_KIND, result.values)).toEqual({ ok: true, issues: [] });
    expect(result.adjustments.length).toBeGreaterThan(0);
  });

  it("clamps a float to its legal bounds and says so", () => {
    const result = coerceParams(effect([FLOAT]), { spread: 99 });
    expect(result.values["spread"]).toBe(2);
    expect(result.adjustments.map((a) => a.kind)).toEqual(["clamped"]);
    expect(result.adjustments[0]?.from).toBe("99");
    expect(result.adjustments[0]?.to).toBe("2");
  });

  it("does not snap a float to its step", () => {
    // `step` is the UI's drag quantum, not a legality constraint. Snapping a
    // loaded value to it would silently edit a number the user typed.
    const result = coerceParams(effect([FLOAT]), { spread: 1.234 });
    expect(result.values["spread"]).toBe(1.234);
    expect(result.adjustments).toEqual([]);
  });

  it("rounds before clamping an int", () => {
    expect(coerceParams(effect([INT]), { levels: 4.6 }).values["levels"]).toBe(5);
    const clamped = coerceParams(effect([INT]), { levels: 999.4 });
    expect(clamped.values["levels"]).toBe(256);
    expect(clamped.adjustments.map((a) => a.kind)).toEqual(["rounded", "clamped"]);
  });

  it("wraps a seed rather than clamping it", () => {
    // A seed has no ordering — one is no closer to "right" than another — so
    // clamping would collapse every out-of-range seed onto the same value and
    // make distinct documents render identically.
    const a = coerceParams(effect([SEED]), { jitterSeed: -1 });
    const b = coerceParams(effect([SEED]), { jitterSeed: -2 });
    expect(a.values["jitterSeed"]).toBe(SEED_RANGE[1]);
    expect(b.values["jitterSeed"]).toBe(SEED_RANGE[1] - 1);
    expect(a.values["jitterSeed"]).not.toBe(b.values["jitterSeed"]);
    expect(a.adjustments.map((adjustment) => adjustment.kind)).toEqual(["wrapped"]);
  });

  it("substitutes the default for a value of the wrong kind", () => {
    expect(coerceParams(effect([BOOL]), { serpentine: "yes" }).values["serpentine"]).toBe(true);
    expect(coerceParams(effect([ENUM]), { shape: "hexagon" }).values["shape"]).toBe("round");
    expect(coerceParams(effect([ENUM]), { shape: 7 }).adjustments[0]?.kind).toBe("wrong-type");
    expect(coerceParams(effect([ENUM]), { shape: "hexagon" }).adjustments[0]?.kind).toBe(
      "unknown-option",
    );
  });

  it("supplies the default for an absent parameter", () => {
    const result = coerceParams(effect([FLOAT]), {});
    expect(result.values["spread"]).toBe(1);
    expect(result.adjustments.map((a) => a.kind)).toEqual(["missing"]);
  });

  it("drops a key the effect does not declare", () => {
    // A parameter this effect no longer declares is either a rename or another
    // effect's; forwarding it to the kernel is how one becomes a bug that looks
    // like the other.
    const result = coerceParams(effect([FLOAT]), { spread: 1, contrast: 0.5 });
    expect(Object.keys(result.values)).toEqual(["spread"]);
    expect(result.adjustments.map((a) => a.kind)).toEqual(["unknown-key"]);
  });

  it("rounds and clamps colour components", () => {
    const result = coerceParams(effect([COLOR]), { tint: [300, -4, 127.6] });
    expect(result.values["tint"]).toEqual([255, 0, 128]);
    expect(result.adjustments.map((a) => a.kind)).toEqual(["clamped"]);
  });

  it("replaces a broken curve whole rather than repairing it", () => {
    // Sorting the points or moving the endpoints onto 0 and 1 would invent a
    // transfer function the user never drew, and a curve is a look decision.
    const result = coerceParams(effect([CURVE]), {
      transfer: [
        { x: 0.9, y: 0.2 },
        { x: 0.1, y: 0.8 },
      ],
    });
    expect(result.values["transfer"]).toEqual(CURVE.default);
    expect(result.adjustments.map((a) => a.kind)).toEqual(["malformed"]);
  });

  it("copies a curve it accepts, so the caller cannot alias the document", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0.5 },
    ];
    const result = coerceParams(effect([CURVE]), { transfer: points });
    expect(result.values["transfer"]).toEqual(points);
    expect(result.values["transfer"]).not.toBe(points);
  });

  it("records every adjustment with what changed and why", () => {
    // The record is what makes a document that no longer round-trips visible.
    const result = coerceParams(effect([FLOAT, INT]), { spread: 99, levels: 4.6 });
    expect(result.adjustments).toHaveLength(2);
    for (const adjustment of result.adjustments) {
      expect(adjustment.effect).toBe("test-effect");
      expect(adjustment.from).not.toBe("");
      expect(adjustment.to).not.toBe("");
      expect(adjustment.reason).not.toBe("");
    }
  });
});
