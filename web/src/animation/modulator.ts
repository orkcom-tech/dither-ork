/**
 * F-AN-02 — the modulators.
 *
 * Six shapes, one phase, one output convention. A modulator is a pure function
 * from a frame index to a number in `[-1, 1]` (bipolar) or `[0, 1]` (unipolar);
 * `binding.ts` is what turns that into a parameter value.
 *
 * ## Phase
 *
 * ```
 * theta(frame) = frac( cycles * (frame mod N) / N + phase )
 * ```
 *
 * Three properties of that expression are deliberate and each is load-bearing:
 *
 * - **`frame mod N`, not `frame`.** Every value is a pure function of the
 *   position in the loop, so frame `N` produces the same bits as frame `0` — not
 *   a value within a tolerance of it, the same bits. See `clock.ts`.
 * - **Computed, not accumulated.** Adding `cycles / N` to a float once per frame
 *   drifts; the phase at the seam would differ from the starting phase in the
 *   last few bits, and a content hash notices what an eye cannot. The integer
 *   product `cycles * (frame mod N)` is exact (`cycles.ts` bounds it for that
 *   reason), so the same frame always yields the same phase.
 * - **`cycles` is an integer by type** (F-AN-03). It is what makes the *unwrapped*
 *   extension periodic too, which is what `seam.ts` measures: `frac(cycles * 1 +
 *   phase)` is `frac(phase)` for integer `cycles` and is not for any other value.
 *
 * `phase` is normalised to `[0, 1)` when the spec is built rather than carried
 * raw, because `frac` of a large float has already lost the bits that matter.
 *
 * ## Periodicity of the two stochastic shapes
 *
 * `smooth-noise` and `stepped-random` are not "noise over time" in the usual
 * sense — that would never close a loop. Both are defined on a **ring**: a fixed
 * number of lattice points around the unit circle, indexed modulo that count, so
 * the sequence is periodic in the phase and therefore periodic in `frame mod N`.
 * Smooth noise interpolates between neighbouring lattice values with a
 * smoothstep, whose derivative is zero at both ends, so the result is C1 across
 * every lattice point including the one at the seam. Stepped random holds each
 * lattice value for its whole step.
 *
 * Their draws come from `rng.ts` — stateless, seeded, integer-exact — so a
 * modulator's noise reproduces byte for byte on every platform. The one thing in
 * this file that does not is `Math.sin`, which no engine is required to round
 * correctly; that is the same platform caveat the colour transforms already
 * carry (docs/ARCHITECTURE.md, "Determinism") and it is why the seam check
 * compares **phases** rather than shape outputs.
 */

import type { ModulatorShape } from "../types/document";
import type { LoopClock } from "./clock";
import { loopFrame } from "./clock";
import type { CyclesPerLoop } from "./cycles";
import { AnimationError } from "./errors";
import { bipolarFrom, fold } from "./rng";

const TAU = Math.PI * 2;

/**
 * Lattice points per cycle for `smooth-noise`.
 *
 * Eight is the count at which one cycle reads as a wandering line rather than as
 * a lumpy sine (too few) or as texture (too many). It is fixed rather than
 * exposed because the control that varies the rate already exists — it is
 * `cyclesPerLoop`, and a second one would be the same knob under a second name.
 */
export const SMOOTH_NOISE_LATTICE = 8;

/** Steps per cycle for `stepped-random`. Fixed for the same reason. */
export const STEPPED_RANDOM_STEPS = 16;

/** Every shape, in the order F-AN-02 lists them. */
export const MODULATOR_SHAPES: readonly ModulatorShape[] = [
  "sine",
  "triangle",
  "saw",
  "square",
  "smooth-noise",
  "stepped-random",
];

/**
 * A modulator, with the global speed and phase offset (F-AN-10) already folded
 * in.
 *
 * Folded in at plan time rather than passed to every evaluation, so there is
 * exactly one place that knows how the global controls combine with a binding's
 * own — and so the seam validator measures the numbers that will actually be
 * rendered rather than the ones the document wrote down.
 */
export interface ModulatorSpec {
  readonly shape: ModulatorShape;
  readonly cycles: CyclesPerLoop;
  /** Turns, normalised to `[0, 1)`. */
  readonly phase: number;
  /** `false` gives `[0, 1]`; `true` gives `[-1, 1]` about the parameter's own value. */
  readonly bipolar: boolean;
  /** Explicit seed for the two stochastic shapes (F-AN-05). */
  readonly seed: number;
}

/** `x - floor(x)`, always in `[0, 1)` including for negative inputs. */
export function fract(value: number): number {
  const result = value - Math.floor(value);
  // -0 collapses to 0: the two are the same phase and must hash the same, for
  // the reason `graph/hash.ts` gives about -0 in parameter values.
  return result === 0 ? 0 : result;
}

/**
 * Normalise a phase in turns to `[0, 1)`.
 *
 * Rejects non-finite input rather than passing NaN into a shape, where it would
 * become a NaN parameter and be caught much further away by the content hasher.
 */
export function normalisePhase(phase: number, what = "phase"): number {
  if (!Number.isFinite(phase)) {
    throw new AnimationError(
      "non-finite-value",
      `${what} is ${String(phase)}; a phase must be a finite number of turns`,
      { value: String(phase) },
    );
  }
  return fract(phase);
}

/**
 * Phase for a frame, in `[0, 1)`.
 *
 * The canonical entry point, and a pure function of `frame mod N`.
 */
export function modulatorPhase(
  spec: ModulatorSpec,
  clock: LoopClock,
  frame: number,
): number {
  return fract((spec.cycles * loopFrame(clock, frame)) / clock.frames + spec.phase);
}

/**
 * Phase for a frame **without** wrapping the frame index into the loop.
 *
 * This exists for exactly one caller: `seam.ts`, which asks what the modulator
 * would do at frame `N` if the loop did not wrap, and compares that against
 * frame `0`. Evaluating the wrapped phase at frame `N` would answer the question
 * by construction and check nothing; evaluating the unwrapped extension is what
 * makes the seam report a measurement rather than a restatement of the design.
 *
 * Nothing else may call it. A render that used it would drift out of the loop.
 */
export function unwrappedPhase(
  spec: ModulatorSpec,
  clock: LoopClock,
  frame: number,
): number {
  return fract((spec.cycles * frame) / clock.frames + spec.phase);
}

/**
 * The shape's own output at a phase, in `[-1, 1]`.
 *
 * All six are phased so that a rising zero crossing sits at `theta = 0` where
 * the shape has one, which is what lets a phase control mean the same thing
 * across shapes. The two that do not — `saw`, whose only feature is its jump,
 * and `square`, whose only feature is its edge — put that feature at `theta = 0`
 * instead, so that with `cyclesPerLoop = 1` the discontinuity lands exactly on
 * the loop seam and is therefore invisible.
 */
export function shapeAt(shape: ModulatorShape, phase: number, seed: number): number {
  const theta = fract(phase);
  switch (shape) {
    case "sine":
      return Math.sin(TAU * theta);
    case "triangle": {
      // Rises 0 -> 1 over [0, 1/4), falls 1 -> -1 over [1/4, 3/4), rises -1 -> 0
      // over [3/4, 1). Same phase as the sine, with straight segments.
      const q = theta * 4;
      if (theta < 0.25) return q;
      if (theta < 0.75) return 2 - q;
      return q - 4;
    }
    case "saw":
      return theta * 2 - 1;
    case "square":
      return theta < 0.5 ? 1 : -1;
    case "smooth-noise":
      return smoothNoise(theta, seed);
    case "stepped-random":
      return steppedRandom(theta, seed);
  }
}

/**
 * Value noise on a ring of {@link SMOOTH_NOISE_LATTICE} points.
 *
 * The ring is what makes it loop: lattice index `L` is lattice index `0`, so the
 * interpolation across the seam is the same interpolation as anywhere else. The
 * smoothstep gives zero derivative at every lattice point, so the result has no
 * corner at the join either.
 */
function smoothNoise(theta: number, seed: number): number {
  const lattice = SMOOTH_NOISE_LATTICE;
  const position = theta * lattice;
  const index = Math.floor(position);
  const f = position - index;
  const a = bipolarFrom(fold(seed, index % lattice));
  const b = bipolarFrom(fold(seed, (index + 1) % lattice));
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/** Sample and hold over {@link STEPPED_RANDOM_STEPS} steps per cycle. */
function steppedRandom(theta: number, seed: number): number {
  const steps = STEPPED_RANDOM_STEPS;
  // `theta` is already in [0, 1), so the floor cannot reach `steps`; the min is
  // belt and braces against a caller that hands in exactly 1 through `fract` of
  // a value that rounded up.
  const index = Math.min(steps - 1, Math.floor(theta * steps));
  return bipolarFrom(fold(seed, index));
}

/**
 * The modulator's unit output for a frame.
 *
 * `[-1, 1]` when bipolar, `[0, 1]` when not. Unipolar is the bipolar output
 * mapped, not a different shape, so switching the toggle changes the range and
 * nothing else about the motion.
 */
export function modulatorUnit(
  spec: ModulatorSpec,
  clock: LoopClock,
  frame: number,
): number {
  const bipolar = shapeAt(spec.shape, modulatorPhase(spec, clock, frame), spec.seed);
  return spec.bipolar ? bipolar : (bipolar + 1) / 2;
}

/**
 * How many features the shape has per cycle — extrema, edges or steps.
 *
 * Used only by the seam report's Nyquist check. A shape sampled fewer than twice
 * per feature does not render the shape; it renders an alias of it, and the
 * result is a document that loops correctly and does not look like what the
 * modulator says it is.
 */
export function featuresPerCycle(shape: ModulatorShape): number {
  switch (shape) {
    case "sine":
    case "triangle":
      return 2;
    case "saw":
      return 1;
    case "square":
      return 2;
    case "smooth-noise":
      return SMOOTH_NOISE_LATTICE;
    case "stepped-random":
      return STEPPED_RANDOM_STEPS;
  }
}

/** Features over one whole loop. */
export function featuresPerLoop(spec: ModulatorSpec): number {
  return featuresPerCycle(spec.shape) * spec.cycles;
}
