/**
 * F-AN-04 — temporal variation.
 *
 * Nine ways for a dither's *pattern* to change from frame to frame, as opposed
 * to a modulator, which changes a parameter's *value*. The two are separate
 * requirements because they are separate mechanisms: a modulator interpolates a
 * number, and every effect file in this repository that declares a seed writes
 * `animatable: false` beside it with the same reason — a seed is a name, not a
 * quantity, and interpolating between two of them means nothing. Stepping
 * between them is what this file does.
 *
 * ## Periodic by construction, not by tuning
 *
 * Every mode is a pure function of `frame mod N` (see `clock.ts`), so the
 * pattern set is periodic in `frame mod N` because there is no expression in
 * here that could fail to be. Frame `N` produces the same bits as frame `0`;
 * there is nothing to check and no tolerance to pick.
 *
 * What *can* still go wrong is a seam that closes with a **visible jump**: a
 * mode that holds each pattern for `K` frames, where `K` does not divide `N`,
 * loops correctly and stutters once per loop because the last hold is short.
 * That is what `seam.ts` reports, and it is a different question from "does
 * frame N equal frame 0".
 *
 * ## Levers: what a mode is allowed to touch
 *
 * A mode does not apply to every node. `bayer-offset-scroll` needs a node that
 * *has* a tiled pattern to offset; `per-frame-reseed` needs a node whose output
 * depends on a seed. So each mode declares one of three **levers**, and
 * {@link temporalModesFor} answers, for a given effect, which modes it can
 * honestly be offered. A mode whose lever the effect does not have is refused by
 * {@link resolveVariation} rather than applied as a no-op: a reseed on a Bayer
 * tile would change the node's content hash on every frame — costing a full
 * re-render per frame — and change not one pixel, which is the worst of both.
 *
 * - `seed` — the node's `StackNode.seed` and every `seed`-typed parameter.
 *   Available when the effect declares a seed parameter, or when it is an
 *   `error-diffusion` effect: those kernels take the node seed for their
 *   threshold jitter (`core/crates/dither-core/src/diffusion.rs`,
 *   `Options::seed`).
 * - `pattern-offset` — the ordered-dither `offsetX` / `offsetY` pair, in matrix
 *   cells.
 * - `pattern-rotation` — the ordered-dither `tileRotation`, in turns.
 *
 * The three parameter keys are restated here as constants and pinned against the
 * shipped catalogue by `temporal.registry.test.ts`, so a rename in
 * `gpu/effects/ordered.ts` fails a test rather than silently emptying the list
 * of modes a node can be offered.
 *
 * ## What the offset modes do not do
 *
 * `blue-noise-cycle` cycles the *phase* of the node's one blue-noise tile
 * through a set of positions chosen so that consecutive frames land far apart in
 * the tile. It is **not** a set of independently generated blue-noise fields.
 * The tile is generated in Rust and baked into the compute pass as a table
 * binding when the effect is compiled (`gpu/effects/ordered.ts`), so a different
 * field per frame would need a per-frame table upload that the pass model does
 * not have. Cycling the phase of one tile is the technique that is actually
 * available, it is a real and long-used one, and it is described here rather
 * than left to be inferred from the name.
 */

import type { StackNode } from "../types/document";
import type { EffectDescriptor, EffectFamily, ParamDescriptor } from "../types/registry";
import type { LoopClock } from "./clock";
import { loopFrame } from "./clock";
import { positiveInteger, wholeNumber } from "./cycles";
import { AnimationError } from "./errors";
import { fract } from "./modulator";
import { seedFromString, seedValue } from "./rng";

// --- the catalogue's side of the contract ---------------------------------

/** Ordered-dither pattern offset, X axis, in matrix cells. */
export const PATTERN_OFFSET_X = "offsetX";
/** Ordered-dither pattern offset, Y axis, in matrix cells. */
export const PATTERN_OFFSET_Y = "offsetY";
/** Ordered-dither pattern rotation, in turns. */
export const PATTERN_ROTATION = "tileRotation";

/**
 * Families whose kernels take `StackNode.seed` without declaring a `seed`
 * parameter.
 *
 * One entry, and it is a fact about the Rust core rather than a guess: the
 * diffusion kernels seed their threshold jitter from `Options::seed`, which
 * `state/render/wasm-backend.ts` fills from the node's seed. Every other effect
 * that uses randomness declares a `seed` parameter, which is the general rule
 * and needs no list.
 */
export const SEEDED_FAMILIES: readonly EffectFamily[] = ["error-diffusion"];

// --- modes and levers -----------------------------------------------------

export type TemporalMode =
  | "static"
  | "per-frame-reseed"
  | "blue-noise-cycle"
  | "bayer-offset-scroll"
  | "bayer-rotation"
  | "ign-scroll"
  | "hold-k-frames"
  | "ping-pong"
  | "golden-ratio-rotation";

/** All nine, in the order F-AN-04 lists them. */
export const TEMPORAL_MODES: readonly TemporalMode[] = [
  "static",
  "per-frame-reseed",
  "blue-noise-cycle",
  "bayer-offset-scroll",
  "bayer-rotation",
  "ign-scroll",
  "hold-k-frames",
  "ping-pong",
  "golden-ratio-rotation",
];

export type TemporalLever = "seed" | "pattern-offset" | "pattern-rotation";

/** Which lever a mode drives. `static` drives none, which is what it means. */
export function temporalLever(mode: TemporalMode): TemporalLever | null {
  switch (mode) {
    case "static":
      return null;
    case "per-frame-reseed":
    case "hold-k-frames":
    case "ping-pong":
      return "seed";
    case "blue-noise-cycle":
    case "bayer-offset-scroll":
    case "ign-scroll":
      return "pattern-offset";
    case "bayer-rotation":
    case "golden-ratio-rotation":
      return "pattern-rotation";
  }
}

/**
 * Whether a mode's motion is continuous or a sequence of jumps.
 *
 * `seam.ts` needs the distinction because the two fail differently. A continuous
 * mode must arrive back at its starting value to loop smoothly, and that is a
 * property of its settings that can be checked in value space. A stepwise mode
 * jumps on every step by design, so the only question its seam raises is whether
 * every step is the same length — which is a property of its period.
 */
export function temporalContinuity(mode: TemporalMode): "continuous" | "stepwise" {
  switch (mode) {
    case "static":
    case "bayer-offset-scroll":
    case "bayer-rotation":
      return "continuous";
    case "per-frame-reseed":
    case "blue-noise-cycle":
    case "ign-scroll":
    case "hold-k-frames":
    case "ping-pong":
    case "golden-ratio-rotation":
      return "stepwise";
  }
}

function numericParam(
  descriptor: EffectDescriptor,
  key: string,
): ParamDescriptor | undefined {
  return descriptor.params.find((param) => param.key === key);
}

function isAnimatableFloat(param: ParamDescriptor | undefined): boolean {
  return param !== undefined && param.type === "float" && param.animatable;
}

/** Every `seed`-typed parameter an effect declares. */
export function seedParams(descriptor: EffectDescriptor): readonly ParamDescriptor[] {
  return descriptor.params.filter((param) => param.type === "seed");
}

/**
 * Whether an effect can honestly be given a variation that drives this lever.
 *
 * The `pattern-rotation` test includes the parameter's legal range because the
 * mode writes a rotation in turns and a turn is circular: the value is wrapped
 * into `[0, 1)`, which has to be inside what the parameter accepts or the wrap
 * would be undone by a clamp.
 */
export function supportsLever(
  descriptor: EffectDescriptor,
  lever: TemporalLever,
): boolean {
  switch (lever) {
    case "seed":
      return seedParams(descriptor).length > 0 || SEEDED_FAMILIES.includes(descriptor.family);
    case "pattern-offset":
      return (
        isAnimatableFloat(numericParam(descriptor, PATTERN_OFFSET_X)) &&
        isAnimatableFloat(numericParam(descriptor, PATTERN_OFFSET_Y))
      );
    case "pattern-rotation": {
      const param = numericParam(descriptor, PATTERN_ROTATION);
      if (!isAnimatableFloat(param) || param === undefined || param.type !== "float") {
        return false;
      }
      const [min, max] = param.legal;
      return min <= 0 && max >= 1;
    }
  }
}

/**
 * The modes an effect may be offered.
 *
 * Always includes `static`, which every node supports because it is the absence
 * of variation. The UI builds its picker from this; anything it offered beyond
 * this list would be a control wired to nothing.
 */
export function temporalModesFor(descriptor: EffectDescriptor): readonly TemporalMode[] {
  return TEMPORAL_MODES.filter((mode) => {
    const lever = temporalLever(mode);
    return lever === null || supportsLever(descriptor, lever);
  });
}

// --- the variation itself -------------------------------------------------

interface VariationBase {
  readonly nodeId: string;
}

/**
 * One node's temporal variation.
 *
 * A discriminated union rather than one record with nine optional settings, so a
 * mode carries exactly what it uses and no more: there is no way to write down a
 * `bayer-rotation` with a hold count, and no way to build a `hold-k-frames`
 * without one.
 *
 * `cellPeriod` is the node's pattern period in matrix cells — 2, 4, 8 or 16 for
 * the Bayer tiles, 64 for blue noise, the uploaded image's width for a threshold
 * map. It is supplied rather than looked up because the animation module has no
 * business knowing the size of a compute pass's table, and because supplying it
 * is what makes the seam check exact: an offset that has travelled a whole
 * number of periods is the pattern it started on, and that is a comparison of
 * two numbers rather than a guess.
 */
export type TemporalVariation =
  | (VariationBase & { readonly mode: "static" })
  | (VariationBase & { readonly mode: "per-frame-reseed" })
  | (VariationBase & {
      readonly mode: "blue-noise-cycle";
      /** Frames each position is held. Divides the frame count, or the seam stutters. */
      readonly hold: number;
      readonly cellPeriod: number;
    })
  | (VariationBase & {
      readonly mode: "bayer-offset-scroll";
      /** Matrix cells travelled over one loop, per axis. Signed; may be zero. */
      readonly cellsPerLoop: readonly [x: number, y: number];
      readonly cellPeriod: number;
    })
  | (VariationBase & {
      readonly mode: "bayer-rotation";
      /** Whole turns over one loop. Signed; an integer, so the rotation closes. */
      readonly turnsPerLoop: number;
    })
  | (VariationBase & { readonly mode: "ign-scroll"; readonly cellPeriod: number })
  | (VariationBase & { readonly mode: "hold-k-frames"; readonly hold: number })
  | (VariationBase & { readonly mode: "ping-pong"; readonly hold: number })
  | (VariationBase & { readonly mode: "golden-ratio-rotation" });

/**
 * What a variation contributes to a node on one frame.
 *
 * `null` for a lever the mode does not drive, so a caller cannot accidentally
 * write a zero offset over a value the document set.
 */
export interface TemporalState {
  /** Replaces `StackNode.seed`, and reseeds every `seed` parameter of the node. */
  readonly seed: number | null;
  /** Added to `offsetX` / `offsetY`, in matrix cells. Already inside one period. */
  readonly offset: readonly [x: number, y: number] | null;
  /** Added to `tileRotation`, in turns. Already inside `[0, 1)`. */
  readonly rotationTurns: number | null;
}

const NO_VARIATION: TemporalState = { seed: null, offset: null, rotationTurns: null };

/**
 * The golden angle, in turns: `(3 - sqrt(5)) / 2`, about 0.381966.
 *
 * Successive multiples of it are maximally spread on the circle for any prefix
 * length, which is what makes `golden-ratio-rotation` visit `N` well-separated
 * rotations rather than clumping — and it returns to zero at multiple zero, so
 * the sequence over `frame mod N` starts where it ends.
 */
export const GOLDEN_ANGLE_TURNS = (3 - Math.sqrt(5)) / 2;

/**
 * The R2 low-discrepancy sequence's two irrational increments, from the plastic
 * number `g` where `g^3 = g + 1`: `1/g` and `1/g^2`.
 *
 * The 2D analogue of the golden angle, and what `blue-noise-cycle` steps
 * through: consecutive positions land far apart in the tile, so consecutive
 * frames get patterns the eye integrates rather than reads as flicker.
 */
export const R2_ALPHA_X = 0.754_877_666_246_692_8;
export const R2_ALPHA_Y = 0.569_840_290_998_053_3;

/**
 * Per-frame advance for animated interleaved gradient noise, in cells.
 *
 * The constant from Jimenez's original presentation of the technique. Its
 * property is that successive frames land on parts of the gradient field with
 * little correlation, which is the whole point of scrolling IGN rather than
 * translating it smoothly.
 */
export const IGN_ADVANCE = 5.588_238;

/** `v mod period`, Euclidean, always in `[0, period)`. */
function wrapTo(value: number, period: number): number {
  const wrapped = value - period * Math.floor(value / period);
  return wrapped === 0 ? 0 : wrapped;
}

/** A per-mode seed, so two modes on two nodes never draw the same sequence. */
function modeSeed(variation: TemporalVariation): number {
  return seedFromString(`temporal:${variation.mode}`);
}

/**
 * The variation's contribution for one frame.
 *
 * `baseSeed` is the node's own seed from the document — the explicit seed of
 * F-AN-05. Every stochastic branch below derives from it and from the loop
 * position, and from nothing else.
 */
export function temporalStateAt(
  variation: TemporalVariation,
  clock: LoopClock,
  frame: number,
  baseSeed: number,
): TemporalState {
  const i = loopFrame(clock, frame);
  const n = clock.frames;

  switch (variation.mode) {
    case "static":
      return NO_VARIATION;

    case "per-frame-reseed":
      return {
        seed: seedValue(baseSeed >>> 0, modeSeed(variation), i),
        offset: null,
        rotationTurns: null,
      };

    case "hold-k-frames":
      return {
        seed: seedValue(baseSeed >>> 0, modeSeed(variation), Math.floor(i / variation.hold)),
        offset: null,
        rotationTurns: null,
      };

    case "ping-pong": {
      const steps = Math.ceil(n / variation.hold);
      const step = Math.floor(i / variation.hold);
      // Folds the step sequence back on itself: 0,1,2,3,2,1 for six steps. The
      // fold point is the only place the sequence reverses, and it reverses
      // rather than jumps, which is what distinguishes this from a plain cycle.
      const index = step * 2 <= steps ? step : steps - step;
      return {
        seed: seedValue(baseSeed >>> 0, modeSeed(variation), index),
        offset: null,
        rotationTurns: null,
      };
    }

    case "blue-noise-cycle": {
      const step = Math.floor(i / variation.hold);
      const period = variation.cellPeriod;
      return {
        seed: null,
        offset: [
          fract(step * R2_ALPHA_X) * period,
          fract(step * R2_ALPHA_Y) * period,
        ],
        rotationTurns: null,
      };
    }

    case "bayer-offset-scroll": {
      const [cx, cy] = variation.cellsPerLoop;
      const period = variation.cellPeriod;
      return {
        seed: null,
        offset: [wrapTo((cx * i) / n, period), wrapTo((cy * i) / n, period)],
        rotationTurns: null,
      };
    }

    case "ign-scroll": {
      // Both axes advance together, which is the published form of the
      // technique: the field is sampled along its diagonal.
      const advance = wrapTo(i * IGN_ADVANCE, variation.cellPeriod);
      return { seed: null, offset: [advance, advance], rotationTurns: null };
    }

    case "bayer-rotation":
      return {
        seed: null,
        offset: null,
        rotationTurns: fract((variation.turnsPerLoop * i) / n),
      };

    case "golden-ratio-rotation":
      return {
        seed: null,
        offset: null,
        rotationTurns: fract(i * GOLDEN_ANGLE_TURNS),
      };
  }
}

// --- validation and application -------------------------------------------

/** A variation that has been checked against its target node and the clock. */
export interface ResolvedVariation {
  readonly variation: TemporalVariation;
  readonly nodeId: string;
  readonly effect: string;
  readonly descriptor: EffectDescriptor;
  readonly lever: TemporalLever | null;
  readonly baseSeed: number;
}

function requireLegalSpan(
  descriptor: EffectDescriptor,
  key: string,
  period: number,
  nodeId: string,
): void {
  const param = descriptor.params.find((candidate) => candidate.key === key);
  if (param === undefined || param.type !== "float") {
    throw new AnimationError(
      "unsupported-lever",
      `effect "${descriptor.id}" has no float parameter "${key}" to offset`,
      { nodeId, effect: descriptor.id, param: key },
    );
  }
  const [min, max] = param.legal;
  if (max - min < period) {
    throw new AnimationError(
      "invalid-period",
      `cellPeriod ${period} does not fit "${descriptor.id}.${key}", whose legal range spans ` +
        `${max - min}; a period the parameter cannot hold would be flattened by the clamp and ` +
        `the pattern would stop moving part way through the loop`,
      { nodeId, effect: descriptor.id, param: key, period, span: max - min },
    );
  }
}

/**
 * Check one variation against its node, its effect and the clock.
 *
 * Throws on anything that would make the variation a lie — a lever the effect
 * does not have, a hold of zero, a ping-pong with nothing to pong between. It
 * does **not** throw when a hold fails to divide the frame count: that loops, it
 * only stutters, and `seam.ts` reports it as the warning it is.
 */
export function resolveVariation(
  variation: TemporalVariation,
  node: StackNode,
  descriptor: EffectDescriptor,
  clock: LoopClock,
): ResolvedVariation {
  const lever = temporalLever(variation.mode);
  if (lever !== null && !supportsLever(descriptor, lever)) {
    throw new AnimationError(
      "unsupported-lever",
      `temporal mode "${variation.mode}" drives the ${lever} of a node, and effect ` +
        `"${descriptor.id}" has none. Applying it would change the node's content hash on ` +
        `every frame — a full re-render per frame — and change no pixel.`,
      { nodeId: node.id, effect: descriptor.id, mode: variation.mode, lever },
    );
  }

  switch (variation.mode) {
    case "static":
    case "per-frame-reseed":
    case "golden-ratio-rotation":
      break;
    case "hold-k-frames":
      positiveInteger(variation.hold, `${variation.mode} hold on node ${node.id}`);
      break;
    case "ping-pong": {
      const hold = positiveInteger(variation.hold, `ping-pong hold on node ${node.id}`);
      const steps = Math.ceil(clock.frames / hold);
      if (steps < 2) {
        throw new AnimationError(
          "invalid-period",
          `ping-pong on node ${node.id} holds ${hold} frames of a ${clock.frames}-frame loop, ` +
            `which is ${steps} step(s); a ping-pong needs at least two patterns to move between`,
          { nodeId: node.id, hold, frames: clock.frames, steps },
        );
      }
      break;
    }
    case "blue-noise-cycle": {
      positiveInteger(variation.hold, `blue-noise-cycle hold on node ${node.id}`);
      const period = positiveInteger(
        variation.cellPeriod,
        `blue-noise-cycle cellPeriod on node ${node.id}`,
      );
      requireLegalSpan(descriptor, PATTERN_OFFSET_X, period, node.id);
      requireLegalSpan(descriptor, PATTERN_OFFSET_Y, period, node.id);
      break;
    }
    case "ign-scroll": {
      const period = positiveInteger(
        variation.cellPeriod,
        `ign-scroll cellPeriod on node ${node.id}`,
      );
      requireLegalSpan(descriptor, PATTERN_OFFSET_X, period, node.id);
      requireLegalSpan(descriptor, PATTERN_OFFSET_Y, period, node.id);
      break;
    }
    case "bayer-offset-scroll": {
      const period = positiveInteger(
        variation.cellPeriod,
        `bayer-offset-scroll cellPeriod on node ${node.id}`,
      );
      wholeNumber(variation.cellsPerLoop[0], `bayer-offset-scroll cellsPerLoop x on ${node.id}`);
      wholeNumber(variation.cellsPerLoop[1], `bayer-offset-scroll cellsPerLoop y on ${node.id}`);
      requireLegalSpan(descriptor, PATTERN_OFFSET_X, period, node.id);
      requireLegalSpan(descriptor, PATTERN_OFFSET_Y, period, node.id);
      break;
    }
    case "bayer-rotation":
      wholeNumber(variation.turnsPerLoop, `bayer-rotation turnsPerLoop on node ${node.id}`);
      break;
  }

  return {
    variation,
    nodeId: node.id,
    effect: descriptor.id,
    descriptor,
    lever,
    baseSeed: node.seed,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function floatLegal(
  descriptor: EffectDescriptor,
  key: string,
): readonly [number, number] {
  const param = descriptor.params.find((candidate) => candidate.key === key);
  if (param === undefined || param.type !== "float") {
    throw new AnimationError(
      "unsupported-lever",
      `effect "${descriptor.id}" has no float parameter "${key}"`,
      { effect: descriptor.id, param: key },
    );
  }
  return param.legal;
}

function numberParam(node: StackNode, key: string): number {
  const value = node.params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AnimationError(
      "non-finite-value",
      `node ${node.id} parameter "${key}" is ${String(value)}; temporal variation adds to it, ` +
        `so it must hold a finite number in the document`,
      { nodeId: node.id, param: key, value: String(value) },
    );
  }
  return value;
}

/**
 * Write a variation's contribution into a node.
 *
 * Returns a new node; nothing is mutated. Applied **after** any modulator
 * binding on the same node, so a rotation that is both modulated and varied gets
 * the variation on top of the modulated value rather than on top of the document
 * value. That order is stated here and asserted in `plan.test.ts`, because with
 * the other order the two controls would silently fight.
 *
 * The rotation is wrapped into `[0, 1)` rather than clamped, because a turn is a
 * full circle: wrapping is the exact same rotation, and clamping would stop the
 * pattern part way round. The offsets are clamped, because a matrix cell is a
 * distance and there is no equivalent identity — `resolveVariation` has already
 * refused a period the parameter cannot hold, so the clamp only bites on a
 * document whose authored offset is already at the edge of its own range.
 */
export function applyTemporalState(
  node: StackNode,
  descriptor: EffectDescriptor,
  state: TemporalState,
): StackNode {
  if (state.seed === null && state.offset === null && state.rotationTurns === null) {
    return node;
  }

  const params: Record<string, (typeof node.params)[string]> = { ...node.params };
  let seed = node.seed;

  if (state.seed !== null) {
    seed = state.seed >>> 0;
    for (const param of seedParams(descriptor)) {
      // Each seed parameter gets its own draw from the frame's seed, so a node
      // with two independent stochastic axes keeps them independent.
      params[param.key] = seedValue(seed, seedFromString(param.key));
    }
  }

  if (state.offset !== null) {
    const [ox, oy] = state.offset;
    const [xmin, xmax] = floatLegal(descriptor, PATTERN_OFFSET_X);
    const [ymin, ymax] = floatLegal(descriptor, PATTERN_OFFSET_Y);
    params[PATTERN_OFFSET_X] = clamp(numberParam(node, PATTERN_OFFSET_X) + ox, xmin, xmax);
    params[PATTERN_OFFSET_Y] = clamp(numberParam(node, PATTERN_OFFSET_Y) + oy, ymin, ymax);
  }

  if (state.rotationTurns !== null) {
    const [min, max] = floatLegal(descriptor, PATTERN_ROTATION);
    const wrapped = fract(numberParam(node, PATTERN_ROTATION) + state.rotationTurns);
    params[PATTERN_ROTATION] = clamp(wrapped, min, max);
  }

  return { ...node, seed, params };
}
