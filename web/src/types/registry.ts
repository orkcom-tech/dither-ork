/**
 * The node registry descriptor.
 *
 * The registry is the single source of truth about effects. The UI builds its
 * effect list from it, the graph schedules from it, and Surprise Me samples
 * from it. There is no second list anywhere — see docs/API.md section 2.
 *
 * Two consequences drive the shapes below.
 *
 * **Surprise Me has no per-effect logic.** The generator reads this file's
 * types and nothing else, so a newly added effect becomes eligible the moment
 * it is registered. That only works if every parameter carries its own surprise
 * metadata, which is why `surprise` is a required field on every parameter kind
 * and why {@link validateRegistry} treats a missing one as a build failure
 * rather than something that shows up as a bad random document months later.
 *
 * **Adding an effect is adding one file.** Each effect lives in its own module
 * under `web/src/effects/`, default-exporting a single descriptor built with
 * {@link defineEffect}; the registry collects them by glob. Nothing central is
 * edited, so two effects added in parallel cannot conflict.
 *
 * ```ts
 * // web/src/effects/floyd-steinberg.ts
 * import { defineEffect } from "../types/registry";
 * export default defineEffect({ id: "floyd-steinberg", ... });
 * ```
 */

import type { CurvePoint, NodeSlot, SrgbTriplet } from "./document";
import type { GpuEffect } from "./gpu";
import type { ThresholdMatrix } from "../gpu/matrices";

/**
 * The two composite parameter values, re-exported from the schema that has to
 * serialise them.
 *
 * They are declared in `./document` and not here because `.dork` is what has to
 * write them down; a second declaration on this side would be one more thing to
 * keep byte-compatible with the first. Descriptors go on importing them from
 * the registry, which is where a parameter kind is described.
 */
export type { CurvePoint, SrgbTriplet };

/**
 * Effect families, matching the spec's requirement groups.
 *
 * `preprocess` is the one that is not in docs/API.md's list: the PP
 * requirements (F-PP-01 internal resolution, levels, HSL, curves, seeded noise)
 * are stack nodes with descriptors like any other, and the five families named
 * there give them no home.
 */
export type EffectFamily =
  | "preprocess"
  | "error-diffusion"
  | "ordered"
  | "pattern"
  | "glitch"
  | "special";

/**
 * Where an effect runs, and therefore what it costs.
 *
 * `wasm` is a serial CPU kernel — error diffusion is inherently serial, so the
 * whole family lives here. `gpu` is a WebGPU compute pass. Each `wasm` node
 * sitting between `gpu` nodes costs a readback plus an upload, which is the
 * known performance ceiling; the scheduler reads this field to coalesce runs of
 * `gpu` nodes and to log every crossing.
 */
export type ExecutionKind = "wasm" | "gpu";

/** Parameter kinds the registry can describe. */
export type ParamType =
  | "float"
  | "int"
  | "bool"
  | "enum"
  | "color"
  | "seed"
  | "curve";

/** An inclusive `[min, max]` bound. */
export type Range = readonly [min: number, max: number];

/** One option in a weighted draw. Weights are relative, not probabilities. */
export interface Weighted<T> {
  readonly value: T;
  /** Must be finite and greater than zero. */
  readonly weight: number;
}

/**
 * How a numeric surprise range is sampled.
 *
 * A union rather than a bare string, because `normal` needs parameters and
 * `log` has a precondition. Naming the distribution without them would leave
 * the generator guessing a mean, and a guessed mean is a look decision made by
 * accident.
 */
export type NumericDistribution =
  /** Flat across the surprise range. */
  | { readonly kind: "uniform" }
  /**
   * Flat in log space — the right default for anything measured in octaves
   * (cell size, radius, frequency), where uniform sampling spends most of its
   * draws in the top octave and the result always looks the same.
   * Requires a strictly positive range.
   */
  | { readonly kind: "log" }
  /** Clustered around `mean`, truncated to the surprise range. */
  | { readonly kind: "normal"; readonly mean: number; readonly sigma: number };

/**
 * Surprise metadata shared by `float` and `int`.
 *
 * `range` is deliberately narrower than the legal range. That gap is the whole
 * difference between a usable random result and noise (F-SM-04): a legal blur
 * radius goes to 200px, a musical one stops around 12.
 */
export interface NumericSurprise {
  readonly range: Range;
  readonly distribution: NumericDistribution;
  /**
   * Relative likelihood that this parameter is one of the ones Surprise Me
   * moves off its default. The chaos slider (F-SM-07) decides how many
   * parameters move; this decides which. Must be greater than zero.
   */
  readonly weight: number;
}

interface ParamBase {
  /** Key under `StackNode.params`. Unique within the effect. */
  readonly key: string;
  readonly label: string;
  readonly type: ParamType;
  /** Whether a modulator or keyframe track may bind to it (F-AN-02). */
  readonly animatable: boolean;
  /** One line of UI help. Absent means the label is self-explanatory. */
  readonly hint?: string;
}

export interface FloatParam extends ParamBase {
  readonly type: "float";
  /** The full range the UI and the loader accept. */
  readonly legal: Range;
  readonly default: number;
  readonly surprise: NumericSurprise;
  /** Drag/entry quantum. Absent means continuous. */
  readonly step?: number;
}

export interface IntParam extends ParamBase {
  readonly type: "int";
  /** Bounds and default must all be integers; the validator enforces it. */
  readonly legal: Range;
  readonly default: number;
  readonly surprise: NumericSurprise;
}

export interface BoolSurprise {
  /**
   * Probability of drawing `true`. The bool analogue of a narrowed range: a
   * serpentine toggle wants about 0.9 because off looks broken, an exotic mode
   * wants 0.1 because it should be a surprise rather than the norm.
   */
  readonly trueProbability: number;
  /** See {@link NumericSurprise.weight}. */
  readonly weight: number;
}

/** A bool's legal range is `{false, true}` by construction, so it is not declared. */
export interface BoolParam extends ParamBase {
  readonly type: "bool";
  readonly default: boolean;
  readonly surprise: BoolSurprise;
}

export interface EnumValue {
  readonly value: string;
  readonly label: string;
}

export interface EnumSurprise {
  /**
   * The subset drawn from, with relative weights. Every entry must name one of
   * the parameter's legal values, and the subset is usually smaller: a halftone
   * dot shape is legally any of four, but two of them carry the look.
   */
  readonly values: readonly Weighted<string>[];
  /** See {@link NumericSurprise.weight}. */
  readonly weight: number;
}

export interface EnumParam extends ParamBase {
  readonly type: "enum";
  /** The legal set, in UI order. */
  readonly values: readonly EnumValue[];
  readonly default: string;
  readonly surprise: EnumSurprise;
}

/**
 * Colour surprise, expressed in OKLab.
 *
 * Sampling sRGB channels independently clumps around muddy mid-greys and gives
 * uneven perceptual lightness; sampling OKLab does not. This is the same reason
 * palette synthesis works in OKLab (see docs/ARCHITECTURE.md, "Surprise
 * generator"). The legal range is the sRGB gamut, which is a property of the
 * type and not per-parameter, so it is not declared.
 */
export interface ColorSurprise {
  /** OKLab L, in `[0, 1]`. */
  readonly lightness: Range;
  /** OKLab chroma. sRGB tops out near 0.33; {@link CHROMA_CEILING} is the bound. */
  readonly chroma: Range;
  /**
   * OKLab hue in degrees, `[0, 360)`. `min > max` is legal and means the arc
   * wraps through 0 — the only way to express "warm" as one range.
   */
  readonly hue: Range;
  /** See {@link NumericSurprise.weight}. */
  readonly weight: number;
}

export interface ColorParam extends ParamBase {
  readonly type: "color";
  readonly default: SrgbTriplet;
  readonly surprise: ColorSurprise;
}

/**
 * Seed surprise.
 *
 * A seed has no narrower musical range — every seed is as good as every other,
 * which is the point of F-AN-05 — so the range and distribution are fixed by
 * the kind ({@link SEED_RANGE}, uniform) rather than restated on every effect.
 * The only decision left is whether a reroll touches it.
 */
export interface SeedSurprise {
  /** See {@link NumericSurprise.weight}. */
  readonly weight: number;
}

/**
 * An explicit seed exposed as a parameter.
 *
 * `StackNode.seed` already gives every node one seed. A `seed` parameter is for
 * effects that need more than one independent stochastic axis — row
 * displacement seeding slice heights separately from offsets — or that expose
 * the seed as a control in its own right, as the glitch family does.
 */
export interface SeedParam extends ParamBase {
  readonly type: "seed";
  readonly default: number;
  readonly surprise: SeedSurprise;
}

/** Legal range of a seed parameter: the full unsigned 32-bit space. */
export const SEED_RANGE: Range = [0, 0xffffffff];

/** Upper bound accepted for an OKLab chroma range. sRGB cannot exceed ~0.33. */
export const CHROMA_CEILING = 0.5;

/**
 * Named curve shapes.
 *
 * Surprise Me samples an archetype and jitters it. Sampling control points
 * directly produces curves that are legal and useless — non-monotonic, clipped
 * at both ends — which is the noise-versus-result distinction of F-SM-04 in its
 * most extreme form.
 */
export type CurveArchetype =
  | "linear"
  | "s-curve"
  | "inverse-s"
  | "lift"
  | "crush"
  | "invert";

export interface CurveSurprise {
  readonly archetypes: readonly Weighted<CurveArchetype>[];
  /** How far a control point may move from the archetype, in unit-square units. */
  readonly jitter: number;
  /** See {@link NumericSurprise.weight}. */
  readonly weight: number;
}

/**
 * An editable transfer curve (F-PP-05).
 *
 * The legal range is the unit square with strictly increasing `x` spanning the
 * full domain — a transfer curve that does not cover `[0, 1]` leaves pixels
 * undefined — so it is a property of the kind, enforced by the validator.
 */
export interface CurveParam extends ParamBase {
  readonly type: "curve";
  readonly default: readonly CurvePoint[];
  readonly surprise: CurveSurprise;
}

export type ParamDescriptor =
  | FloatParam
  | IntParam
  | BoolParam
  | EnumParam
  | ColorParam
  | SeedParam
  | CurveParam;

/**
 * One effect's complete self-description.
 *
 * This is the only thing an effect has to add to become visible to the UI, the
 * scheduler and Surprise Me.
 */
export interface EffectDescriptor {
  /** Stable id, referenced by `StackNode.effect`. Kebab-case, unique. */
  readonly id: string;
  readonly name: string;
  /**
   * The spec requirement this implements, e.g. `"F-ED-01"`. Carried so the
   * catalogue can be checked against the spec mechanically instead of by
   * counting rows in a table by hand.
   */
  readonly requirement: string;
  /** Slot in the stack grammar. Surprise Me builds stacks against this. */
  readonly slot: NodeSlot;
  readonly family: EffectFamily;
  readonly execution: ExecutionKind;
  readonly params: readonly ParamDescriptor[];
  /**
   * Relative likelihood in Surprise Me. 1.0 is ordinary; niche effects sit
   * lower so that signature looks appear more often than curiosities (F-SM-03).
   */
  readonly surpriseWeight: number;
  /**
   * True when this node quantizes and therefore emits an index map alongside
   * its RGBA buffer. The graph reads it to know when the pipeline changes shape
   * (see docs/ARCHITECTURE.md, "Data layout").
   */
  readonly producesIndexMap: boolean;
  /**
   * True when this node reads the index map — outline, dilate/erode,
   * hue-targeted recolour, index remap. Such a node is only legal downstream of
   * a quantizer, which is a grammar constraint Surprise Me must respect rather
   * than a runtime error to discover.
   */
  readonly requiresIndexMap: boolean;
  /**
   * Effect ids this one must not share a stack with. Incompatible combinations
   * are excluded by the grammar, not filtered after generation (F-SM-03).
   */
  readonly excludes?: readonly string[];
}

/**
 * Identity function that types a descriptor literal without widening it.
 *
 * It exists so an effect file has exactly one import and no type annotation:
 * the literal keeps its narrow types (so `params` stays a tuple of the specific
 * parameter kinds) while still being checked against
 * {@link EffectDescriptor} at the point of definition, where the error is
 * readable.
 */
export function defineEffect<const D extends EffectDescriptor>(descriptor: D): D {
  return descriptor;
}

// --- from an effect id to its compute passes -----------------------------
//
// The registry globs *descriptors*, and a descriptor says an effect runs on the
// GPU without saying where its passes are. Until this contract existed each
// effect module exported its `GpuEffect` under a name of its own — `INVERT_GPU`,
// `blurGpuEffect`, `halftoneEffect()` — and the only caller was a page that
// imported them all by hand. A document loader cannot do that: it has an
// effect id out of a `.dork` file and nothing else.
//
// One convention, stated once: **an effect module that declares `execution:
// "gpu"` exports `const gpu: GpuEffectSource` beside its default export.**
// `registry/gpu-effects.ts` collects them with the same glob that collects the
// descriptors, and refuses a catalogue where the two disagree.

/**
 * What an effect needs handed to it before its passes exist.
 *
 * A closed union with two members rather than a boolean, because the interesting
 * case is the one the naive design gets wrong: the five ordered dithers cannot
 * be built at all until the Rust core has produced a threshold tile, so
 * "constructible from nothing" is a property some effects do not have and the
 * lookup has to be able to say so *before* it tries. Today `threshold-matrix` is
 * the only kind of build-time data any effect needs; a second kind is a
 * deliberate edit here, not something a caller can improvise.
 */
export type GpuBuildRequirement =
  /** Constructible from nothing. Forty-three of the forty-eight. */
  | { readonly kind: "none" }
  /**
   * Needs a validated tile of `size * size` ranks from `dither-core`
   * (F-OD-01..05). Nothing on the web side fabricates one.
   */
  | { readonly kind: "threshold-matrix"; readonly size: number };

/** The build-time data itself, in the same closed set as the requirement. */
export type GpuBuildData =
  | { readonly kind: "none" }
  | { readonly kind: "threshold-matrix"; readonly matrix: ThresholdMatrix };

/** The only value of {@link GpuBuildData} an effect requiring nothing accepts. */
export const NO_GPU_BUILD_DATA: GpuBuildData = { kind: "none" };

/** Thrown when {@link GpuEffectSource.build} is handed data of the wrong kind. */
export class GpuBuildDataError extends Error {
  readonly effect: string;

  constructor(effect: string, message: string) {
    super(message);
    this.name = "GpuBuildDataError";
    this.effect = effect;
  }
}

/**
 * An effect module's GPU side: how to get from its id to its compute passes.
 *
 * `build` is a function rather than a ready-made `GpuEffect` for two reasons,
 * both of which bite in a catalogue this size. Several effects assemble a table
 * before they can name their passes — the glyph sheet (F-PT-08), the clustered
 * dot screens (F-PT-03) — and doing that at module-evaluation time makes every
 * effect in the build cost something whether or not the document uses it. And a
 * `const` evaluated at import time has to be declared after everything it
 * mentions; a thunk can sit anywhere in the file, which is what makes the
 * convention a mechanical addition to each existing module rather than a
 * reordering of it.
 */
export interface GpuEffectSource {
  /** Must equal the id of the descriptor the same module default-exports. */
  readonly effect: string;
  readonly requires: GpuBuildRequirement;
  /** @throws GpuBuildDataError when `data.kind` is not `requires.kind`. */
  build(data: GpuBuildData): GpuEffect;
}

/**
 * Declare the GPU side of an effect whose passes are constant.
 *
 * ```ts
 * export const gpu = staticGpuEffect("invert", () => INVERT_GPU);
 * ```
 */
export function staticGpuEffect(
  effect: string,
  build: () => GpuEffect,
): GpuEffectSource {
  return {
    effect,
    requires: { kind: "none" },
    build: (data) => {
      if (data.kind !== "none") {
        throw new GpuBuildDataError(
          effect,
          `${effect} needs no build-time data, but was handed ${data.kind}`,
        );
      }
      return build();
    },
  };
}

/**
 * Declare the GPU side of an effect whose passes need a threshold tile.
 *
 * ```ts
 * export const gpu = thresholdMatrixGpuEffect(spec.effectId, spec.tile, (matrix) =>
 *   orderedDitherEffect(spec, matrix),
 * );
 * ```
 *
 * The tile is not fetched here and it is not defaulted. `size` is declared so a
 * caller can ask the core for the right tile *before* it has anything to build
 * with; the matrix's own id and size are checked by the effect that consumes it.
 */
export function thresholdMatrixGpuEffect(
  effect: string,
  size: number,
  build: (matrix: ThresholdMatrix) => GpuEffect,
): GpuEffectSource {
  return {
    effect,
    requires: { kind: "threshold-matrix", size },
    build: (data) => {
      if (data.kind !== "threshold-matrix") {
        throw new GpuBuildDataError(
          effect,
          `${effect} needs a ${size}x${size} threshold matrix, but was handed ${data.kind}`,
        );
      }
      return build(data.matrix);
    },
  };
}

/**
 * The shape of an effect module, as the glob loader sees it.
 *
 * `gpu` is present exactly when the descriptor declares `execution: "gpu"`, and
 * `registry/gpu-effects.ts` fails the catalogue when it is not.
 */
export interface EffectModule {
  readonly default: EffectDescriptor;
  readonly gpu?: GpuEffectSource;
}

/** Everything {@link validateRegistry} can reject, as a closed set. */
export type RegistryIssueCode =
  | "empty-id"
  | "malformed-id"
  | "duplicate-effect-id"
  | "malformed-requirement"
  | "invalid-surprise-weight"
  | "unknown-exclusion"
  | "self-exclusion"
  | "diffusion-must-run-serially"
  | "index-map-consumer-in-preprocess"
  | "duplicate-param-key"
  | "empty-param-key"
  | "missing-surprise"
  | "invalid-weight"
  | "invalid-probability"
  | "inverted-legal-range"
  | "inverted-surprise-range"
  | "surprise-outside-legal"
  | "default-outside-legal"
  | "non-integer-bound"
  | "log-needs-positive-range"
  | "invalid-normal-parameters"
  | "empty-enum"
  | "duplicate-enum-value"
  | "unknown-enum-default"
  | "enum-surprise-outside-legal"
  | "empty-surprise-set"
  | "invalid-color-component"
  | "chroma-out-of-gamut"
  | "hue-out-of-range"
  | "lightness-out-of-range"
  | "invalid-seed-default"
  | "curve-too-short"
  | "curve-not-monotonic"
  | "curve-outside-unit-square"
  | "curve-domain-not-covered"
  | "invalid-jitter";

export interface RegistryIssue {
  /** Effect id, or `"<unnamed>"` when the id itself is what is wrong. */
  readonly effect: string;
  /** Parameter key, when the issue is inside a parameter. */
  readonly param?: string;
  readonly code: RegistryIssueCode;
  readonly message: string;
}

export interface RegistryValidation {
  readonly ok: boolean;
  readonly issues: readonly RegistryIssue[];
}

// --- validation ---------------------------------------------------------
//
// Validation runs at build time (docs/API.md section 2). Most of what it checks
// cannot be expressed in the type system at all — that a surprise range sits
// inside its legal range, that a default is reachable, that a log distribution
// has a positive range — so this is the only gate.
//
// It also checks that required metadata is *present*, which the types appear to
// guarantee. They guarantee it for descriptors written as literals in this
// repository; they guarantee nothing for a descriptor assembled programmatically
// or arriving from an untyped module. Since the cost of the check is a `typeof`
// and the cost of missing it is Surprise Me silently skipping a parameter
// forever, it is checked.

function issue(
  effect: string,
  code: RegistryIssueCode,
  message: string,
): RegistryIssue {
  return { effect, code, message };
}

function paramIssue(
  effect: string,
  param: string,
  code: RegistryIssueCode,
  message: string,
): RegistryIssue {
  return { effect, param, code, message };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRange(value: unknown): value is Range {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1])
  );
}

function isPresentObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isPositiveWeight(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/** `F-` plus a two-or-three letter group plus a number, e.g. `F-ED-01`, `F-ED-CTL`. */
const REQUIREMENT_PATTERN = /^F-[A-Z]{2}-[A-Z0-9]{2,3}$/;

/**
 * Lowercase kebab-case. Enforced rather than merely documented because an id
 * ends up in the share URL fragment (F-DO-06) and in preset file names, where
 * a space or a capital is a bug discovered by a user rather than by CI.
 */
const EFFECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Checks the weighted set every categorical surprise uses: non-empty, every
 * weight positive, every value legal.
 */
function checkWeightedSet(
  effectId: string,
  key: string,
  set: unknown,
  legalValues: readonly string[] | null,
  issues: RegistryIssue[],
): void {
  if (!Array.isArray(set) || set.length === 0) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "empty-surprise-set",
        "surprise draws from an empty set, so this parameter can never be surprised",
      ),
    );
    return;
  }
  for (const entry of set as readonly unknown[]) {
    if (!isPresentObject(entry) || !isPositiveWeight(entry["weight"])) {
      issues.push(
        paramIssue(
          effectId,
          key,
          "invalid-weight",
          "every surprise option needs a finite weight greater than zero",
        ),
      );
      continue;
    }
    const value = entry["value"];
    if (legalValues !== null && !legalValues.includes(String(value))) {
      issues.push(
        paramIssue(
          effectId,
          key,
          "enum-surprise-outside-legal",
          `surprise option ${String(value)} is not one of the legal values`,
        ),
      );
    }
  }
}

/** Shared numeric checks for `float` and `int`. */
function checkNumericParam(
  effectId: string,
  param: FloatParam | IntParam,
  issues: RegistryIssue[],
): void {
  const key = param.key;
  const requireIntegers = param.type === "int";

  if (!isRange(param.legal)) {
    issues.push(
      paramIssue(effectId, key, "inverted-legal-range", "legal range is not a finite [min, max]"),
    );
    return;
  }
  const [legalMin, legalMax] = param.legal;
  if (legalMin >= legalMax) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "inverted-legal-range",
        `legal range [${legalMin}, ${legalMax}] is empty or inverted`,
      ),
    );
  }

  if (!isFiniteNumber(param.default)) {
    issues.push(
      paramIssue(effectId, key, "default-outside-legal", "default is not a finite number"),
    );
  } else if (param.default < legalMin || param.default > legalMax) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "default-outside-legal",
        `default ${param.default} is outside the legal range [${legalMin}, ${legalMax}]`,
      ),
    );
  }

  if (requireIntegers) {
    for (const [what, value] of [
      ["legal min", legalMin],
      ["legal max", legalMax],
      ["default", param.default],
    ] as const) {
      if (!Number.isInteger(value)) {
        issues.push(
          paramIssue(
            effectId,
            key,
            "non-integer-bound",
            `${what} ${value} is not an integer on an int parameter`,
          ),
        );
      }
    }
  }

  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(
      paramIssue(effectId, key, "missing-surprise", "no surprise metadata; Surprise Me cannot sample it"),
    );
    return;
  }

  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, key, "invalid-weight", "surprise weight must be finite and greater than zero"),
    );
  }

  const range: unknown = surprise["range"];
  if (!isRange(range)) {
    issues.push(
      paramIssue(effectId, key, "missing-surprise", "surprise range is missing or not a finite [min, max]"),
    );
    return;
  }
  const [surpriseMin, surpriseMax] = range;
  if (surpriseMin > surpriseMax) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "inverted-surprise-range",
        `surprise range [${surpriseMin}, ${surpriseMax}] is inverted`,
      ),
    );
  }
  if (surpriseMin < legalMin || surpriseMax > legalMax) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "surprise-outside-legal",
        `surprise range [${surpriseMin}, ${surpriseMax}] escapes the legal range [${legalMin}, ${legalMax}]`,
      ),
    );
  }
  if (requireIntegers && (!Number.isInteger(surpriseMin) || !Number.isInteger(surpriseMax))) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "non-integer-bound",
        `surprise range [${surpriseMin}, ${surpriseMax}] is not integral on an int parameter`,
      ),
    );
  }

  const distribution: unknown = surprise["distribution"];
  if (!isPresentObject(distribution)) {
    issues.push(
      paramIssue(effectId, key, "missing-surprise", "no sampling distribution declared"),
    );
    return;
  }
  const kind = distribution["kind"];
  if (kind === "log" && surpriseMin <= 0) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "log-needs-positive-range",
        `log sampling needs a strictly positive range; got [${surpriseMin}, ${surpriseMax}]`,
      ),
    );
  }
  if (kind === "normal") {
    const mean = distribution["mean"];
    const sigma = distribution["sigma"];
    if (!isFiniteNumber(mean) || mean < surpriseMin || mean > surpriseMax) {
      issues.push(
        paramIssue(
          effectId,
          key,
          "invalid-normal-parameters",
          "normal sampling needs a finite mean inside the surprise range",
        ),
      );
    }
    if (!isFiniteNumber(sigma) || sigma <= 0) {
      issues.push(
        paramIssue(
          effectId,
          key,
          "invalid-normal-parameters",
          "normal sampling needs a sigma greater than zero",
        ),
      );
    }
  }
  if (kind !== "uniform" && kind !== "log" && kind !== "normal") {
    issues.push(
      paramIssue(effectId, key, "missing-surprise", `unknown sampling distribution ${String(kind)}`),
    );
  }
}

function checkBoolParam(effectId: string, param: BoolParam, issues: RegistryIssue[]): void {
  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(
      paramIssue(effectId, param.key, "missing-surprise", "no surprise metadata"),
    );
    return;
  }
  if (!isProbability(surprise["trueProbability"])) {
    issues.push(
      paramIssue(
        effectId,
        param.key,
        "invalid-probability",
        "trueProbability must be a number in [0, 1]",
      ),
    );
  }
  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, param.key, "invalid-weight", "surprise weight must be greater than zero"),
    );
  }
  if (typeof param.default !== "boolean") {
    issues.push(
      paramIssue(effectId, param.key, "default-outside-legal", "default must be a boolean"),
    );
  }
}

function checkEnumParam(effectId: string, param: EnumParam, issues: RegistryIssue[]): void {
  const key = param.key;
  if (!Array.isArray(param.values) || param.values.length === 0) {
    issues.push(paramIssue(effectId, key, "empty-enum", "enum parameter declares no values"));
    return;
  }

  const legalValues: string[] = [];
  for (const option of param.values) {
    if (legalValues.includes(option.value)) {
      issues.push(
        paramIssue(effectId, key, "duplicate-enum-value", `value ${option.value} is declared twice`),
      );
    }
    legalValues.push(option.value);
  }

  if (!legalValues.includes(param.default)) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "unknown-enum-default",
        `default ${param.default} is not one of the declared values`,
      ),
    );
  }

  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(paramIssue(effectId, key, "missing-surprise", "no surprise metadata"));
    return;
  }
  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, key, "invalid-weight", "surprise weight must be greater than zero"),
    );
  }
  checkWeightedSet(effectId, key, surprise["values"], legalValues, issues);
}

function checkColorParam(effectId: string, param: ColorParam, issues: RegistryIssue[]): void {
  const key = param.key;
  const triplet: unknown = param.default;
  if (!Array.isArray(triplet) || triplet.length !== 3) {
    issues.push(
      paramIssue(effectId, key, "invalid-color-component", "default must be an [r, g, b] triplet"),
    );
  } else {
    for (const component of triplet as readonly unknown[]) {
      if (!Number.isInteger(component) || (component as number) < 0 || (component as number) > 255) {
        issues.push(
          paramIssue(
            effectId,
            key,
            "invalid-color-component",
            `default component ${String(component)} is not an 8-bit sRGB value`,
          ),
        );
      }
    }
  }

  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(paramIssue(effectId, key, "missing-surprise", "no surprise metadata"));
    return;
  }
  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, key, "invalid-weight", "surprise weight must be greater than zero"),
    );
  }

  const lightness: unknown = surprise["lightness"];
  const chroma: unknown = surprise["chroma"];
  const hue: unknown = surprise["hue"];

  if (!isRange(lightness) || lightness[0] > lightness[1]) {
    issues.push(
      paramIssue(effectId, key, "lightness-out-of-range", "lightness must be a [min, max] with min <= max"),
    );
  } else if (lightness[0] < 0 || lightness[1] > 1) {
    issues.push(
      paramIssue(effectId, key, "lightness-out-of-range", "OKLab lightness lives in [0, 1]"),
    );
  }

  if (!isRange(chroma) || chroma[0] > chroma[1]) {
    issues.push(
      paramIssue(effectId, key, "chroma-out-of-gamut", "chroma must be a [min, max] with min <= max"),
    );
  } else if (chroma[0] < 0 || chroma[1] > CHROMA_CEILING) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "chroma-out-of-gamut",
        `chroma must stay within [0, ${CHROMA_CEILING}]; sRGB cannot reach further`,
      ),
    );
  }

  // No min <= max check: an inverted hue range is the legal way to say the arc
  // wraps through 0.
  if (!isRange(hue) || hue[0] < 0 || hue[0] >= 360 || hue[1] < 0 || hue[1] >= 360) {
    issues.push(
      paramIssue(effectId, key, "hue-out-of-range", "hue bounds must both lie in [0, 360)"),
    );
  }
}

function checkSeedParam(effectId: string, param: SeedParam, issues: RegistryIssue[]): void {
  const [seedMin, seedMax] = SEED_RANGE;
  if (!Number.isInteger(param.default) || param.default < seedMin || param.default > seedMax) {
    issues.push(
      paramIssue(
        effectId,
        param.key,
        "invalid-seed-default",
        `default ${param.default} is not a 32-bit unsigned integer`,
      ),
    );
  }
  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(paramIssue(effectId, param.key, "missing-surprise", "no surprise metadata"));
    return;
  }
  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, param.key, "invalid-weight", "surprise weight must be greater than zero"),
    );
  }
}

function checkCurveParam(effectId: string, param: CurveParam, issues: RegistryIssue[]): void {
  const key = param.key;
  const points = param.default;
  if (!Array.isArray(points) || points.length < 2) {
    issues.push(
      paramIssue(effectId, key, "curve-too-short", "a curve needs at least two control points"),
    );
  } else {
    let previousX = Number.NEGATIVE_INFINITY;
    let outside = false;
    for (const point of points) {
      if (
        !isFiniteNumber(point.x) ||
        !isFiniteNumber(point.y) ||
        point.x < 0 ||
        point.x > 1 ||
        point.y < 0 ||
        point.y > 1
      ) {
        outside = true;
        continue;
      }
      if (point.x <= previousX) {
        issues.push(
          paramIssue(
            effectId,
            key,
            "curve-not-monotonic",
            `control point x=${point.x} does not increase; a curve must be a function of x`,
          ),
        );
      }
      previousX = point.x;
    }
    if (outside) {
      issues.push(
        paramIssue(effectId, key, "curve-outside-unit-square", "control points must lie in the unit square"),
      );
    }
    const first = points[0];
    const last = points[points.length - 1];
    if (first !== undefined && last !== undefined && (first.x !== 0 || last.x !== 1)) {
      issues.push(
        paramIssue(
          effectId,
          key,
          "curve-domain-not-covered",
          "a transfer curve must span x = 0 to x = 1, or some inputs have no output",
        ),
      );
    }
  }

  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(paramIssue(effectId, key, "missing-surprise", "no surprise metadata"));
    return;
  }
  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, key, "invalid-weight", "surprise weight must be greater than zero"),
    );
  }
  if (!isProbability(surprise["jitter"])) {
    issues.push(
      paramIssue(effectId, key, "invalid-jitter", "jitter must be a number in [0, 1]"),
    );
  }
  checkWeightedSet(effectId, key, surprise["archetypes"], null, issues);
}

/**
 * Validate one descriptor in isolation.
 *
 * Cross-effect rules — id uniqueness, exclusion targets — need the whole set
 * and live in {@link validateRegistry}.
 */
export function validateEffect(effect: EffectDescriptor): readonly RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const id = typeof effect.id === "string" && effect.id.length > 0 ? effect.id : "<unnamed>";

  if (id === "<unnamed>") {
    issues.push(issue(id, "empty-id", "effect has no id"));
  } else if (!EFFECT_ID_PATTERN.test(id)) {
    issues.push(issue(id, "malformed-id", `effect id ${id} is not lowercase kebab-case`));
  }
  if (typeof effect.requirement !== "string" || !REQUIREMENT_PATTERN.test(effect.requirement)) {
    issues.push(
      issue(
        id,
        "malformed-requirement",
        `requirement ${String(effect.requirement)} is not a spec id such as F-ED-01`,
      ),
    );
  }
  if (!isPositiveWeight(effect.surpriseWeight)) {
    issues.push(
      issue(id, "invalid-surprise-weight", "surpriseWeight must be finite and greater than zero"),
    );
  }

  // Error diffusion is serial by definition — that constraint is the reason the
  // renderer is split in two at all. A descriptor claiming otherwise is a
  // mislabelled effect, and it would be scheduled into a GPU batch that cannot
  // run it.
  if (effect.family === "error-diffusion" && effect.execution !== "wasm") {
    issues.push(
      issue(
        id,
        "diffusion-must-run-serially",
        "error diffusion cannot be expressed as a compute pass; execution must be wasm",
      ),
    );
  }

  // Nothing has quantized before the dither slot, so an index-map consumer
  // placed in preprocess can never have an input to read.
  if (effect.requiresIndexMap && effect.slot === "preprocess") {
    issues.push(
      issue(
        id,
        "index-map-consumer-in-preprocess",
        "reads the index map but sits before the dither slot, where none exists yet",
      ),
    );
  }

  if (effect.excludes !== undefined && effect.excludes.includes(effect.id)) {
    issues.push(issue(id, "self-exclusion", "effect excludes itself"));
  }

  const seenKeys: string[] = [];
  for (const param of effect.params) {
    if (typeof param.key !== "string" || param.key.length === 0) {
      issues.push(issue(id, "empty-param-key", "a parameter has no key"));
      continue;
    }
    if (seenKeys.includes(param.key)) {
      issues.push(
        issue(id, "duplicate-param-key", `parameter key ${param.key} is declared twice`),
      );
    }
    seenKeys.push(param.key);

    switch (param.type) {
      case "float":
      case "int":
        checkNumericParam(id, param, issues);
        break;
      case "bool":
        checkBoolParam(id, param, issues);
        break;
      case "enum":
        checkEnumParam(id, param, issues);
        break;
      case "color":
        checkColorParam(id, param, issues);
        break;
      case "seed":
        checkSeedParam(id, param, issues);
        break;
      case "curve":
        checkCurveParam(id, param, issues);
        break;
    }
  }

  return issues;
}

/**
 * Validate the whole registry.
 *
 * Called at build time; a non-`ok` result fails the build. That is what keeps
 * Surprise Me correct as effects are added, instead of letting it degrade
 * quietly into never touching a parameter nobody described.
 */
export function validateRegistry(
  effects: readonly EffectDescriptor[],
): RegistryValidation {
  const issues: RegistryIssue[] = [];
  const seenIds: string[] = [];

  for (const effect of effects) {
    issues.push(...validateEffect(effect));
    if (typeof effect.id === "string" && effect.id.length > 0) {
      if (seenIds.includes(effect.id)) {
        issues.push(
          issue(effect.id, "duplicate-effect-id", `effect id ${effect.id} is registered twice`),
        );
      }
      seenIds.push(effect.id);
    }
  }

  for (const effect of effects) {
    for (const excluded of effect.excludes ?? []) {
      if (!seenIds.includes(excluded)) {
        issues.push(
          issue(
            effect.id,
            "unknown-exclusion",
            `excludes ${excluded}, which is not a registered effect`,
          ),
        );
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
