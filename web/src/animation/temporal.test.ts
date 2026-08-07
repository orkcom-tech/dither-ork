/**
 * F-AN-04 — temporal variation, all nine modes.
 *
 * Three things are asserted, and they are different questions:
 *
 * - **Every mode is periodic in `frame mod N`.** Asserted for all nine, over
 *   several frame counts, by deep-comparing the state at frame `N` with the
 *   state at frame `0` and the state at `frame + N` with the state at `frame`.
 *   This is cheap because it is true by construction; it is here because "by
 *   construction" is a claim about code that can stop being true.
 * - **Every mode does something distinguishable.** A mode that returned a
 *   constant would pass every periodicity test ever written. Each one is
 *   separately checked to move, and to move in the way its name says.
 * - **A mode is refused on a node that has no lever for it.** That is the
 *   difference between a mode list and a mode list that lies: a reseed on a
 *   Bayer tile would re-hash every frame and change no pixel.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { EffectDescriptor, ParamDescriptor } from "../types/registry";
import { setLevel } from "../lib/log";
import { loopClock } from "./clock";
import { AnimationError } from "./errors";
import {
  DIFFUSION_EFFECT,
  PATTERN_EFFECT,
  PLAIN_EFFECT,
  SEEDED_EFFECT,
  diffusionNode,
  patternNode,
  plainNode,
  seededNode,
} from "./fixture";
import {
  GOLDEN_ANGLE_TURNS,
  PATTERN_OFFSET_X,
  PATTERN_OFFSET_Y,
  PATTERN_ROTATION,
  TEMPORAL_MODES,
  applyTemporalState,
  resolveVariation,
  seedParams,
  supportsLever,
  temporalContinuity,
  temporalLever,
  temporalModesFor,
  temporalStateAt,
  type TemporalVariation,
} from "./temporal";

beforeAll(() => setLevel("error"));
afterEach(() => vi.restoreAllMocks());

const clock = loopClock({ frames: 60, fps: 30 });

/** One well-formed variation per mode, all on the same node id. */
function everyMode(nodeId = "n"): readonly TemporalVariation[] {
  return [
    { nodeId, mode: "static" },
    { nodeId, mode: "per-frame-reseed" },
    { nodeId, mode: "blue-noise-cycle", hold: 4, cellPeriod: 64 },
    { nodeId, mode: "bayer-offset-scroll", cellsPerLoop: [8, 4], cellPeriod: 4 },
    { nodeId, mode: "bayer-rotation", turnsPerLoop: 1 },
    { nodeId, mode: "ign-scroll", cellPeriod: 8 },
    { nodeId, mode: "hold-k-frames", hold: 5 },
    { nodeId, mode: "ping-pong", hold: 6 },
    { nodeId, mode: "golden-ratio-rotation" },
  ];
}

describe("the mode table", () => {
  it("has all nine, in the order F-AN-04 lists them", () => {
    expect(TEMPORAL_MODES).toEqual([
      "static",
      "per-frame-reseed",
      "blue-noise-cycle",
      "bayer-offset-scroll",
      "bayer-rotation",
      "ign-scroll",
      "hold-k-frames",
      "ping-pong",
      "golden-ratio-rotation",
    ]);
    expect(everyMode()).toHaveLength(TEMPORAL_MODES.length);
  });

  it("gives every mode exactly one lever, and static none", () => {
    expect(temporalLever("static")).toBeNull();
    for (const mode of TEMPORAL_MODES) {
      if (mode === "static") continue;
      expect(temporalLever(mode)).not.toBeNull();
    }
  });

  it("classifies every mode as continuous or stepwise", () => {
    for (const mode of TEMPORAL_MODES) {
      expect(["continuous", "stepwise"]).toContain(temporalContinuity(mode));
    }
  });
});

describe("periodicity in frame mod N", () => {
  it("holds for every mode at several frame counts", () => {
    for (const frames of [1, 7, 24, 60, 120]) {
      const c = loopClock({ frames, fps: 24 });
      for (const variation of everyMode()) {
        // A ping-pong needs two steps; skip the counts where the plan would
        // refuse it rather than assert on a state it would never be asked for.
        if (variation.mode === "ping-pong" && Math.ceil(frames / variation.hold) < 2) continue;
        expect(temporalStateAt(variation, c, frames, 5)).toEqual(
          temporalStateAt(variation, c, 0, 5),
        );
        for (const frame of [0, 1, Math.floor(frames / 2), frames - 1]) {
          expect(temporalStateAt(variation, c, frame + frames, 5)).toEqual(
            temporalStateAt(variation, c, frame, 5),
          );
          expect(temporalStateAt(variation, c, frame - frames, 5)).toEqual(
            temporalStateAt(variation, c, frame, 5),
          );
        }
      }
    }
  });

  it("touches only the lever its mode declares", () => {
    for (const variation of everyMode()) {
      const state = temporalStateAt(variation, clock, 7, 5);
      const lever = temporalLever(variation.mode);
      expect(state.seed !== null).toBe(lever === "seed");
      expect(state.offset !== null).toBe(lever === "pattern-offset");
      expect(state.rotationTurns !== null).toBe(lever === "pattern-rotation");
    }
  });

  it("makes every non-static mode actually move", () => {
    for (const variation of everyMode()) {
      const states = new Set<string>();
      for (let frame = 0; frame < clock.frames; frame += 1) {
        states.add(JSON.stringify(temporalStateAt(variation, clock, frame, 5)));
      }
      if (variation.mode === "static") expect(states.size).toBe(1);
      else expect(states.size).toBeGreaterThan(1);
    }
  });
});

describe("the seed modes", () => {
  it("per-frame-reseed gives every frame its own field", () => {
    const variation: TemporalVariation = { nodeId: "n", mode: "per-frame-reseed" };
    const seeds = new Set<number>();
    for (let frame = 0; frame < clock.frames; frame += 1) {
      const seed = temporalStateAt(variation, clock, frame, 9).seed;
      expect(seed).not.toBeNull();
      seeds.add(seed ?? -1);
    }
    expect(seeds.size).toBe(clock.frames);
  });

  it("hold-k-frames holds for exactly K and then changes", () => {
    const variation: TemporalVariation = { nodeId: "n", mode: "hold-k-frames", hold: 5 };
    const seedAt = (frame: number) => temporalStateAt(variation, clock, frame, 9).seed;
    for (let frame = 0; frame < 5; frame += 1) expect(seedAt(frame)).toBe(seedAt(0));
    expect(seedAt(5)).not.toBe(seedAt(0));
    for (let frame = 5; frame < 10; frame += 1) expect(seedAt(frame)).toBe(seedAt(5));
    expect(seedAt(10)).not.toBe(seedAt(5));
  });

  it("ping-pong folds the step sequence back on itself", () => {
    const short = loopClock({ frames: 6, fps: 24 });
    const variation: TemporalVariation = { nodeId: "n", mode: "ping-pong", hold: 1 };
    const seeds = [0, 1, 2, 3, 4, 5].map(
      (frame) => temporalStateAt(variation, short, frame, 9).seed,
    );
    // 0,1,2,3,2,1 — the walk out and the walk back share their patterns.
    expect(seeds[4]).toBe(seeds[2]);
    expect(seeds[5]).toBe(seeds[1]);
    expect(new Set(seeds).size).toBe(4);
    expect(seeds[3]).not.toBe(seeds[0]);
  });

  it("draws from the node's own seed, so re-rolling the node re-rolls the animation", () => {
    const variation: TemporalVariation = { nodeId: "n", mode: "per-frame-reseed" };
    expect(temporalStateAt(variation, clock, 3, 1).seed).not.toBe(
      temporalStateAt(variation, clock, 3, 2).seed,
    );
    expect(temporalStateAt(variation, clock, 3, 1).seed).toBe(
      temporalStateAt(variation, clock, 3, 1).seed,
    );
  });

  it("gives the three seed modes different sequences from one node seed", () => {
    const perFrame = temporalStateAt({ nodeId: "n", mode: "per-frame-reseed" }, clock, 0, 9).seed;
    const hold = temporalStateAt({ nodeId: "n", mode: "hold-k-frames", hold: 4 }, clock, 0, 9).seed;
    const pong = temporalStateAt({ nodeId: "n", mode: "ping-pong", hold: 4 }, clock, 0, 9).seed;
    expect(new Set([perFrame, hold, pong]).size).toBe(3);
  });
});

describe("the offset modes", () => {
  it("all start at zero offset, which is what closes the loop", () => {
    for (const variation of everyMode()) {
      if (temporalLever(variation.mode) !== "pattern-offset") continue;
      expect(temporalStateAt(variation, clock, 0, 5).offset).toEqual([0, 0]);
    }
  });

  it("keeps every offset inside one pattern period", () => {
    for (const variation of everyMode()) {
      if (temporalLever(variation.mode) !== "pattern-offset") continue;
      const period = "cellPeriod" in variation ? variation.cellPeriod : 0;
      for (let frame = 0; frame < clock.frames; frame += 1) {
        const offset = temporalStateAt(variation, clock, frame, 5).offset;
        expect(offset).not.toBeNull();
        for (const axis of offset ?? []) {
          expect(axis).toBeGreaterThanOrEqual(0);
          expect(axis).toBeLessThan(period);
        }
      }
    }
  });

  it("scrolls linearly and lands back on the pattern when the travel is a whole period", () => {
    const variation: TemporalVariation = {
      nodeId: "n",
      mode: "bayer-offset-scroll",
      cellsPerLoop: [8, 0],
      cellPeriod: 4,
    };
    // 8 cells over 60 frames through a 4-cell pattern: two whole periods, so the
    // offset is congruent to zero at the seam.
    expect(temporalStateAt(variation, clock, 0, 5).offset?.[0]).toBe(0);
    expect(temporalStateAt(variation, clock, 30, 5).offset?.[0]).toBe(0);
    expect(temporalStateAt(variation, clock, 15, 5).offset?.[0]).toBeCloseTo(2, 12);
  });

  it("spreads a blue-noise cycle's positions rather than walking them", () => {
    const variation: TemporalVariation = {
      nodeId: "n",
      mode: "blue-noise-cycle",
      hold: 4,
      cellPeriod: 64,
    };
    const positions: number[][] = [];
    for (let frame = 0; frame < clock.frames; frame += 4) {
      const offset = temporalStateAt(variation, clock, frame, 5).offset;
      if (offset !== null) positions.push([...offset]);
    }
    expect(positions).toHaveLength(15);
    // Consecutive positions are far apart in the tile: the whole point of an R2
    // walk rather than an increment.
    for (let i = 1; i < positions.length; i += 1) {
      const a = positions[i - 1];
      const b = positions[i];
      if (a === undefined || b === undefined) throw new Error("missing position");
      const dx = Math.abs((a[0] ?? 0) - (b[0] ?? 0));
      const dy = Math.abs((a[1] ?? 0) - (b[1] ?? 0));
      expect(Math.max(dx, dy)).toBeGreaterThan(8);
    }
  });

  it("advances IGN along its diagonal, a new position every frame", () => {
    const variation: TemporalVariation = { nodeId: "n", mode: "ign-scroll", cellPeriod: 8 };
    const seen = new Set<string>();
    for (let frame = 0; frame < clock.frames; frame += 1) {
      const offset = temporalStateAt(variation, clock, frame, 5).offset;
      expect(offset?.[0]).toBe(offset?.[1]);
      seen.add(String(offset?.[0]));
    }
    expect(seen.size).toBe(clock.frames);
  });
});

describe("the rotation modes", () => {
  it("rotates a whole number of turns over the loop and returns to zero", () => {
    const variation: TemporalVariation = { nodeId: "n", mode: "bayer-rotation", turnsPerLoop: 2 };
    expect(temporalStateAt(variation, clock, 0, 5).rotationTurns).toBe(0);
    expect(temporalStateAt(variation, clock, 30, 5).rotationTurns).toBe(0);
    expect(temporalStateAt(variation, clock, 15, 5).rotationTurns).toBeCloseTo(0.5, 12);
    expect(temporalStateAt(variation, clock, 60, 5).rotationTurns).toBe(0);
  });

  it("rotates backwards for a negative turn count", () => {
    const variation: TemporalVariation = { nodeId: "n", mode: "bayer-rotation", turnsPerLoop: -1 };
    expect(temporalStateAt(variation, clock, 15, 5).rotationTurns).toBeCloseTo(0.75, 12);
  });

  it("steps the golden angle and visits N well-separated rotations", () => {
    const variation: TemporalVariation = { nodeId: "n", mode: "golden-ratio-rotation" };
    expect(temporalStateAt(variation, clock, 0, 5).rotationTurns).toBe(0);
    expect(temporalStateAt(variation, clock, 1, 5).rotationTurns).toBeCloseTo(
      GOLDEN_ANGLE_TURNS,
      12,
    );
    const turns: number[] = [];
    for (let frame = 0; frame < clock.frames; frame += 1) {
      turns.push(temporalStateAt(variation, clock, frame, 5).rotationTurns ?? -1);
    }
    expect(new Set(turns).size).toBe(clock.frames);
    // Low discrepancy: sorted, no gap is more than twice the mean gap.
    const sorted = [...turns].sort((a, b) => a - b);
    const mean = 1 / clock.frames;
    for (let i = 1; i < sorted.length; i += 1) {
      expect((sorted[i] ?? 0) - (sorted[i - 1] ?? 0)).toBeLessThan(mean * 2);
    }
  });
});

describe("levers", () => {
  it("gives a pattern effect the offset and rotation levers and not the seed", () => {
    expect(supportsLever(PATTERN_EFFECT, "pattern-offset")).toBe(true);
    expect(supportsLever(PATTERN_EFFECT, "pattern-rotation")).toBe(true);
    expect(supportsLever(PATTERN_EFFECT, "seed")).toBe(false);
    expect(temporalModesFor(PATTERN_EFFECT)).toEqual([
      "static",
      "blue-noise-cycle",
      "bayer-offset-scroll",
      "bayer-rotation",
      "ign-scroll",
      "golden-ratio-rotation",
    ]);
  });

  it("gives an effect that declares a seed the seed lever and nothing else", () => {
    expect(supportsLever(SEEDED_EFFECT, "seed")).toBe(true);
    expect(supportsLever(SEEDED_EFFECT, "pattern-offset")).toBe(false);
    expect(temporalModesFor(SEEDED_EFFECT)).toEqual([
      "static",
      "per-frame-reseed",
      "hold-k-frames",
      "ping-pong",
    ]);
    expect(seedParams(SEEDED_EFFECT).map((p) => p.key)).toEqual(["seed", "second"]);
  });

  it("gives error diffusion the seed lever without a seed parameter", () => {
    // The kernels take StackNode.seed for their threshold jitter; the family is
    // the one entry in SEEDED_FAMILIES and this is what pins it.
    expect(seedParams(DIFFUSION_EFFECT)).toHaveLength(0);
    expect(supportsLever(DIFFUSION_EFFECT, "seed")).toBe(true);
  });

  it("offers a plain effect nothing but static", () => {
    expect(temporalModesFor(PLAIN_EFFECT)).toEqual(["static"]);
  });
});

describe("resolveVariation", () => {
  it("refuses a mode whose lever the effect does not have", () => {
    let thrown: unknown;
    try {
      resolveVariation(
        { nodeId: "pattern", mode: "per-frame-reseed" },
        patternNode(),
        PATTERN_EFFECT,
        clock,
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AnimationError).code).toBe("unsupported-lever");
    expect((thrown as AnimationError).message).toContain("change no pixel");
  });

  it("refuses a hold of zero", () => {
    expect(() =>
      resolveVariation(
        { nodeId: "seeded", mode: "hold-k-frames", hold: 0 },
        seededNode(),
        SEEDED_EFFECT,
        clock,
      ),
    ).toThrow(AnimationError);
  });

  it("refuses a ping-pong with nothing to pong between", () => {
    expect(() =>
      resolveVariation(
        { nodeId: "seeded", mode: "ping-pong", hold: 60 },
        seededNode(),
        SEEDED_EFFECT,
        clock,
      ),
    ).toThrow(/at least two patterns/);
  });

  it("refuses a cell period the offset parameter cannot hold", () => {
    const narrowOffset: ParamDescriptor = {
      key: PATTERN_OFFSET_X,
      label: "Offset X",
      description:
        "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
      type: "float",
      animatable: true,
      legal: [0, 2],
      default: 0,
      surprise: { range: [0, 1], distribution: { kind: "uniform" }, weight: 1 },
    };
    const narrow: EffectDescriptor = {
      ...PATTERN_EFFECT,
      params: PATTERN_EFFECT.params.map((param) =>
        param.key === PATTERN_OFFSET_X ? narrowOffset : param,
      ),
    };
    expect(() =>
      resolveVariation(
        { nodeId: "pattern", mode: "ign-scroll", cellPeriod: 64 },
        patternNode(),
        narrow,
        clock,
      ),
    ).toThrow(/does not fit/);
  });

  it("accepts a hold that does not divide the frame count — that is a warning, not a refusal", () => {
    expect(
      resolveVariation(
        { nodeId: "seeded", mode: "hold-k-frames", hold: 7 },
        seededNode(),
        SEEDED_EFFECT,
        clock,
      ).lever,
    ).toBe("seed");
  });
});

describe("applyTemporalState", () => {
  it("returns the node itself when nothing moved", () => {
    const node = patternNode();
    expect(
      applyTemporalState(node, PATTERN_EFFECT, {
        seed: null,
        offset: null,
        rotationTurns: null,
      }),
    ).toBe(node);
  });

  it("replaces the node seed and reseeds every seed parameter independently", () => {
    const node = seededNode();
    const next = applyTemporalState(node, SEEDED_EFFECT, {
      seed: 0xabcdef,
      offset: null,
      rotationTurns: null,
    });
    expect(next.seed).toBe(0xabcdef);
    expect(next.params.seed).not.toBe(node.params.seed);
    expect(next.params.second).not.toBe(node.params.second);
    expect(next.params.seed).not.toBe(next.params.second);
    expect(next.params.amount).toBe(node.params.amount);
  });

  it("adds the offset to the authored value", () => {
    const node = patternNode();
    const shifted = { ...node, params: { ...node.params, [PATTERN_OFFSET_X]: 3 } };
    const next = applyTemporalState(shifted, PATTERN_EFFECT, {
      seed: null,
      offset: [1.5, 0.25],
      rotationTurns: null,
    });
    expect(next.params[PATTERN_OFFSET_X]).toBe(4.5);
    expect(next.params[PATTERN_OFFSET_Y]).toBe(0.25);
    expect(next.seed).toBe(node.seed);
  });

  it("wraps the rotation rather than clamping it, because a turn is a circle", () => {
    const node = patternNode();
    const spun = { ...node, params: { ...node.params, [PATTERN_ROTATION]: 0.9 } };
    const next = applyTemporalState(spun, PATTERN_EFFECT, {
      seed: null,
      offset: null,
      rotationTurns: 0.5,
    });
    // 1.4 turns is 0.4 turns. A clamp to the legal [-1, 1] would have given 1,
    // and the pattern would have stopped part way round.
    expect(next.params[PATTERN_ROTATION]).toBeCloseTo(0.4, 12);
  });

  it("mutates nothing", () => {
    const node = seededNode();
    const before = JSON.stringify(node);
    applyTemporalState(node, SEEDED_EFFECT, { seed: 1, offset: null, rotationTurns: null });
    expect(JSON.stringify(node)).toBe(before);
  });

  it("refuses a document whose offset parameter is not a number", () => {
    const node = patternNode();
    const broken = { ...node, params: { ...node.params, [PATTERN_OFFSET_X]: true } };
    expect(() =>
      applyTemporalState(broken, PATTERN_EFFECT, {
        seed: null,
        offset: [1, 1],
        rotationTurns: null,
      }),
    ).toThrow(AnimationError);
  });
});

describe("F-AN-05 — temporal variation reads no clock and no unseeded generator", () => {
  it("evaluates every mode with Math.random, Date.now and performance.now removed", () => {
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
      for (const variation of everyMode()) {
        for (let frame = 0; frame < clock.frames; frame += 1) {
          temporalStateAt(variation, clock, frame, 5);
        }
      }
      applyTemporalState(diffusionNode(), DIFFUSION_EFFECT, {
        seed: 3,
        offset: null,
        rotationTurns: null,
      });
      applyTemporalState(plainNode(), PLAIN_EFFECT, {
        seed: null,
        offset: null,
        rotationTurns: null,
      });
    }).not.toThrow();
  });
});
