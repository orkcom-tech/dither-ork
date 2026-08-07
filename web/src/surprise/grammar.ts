/**
 * The stack grammar — F-SM-03.
 *
 * "The stack is built to a grammar, not sampled uniformly: an optional
 * preprocessing chain, then exactly one primary dither node, then an optional
 * post-processing and glitch chain. Mutually incompatible combinations are
 * excluded by the grammar rather than filtered after the fact."
 *
 * The distinction in that last sentence is the whole design of this file.
 * Filtering after the fact means generating a stack, asking `validateStack`
 * whether it is legal, and drawing again if it is not — which is a rejection
 * loop whose termination depends on how much of the catalogue happens to be
 * illegal today, and which quietly biases the result toward whatever combination
 * survives. Excluding by the grammar means **the candidate pool at each step is
 * computed from the state the stack is in at that step**, so an illegal choice is
 * never available to be made.
 *
 * The state is exactly what `registry/stack.ts` walks: which effects are already
 * in the stack (for `excludes`), and whether an index map is live (for
 * `requiresIndexMap` and for the extent rule). It is re-derived here from the
 * same descriptor fields rather than imported, because this walks a stack it is
 * *building* and that one walks a stack that already exists — but the rules are
 * read off the same three declarations, and {@link composeStack} asserts its own
 * output against `validateStack` before returning it. That assertion is not a
 * filter: it never draws again, it throws. A grammar that can emit an illegal
 * stack is a defect, and a defect should stop rather than be retried around.
 *
 * ## Why exactly one dither
 *
 * Two dithers in a row is not illegal — the second quantizes the first's output
 * and `validateStack` accepts it — and it is also almost always mud. The
 * grammar's job is to make the *usable* results likely, which is the same
 * argument that gives every parameter a surprise range narrower than its legal
 * one (F-SM-04). One dither is the shape of the thing being generated.
 *
 * ## Why no effect appears twice
 *
 * F-ST-07 allows any node any number of times, so this is a taste decision
 * rather than a legality one, and it is stated here so it can be found: two
 * copies of the same glitch at different parameters read as one glitch that did
 * not quite work, and they crowd out the twenty other effects that would have
 * made the stack interesting.
 */

import { logger } from "../lib/log";
import type { NodeSlot } from "../types/document";
import type { EffectRegistry } from "../registry";
import { validateStack } from "../registry";
import type { EffectDescriptor } from "../types/registry";
import type { Weighted } from "../types/registry";
import type { Pcg32 } from "./rng";
import { weightedChoice } from "./sample";

const log = logger("app");

export class GrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrammarError";
  }
}

/**
 * How much of the catalogue a chaos setting reaches.
 *
 * F-SM-07 names three things the slider controls, and two of them are here:
 * node count and the probability of glitch nodes appearing. The third,
 * parameter deviation, is in `params.ts`.
 *
 * The numbers are the tame and wild ends of each; everything between is a
 * straight interpolation. They are constants in one block rather than literals
 * scattered through the code, because they are the feature's taste and somebody
 * will want to argue with them.
 */
export const CHAOS = {
  /** Most preprocessing nodes at chaos 0 and at chaos 1. */
  preprocessCeiling: [1, 4] as const,
  /** Most postprocessing nodes at chaos 0 and at chaos 1. */
  postprocessCeiling: [1, 5] as const,
  /**
   * Multiplier on a glitch-family effect's declared `surpriseWeight`.
   *
   * Below 1 at the tame end, so a glitch is a rare seasoning; well above it at
   * the wild end, so the postprocess chain becomes mostly glitch. It multiplies
   * the descriptor's own weight rather than replacing it, so a niche glitch
   * stays niche relative to a signature one at every setting.
   */
  glitchWeight: [0.35, 2.5] as const,
} as const;

export function lerp(range: readonly [number, number], t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return range[0] + (range[1] - range[0]) * clamped;
}

export interface StackGrammarOptions {
  readonly registry: EffectRegistry;
  /** Tame to wild, `[0, 1]` (F-SM-07). */
  readonly chaos: number;
}

/** The composition: effect ids in stack order, and what the grammar decided. */
export interface ComposedStack {
  readonly effects: readonly string[];
  readonly preprocess: number;
  readonly dither: string;
  readonly postprocess: number;
  /** True when the chosen dither emits an index map, so consumers were eligible. */
  readonly indexMapLive: boolean;
}

/** What the walk knows at each step. The same three facts `validateStack` uses. */
interface GrammarState {
  readonly chosen: readonly EffectDescriptor[];
  readonly indexMapLive: boolean;
}

/**
 * Whether `candidate` may be placed given what is already in the stack.
 *
 * Every clause reads one declared field, and each one is the grammar's copy of a
 * rule `registry/stack.ts` states in prose:
 *
 * - `requiresIndexMap` — outline, dilate/erode and nearest upscale read the
 *   index map, so they are only in the pool while one is live. That is what
 *   keeps a stack whose dither is CMYK halftone (the one dither-slot node that
 *   emits no map) from ever being offered an outline.
 * - `resamples` while a map is live — palette indices are names, not
 *   quantities, so no filter means anything applied to them. A resampler that
 *   does not carry the map across would leave colours and indices naming
 *   different pixel grids.
 * - `excludes` — checked in both directions, because either descriptor may be
 *   the one that names the conflict.
 */
function eligible(candidate: EffectDescriptor, state: GrammarState): boolean {
  if (state.chosen.some((chosen) => chosen.id === candidate.id)) return false;

  if (candidate.requiresIndexMap && !state.indexMapLive) return false;
  if (candidate.resamples === true && state.indexMapLive && !candidate.producesIndexMap) {
    return false;
  }

  for (const chosen of state.chosen) {
    if ((candidate.excludes ?? []).includes(chosen.id)) return false;
    if ((chosen.excludes ?? []).includes(candidate.id)) return false;
  }
  return true;
}

/**
 * The state after placing `descriptor`, by the same transition
 * `registry/stack.ts` walks.
 *
 * A dither-slot node **replaces** the live map rather than adding to it:
 * quantizing is what the slot is for, so whatever indices arrived at it no
 * longer describe the pixels leaving it. That is why CMYK halftone clears the
 * map rather than passing one through.
 */
function advance(state: GrammarState, descriptor: EffectDescriptor): GrammarState {
  const chosen = [...state.chosen, descriptor];
  if (descriptor.slot === "dither") {
    return { chosen, indexMapLive: descriptor.producesIndexMap };
  }
  return {
    chosen,
    indexMapLive: state.indexMapLive || descriptor.producesIndexMap,
  };
}

/** The weight an effect carries in this draw, after the chaos adjustment. */
function weightOf(descriptor: EffectDescriptor, chaos: number): number {
  const glitch = descriptor.family === "glitch" ? lerp(CHAOS.glitchWeight, chaos) : 1;
  return descriptor.surpriseWeight * glitch;
}

function poolFor(
  registry: EffectRegistry,
  slot: NodeSlot,
  state: GrammarState,
  chaos: number,
): readonly Weighted<EffectDescriptor>[] {
  return registry
    .bySlot(slot)
    .filter((descriptor) => eligible(descriptor, state))
    .map((descriptor) => ({ value: descriptor, weight: weightOf(descriptor, chaos) }));
}

/**
 * Build a stack.
 *
 * The draw order is fixed and is part of what a seed means: counts, then the
 * dither, then the preprocess chain, then the postprocess chain. The dither
 * comes before the chains because it is what decides whether an index map is
 * live, and therefore what the postprocess pool contains — computing the pool
 * from a decision not yet made is the "filter afterwards" this file exists to
 * avoid.
 *
 * @throws GrammarError when the catalogue cannot satisfy the grammar at all —
 * no dither-slot effect, or a composed stack that `validateStack` rejects. Both
 * are build defects and both stop rather than being drawn around.
 */
export function composeStack(rng: Pcg32, options: StackGrammarOptions): ComposedStack {
  const { registry, chaos } = options;

  // Counts first, so the same seed asks for the same shape whatever the
  // catalogue happens to contain. Each is drawn from `0..=ceiling`, so "no
  // preprocessing at all" stays a real outcome at every chaos setting — a bare
  // dither is a legitimate look and the tame end should reach it.
  const preWanted = rng.nextBelow(Math.round(lerp(CHAOS.preprocessCeiling, chaos)) + 1);
  const postWanted = rng.nextBelow(Math.round(lerp(CHAOS.postprocessCeiling, chaos)) + 1);

  const ditherPool = poolFor(registry, "dither", { chosen: [], indexMapLive: false }, chaos);
  if (ditherPool.length === 0) {
    throw new GrammarError(
      "the catalogue has no dither-slot effect; a surprise is exactly one primary dither and cannot be built without one",
    );
  }
  const dither = weightedChoice(rng, ditherPool);

  // The preprocess chain is drawn against a state that already contains the
  // dither, so `excludes` between a preprocess node and the chosen dither is
  // honoured — but with `indexMapLive` false, because nothing has quantized yet
  // at the point these nodes run. Position in the stack, not order of drawing,
  // is what the index-map rules are about.
  let preState: GrammarState = { chosen: [dither], indexMapLive: false };
  const preprocess: EffectDescriptor[] = [];
  for (let i = 0; i < preWanted; i += 1) {
    const pool = poolFor(registry, "preprocess", preState, chaos);
    if (pool.length === 0) break;
    const picked = weightedChoice(rng, pool);
    preprocess.push(picked);
    preState = advance(preState, picked);
  }

  // Now walk forward properly: everything chosen so far, with the map that the
  // dither actually leaves behind.
  let postState: GrammarState = {
    chosen: [...preprocess, dither],
    indexMapLive: dither.producesIndexMap,
  };
  const postprocess: EffectDescriptor[] = [];
  for (let i = 0; i < postWanted; i += 1) {
    const pool = poolFor(registry, "postprocess", postState, chaos);
    if (pool.length === 0) break;
    const picked = weightedChoice(rng, pool);
    postprocess.push(picked);
    postState = advance(postState, picked);
  }

  const effects = [...preprocess.map((d) => d.id), dither.id, ...postprocess.map((d) => d.id)];

  // The self-check. Not a filter: a stack the grammar built and validation
  // rejects is a defect in this file, and it stops here rather than reaching a
  // user as an error banner over a picture that will not render.
  const verdict = validateStack(
    registry,
    effects.map((effect, index) => ({ id: `g${index}`, effect, enabled: true })),
  );
  if (!verdict.ok) {
    throw new GrammarError(
      `the surprise grammar produced a stack the registry rejects: ${verdict.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  log.debug("surprise stack composed", {
    effects: effects.length,
    preprocess: preprocess.length,
    dither: dither.id,
    postprocess: postprocess.length,
    indexMapLive: dither.producesIndexMap,
    chaos,
    // Stated when the pool ran dry before the count was met, so a stack that is
    // shorter than the chaos setting asked for has a visible reason.
    preShort: preprocess.length < preWanted,
    postShort: postprocess.length < postWanted,
  });

  return {
    effects,
    preprocess: preprocess.length,
    dither: dither.id,
    postprocess: postprocess.length,
    indexMapLive: dither.producesIndexMap,
  };
}
