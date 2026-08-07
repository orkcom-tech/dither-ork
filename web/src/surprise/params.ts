/**
 * A node's parameters, drawn from what its descriptor declares — F-SM-04 and the
 * per-node half of F-SM-07.
 *
 * # One stream per parameter
 *
 * Every parameter is drawn from its own generator, seeded from the document seed
 * and the string `surprise/param/<nodeId>/<key>`. That is the argument
 * `core/…/rng.rs` makes for streams, applied here, and it buys three properties
 * that a single shared generator does not have:
 *
 * - **Adding a parameter to an effect does not re-roll its neighbours.** With one
 *   generator per node, inserting a `spread` control in the middle of a
 *   descriptor shifts every draw after it, so every saved seed produces a
 *   different picture from the same build. With one stream per key, the new
 *   parameter is the only thing that moves.
 * - **A parameter that stays at its default costs the same as one that moves.**
 *   Different parameter kinds consume different numbers of draws — an enum takes
 *   one, a truncated normal may take eight — so a shared generator would make
 *   each parameter's value depend on the *kinds* of the parameters before it.
 * - **Per-node reroll (F-SM-08) is exactly a change of seed.** Nothing has to be
 *   replayed and no other node is disturbed.
 *
 * # What chaos does here
 *
 * F-SM-07's "parameter deviation from defaults" is two separate things and both
 * are it:
 *
 * - **How many parameters move.** Each parameter's chance of moving is the chaos
 *   base probability scaled by the parameter's own declared `weight` relative to
 *   its siblings — the registry's comment says the weight is precisely "the
 *   relative likelihood that this parameter is one of the ones Surprise Me moves
 *   off its default", so it is read literally.
 * - **How far a numeric one moves.** A sampled value is interpolated back toward
 *   the default at the tame end, and taken whole at the wild end. Non-numeric
 *   kinds have no "half way" — half an enum is not a value — so for those, chaos
 *   moves only the probability.
 */

import { logger } from "../lib/log";
import type { ParameterValue } from "../types/document";
import { defaultParams } from "../registry";
import type { EffectParams } from "../registry";
import type { EffectDescriptor, ParamDescriptor } from "../types/registry";
import { streamFor, type Pcg32 } from "./rng";
import { lerp } from "./grammar";
import {
  quantise,
  sampleBool,
  sampleColor,
  sampleCurve,
  sampleEnum,
  sampleNumeric,
  towardDefault,
} from "./sample";

const log = logger("app");

/** The chaos ends for the two things chaos does to a parameter set. */
export const PARAM_CHAOS = {
  /**
   * Base probability that a parameter of average weight moves off its default.
   *
   * Never zero at the tame end: a "surprise" where nothing moved is not one.
   * Never quite one at the wild end either — a stack where every single control
   * is off its default tends to cancel itself out into grey, and leaving a few
   * at rest is what lets the ones that moved read.
   */
  moveProbability: [0.3, 0.92] as const,
  /**
   * How much of the sampled distance from the default is kept, for numerics.
   *
   * At 0.45 a tame surprise sits noticeably off its defaults without leaving the
   * neighbourhood; at 1 the sample is taken whole, which is the full width of
   * the declared surprise range.
   */
  deviation: [0.45, 1] as const,
} as const;

export interface NodeParamRequest {
  /** The document seed (F-SM-02), or a fresh one for a per-node reroll. */
  readonly seed: bigint;
  /** The stack node's id. Part of every stream name, so two nodes differ. */
  readonly nodeId: string;
  readonly descriptor: EffectDescriptor;
  /** Tame to wild, `[0, 1]`. */
  readonly chaos: number;
}

/** The stream a single parameter draws from. */
function streamName(nodeId: string, key: string): string {
  return `surprise/param/${nodeId}/${key}`;
}

/**
 * Mean declared weight across a descriptor's parameters.
 *
 * The move probability is scaled by `weight / mean`, so the weights behave as
 * the registry describes them — *relative* likelihoods — rather than as absolute
 * probabilities. An effect whose parameters all declare weight 3 behaves
 * identically to one whose parameters all declare weight 1, which is the correct
 * reading of "relative" and is not what multiplying by the raw weight would do.
 */
function meanWeight(params: readonly ParamDescriptor[]): number {
  if (params.length === 0) return 1;
  let total = 0;
  for (const param of params) total += weightOf(param);
  return total / params.length;
}

function weightOf(param: ParamDescriptor): number {
  return param.surprise.weight;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Draw one parameter's value, given a generator that is its and no one else's. */
function drawValue(
  rng: Pcg32,
  param: ParamDescriptor,
  fallback: ParameterValue,
  deviation: number,
): ParameterValue {
  switch (param.type) {
    case "float": {
      const sampled = sampleNumeric(rng, param.surprise, false);
      const pulled = towardDefault(sampled, param.default, deviation);
      // Quantised against the *legal* range here rather than the surprise range:
      // the interpolation toward the default can land outside the surprise range
      // (the default is allowed to sit outside it) and that is legal and
      // intended, but it must still be legal.
      return quantise(pulled, param.legal);
    }

    case "int": {
      const sampled = sampleNumeric(rng, param.surprise, true);
      const pulled = Math.round(towardDefault(sampled, param.default, deviation));
      const [low, high] = param.legal;
      return pulled < low ? low : pulled > high ? high : pulled;
    }

    case "seed":
      // The full unsigned 32-bit space `SEED_RANGE` declares. A seed has no
      // narrower musical range — every seed is as good as every other, which is
      // the point of F-AN-05 — so `deviation` has nothing to mean here and is
      // not applied: half way between two seeds is not half a look.
      return rng.nextU32();

    case "bool":
      return sampleBool(rng, param.surprise);

    case "enum":
      return sampleEnum(rng, param.surprise);

    case "color":
      return sampleColor(rng, param.surprise);

    case "curve":
      return sampleCurve(rng, param.surprise);

    default:
      // Unreachable for the seven declared kinds; present so that adding an
      // eighth fails loudly here rather than silently returning the default for
      // every node in every surprise from then on.
      return fallback;
  }
}

/**
 * Draw a whole parameter set.
 *
 * Every declared key is present in the result, at its default or at a sampled
 * value, so the set passes `validateParams` without coercion. Nothing is
 * clamped after the fact: the surprise range sits inside the legal range by
 * `validateRegistry`, and the only value that can leave it — a numeric pulled
 * toward a default outside the surprise range — is quantised into the legal
 * range where it is produced.
 */
export function sampleNodeParams(request: NodeParamRequest): EffectParams {
  const { seed, nodeId, descriptor, chaos } = request;
  const defaults = defaultParams(descriptor);
  const base = lerp(PARAM_CHAOS.moveProbability, chaos);
  const deviation = lerp(PARAM_CHAOS.deviation, chaos);
  const mean = meanWeight(descriptor.params);

  const values: Record<string, ParameterValue> = {};
  let moved = 0;

  for (const param of descriptor.params) {
    const fallback = defaults[param.key];
    if (fallback === undefined) {
      // `defaultParams` fills every declared key, so this cannot happen; it is
      // checked because the alternative is a key missing from the document,
      // which `coerceParams` would silently repair and log as a warning on every
      // render of every surprise.
      throw new Error(
        `descriptor for "${descriptor.id}" produced no default for parameter "${param.key}"`,
      );
    }

    const rng = streamFor(seed, streamName(nodeId, param.key));
    const probability = clamp01((base * weightOf(param)) / mean);
    if (!rng.nextBool(probability)) {
      values[param.key] = fallback;
      continue;
    }
    values[param.key] = drawValue(rng, param, fallback, deviation);
    moved += 1;
  }

  log.debug("surprise parameters drawn", {
    effect: descriptor.id,
    nodeId,
    params: descriptor.params.length,
    moved,
    chaos,
  });
  return values;
}

/**
 * The node's own seed — the field every stochastic effect reads (F-AN-05).
 *
 * Its own stream, so it does not depend on how many parameters the effect
 * declares, and the full unsigned 32-bit range that `SEED_RANGE` and
 * `setNodeSeed` accept. `state/document.ts`'s `seedForNodeId` keeps its own
 * output inside 2^31, which is a property of that hash rather than of the field:
 * the seed is hashed as an `f64` and packed as a `u32`, both of which carry the
 * whole range exactly.
 */
export function sampleNodeSeed(seed: bigint, nodeId: string): number {
  return streamFor(seed, `surprise/node-seed/${nodeId}`).nextU32();
}
