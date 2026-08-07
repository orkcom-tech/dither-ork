/**
 * The plan, and the document a frame renders.
 *
 * This is the file that checks the property the animated render path is built
 * on: **a node that nothing drives produces an identical parameter record on
 * every frame.** `graph/animate.ts` works out which nodes to render once and
 * reuse by comparing content hashes, and a hash is over the parameter record —
 * so if this were not exactly true, an `N`-frame export would silently cost `N`
 * full renders and nothing would report it.
 *
 * The other half is the seam into the existing renderer: a document that comes
 * out of `documentAtFrame` carries **no bindings**, which is what lets
 * `state/render/graph.ts` keep refusing documents that do — a refusal that is
 * correct and must not be relaxed.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setLevel } from "../lib/log";
import { globalSpeed } from "./cycles";
import { AnimationError } from "./errors";
import {
  binding,
  diffusionNode,
  patternNode,
  plainNode,
  seededNode,
  testDocument,
  testRegistry,
} from "./fixture";
import { documentAtFrame, planAnimation, planTime, stackAtFrame } from "./plan";
import { PATTERN_ROTATION, type TemporalVariation } from "./temporal";

beforeAll(() => setLevel("error"));
afterEach(() => vi.restoreAllMocks());

const registry = testRegistry();

function stack() {
  return [plainNode(), patternNode(), seededNode()];
}

describe("planAnimation", () => {
  it("checks the clock and resolves what the document holds", () => {
    const plan = planAnimation(
      testDocument(stack(), [binding({ nodeId: "pattern", param: "spread" })]),
      registry,
    );
    expect(plan.clock).toEqual({ frames: 60, fps: 30 });
    expect(plan.bindings).toHaveLength(1);
    expect(plan.variations).toEqual([]);
    expect(plan.animatedNodes).toEqual(["pattern"]);
  });

  it("names every node that moves, in stack order", () => {
    const plan = planAnimation(
      testDocument(stack(), [binding({ nodeId: "seeded", param: "amount" })]),
      registry,
      { variations: [{ nodeId: "pattern", mode: "golden-ratio-rotation" }] },
    );
    expect(plan.animatedNodes).toEqual(["pattern", "seeded"]);
  });

  it("does not count a static variation as movement", () => {
    const plan = planAnimation(testDocument(stack()), registry, {
      variations: [{ nodeId: "pattern", mode: "static" }],
    });
    expect(plan.animatedNodes).toEqual([]);
  });

  it("refuses a variation on a node that is not in the stack", () => {
    expect(() =>
      planAnimation(testDocument(stack()), registry, {
        variations: [{ nodeId: "ghost", mode: "per-frame-reseed" }],
      }),
    ).toThrow(/not in the stack/);
  });

  it("refuses two variations on one node", () => {
    let thrown: unknown;
    try {
      planAnimation(testDocument(stack()), registry, {
        variations: [
          { nodeId: "seeded", mode: "per-frame-reseed" },
          { nodeId: "seeded", mode: "hold-k-frames", hold: 4 },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AnimationError).code).toBe("duplicate-variation");
  });

  it("refuses a stack with duplicate node ids, which no binding could name", () => {
    expect(() =>
      planAnimation(testDocument([patternNode("dup"), patternNode("dup")]), registry),
    ).toThrow(/share the id/);
  });

  it("refuses a node naming an effect this build does not have", () => {
    const alien = { ...plainNode(), effect: "not-registered" };
    expect(() => planAnimation(testDocument([alien]), registry)).toThrow(/does not have/);
  });
});

describe("stackAtFrame", () => {
  it("returns an undriven node by identity, not as a copy", () => {
    const nodes = stack();
    const plan = planAnimation(
      testDocument(nodes, [binding({ nodeId: "pattern", param: "spread" })]),
      registry,
    );
    for (let frame = 0; frame < plan.clock.frames; frame += 1) {
      const resolved = stackAtFrame(plan, frame);
      expect(resolved[0]).toBe(nodes[0]);
      expect(resolved[2]).toBe(nodes[2]);
      expect(resolved[1]).not.toBe(nodes[1]);
    }
  });

  it("gives an undriven node the same parameters on every frame — what makes the cache work", () => {
    // A saw rather than a sine: a sine passes back through its own base value
    // twice per cycle, and this assertion is about the undriven node, not about
    // finding frames where the driven one happens to sit still.
    const plan = planAnimation(
      testDocument(stack(), [
        binding({ nodeId: "pattern", param: "spread", shape: "saw", amount: 0.5 }),
      ]),
      registry,
      { variations: [{ nodeId: "seeded", mode: "per-frame-reseed" }] },
    );
    const first = stackAtFrame(plan, 0);
    for (let frame = 1; frame < plan.clock.frames; frame += 1) {
      const later = stackAtFrame(plan, frame);
      expect(later[0]).toEqual(first[0]);
      expect(later[1]).not.toEqual(first[1]);
      expect(later[2]).not.toEqual(first[2]);
    }
  });

  it("writes the modulated value into the parameter record", () => {
    const plan = planAnimation(
      testDocument([patternNode()], [
        binding({ nodeId: "pattern", param: "spread", amount: 0.5, cyclesPerLoop: 1 }),
      ]),
      registry,
    );
    // Quarter of the way round, a sine is at its peak.
    expect(stackAtFrame(plan, 15)[0]?.params.spread).toBeCloseTo(1.5, 12);
    expect(stackAtFrame(plan, 0)[0]?.params.spread).toBeCloseTo(1, 12);
  });

  it("applies the variation on top of the binding, not the other way round", () => {
    // A rotation carrying both a modulator and a bayer-rotation: at frame 15 the
    // sine contributes +0.25 and the variation contributes another 0.25 turn.
    const plan = planAnimation(
      testDocument([patternNode()], [
        binding({
          nodeId: "pattern",
          param: PATTERN_ROTATION,
          amount: 0.25,
          cyclesPerLoop: 1,
          bipolar: true,
        }),
      ]),
      registry,
      { variations: [{ nodeId: "pattern", mode: "bayer-rotation", turnsPerLoop: 1 }] },
    );
    const rotation = stackAtFrame(plan, 15)[0]?.params[PATTERN_ROTATION];
    expect(rotation).toBeCloseTo(0.5, 12);
  });

  it("carries a per-node seed change through", () => {
    const plan = planAnimation(testDocument([diffusionNode()]), registry, {
      variations: [{ nodeId: "diffusion", mode: "per-frame-reseed" }],
    });
    const seeds = new Set<number>();
    for (let frame = 0; frame < plan.clock.frames; frame += 1) {
      seeds.add(stackAtFrame(plan, frame)[0]?.seed ?? -1);
    }
    expect(seeds.size).toBe(plan.clock.frames);
  });
});

describe("documentAtFrame", () => {
  it("carries no bindings, so the existing graph builder's refusal still passes", () => {
    const plan = planAnimation(
      testDocument(stack(), [binding({ nodeId: "pattern", param: "spread" })]),
      registry,
    );
    const frame = documentAtFrame(plan, 12);
    expect(frame.bindings).toEqual([]);
    expect(plan.document.bindings).toHaveLength(1);
  });

  it("keeps everything else about the document", () => {
    const document = testDocument(stack(), [binding({ nodeId: "pattern", param: "spread" })]);
    const plan = planAnimation(document, registry);
    const frame = documentAtFrame(plan, 3);
    expect(frame.schema).toBe(document.schema);
    expect(frame.palette).toBe(document.palette);
    expect(frame.clock).toBe(document.clock);
    expect(frame.source).toBe(document.source);
    expect(frame.stack).toHaveLength(document.stack.length);
  });

  it("mutates nothing", () => {
    const document = testDocument(stack(), [binding({ nodeId: "pattern", param: "spread" })]);
    const before = JSON.stringify(document);
    const plan = planAnimation(document, registry, {
      variations: [{ nodeId: "seeded", mode: "hold-k-frames", hold: 4 }],
    });
    for (let frame = 0; frame < 60; frame += 1) documentAtFrame(plan, frame);
    expect(JSON.stringify(document)).toBe(before);
  });

  it("gives frame N the document of frame 0", () => {
    const variations: readonly TemporalVariation[] = [
      { nodeId: "pattern", mode: "bayer-offset-scroll", cellsPerLoop: [8, 8], cellPeriod: 4 },
      { nodeId: "seeded", mode: "ping-pong", hold: 4 },
    ];
    const plan = planAnimation(
      testDocument(stack(), [
        binding({ nodeId: "pattern", param: "spread", cyclesPerLoop: 3 }),
        binding({ nodeId: "seeded", param: "amount", shape: "smooth-noise", cyclesPerLoop: 2 }),
      ]),
      registry,
      { variations },
    );
    expect(documentAtFrame(plan, plan.clock.frames)).toEqual(documentAtFrame(plan, 0));
  });
});

describe("F-AN-05 — the whole plan is deterministic", () => {
  it("produces byte-identical documents on repeated evaluation", () => {
    const document = testDocument(stack(), [
      binding({ nodeId: "pattern", param: "spread", shape: "stepped-random", cyclesPerLoop: 2 }),
      binding({ nodeId: "seeded", param: "amount", shape: "smooth-noise" }),
    ]);
    const options = {
      variations: [{ nodeId: "seeded", mode: "per-frame-reseed" }] as const,
      timing: { speed: globalSpeed(2), phaseOffset: 0.37 },
    };
    const a = planAnimation(document, registry, options);
    const b = planAnimation(document, registry, options);
    for (let frame = 0; frame < 60; frame += 1) {
      expect(JSON.stringify(documentAtFrame(b, frame))).toBe(
        JSON.stringify(documentAtFrame(a, frame)),
      );
    }
  });

  it("does not depend on the order frames are asked for", () => {
    const plan = planAnimation(
      testDocument(stack(), [
        binding({ nodeId: "pattern", param: "spread", shape: "smooth-noise" }),
      ]),
      registry,
      { variations: [{ nodeId: "seeded", mode: "hold-k-frames", hold: 4 }] },
    );
    const forwards: string[] = [];
    for (let frame = 0; frame < 60; frame += 1) {
      forwards.push(JSON.stringify(documentAtFrame(plan, frame)));
    }
    const backwards: string[] = [];
    for (let frame = 59; frame >= 0; frame -= 1) {
      backwards.unshift(JSON.stringify(documentAtFrame(plan, frame)));
    }
    expect(backwards).toEqual(forwards);
  });

  it("resolves a whole loop with Math.random, Date.now and performance.now removed", () => {
    const plan = planAnimation(
      testDocument(stack(), [
        binding({ nodeId: "pattern", param: "spread", shape: "stepped-random" }),
        binding({ nodeId: "seeded", param: "amount", shape: "smooth-noise" }),
      ]),
      registry,
      {
        variations: [
          { nodeId: "pattern", mode: "ign-scroll", cellPeriod: 8 },
          { nodeId: "seeded", mode: "ping-pong", hold: 5 },
        ],
      },
    );

    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random in a render path");
    });
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now in a render path");
    });
    vi.spyOn(performance, "now").mockImplementation(() => {
      throw new Error("performance.now in a render path");
    });

    expect(() => {
      for (let frame = 0; frame < plan.clock.frames; frame += 1) documentAtFrame(plan, frame);
    }).not.toThrow();
  });
});

describe("planTime", () => {
  it("is F-AN-01's t, and never reaches 1", () => {
    const plan = planAnimation(testDocument(stack()), registry);
    expect(planTime(plan, 0)).toBe(0);
    expect(planTime(plan, 59)).toBeCloseTo(59 / 60, 15);
    expect(planTime(plan, 60)).toBe(0);
  });
});
