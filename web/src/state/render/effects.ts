/**
 * From an effect id to a compiled set of compute passes.
 *
 * Three things have to happen before a parallel node can be encoded, and each
 * of them is expensive enough that doing it per frame would be visible: ask the
 * resolver what the effect needs built, build it, and compile the WGSL into a
 * pipeline. All three happen once per effect id per session and are cached
 * here — a pipeline compile is tens of milliseconds and a 64x64 blue-noise tile
 * is `O(size^4)` in the Rust core.
 *
 * ## The tile table, and why it is a table
 *
 * `GpuBuildRequirement` says an ordered dither needs a `size * size` threshold
 * tile. It does **not** say which generator produces it, and docs/API.md
 * records that as a real gap: a caller holding nothing but an effect id cannot
 * ask the core for the right tile. So this file carries the same three-line
 * table `web/test/gpu-golden/harness.ts` and `gpu/effects/` carry — blue noise
 * wants void-and-cluster, the four Bayers want Bayer — and it is written as a
 * lookup that *fails* on an unknown id rather than defaulting to Bayer, because
 * a plausible wrong tile renders a plausible wrong picture.
 *
 * The blue-noise seed is the constant the proof page and the golden harness
 * use. It has to be the same number in all three or the preview and the
 * reference set are two different dithers.
 */

import type { GpuEffect } from "../../types/gpu";
import type { EffectRegistry } from "../../registry";
import type { GpuEffectResolver } from "../../registry";
import { NO_GPU_BUILD_DATA } from "../../types/registry";
import type { PassCompiler } from "../../gpu";
import { thresholdMatrix } from "../../gpu";
import { logger } from "../../lib/log";

const log = logger("gpu");

/** The seed `web/src/main.ts` and the golden harness both use. */
export const BLUE_NOISE_SEED = 0x5eed_0d17n;

/** The two tile generators, as the Rust core exposes them. */
export interface ThresholdRankSource {
  bayerRanks(size: number): Uint32Array;
  blueNoiseRanks(size: number, seed: bigint): Uint32Array;
}

/** Which generator an effect's tile comes from. Unknown ids fail loudly. */
function ranksFor(
  effectId: string,
  size: number,
  source: ThresholdRankSource,
): Uint32Array {
  if (effectId === "blue-noise") return source.blueNoiseRanks(size, BLUE_NOISE_SEED);
  if (effectId.startsWith("bayer-")) return source.bayerRanks(size);
  throw new Error(
    `effect "${effectId}" requires a ${size}x${size} threshold tile and nothing here knows ` +
      `which generator produces it. Add it to the table in state/render/effects.ts — ` +
      `defaulting to Bayer would render a plausible wrong picture.`,
  );
}

export interface GpuEffectCacheDeps {
  readonly registry: EffectRegistry;
  readonly resolver: GpuEffectResolver;
  readonly compiler: PassCompiler;
  readonly ranks: ThresholdRankSource;
}

export class GpuEffectCache {
  readonly #deps: GpuEffectCacheDeps;
  readonly #effects = new Map<string, GpuEffect>();
  /** In flight, so two nodes of the same effect in one batch compile once. */
  readonly #pending = new Map<string, Promise<GpuEffect>>();

  constructor(deps: GpuEffectCacheDeps) {
    this.#deps = deps;
  }

  get size(): number {
    return this.#effects.size;
  }

  /** The compiled effect, compiling it if this is the first time it is asked for. */
  async effectFor(effectId: string): Promise<GpuEffect> {
    const ready = this.#effects.get(effectId);
    if (ready !== undefined) return ready;

    const pending = this.#pending.get(effectId);
    if (pending !== undefined) return pending;

    const build = this.#build(effectId);
    this.#pending.set(effectId, build);
    try {
      const effect = await build;
      this.#effects.set(effectId, effect);
      return effect;
    } finally {
      this.#pending.delete(effectId);
    }
  }

  async #build(effectId: string): Promise<GpuEffect> {
    const descriptor = this.#deps.registry.require(effectId);
    const requirement = this.#deps.resolver.requirementOf(effectId);

    const started = performance.now();
    const effect =
      requirement.kind === "none"
        ? this.#deps.resolver.resolve(effectId, NO_GPU_BUILD_DATA)
        : this.#deps.resolver.resolve(effectId, {
            kind: "threshold-matrix",
            matrix: thresholdMatrix(
              effectId,
              requirement.size,
              ranksFor(effectId, requirement.size, this.#deps.ranks),
            ),
          });

    await this.#deps.compiler.compile(descriptor, effect);
    log.info("effect compiled", {
      effect: effectId,
      passes: effect.passes.length,
      requires: requirement.kind,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });
    return effect;
  }
}
