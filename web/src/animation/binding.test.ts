/**
 * F-AN-02 and F-AN-10 — bindings against the registry.
 *
 * Most of this file is about what is **refused**. A modulator attached to a
 * parameter the catalogue says is not animatable, or to a parameter that does
 * not exist, or to a node that is not in the stack, would each render a picture
 * that is not the document — and would do it convincingly, which is the failure
 * this whole layer is arranged to prevent. Every one of them throws.
 *
 * The rest is the arithmetic: modulation is around the authored value, the
 * clamp keeps a swing legal without breaking the loop, and the global controls
 * apply to every binding at once without any of them leaving F-AN-03.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { loopClock } from "./clock";
import { cyclesPerLoop, globalSpeed } from "./cycles";
import { AnimationError } from "./errors";
import {
  DEFAULT_TIMING,
  bindingRawValueAt,
  bindingSeed,
  bindingSwing,
  bindingValueAt,
  resolveBindings,
} from "./binding";
import {
  binding,
  diffusionNode,
  patternNode,
  seededNode,
  testDocument,
  testRegistry,
} from "./fixture";
import { PATTERN_ROTATION } from "./temporal";

beforeAll(() => setLevel("error"));

const registry = testRegistry();
const clock = loopClock({ frames: 60, fps: 30 });

function resolveOne(
  doc = testDocument([patternNode()], [binding({ nodeId: "pattern", param: "spread" })]),
  timing = DEFAULT_TIMING,
) {
  const resolved = resolveBindings(doc, registry, timing);
  const first = resolved[0];
  if (first === undefined) throw new Error("fixture produced no binding");
  return first;
}

describe("what a binding may attach to", () => {
  it("resolves a float parameter that declares animatable: true", () => {
    const resolved = resolveOne();
    expect(resolved.nodeId).toBe("pattern");
    expect(resolved.param).toBe("spread");
    expect(resolved.base).toBe(1);
    expect(resolved.descriptor.type).toBe("float");
  });

  it("resolves an int parameter", () => {
    const doc = testDocument(
      [patternNode()],
      [binding({ nodeId: "pattern", param: "cells", amount: 4 })],
    );
    expect(resolveBindings(doc, registry, DEFAULT_TIMING)[0]?.descriptor.type).toBe("int");
  });

  it("refuses a node that is not in the stack", () => {
    const doc = testDocument([patternNode()], [binding({ nodeId: "ghost", param: "spread" })]);
    expect(() => resolveBindings(doc, registry, DEFAULT_TIMING)).toThrow(/not in the stack/);
  });

  it("refuses a parameter the effect does not declare", () => {
    const doc = testDocument([patternNode()], [binding({ nodeId: "pattern", param: "nope" })]);
    expect(() => resolveBindings(doc, registry, DEFAULT_TIMING)).toThrow(/declares no parameter/);
  });

  it("refuses a seed, because a seed is a name and not a quantity", () => {
    const doc = testDocument([seededNode()], [binding({ nodeId: "seeded", param: "seed" })]);
    let thrown: unknown;
    try {
      resolveBindings(doc, registry, DEFAULT_TIMING);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AnimationError).code).toBe("parameter-not-animatable");
    expect((thrown as AnimationError).message).toContain("F-AN-04");
  });

  it("refuses an enum, whose ordinal has no meaning between two values", () => {
    const doc = testDocument([patternNode()], [binding({ nodeId: "pattern", param: "shape" })]);
    expect(() => resolveBindings(doc, registry, DEFAULT_TIMING)).toThrow(AnimationError);
  });

  it("refuses two bindings on one parameter", () => {
    const doc = testDocument(
      [patternNode()],
      [
        binding({ nodeId: "pattern", param: "spread" }),
        binding({ nodeId: "pattern", param: "spread", shape: "saw" }),
      ],
    );
    let thrown: unknown;
    try {
      resolveBindings(doc, registry, DEFAULT_TIMING);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AnimationError).code).toBe("duplicate-binding");
  });

  it("refuses a fractional cycles-per-loop found in a document", () => {
    const doc = testDocument(
      [patternNode()],
      [binding({ nodeId: "pattern", param: "spread", cyclesPerLoop: 2.5 })],
    );
    expect(() => resolveBindings(doc, registry, DEFAULT_TIMING)).toThrow(/F-AN-03/);
  });

  it("refuses a bound parameter the document left as a non-number", () => {
    const node = patternNode();
    const broken = { ...node, params: { ...node.params, spread: "loud" } };
    const doc = testDocument([broken], [binding({ nodeId: "pattern", param: "spread" })]);
    expect(() => resolveBindings(doc, registry, DEFAULT_TIMING)).toThrow(/finite number/);
  });
});

describe("the value a binding produces", () => {
  it("swings around the authored value, so amount 0 is the identity", () => {
    const doc = testDocument(
      [patternNode()],
      [binding({ nodeId: "pattern", param: "spread", amount: 0 })],
    );
    const resolved = resolveOne(doc);
    for (let frame = 0; frame < clock.frames; frame += 1) {
      expect(bindingValueAt(resolved, clock, frame)).toBe(1);
    }
  });

  it("is bipolar about the base and unipolar above it", () => {
    const bip = resolveOne(
      testDocument(
        [patternNode()],
        [binding({ nodeId: "pattern", param: "spread", amount: 0.5, bipolar: true })],
      ),
    );
    const uni = resolveOne(
      testDocument(
        [patternNode()],
        [binding({ nodeId: "pattern", param: "spread", amount: 0.5, bipolar: false })],
      ),
    );
    const bipSwing = bindingSwing(bip, clock);
    const uniSwing = bindingSwing(uni, clock);
    expect(bipSwing.min).toBeLessThan(1);
    expect(bipSwing.max).toBeGreaterThan(1);
    expect(uniSwing.min).toBeGreaterThanOrEqual(1 - 1e-12);
    expect(uniSwing.max).toBeGreaterThan(1);
  });

  it("clamps to the parameter's legal range without breaking the loop", () => {
    // spread is legal 0..2; base 1 with amount 5 runs far past both ends.
    const resolved = resolveOne(
      testDocument(
        [patternNode()],
        [binding({ nodeId: "pattern", param: "spread", amount: 5 })],
      ),
    );
    for (let frame = 0; frame < clock.frames; frame += 1) {
      const value = bindingValueAt(resolved, clock, frame);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(2);
    }
    expect(bindingValueAt(resolved, clock, clock.frames)).toBe(bindingValueAt(resolved, clock, 0));
    // The unclamped value is still available, which is what the seam report
    // measures the overrun with.
    expect(Math.abs(bindingRawValueAt(resolved, clock, 15))).toBeGreaterThan(2);
  });

  it("rounds an int parameter and then clamps it", () => {
    const resolved = resolveOne(
      testDocument(
        [patternNode()],
        [binding({ nodeId: "pattern", param: "cells", amount: 100 })],
      ),
    );
    for (let frame = 0; frame < clock.frames; frame += 1) {
      const value = bindingValueAt(resolved, clock, frame);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(16);
    }
  });

  it("never produces -0, which would hash differently from 0", () => {
    const node = patternNode();
    const zeroed = { ...node, params: { ...node.params, [PATTERN_ROTATION]: 0 } };
    const resolved = resolveOne(
      testDocument(
        [zeroed],
        [binding({ nodeId: "pattern", param: PATTERN_ROTATION, amount: 0.5 })],
      ),
    );
    for (let frame = 0; frame < clock.frames; frame += 1) {
      expect(Object.is(bindingValueAt(resolved, clock, frame), -0)).toBe(false);
    }
  });

  it("gives frame N the value of frame 0 for every shape", () => {
    for (const shape of ["sine", "triangle", "saw", "square", "smooth-noise", "stepped-random"] as const) {
      const resolved = resolveOne(
        testDocument(
          [patternNode()],
          [binding({ nodeId: "pattern", param: "spread", shape, cyclesPerLoop: 3 })],
        ),
      );
      expect(bindingValueAt(resolved, clock, clock.frames)).toBe(
        bindingValueAt(resolved, clock, 0),
      );
    }
  });
});

describe("F-AN-10 — the global controls", () => {
  it("multiplies every binding's cycle count and keeps it integral", () => {
    const doc = testDocument(
      [patternNode(), diffusionNode()],
      [
        binding({ nodeId: "pattern", param: "spread", cyclesPerLoop: 3 }),
        binding({ nodeId: "diffusion", param: "strength", cyclesPerLoop: 2 }),
      ],
    );
    const resolved = resolveBindings(doc, registry, {
      speed: globalSpeed(4),
      phaseOffset: 0,
    });
    expect(resolved.map((r) => r.spec.cycles)).toEqual([12, 8]);
    for (const r of resolved) expect(Number.isInteger(r.spec.cycles)).toBe(true);
  });

  it("adds one phase offset to every binding and normalises it", () => {
    const doc = testDocument(
      [patternNode()],
      [binding({ nodeId: "pattern", param: "spread", phase: 0.75 })],
    );
    const resolved = resolveBindings(doc, registry, {
      speed: globalSpeed(1),
      phaseOffset: 0.5,
    });
    expect(resolved[0]?.spec.phase).toBeCloseTo(0.25, 12);
  });

  it("leaves every binding periodic whatever the speed", () => {
    for (const speed of [1, 2, 3, 7]) {
      const resolved = resolveOne(
        testDocument(
          [patternNode()],
          [binding({ nodeId: "pattern", param: "spread", cyclesPerLoop: 5 })],
        ),
        { speed: globalSpeed(speed), phaseOffset: 0.3 },
      );
      expect(bindingValueAt(resolved, clock, clock.frames)).toBe(
        bindingValueAt(resolved, clock, 0),
      );
    }
  });
});

describe("F-AN-05 — the modulator's own seed", () => {
  it("comes from the target node's saved seed, so it reproduces from the document", () => {
    const node = patternNode("pattern", 42);
    const b = binding({ nodeId: "pattern", param: "spread", shape: "smooth-noise" });
    expect(bindingSeed(node, b, 0)).toBe(bindingSeed(node, b, 0));
    expect(bindingSeed({ ...node, seed: 43 }, b, 0)).not.toBe(bindingSeed(node, b, 0));
  });

  it("differs per parameter and per shape, so two tracks on one node do not lock together", () => {
    const node = patternNode();
    const a = binding({ nodeId: "pattern", param: "spread", shape: "smooth-noise" });
    const b = binding({ nodeId: "pattern", param: PATTERN_ROTATION, shape: "smooth-noise" });
    const c = binding({ nodeId: "pattern", param: "spread", shape: "stepped-random" });
    expect(bindingSeed(node, a, 0)).not.toBe(bindingSeed(node, b, 0));
    expect(bindingSeed(node, a, 0)).not.toBe(bindingSeed(node, c, 0));
  });

  it("takes the document seed too, for when the schema grows one", () => {
    const node = patternNode();
    const b = binding({ nodeId: "pattern", param: "spread", shape: "smooth-noise" });
    expect(bindingSeed(node, b, 1)).not.toBe(bindingSeed(node, b, 0));
  });

  it("gives byte-identical values on repeated resolution", () => {
    const doc = testDocument(
      [patternNode()],
      [binding({ nodeId: "pattern", param: "spread", shape: "stepped-random", cyclesPerLoop: 2 })],
    );
    const first = resolveBindings(doc, registry, DEFAULT_TIMING)[0];
    const second = resolveBindings(doc, registry, DEFAULT_TIMING)[0];
    if (first === undefined || second === undefined) throw new Error("no binding");
    for (let frame = 0; frame < clock.frames; frame += 1) {
      expect(bindingValueAt(second, clock, frame)).toBe(bindingValueAt(first, clock, frame));
    }
  });
});

describe("bindingSwing", () => {
  it("reports the extremes the loop actually reaches", () => {
    const resolved = resolveOne(
      testDocument(
        [patternNode()],
        [binding({ nodeId: "pattern", param: "spread", amount: 0.5, cyclesPerLoop: 1 })],
      ),
    );
    const swing = bindingSwing(resolved, clock);
    expect(swing.min).toBeCloseTo(0.5, 2);
    expect(swing.max).toBeCloseTo(1.5, 2);
  });
});

describe("resolveBindings ordering", () => {
  it("preserves the document's order", () => {
    const doc = testDocument(
      [patternNode(), seededNode()],
      [
        binding({ nodeId: "seeded", param: "amount" }),
        binding({ nodeId: "pattern", param: "spread" }),
      ],
    );
    expect(resolveBindings(doc, registry, DEFAULT_TIMING).map((r) => r.nodeId)).toEqual([
      "seeded",
      "pattern",
    ]);
  });

  it("returns nothing for a document with no bindings", () => {
    expect(resolveBindings(testDocument([patternNode()]), registry, DEFAULT_TIMING)).toEqual([]);
  });
});

describe("cyclesPerLoop is reachable from here", () => {
  it("re-exports the constructor the document loader needs", () => {
    expect(cyclesPerLoop(3)).toBe(3);
  });
});
