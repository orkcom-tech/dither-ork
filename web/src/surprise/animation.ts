/**
 * Random animation — F-SM-09.
 *
 * "A random subset of parameters receives modulator bindings, with
 * cycles-per-loop kept integral so F-AN-03 still holds and the loop still
 * closes."
 *
 * # What this file assumes, because the schema does not say
 *
 * The modulator core (F-AN-02) is being written in parallel and is not in this
 * build. `Binding` in `web/src/types/document.ts` fixes the *shape* — `shape`,
 * `amount`, `cyclesPerLoop`, `phase`, `bipolar` — and the loader fixes one rule,
 * that `cyclesPerLoop` is an integer. Everything else below is an assumption and
 * is written down rather than left to be discovered:
 *
 * - **`cyclesPerLoop` is a positive integer.** Not an assumption: F-AN-03 and
 *   `state/mutations.ts`'s `setBindings` both say so, and the second throws.
 *   Drawn from a weighted set that leans hard on 1 and 2, because a parameter
 *   going round eight times in a two-second loop reads as a flicker rather than
 *   as a movement.
 * - **`phase` is a fraction of one cycle, in `[0, 1)`.** The alternative
 *   readings are degrees and radians; a value in `[0, 1)` is a small offset
 *   under all three, so a wrong guess here is quiet.
 * - **`amount` is a unit fraction, drawn in `[0.08, 0.55]`.** This is the one
 *   that matters and the direction was chosen for how it fails. Read as a
 *   fraction of the parameter's range — the intended reading, and the one
 *   docs/API.md's example (`"amount": 0.25` on a parameter whose legal range is
 *   `0..1`) is consistent with — it is a modulation of between 8% and 55%. Read
 *   instead as absolute parameter units, it is the right magnitude on a
 *   normalized parameter and a very small one on a wide-range parameter such as
 *   a screen angle: a modulation too subtle to see. The opposite choice —
 *   emitting absolute units and having them read as fractions — would send a
 *   screen angle round 360 times per loop. **A quiet wrong guess beats a violent
 *   one**, so this emits the small number. When the modulator core lands this is
 *   the one line to check.
 * - **Only `float` and `int` parameters marked `animatable` are bound.** F-AN-02
 *   says "any numeric parameter"; `ParamBase.animatable` is the registry's own
 *   declaration of which ones a binding may attach to, and it is honoured rather
 *   than second-guessed. `seed` is numeric and is deliberately excluded: sliding
 *   a seed continuously between two values produces neither of the two noise
 *   fields, and F-AN-04 (temporal variation) is the mechanism for animating
 *   seeded noise.
 *
 * # Nothing here runs unless the renderer accepts bindings
 *
 * `state/render/graph.ts` currently **refuses** a document that carries
 * bindings, because resolving one needs a modulator and there is none. A
 * surprise that produced bindings today would produce a document that cannot be
 * rendered — a control that lies, which is the one outcome this project treats
 * as worse than a missing feature. So the caller passes `animate: false` until a
 * probe of the real `buildRenderGraph` says otherwise, and the UI does not offer
 * the animation lock while that is the case. See `ui/surprise/capability.ts`.
 * This module is complete and tested regardless, so the day the refusal goes the
 * feature is one probe result away.
 */

import { logger } from "../lib/log";
import type { Binding, ModulatorShape, StackNode } from "../types/document";
import type { EffectRegistry } from "../registry";
import type { ParamDescriptor, Weighted } from "../types/registry";
import { lerp } from "./grammar";
import { streamFor } from "./rng";
import { quantise, weightedChoice } from "./sample";

const log = logger("app");

export const ANIMATION_CHAOS = {
  /** Chance an eligible parameter of average weight gets bound, tame to wild. */
  bindProbability: [0.06, 0.32] as const,
} as const;

/**
 * Ceiling on how many parameters one surprise animates.
 *
 * Not taste: `graph/animate.ts` renders each frame by re-evaluating only the
 * nodes whose content hash moved, and warns when *no* node is frame-invariant
 * because that turns an N-frame export into N full renders. Every extra bound
 * node taints itself and everything downstream of it, so a stack with a binding
 * on every node is the worst case that file describes. Six is enough for a loop
 * with several things going on and short of the point where the optimisation
 * stops existing.
 */
export const MAX_BINDINGS = 6;

/**
 * Modulator shapes, weighted.
 *
 * Sine leads because a smooth loop is what most parameters want. Square and
 * stepped-random are the two that read as edits rather than as motion, so they
 * are rarer without being absent — they are the ones that make a loop look
 * deliberate when they land on the right control.
 */
const SHAPE_WEIGHTS: readonly Weighted<ModulatorShape>[] = [
  { value: "sine", weight: 1.6 },
  { value: "triangle", weight: 1 },
  { value: "smooth-noise", weight: 0.9 },
  { value: "saw", weight: 0.7 },
  { value: "stepped-random", weight: 0.5 },
  { value: "square", weight: 0.4 },
];

/**
 * Cycles per loop (F-AN-03: a positive integer, so frame N equals frame 0).
 *
 * Weighted to 1 and 2. Above about 4 the parameter is moving faster than the
 * eye separates it from the dither's own noise, and the loop reads as flicker.
 */
const CYCLE_WEIGHTS: readonly Weighted<number>[] = [
  { value: 1, weight: 3 },
  { value: 2, weight: 1.6 },
  { value: 3, weight: 0.7 },
  { value: 4, weight: 0.4 },
];

/** See the assumption note at the top of the file. */
const AMOUNT_RANGE = [0.08, 0.55] as const;

/** Chance a binding swings both ways rather than only upward. */
const BIPOLAR_PROBABILITY = 0.7;

export interface BindingRequest {
  /** The document seed (F-SM-02). */
  readonly seed: bigint;
  /** The stack the bindings attach to. Ids must be the final ones. */
  readonly stack: readonly StackNode[];
  readonly registry: EffectRegistry;
  /** Tame to wild, `[0, 1]`. */
  readonly chaos: number;
}

/** Whether a modulator may attach to this parameter. */
export function isBindable(param: ParamDescriptor): boolean {
  if (!param.animatable) return false;
  // `seed` is numeric and is not a quantity — see the note at the top.
  return param.type === "float" || param.type === "int";
}

/**
 * Draw the bindings for one surprise.
 *
 * Each candidate parameter is decided in **its own stream**, named for the node
 * and the key, for the same reason `params.ts` gives: whether one parameter is
 * animated must not depend on how many parameters the nodes before it happened
 * to declare. The cap is applied in stack order, so a stack that produces more
 * than {@link MAX_BINDINGS} candidates keeps the earlier ones and says so.
 */
export function sampleBindings(request: BindingRequest): readonly Binding[] {
  const { seed, stack, registry, chaos } = request;
  const base = lerp(ANIMATION_CHAOS.bindProbability, chaos);

  const bindings: Binding[] = [];
  let candidates = 0;
  let dropped = 0;

  for (const node of stack) {
    const descriptor = registry.get(node.effect);
    if (descriptor === undefined) {
      // A stack naming an effect this build does not have. Reported rather than
      // skipped in silence: it means the document came from elsewhere, and the
      // caller is about to try to render it.
      log.warn("no bindings drawn for a node whose effect is unknown", {
        nodeId: node.id,
        effect: node.effect,
      });
      continue;
    }

    const bindable = descriptor.params.filter(isBindable);
    if (bindable.length === 0) continue;
    const mean =
      bindable.reduce((total, param) => total + param.surprise.weight, 0) / bindable.length;

    for (const param of bindable) {
      candidates += 1;
      const rng = streamFor(seed, `surprise/bind/${node.id}/${param.key}`);
      const probability = Math.min(1, (base * param.surprise.weight) / mean);
      if (!rng.nextBool(probability)) continue;

      if (bindings.length >= MAX_BINDINGS) {
        dropped += 1;
        continue;
      }

      bindings.push({
        nodeId: node.id,
        param: param.key,
        shape: weightedChoice(rng, SHAPE_WEIGHTS),
        amount: quantise(rng.nextFloat(AMOUNT_RANGE[0], AMOUNT_RANGE[1]), [0, 1]),
        cyclesPerLoop: weightedChoice(rng, CYCLE_WEIGHTS),
        phase: quantise(rng.nextF32(), [0, 1]),
        bipolar: rng.nextBool(BIPOLAR_PROBABILITY),
      });
    }
  }

  log.info("surprise bindings drawn", {
    bindings: bindings.length,
    candidates,
    dropped,
    chaos,
  });
  return bindings;
}

/**
 * Keep only the bindings whose node is still in the stack.
 *
 * Used when the animation lock (F-SM-06) holds bindings across a stack reroll:
 * the parameters were bound to nodes that a new composition does not contain,
 * and `setBindings` throws on a binding that names a node the stack does not
 * have. Dropping them is the only coherent answer — a binding is a reference to
 * a node, not a value that can survive without one — and it is logged, because
 * "I locked animation and half of it went away" needs a reason a person can
 * find.
 */
export function retainBindings(
  bindings: readonly Binding[],
  stack: readonly StackNode[],
): readonly Binding[] {
  const ids = new Set(stack.map((node) => node.id));
  const kept = bindings.filter((binding) => ids.has(binding.nodeId));
  if (kept.length !== bindings.length) {
    log.info("locked bindings dropped: their nodes are not in the new stack", {
      was: bindings.length,
      kept: kept.length,
    });
  }
  return kept;
}
