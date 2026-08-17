/**
 * The animation core (F-AN-01 … F-AN-06, F-AN-10).
 *
 * A document plus a frame index becomes a document with every bound parameter
 * resolved to a concrete number. That is the whole of it, and everything else
 * here is the guarantee that comes with it: **the loop closes**.
 *
 * ```ts
 * const plan = planAnimation(document, registry, { timing, variations });
 *
 * const seam = validateLoopSeam(plan, { hashForFrame });
 * if (!seam.ok) return seam;                       // F-AN-06, before exporting
 *
 * const graphForFrame = (frame: number) =>
 *   buildRenderGraph(documentAtFrame(plan, frame), { width, height, quality, frame, solo });
 * await renderAnimation({ frames: plan.clock.frames, graphForFrame, source, palette, onFrame }, deps);
 * ```
 *
 * Nothing in here renders, touches a device or knows a browser exists. It has
 * one dependency outside itself and `types/` — the effect registry, read
 * type-only, because a modulator must not be attached to a parameter the
 * catalogue says is not animatable.
 *
 * ## The three properties everything else follows from
 *
 * - **Every animated value is a pure function of `frame mod N`** (`clock.ts`).
 *   Frame `N` is therefore frame `0` — the same bits, not a value within a
 *   tolerance — so periodicity is structural.
 * - **Cycles per loop is a positive integer in the type** (`cycles.ts`). It
 *   cannot be produced except through a constructor that refuses anything else,
 *   so a modulator that would not close cannot be built without a visible cast.
 * - **Nothing reads a clock or an unseeded generator** (`rng.ts`). Every draw is
 *   a pure function of an explicit seed and an explicit index, which is what
 *   makes scrubbing, caching and re-rendering give the same answer.
 *
 * There is no Rust in this module and it does not need any: the whole per-frame
 * cost is a handful of arithmetic operations per binding, which is nothing
 * beside the render it configures, and putting it in the core would have moved
 * the registry's `animatable` contract across the WASM boundary for no gain.
 */

export { AnimationError } from "./errors";
export type { AnimationErrorCode } from "./errors";

export {
  MAX_CYCLES_PER_LOOP,
  MAX_GLOBAL_SPEED,
  cyclesPerLoop,
  globalSpeed,
  isCyclesPerLoop,
  isGlobalSpeed,
  positiveInteger,
  scaleCycles,
  wholeNumber,
} from "./cycles";
export type { CyclesPerLoop, GlobalSpeed } from "./cycles";

export {
  MAX_FPS,
  MAX_FRAMES,
  loopClock,
  loopDuration,
  loopFrame,
  loopSeconds,
  loopTime,
} from "./clock";
export type { LoopClock } from "./clock";

export { bipolarFrom, fold, mix32, seedFromString, seedValue, unitFrom } from "./rng";

export {
  MODULATOR_SHAPES,
  SMOOTH_NOISE_LATTICE,
  STEPPED_RANDOM_STEPS,
  featuresPerCycle,
  featuresPerLoop,
  fract,
  modulatorPhase,
  modulatorUnit,
  normalisePhase,
  shapeAt,
  unwrappedPhase,
} from "./modulator";
export type { ModulatorSpec } from "./modulator";

export {
  DEFAULT_DOCUMENT_SEED,
  DEFAULT_TIMING,
  bindingRawValueAt,
  bindingSeed,
  bindingSwing,
  bindingValueAt,
  resolveBindings,
} from "./binding";
export type { GlobalTiming, NumericParam, ResolvedBinding } from "./binding";

export {
  GOLDEN_ANGLE_TURNS,
  IGN_ADVANCE,
  PATTERN_OFFSET_X,
  PATTERN_OFFSET_Y,
  PATTERN_ROTATION,
  R2_ALPHA_X,
  R2_ALPHA_Y,
  SEEDED_FAMILIES,
  TEMPORAL_MODES,
  applyTemporalState,
  resolveVariation,
  seedParams,
  supportsLever,
  temporalContinuity,
  temporalLever,
  temporalModesFor,
  temporalStateAt,
} from "./temporal";
export type {
  ResolvedVariation,
  TemporalLever,
  TemporalMode,
  TemporalState,
  TemporalVariation,
} from "./temporal";

export {
  FEEDBACK_STILL_FRACTION,
  documentAtFrame,
  planAnimation,
  planTime,
  stackAtFrame,
  stillFrameFor,
} from "./plan";
export type { AnimationOptions, AnimationPlan } from "./plan";

export { SEAM_PHASE_TOLERANCE, phaseDistance, validateLoopSeam } from "./seam";
export type { SeamIssue, SeamIssueCode, SeamOptions, SeamReport, SeamSeverity } from "./seam";
