/**
 * F-AN-02 and F-AN-10 — a binding, resolved.
 *
 * A `Binding` in a `.dork` is four numbers and two names. This is where it
 * becomes something that can be evaluated: the target parameter is looked up in
 * the registry, the global speed and phase offset are folded into a
 * {@link ModulatorSpec}, and the parameter's own authored value is captured as
 * the base the modulator swings around.
 *
 * ## What is refused, and why refusing is the point
 *
 * A binding is checked against the effect's descriptor before anything renders,
 * and every failure below is a throw rather than a skip:
 *
 * - The node is not in the stack, or names an effect the build does not have.
 * - The parameter is not declared by the effect.
 * - The parameter declares `animatable: false`. That flag is not advisory. A
 *   `seed` is a name and not a quantity, and an `enum` reaches a shader as an
 *   ordinal — interpolating either one produces a value that means nothing, and
 *   the effect files say so at the declaration. (Animating a seed is a real
 *   thing to want; it is `temporal.ts`, which steps seeds rather than
 *   interpolating them.)
 * - Two bindings drive the same parameter. Whichever won would be an accident of
 *   iteration order, and the document would render differently from what either
 *   binding describes.
 *
 * Skipping any of these would render a picture that is not the document, which
 * is exactly what `state/render/graph.ts` refuses to do when it finds bindings
 * it cannot resolve.
 *
 * ## Modulation is around the authored value, not instead of it
 *
 * ```
 * value(frame) = clamp( base + amount * unit(frame), legal )
 * ```
 *
 * `base` is what the parameter is set to in the document, so unbinding a
 * parameter leaves it where the slider is and a bipolar modulator at amount 0 is
 * the identity. The clamp is to the parameter's **legal** range from its
 * descriptor: a modulator that swings past it would otherwise hand a shader a
 * value its uniform packer has no meaning for. Clamping is a pure function of
 * the value, so it cannot break the loop — but it does flatten the shape, so
 * `seam.ts` reports which bindings clip and by how much rather than leaving it
 * to be noticed on screen.
 */

import type { Binding, DitherDocument, StackNode } from "../types/document";
import type {
  EffectDescriptor,
  FloatParam,
  IntParam,
  ParamDescriptor,
} from "../types/registry";
import type { EffectRegistry } from "../registry/registry";
import type { LoopClock } from "./clock";
import type { CyclesPerLoop, GlobalSpeed } from "./cycles";
import { cyclesPerLoop, globalSpeed, scaleCycles } from "./cycles";
import { AnimationError } from "./errors";
import type { ModulatorSpec } from "./modulator";
import { modulatorUnit, normalisePhase } from "./modulator";
import { fold, seedFromString } from "./rng";

/** The two parameter kinds a modulator can drive. */
export type NumericParam = FloatParam | IntParam;

/**
 * F-AN-10 — the two controls that apply to every binding at once.
 *
 * `speed` is a positive integer because it multiplies each binding's
 * cycles-per-loop and F-AN-03 must survive it; the argument is in `cycles.ts`.
 * `phaseOffset` is a free real: adding a constant to every phase moves where the
 * loop starts and cannot change whether it closes.
 */
export interface GlobalTiming {
  readonly speed: GlobalSpeed;
  /** Turns, added to every binding's own phase. */
  readonly phaseOffset: number;
}

/** Speed 1, no offset: the document as written. */
export const DEFAULT_TIMING: GlobalTiming = {
  speed: globalSpeed(1),
  phaseOffset: 0,
};

/**
 * The document-level seed folded into every modulator's noise (F-AN-05).
 *
 * Zero by default, and the default is a value rather than an absence: the seed
 * that produces a document's look has to be reproducible from the saved
 * document, so a caller that supplies nothing must still get the same animation
 * every time. `.dork` has no document-seed field today, so the per-binding noise
 * seed is derived from the **target node's own seed**, which is saved — see
 * {@link bindingSeed}. This option is the place a document-level seed will be
 * threaded when the schema grows one.
 */
export const DEFAULT_DOCUMENT_SEED = 0;

/**
 * A binding that has been checked and can be evaluated.
 *
 * Holds the descriptor rather than looking it up per frame: an animated export
 * evaluates every binding on every frame, and a registry lookup per binding per
 * frame is work that has one correct answer for the whole export.
 */
export interface ResolvedBinding {
  readonly binding: Binding;
  readonly nodeId: string;
  readonly param: string;
  readonly effect: string;
  readonly descriptor: NumericParam;
  /** The value in the document — what the parameter reads when nothing is bound. */
  readonly base: number;
  readonly amount: number;
  readonly spec: ModulatorSpec;
}

/**
 * The seed for one binding's stochastic shapes.
 *
 * Folded from the target node's seed, the parameter key, the shape name and the
 * document seed, so two `smooth-noise` bindings on two parameters of one node
 * wander independently rather than in lockstep, and re-rolling a node's seed
 * re-rolls its modulator noise along with everything else stochastic about it.
 */
export function bindingSeed(
  node: StackNode,
  binding: Binding,
  documentSeed: number,
): number {
  return fold(
    documentSeed >>> 0,
    node.seed >>> 0,
    seedFromString(binding.param),
    seedFromString(binding.shape),
  );
}

function isNumericParam(param: ParamDescriptor): param is NumericParam {
  return param.type === "float" || param.type === "int";
}

function findParam(
  descriptor: EffectDescriptor,
  key: string,
): ParamDescriptor | undefined {
  return descriptor.params.find((param) => param.key === key);
}

function requireFiniteAmount(binding: Binding): number {
  if (!Number.isFinite(binding.amount)) {
    throw new AnimationError(
      "non-finite-value",
      `binding ${binding.nodeId}.${binding.param} has amount ${String(binding.amount)}; ` +
        `it must be finite`,
      { nodeId: binding.nodeId, param: binding.param, amount: String(binding.amount) },
    );
  }
  return binding.amount;
}

/**
 * The parameter's value in the document.
 *
 * A bound parameter that is missing from the node's record, or that holds
 * something that is not a number, is an error rather than a fall back to the
 * descriptor default: the default is a different picture, and quietly rendering
 * it is the failure this whole module exists to avoid.
 */
function baseValue(node: StackNode, descriptor: NumericParam): number {
  const value = node.params[descriptor.key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AnimationError(
      "non-finite-value",
      `node ${node.id} parameter "${descriptor.key}" is ${String(value)}; a bound parameter ` +
        `must hold a finite number in the document, because the modulator swings around it`,
      { nodeId: node.id, param: descriptor.key, value: String(value) },
    );
  }
  return value;
}

/**
 * Resolve every binding in a document.
 *
 * Order is the document's. Nothing is dropped and nothing is repaired.
 */
export function resolveBindings(
  document: DitherDocument,
  registry: EffectRegistry,
  timing: GlobalTiming,
  documentSeed: number = DEFAULT_DOCUMENT_SEED,
): readonly ResolvedBinding[] {
  const nodes = new Map<string, StackNode>();
  for (const node of document.stack) nodes.set(node.id, node);

  const seen = new Set<string>();
  const resolved: ResolvedBinding[] = [];

  for (const binding of document.bindings) {
    const node = nodes.get(binding.nodeId);
    if (node === undefined) {
      throw new AnimationError(
        "unknown-node",
        `binding targets node "${binding.nodeId}", which is not in the stack`,
        { nodeId: binding.nodeId, param: binding.param },
      );
    }

    const descriptor = registry.get(node.effect);
    if (descriptor === undefined) {
      throw new AnimationError(
        "unknown-effect",
        `node ${node.id} names effect "${node.effect}", which this build does not have`,
        { nodeId: node.id, effect: node.effect },
      );
    }

    const param = findParam(descriptor, binding.param);
    if (param === undefined) {
      throw new AnimationError(
        "unknown-parameter",
        `effect "${descriptor.id}" declares no parameter "${binding.param}"`,
        { nodeId: node.id, effect: descriptor.id, param: binding.param },
      );
    }
    if (!param.animatable) {
      throw new AnimationError(
        "parameter-not-animatable",
        `"${descriptor.id}.${param.key}" declares animatable: false, so a modulator may not ` +
          `drive it. A ${param.type} parameter is a name rather than a quantity — stepping it ` +
          `is temporal variation (F-AN-04), not modulation.`,
        { nodeId: node.id, effect: descriptor.id, param: param.key, type: param.type },
      );
    }
    if (!isNumericParam(param)) {
      throw new AnimationError(
        "parameter-not-numeric",
        `"${descriptor.id}.${param.key}" is a ${param.type}; only float and int parameters ` +
          `can carry a modulator`,
        { nodeId: node.id, effect: descriptor.id, param: param.key, type: param.type },
      );
    }

    const key = `${binding.nodeId}\u0000${binding.param}`;
    if (seen.has(key)) {
      throw new AnimationError(
        "duplicate-binding",
        `two bindings drive ${binding.nodeId}.${binding.param}; whichever won would be an ` +
          `accident of order, so the document is refused instead`,
        { nodeId: binding.nodeId, param: binding.param },
      );
    }
    seen.add(key);

    const own = cyclesPerLoop(
      binding.cyclesPerLoop,
      `binding ${binding.nodeId}.${binding.param} cyclesPerLoop`,
    );

    resolved.push({
      binding,
      nodeId: binding.nodeId,
      param: binding.param,
      effect: descriptor.id,
      descriptor: param,
      base: baseValue(node, param),
      amount: requireFiniteAmount(binding),
      spec: {
        shape: binding.shape,
        cycles: scaleCycles(own, timing.speed),
        phase: normalisePhase(
          binding.phase + timing.phaseOffset,
          `binding ${binding.nodeId}.${binding.param} phase`,
        ),
        bipolar: binding.bipolar,
        seed: bindingSeed(node, binding, documentSeed),
      },
    });
  }

  return resolved;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * The unclamped value a binding produces for a frame.
 *
 * Separate from {@link bindingValueAt} so `seam.ts` can measure how far a
 * binding runs past its parameter's legal range without re-deriving the swing.
 */
export function bindingRawValueAt(
  resolved: ResolvedBinding,
  clock: LoopClock,
  frame: number,
): number {
  return resolved.base + resolved.amount * modulatorUnit(resolved.spec, clock, frame);
}

/**
 * The value a binding writes into the node's parameter record for a frame.
 *
 * An `int` parameter is rounded before it is clamped, so the clamp is what
 * guarantees the legal bound rather than the rounding being trusted not to have
 * crossed it. `-0` collapses to `0`, matching `graph/hash.ts` — the two are the
 * same value and must produce the same content hash.
 */
export function bindingValueAt(
  resolved: ResolvedBinding,
  clock: LoopClock,
  frame: number,
): number {
  const raw = bindingRawValueAt(resolved, clock, frame);
  const [min, max] = resolved.descriptor.legal;
  const shaped = resolved.descriptor.type === "int" ? Math.round(raw) : raw;
  const value = clamp(shaped, min, max);
  return value === 0 ? 0 : value;
}

/**
 * The extremes a binding reaches over a whole loop, unclamped.
 *
 * Computed by walking every frame rather than by reasoning about the shape,
 * because the two stochastic shapes have no closed form and because the answer
 * has to be the one the render will actually produce. It is `O(N)` per binding
 * and is called once per plan, never per frame.
 */
export function bindingSwing(
  resolved: ResolvedBinding,
  clock: LoopClock,
): { readonly min: number; readonly max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let frame = 0; frame < clock.frames; frame += 1) {
    const value = bindingRawValueAt(resolved, clock, frame);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

export { globalSpeed, cyclesPerLoop };
export type { CyclesPerLoop, GlobalSpeed };
