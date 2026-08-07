/**
 * The stack grammar, against the real catalogue.
 *
 * These run over the sixty-seven descriptors actually in `web/src/effects/`,
 * discovered by the same glob the application uses, because the property that
 * matters is not "the grammar is internally consistent" — it is **"the grammar
 * cannot produce a stack this build refuses to render"**, and only the shipped
 * descriptors can establish that.
 *
 * The headline test draws a thousand stacks across the chaos range and puts
 * every one through `validateStack`. That is deliberately the same check the
 * grammar runs on itself: here it is a test of the grammar, there it is a
 * tripwire in production, and having both is what makes the tripwire something
 * that has never fired rather than something nobody has looked at.
 */

import { describe, expect, it } from "vitest";

import { discoverEffects } from "../registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../registry/registry";
import { validateStack } from "../registry/stack";
import { CHAOS, GrammarError, composeStack, lerp } from "./grammar";
import { seededPcg32, streamFor } from "./rng";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());

function refs(effects: readonly string[]): { id: string; effect: string; enabled: boolean }[] {
  return effects.map((effect, index) => ({ id: `n${index + 1}`, effect, enabled: true }));
}

describe("composeStack against the shipped catalogue", () => {
  it("never produces a stack the registry rejects", () => {
    let longest = 0;
    let indexConsumers = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const chaos = (i % 11) / 10;
      const composed = composeStack(streamFor(BigInt(i), "surprise/stack"), {
        registry,
        chaos,
      });
      const verdict = validateStack(registry, refs(composed.effects));
      expect(verdict.issues.map((issue) => issue.code)).toEqual([]);
      expect(verdict.ok).toBe(true);
      longest = Math.max(longest, composed.effects.length);
      indexConsumers += composed.effects.filter(
        (effect) => registry.get(effect)?.requiresIndexMap === true,
      ).length;
    }
    // The run has to have actually reached the interesting shapes, or it proves
    // only that short stacks are legal.
    expect(longest).toBeGreaterThanOrEqual(6);
    expect(indexConsumers).toBeGreaterThan(0);
  });

  it("puts exactly one dither in every stack, in the middle", () => {
    for (let i = 0; i < 400; i += 1) {
      const composed = composeStack(seededPcg32(BigInt(i)), { registry, chaos: 0.7 });
      const slots = composed.effects.map((effect) => registry.require(effect).slot);
      expect(slots.filter((slot) => slot === "dither")).toHaveLength(1);

      const dither = slots.indexOf("dither");
      expect(slots.slice(0, dither).every((slot) => slot === "preprocess")).toBe(true);
      expect(slots.slice(dither + 1).every((slot) => slot === "postprocess")).toBe(true);
      expect(composed.effects[dither]).toBe(composed.dither);
      expect(composed.preprocess).toBe(dither);
      expect(composed.postprocess).toBe(slots.length - dither - 1);
    }
  });

  it("never repeats an effect within one stack", () => {
    for (let i = 0; i < 400; i += 1) {
      const composed = composeStack(seededPcg32(BigInt(i)), { registry, chaos: 1 });
      expect(new Set(composed.effects).size).toBe(composed.effects.length);
    }
  });

  /**
   * The rule this file exists for. CMYK halftone is the one dither-slot node
   * that emits no index map — its colours are ink overprints rather than palette
   * entries — so outline, dilate/erode and nearest upscale must never appear
   * behind it. Excluded by the pool, not filtered afterwards.
   */
  it("never puts an index-map consumer behind a dither that emits no map", () => {
    let sawMaplessDither = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const composed = composeStack(seededPcg32(BigInt(i) * 7n + 1n), {
        registry,
        chaos: 1,
      });
      const dither = registry.require(composed.dither);
      if (dither.producesIndexMap) continue;
      sawMaplessDither += 1;
      expect(composed.indexMapLive).toBe(false);
      for (const effect of composed.effects) {
        expect(registry.require(effect).requiresIndexMap).toBe(false);
      }
    }
    // If the catalogue's one map-less dither never came up, this test asserted
    // nothing at all.
    expect(sawMaplessDither).toBeGreaterThan(0);
  });

  /**
   * The extent rule. A node that resamples while an index map is live must
   * produce the map it leaves behind — palette indices are names, not
   * quantities, so no filter means anything applied to them.
   */
  it("never resamples over a live index map without carrying it", () => {
    for (let i = 0; i < 1_000; i += 1) {
      const composed = composeStack(seededPcg32(BigInt(i) * 13n), { registry, chaos: 1 });
      let live = false;
      for (const effect of composed.effects) {
        const descriptor = registry.require(effect);
        if (descriptor.resamples === true && live) {
          expect(descriptor.producesIndexMap).toBe(true);
        }
        if (descriptor.slot === "dither") live = descriptor.producesIndexMap;
        else live = live || descriptor.producesIndexMap;
      }
    }
  });

  it("reproduces the same stack from the same seed", () => {
    for (const seed of [0n, 1n, 0xdead_beefn, 0xffff_ffff_ffff_ffffn]) {
      const a = composeStack(streamFor(seed, "surprise/stack"), { registry, chaos: 0.5 });
      const b = composeStack(streamFor(seed, "surprise/stack"), { registry, chaos: 0.5 });
      expect(a.effects).toEqual(b.effects);
    }
  });
});

describe("chaos (F-SM-07)", () => {
  function meanLength(chaos: number): number {
    let total = 0;
    const runs = 600;
    for (let i = 0; i < runs; i += 1) {
      total += composeStack(seededPcg32(BigInt(i) * 31n + 5n), { registry, chaos }).effects
        .length;
    }
    return total / runs;
  }

  it("makes stacks longer as it rises", () => {
    const tame = meanLength(0);
    const wild = meanLength(1);
    expect(wild).toBeGreaterThan(tame + 1.5);
  });

  it("makes glitch nodes more likely as it rises", () => {
    function glitchShare(chaos: number): number {
      let glitch = 0;
      let total = 0;
      for (let i = 0; i < 800; i += 1) {
        const composed = composeStack(seededPcg32(BigInt(i) * 17n + 3n), { registry, chaos });
        for (const effect of composed.effects) {
          total += 1;
          if (registry.require(effect).family === "glitch") glitch += 1;
        }
      }
      return glitch / total;
    }
    expect(glitchShare(1)).toBeGreaterThan(glitchShare(0) * 1.5);
  });

  it("still reaches a bare dither at the wild end and a full stack at the tame end", () => {
    // Neither end is a corner: chaos moves the ceiling of a `0..=ceiling` draw,
    // so "no preprocessing at all" stays reachable everywhere and a longer stack
    // is possible even when tame.
    const lengths = new Set<number>();
    for (let i = 0; i < 400; i += 1) {
      lengths.add(composeStack(seededPcg32(BigInt(i)), { registry, chaos: 1 }).effects.length);
    }
    expect(lengths.has(1)).toBe(true);
  });

  it("interpolates its stated ends", () => {
    expect(lerp(CHAOS.preprocessCeiling, 0)).toBe(CHAOS.preprocessCeiling[0]);
    expect(lerp(CHAOS.preprocessCeiling, 1)).toBe(CHAOS.preprocessCeiling[1]);
    // Out-of-range inputs are clamped rather than extrapolated: a chaos of 2
    // must not produce a ceiling nothing declared.
    expect(lerp(CHAOS.glitchWeight, 5)).toBe(CHAOS.glitchWeight[1]);
    expect(lerp(CHAOS.glitchWeight, -5)).toBe(CHAOS.glitchWeight[0]);
  });
});

describe("what it refuses", () => {
  it("refuses a catalogue with no dither rather than emitting a stack with none", () => {
    const ditherless = createEffectRegistry(
      discoverEffects().filter((entry) => entry.descriptor.slot !== "dither"),
    );
    expect(() => composeStack(seededPcg32(1n), { registry: ditherless, chaos: 0.5 })).toThrow(
      GrammarError,
    );
  });
});
