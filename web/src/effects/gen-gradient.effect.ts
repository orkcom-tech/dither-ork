/**
 * Gradient source (F-GN-02).
 *
 * A linear, radial or conical ramp, shaped by a transfer curve. **It takes no
 * image**: it sits in the `source` slot and its pass binds no `input-color`, so
 * a document containing one needs no photograph.
 *
 * ## The ramp is the existing curve parameter
 *
 * A gradient's interesting control is not its ends, it is the shape between
 * them — a plain ramp, an ease, a hard step. That is what F-PP-05's transfer
 * curve already is, so `ramp` is a `curve` parameter and it is sampled into the
 * same 256-entry LUT `curves.wgsl` reads, through the same `instance-data`
 * binding and with `buildCurveLut` itself rather than a second sampler. The
 * curve editor's default — the diagonal — is the plain linear ramp, which is
 * what a gradient node should do on the frame it is added.
 *
 * That also settles what would otherwise be nine float parameters: the ramp is
 * greyscale, and colour comes from putting `gradient-map` after it. The uniform
 * packer deliberately refuses a `color` parameter (`gpu/uniforms.ts` says why),
 * and a two-colour gradient here would mean six floats pretending to be two
 * colours, with none of the colour picker or the OKLab surprise metadata that
 * `gradient-map` already has.
 *
 * ## Animation
 *
 * Centre, angle and extent are modulator targets. Angle is in turns, so a
 * modulator ramping across the loop sweeps a conical gradient exactly once and
 * lands where it started (F-AN-03) — a generator has no reason to break loop
 * closure and this one does not.
 *
 * ## No seed
 *
 * Closed form in the pixel coordinate; nothing to reroll.
 */

import {
  defineEffect,
  staticGpuEffect,
  type ParamDescriptor,
} from "../types/registry";
import type { CurvePoint, ParameterValue } from "../types/document";
import type {
  ComputePass,
  GpuEffect,
  InstanceDataBinding,
  InstanceDataInput,
  PassBinding,
  UniformLayout,
} from "../types/gpu";
import { logger } from "../lib/log";
import { CurveLutError, buildCurveLut } from "./curves.effect";

import wgsl from "../shaders/gen-gradient.wgsl?raw";

const log = logger("gpu");

/**
 * Canonical binding numbers, restated from `shaders/CONVENTIONS.md`.
 *
 * **There is no `inputColor`.** That absence is what makes this a source, and
 * `gpu/compiler.ts` checks it against the descriptor's slot both ways.
 */
export const GEN_GRADIENT_BINDING = {
  outputColor: 1,
  uniforms: 5,
  /** First effect-specific slot; `curves` numbers its own LUT the same. */
  lut: 6,
} as const;

/** Names this node's bulk data, so two slots on one pass cannot collide. */
export const GEN_GRADIENT_LUT_SLOT = "ramp-lut";

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const GEN_GRADIENT_PARAM = {
  kind: "kind",
  repeats: "repeats",
  centerX: "centerX",
  centerY: "centerY",
  angle: "angle",
  extent: "extent",
  mirror: "mirror",
  invert: "invert",
  ramp: "ramp",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/gen-gradient.wgsl`.
 *
 * Ten 4-byte scalars occupy 40 bytes and the block rounds up to 48; the two
 * tail words are declared as padding in the shader and written by nobody.
 */
export const GEN_GRADIENT_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: GEN_GRADIENT_PARAM.kind }, type: "u32", offset: 8 },
    { source: { kind: "param", key: GEN_GRADIENT_PARAM.repeats }, type: "u32", offset: 12 },
    { source: { kind: "param", key: GEN_GRADIENT_PARAM.centerX }, type: "f32", offset: 16 },
    { source: { kind: "param", key: GEN_GRADIENT_PARAM.centerY }, type: "f32", offset: 20 },
    { source: { kind: "param", key: GEN_GRADIENT_PARAM.angle }, type: "f32", offset: 24 },
    { source: { kind: "param", key: GEN_GRADIENT_PARAM.extent }, type: "f32", offset: 28 },
    { source: { kind: "param", key: GEN_GRADIENT_PARAM.mirror }, type: "u32", offset: 32 },
    { source: { kind: "param", key: GEN_GRADIENT_PARAM.invert }, type: "u32", offset: 36 },
  ],
};

/** The identity ramp: the diagonal, which is a plain linear gradient. */
export const GEN_GRADIENT_DEFAULT_RAMP: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

function isCurvePoint(value: unknown): value is CurvePoint {
  if (typeof value !== "object" || value === null) return false;
  const point = value as { x?: unknown; y?: unknown };
  return (
    typeof point.x === "number" &&
    Number.isFinite(point.x) &&
    typeof point.y === "number" &&
    Number.isFinite(point.y)
  );
}

/**
 * The node's ramp control points, or a refusal naming what was wrong.
 *
 * A reader of its own rather than `curves`': the messages name *this*
 * parameter, and a builder that silently substituted a diagonal for a malformed
 * curve would render a gradient the document does not describe.
 */
function readRamp(value: ParameterValue | undefined): readonly CurvePoint[] {
  if (value === undefined) {
    throw new CurveLutError(
      `no value for parameter "${GEN_GRADIENT_PARAM.ramp}" on this node`,
    );
  }
  if (!Array.isArray(value) || !value.every(isCurvePoint)) {
    throw new CurveLutError(
      `parameter "${GEN_GRADIENT_PARAM.ramp}" is not a list of finite {x, y} control points`,
    );
  }
  const points = value as readonly CurvePoint[];
  if (points.length < 2) {
    throw new CurveLutError(
      `a ramp needs at least two control points; this node carries ${points.length}`,
    );
  }
  let previousX = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      throw new CurveLutError(
        `control point (${point.x}, ${point.y}) is outside the unit square`,
      );
    }
    if (point.x <= previousX) {
      throw new CurveLutError(
        `control point x=${point.x} does not increase; a ramp must be a function of position`,
      );
    }
    previousX = point.x;
  }
  return points;
}

/** The ramp LUT as bytes, which is what an `instance-data` binding takes. */
export function buildRampLutBytes(input: InstanceDataInput): Uint8Array {
  try {
    const lut = buildCurveLut(readRamp(input.params[GEN_GRADIENT_PARAM.ramp]));
    return new Uint8Array(lut.buffer);
  } catch (error) {
    // Logged here and rethrown: `resolveInstanceData` reports the pass and the
    // slot but cannot say which control point was wrong.
    log.error("gradient ramp LUT could not be built", {
      node: input.nodeId,
      slot: GEN_GRADIENT_LUT_SLOT,
      error: String(error),
    });
    throw error;
  }
}

const GEN_GRADIENT_PARAMS: readonly ParamDescriptor[] = [
  {
    key: GEN_GRADIENT_PARAM.kind,
    label: "Geometry",
    type: "enum",
    // A choice, not a quantity: a modulator bound to it would cut between three
    // unrelated geometries rather than animate one.
    animatable: false,
    description:
      "Whether the ramp runs across the frame in a straight line, outward from a point, or around one.",
    // Append-only: the shader reads the ordinal.
    values: [
      { value: "linear", label: "Linear" },
      { value: "radial", label: "Radial" },
      { value: "conical", label: "Conical" },
    ],
    default: "linear",
    surprise: {
      values: [
        { value: "linear", weight: 2 },
        { value: "radial", weight: 1.5 },
        // The loudest of the three: a conical ramp has a discontinuity at its
        // own seam unless the ramp curve returns to where it started.
        { value: "conical", weight: 0.8 },
      ],
      weight: 1,
    },
  },
  {
    key: GEN_GRADIENT_PARAM.centerX,
    label: "Centre X",
    type: "float",
    animatable: true,
    description:
      "Where the ramp is anchored across the frame, as a fraction of its width. A linear ramp's midpoint, a radial one's origin, a conical one's axis.",
    // Past the edge on purpose, so a bound modulator can sweep the anchor
    // through the frame and out of it.
    legal: [-1, 2],
    default: 0.5,
    step: 0.001,
    surprise: {
      range: [0.2, 0.8],
      distribution: { kind: "normal", mean: 0.5, sigma: 0.2 },
      weight: 0.7,
    },
  },
  {
    key: GEN_GRADIENT_PARAM.centerY,
    label: "Centre Y",
    type: "float",
    animatable: true,
    description:
      "Where the ramp is anchored down the frame, as a fraction of its height. 0 is the top edge.",
    legal: [-1, 2],
    default: 0.5,
    step: 0.001,
    surprise: {
      range: [0.2, 0.8],
      distribution: { kind: "normal", mean: 0.5, sigma: 0.2 },
      weight: 0.7,
    },
  },
  {
    key: GEN_GRADIENT_PARAM.angle,
    label: "Angle",
    type: "float",
    animatable: true,
    // Turns, not degrees — CONVENTIONS.md.
    description:
      "Which way a linear ramp runs, or where a conical one starts, in turns. 0 runs it left to right, 0.25 top to bottom. Radial ignores it.",
    legal: [-1, 1],
    default: 0,
    step: 0.001,
    surprise: {
      range: [0, 1],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: GEN_GRADIENT_PARAM.extent,
    label: "Extent",
    type: "float",
    animatable: true,
    description:
      "How far the ramp takes to complete, as a fraction of the frame's short side. At 1 a radial ramp reaches full tone at the short edge. Conical ignores it.",
    // Strictly positive: it is a divisor, and a zero-length ramp is a step
    // function with no position for it to step at.
    legal: [0.01, 8],
    default: 1,
    step: 0.01,
    surprise: {
      // Log, because this is a length and the interesting range is octaves
      // wide: 0.2 is a tight core, 4 is a barely-visible wash.
      range: [0.3, 3],
      distribution: { kind: "log" },
      weight: 0.9,
    },
  },
  {
    key: GEN_GRADIENT_PARAM.repeats,
    label: "Repeats",
    type: "int",
    // Integral and discrete: ramping it jumps a whole band per integer.
    animatable: false,
    description:
      "How many times the ramp is tiled across its extent. 1 clamps at both ends, which is an ordinary gradient; more turns it into bands.",
    legal: [1, 64],
    default: 1,
    surprise: {
      // Past about twelve the bands are finer than a dither can resolve on a
      // normal frame, and the result is grey (F-SM-04).
      range: [1, 10],
      distribution: { kind: "log" },
      weight: 0.8,
    },
  },
  {
    key: GEN_GRADIENT_PARAM.mirror,
    label: "Mirror repeats",
    type: "bool",
    animatable: false,
    description:
      "Make every other tile run backwards, so repeated bands join smoothly instead of cutting from the ramp's end back to its start.",
    default: true,
    surprise: {
      // High: an unmirrored repeat has a hard seam per tile, which is
      // occasionally the point and usually an accident.
      trueProbability: 0.75,
      weight: 0.4,
    },
  },
  {
    key: GEN_GRADIENT_PARAM.invert,
    label: "Flip",
    type: "bool",
    animatable: false,
    description: "Run the ramp the other way round, so it ends where it started.",
    default: false,
    surprise: {
      trueProbability: 0.5,
      weight: 0.4,
    },
  },
  {
    key: GEN_GRADIENT_PARAM.ramp,
    label: "Ramp",
    type: "curve",
    description:
      "The shape of the ramp from start to end. The diagonal is an even fade; an S eases both ends, a step makes a hard edge with no fade at all.",
    // A curve is bulk data rebuilt from its control points, not a number a
    // modulator can ramp. Animating a *shape* is a keyframe track over the
    // points, which is a different mechanism.
    animatable: false,
    default: GEN_GRADIENT_DEFAULT_RAMP,
    surprise: {
      // Archetypes, not sampled control points — the same argument
      // `curves.effect.ts` makes: drawn points give curves that are legal and
      // useless.
      archetypes: [
        // Linear stays common: the plain ramp is the thing a gradient is for,
        // and every other archetype is a variation on it.
        { value: "linear", weight: 2 },
        { value: "s-curve", weight: 1.4 },
        { value: "inverse-s", weight: 0.8 },
        { value: "lift", weight: 0.8 },
        { value: "crush", weight: 0.8 },
        { value: "invert", weight: 0.3 },
      ],
      jitter: 0.1,
      weight: 0.9,
    },
  },
];

export default defineEffect({
  id: "gen-gradient",
  name: "Gradient",
  summary:
    "Fills the frame with a linear, radial or conical ramp — a source node, so it needs no image.",
  description:
    "A generator: it takes no picture and makes one from its parameters, so a document can start here instead of with a photograph. The three geometries differ only in how a pixel becomes a position along the ramp — across the frame, outward from a point, or around one — and everything after that is shared, including the ramp's own shape, which is the same transfer curve the Curves node uses. The diagonal is an even fade, an S eases both ends, and a step gives a hard edge with no fade at all. Repeats tile the ramp into bands, and mirroring makes those bands join instead of cutting. It is greyscale on purpose: put Gradient map after it for colour, which gives you a real colour picker rather than six numbers pretending to be two colours. A gradient is what a dither has the most to say about — a smooth ramp is precisely the thing a small palette cannot represent, so every kernel in the catalogue draws a visibly different texture across one.",
  keywords: [
    "gradient",
    "ramp",
    "fade",
    "linear gradient",
    "radial gradient",
    "conical",
    "angular",
    "sweep",
    "cone",
    "generator",
    "source",
    "background",
    "backdrop",
    "bands",
    "banding",
    "test ramp",
    "greyscale ramp",
    "grayscale ramp",
    "no image",
    "from scratch",
    "touchdesigner",
  ],
  concept: "tone-and-colour",
  requirement: "F-GN-02",
  slot: "source",
  family: "pattern",
  execution: "gpu",
  params: GEN_GRADIENT_PARAMS,
  surpriseWeight: 0.6,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const GEN_GRADIENT_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  GEN_GRADIENT_PARAMS.map((param) => [param.key, param]),
);

/**
 * This node's own ramp table.
 *
 * `supplied: "none"` because everything it is built from is a parameter — the
 * uploaded-asset channel is F-PP-07's, not this one's.
 */
const lutBinding: InstanceDataBinding = {
  role: "instance-data",
  binding: GEN_GRADIENT_BINDING.lut,
  slot: GEN_GRADIENT_LUT_SLOT,
  supplied: "none",
  build: buildRampLutBytes,
};

const bindings: readonly PassBinding[] = [
  // No `input-color`. That absence is the whole of what makes this a source.
  { role: "output-color", binding: GEN_GRADIENT_BINDING.outputColor },
  { role: "uniforms", binding: GEN_GRADIENT_BINDING.uniforms },
  lutBinding,
];

const pass: ComputePass = {
  id: "gen-gradient/main",
  label: "Gradient source",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Every pixel is a closed-form function of its own coordinate.
  access: "pointwise",
  bindings,
  uniforms: GEN_GRADIENT_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const GEN_GRADIENT_GPU: GpuEffect = {
  effect: "gen-gradient",
  passes: [pass],
};

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("gen-gradient", () => GEN_GRADIENT_GPU);
