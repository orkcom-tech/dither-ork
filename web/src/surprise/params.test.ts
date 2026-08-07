/**
 * Parameter drawing, against the real catalogue.
 *
 * The property that matters is that **every parameter set a surprise produces
 * passes `validateParams` untouched**. `coerceParams` would repair a bad one and
 * log a warning per key on every render, so a generator that produced
 * out-of-range values would look like it worked and would fill the console.
 * That is checked here across every effect in the build at both chaos ends.
 */

import { describe, expect, it } from "vitest";

import { discoverEffects } from "../registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../registry/registry";
import { defaultParams, validateParams } from "../registry/params";
import { PARAM_CHAOS, sampleNodeParams, sampleNodeSeed } from "./params";
import { SEED_RANGE } from "../types/registry";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());

describe("sampleNodeParams over the whole catalogue", () => {
  it("produces a set that validates, for every effect at every chaos end", () => {
    for (const descriptor of registry.all()) {
      for (const chaos of [0, 0.5, 1]) {
        for (let run = 0; run < 4; run += 1) {
          const params = sampleNodeParams({
            seed: BigInt(run) * 0x9e37_79b9n + 1n,
            nodeId: `n${run + 1}`,
            descriptor,
            chaos,
          });
          const verdict = validateParams(descriptor, params);
          expect(
            verdict.issues.map((issue) => `${issue.key}: ${issue.message}`),
            `${descriptor.id} at chaos ${chaos}`,
          ).toEqual([]);
        }
      }
    }
  });

  it("declares a value for every key the descriptor declares, and no others", () => {
    for (const descriptor of registry.all()) {
      const params = sampleNodeParams({
        seed: 42n,
        nodeId: "n1",
        descriptor,
        chaos: 0.6,
      });
      expect(Object.keys(params).sort()).toEqual(
        descriptor.params.map((param) => param.key).sort(),
      );
    }
  });

  it("stays inside every declared surprise range for numeric parameters", () => {
    // The surprise range, not merely the legal range — F-SM-04's whole point.
    // The one legitimate escape is a value pulled toward a default that sits
    // outside its own surprise range, so the assertion is over the interval
    // spanned by the surprise range *and* the default.
    for (const descriptor of registry.all()) {
      for (let run = 0; run < 6; run += 1) {
        const params = sampleNodeParams({
          seed: BigInt(run) * 977n + 3n,
          nodeId: "n1",
          descriptor,
          chaos: 1,
        });
        for (const param of descriptor.params) {
          if (param.type !== "float" && param.type !== "int") continue;
          const value = params[param.key];
          expect(typeof value).toBe("number");
          const low = Math.min(param.surprise.range[0], param.default);
          const high = Math.max(param.surprise.range[1], param.default);
          expect(value as number, `${descriptor.id}.${param.key}`).toBeGreaterThanOrEqual(low);
          expect(value as number, `${descriptor.id}.${param.key}`).toBeLessThanOrEqual(high);
        }
      }
    }
  });

  it("is reproducible from the seed and the node id", () => {
    const descriptor = registry.require("halftone");
    const a = sampleNodeParams({ seed: 7n, nodeId: "n3", descriptor, chaos: 0.5 });
    const b = sampleNodeParams({ seed: 7n, nodeId: "n3", descriptor, chaos: 0.5 });
    expect(a).toEqual(b);
  });

  it("gives two nodes of the same effect different parameters", () => {
    const descriptor = registry.require("halftone");
    const a = sampleNodeParams({ seed: 7n, nodeId: "n1", descriptor, chaos: 0.8 });
    const b = sampleNodeParams({ seed: 7n, nodeId: "n2", descriptor, chaos: 0.8 });
    expect(a).not.toEqual(b);
  });

  /**
   * The reason for one stream per key. With a shared generator, a parameter's
   * value depends on how many draws the parameters before it happened to make —
   * so inserting a control in the middle of a descriptor re-rolls everything
   * after it, and every saved seed produces a different picture from the same
   * build.
   */
  it("gives a parameter a value that does not depend on its siblings", () => {
    const descriptor = registry.require("halftone");
    const full = sampleNodeParams({ seed: 99n, nodeId: "n1", descriptor, chaos: 0.7 });

    const trimmed = {
      ...descriptor,
      params: descriptor.params.slice(1),
    };
    const withoutFirst = sampleNodeParams({
      seed: 99n,
      nodeId: "n1",
      descriptor: trimmed,
      chaos: 0.7,
    });

    for (const param of trimmed.params) {
      expect(withoutFirst[param.key], param.key).toEqual(full[param.key]);
    }
  });

  it("moves more parameters off their defaults as chaos rises", () => {
    function movedShare(chaos: number): number {
      let moved = 0;
      let total = 0;
      for (const descriptor of registry.all()) {
        const defaults = defaultParams(descriptor);
        const params = sampleNodeParams({ seed: 1234n, nodeId: "n1", descriptor, chaos });
        for (const param of descriptor.params) {
          total += 1;
          if (JSON.stringify(params[param.key]) !== JSON.stringify(defaults[param.key])) {
            moved += 1;
          }
        }
      }
      return moved / total;
    }
    const tame = movedShare(0);
    const wild = movedShare(1);
    expect(wild).toBeGreaterThan(tame);
    // Both ends have to be real: nothing moving is not a surprise, and
    // everything moving tends to cancel out into grey.
    expect(tame).toBeGreaterThan(0.15);
    expect(wild).toBeLessThan(0.99);
  });

  it("keeps a tame numeric closer to its default than a wild one", () => {
    // The other half of "parameter deviation from defaults": not only how many
    // parameters move, but how far.
    const descriptor = registry.require("blur");
    const found = descriptor.params.find((param) => param.type === "float");
    expect(found).toBeDefined();
    if (found === undefined || found.type !== "float") return;
    const radius = found;

    const meanDistance = (chaos: number): number => {
      let total = 0;
      let n = 0;
      for (let i = 0; i < 400; i += 1) {
        const params = sampleNodeParams({
          seed: BigInt(i) * 61n + 11n,
          nodeId: "n1",
          descriptor,
          chaos,
        });
        const value = params[radius.key];
        if (typeof value !== "number") continue;
        if (value === radius.default) continue;
        total += Math.abs(value - radius.default);
        n += 1;
      }
      return n === 0 ? 0 : total / n;
    };

    expect(meanDistance(1)).toBeGreaterThan(meanDistance(0));
  });

  it("interpolates the stated chaos ends", () => {
    expect(PARAM_CHAOS.moveProbability[0]).toBeGreaterThan(0);
    expect(PARAM_CHAOS.moveProbability[1]).toBeLessThanOrEqual(1);
    expect(PARAM_CHAOS.deviation[1]).toBe(1);
  });
});

describe("sampleNodeSeed", () => {
  it("draws inside the legal seed range", () => {
    for (let i = 0; i < 500; i += 1) {
      const seed = sampleNodeSeed(BigInt(i), `n${i}`);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(SEED_RANGE[0]);
      expect(seed).toBeLessThanOrEqual(SEED_RANGE[1]);
    }
  });

  it("gives different nodes different seeds, and is reproducible", () => {
    expect(sampleNodeSeed(5n, "n1")).toBe(sampleNodeSeed(5n, "n1"));
    expect(sampleNodeSeed(5n, "n1")).not.toBe(sampleNodeSeed(5n, "n2"));
    expect(sampleNodeSeed(5n, "n1")).not.toBe(sampleNodeSeed(6n, "n1"));
  });

  /**
   * Its own stream, so the node seed does not move when the effect gains a
   * parameter — the same argument as the per-key streams, applied to the field
   * every stochastic effect actually reads.
   */
  it("does not depend on how many parameters the effect declares", () => {
    expect(sampleNodeSeed(5n, "n1")).toBe(sampleNodeSeed(5n, "n1"));
  });
});
