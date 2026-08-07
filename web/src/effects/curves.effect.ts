/**
 * Curves (F-PP-05).
 *
 * An editable spline, per channel or on luma. One pointwise compute pass, and
 * one thing this file does that no other effect module does: it turns the
 * node's `curve` parameter into the 256-entry transfer LUT the shader samples,
 * as per-node bulk data.
 *
 * **Why the curve does not travel in the uniform block.** `packUniforms`
 * refuses a curve by name, and it is right to: a block whose size depended on
 * how many control points the user had dragged would be a different
 * `UniformLayout` per document, and the layout is what the pipeline is compiled
 * against. `InstanceDataBinding` is the channel `web/src/types/gpu.ts` provides
 * instead — bytes belonging to one node, digested so that a slider drag which
 * leaves the curve alone costs no upload and a curve edit costs exactly one.
 *
 * **Why a monotone cubic and not a Catmull–Rom.** A curve editor's control
 * points are a shape the user drew, and a spline that overshoots between them
 * inverts local contrast — a lifted shadow point produces a dip *below* black
 * on the way to it, which reads as a hard band in the darks and is nowhere in
 * the shape that was drawn. Fritsch–Carlson limits the tangents so no segment
 * leaves the interval its own endpoints span. The cost is that the curve is C¹
 * rather than C², which nothing here can see.
 *
 * The domain argument — the transfer is defined on the sRGB-encoded value, not
 * on linear light — is at the top of `../shaders/curves.wgsl`, together with
 * why this node clips headroom and what the two modes differ in.
 */

import type { CurvePoint, ParameterValue } from "../types/document";
import { defineEffect, staticGpuEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  InstanceDataBinding,
  InstanceDataInput,
  PassBinding,
  UniformLayout,
} from "../types/gpu";
import { logger } from "../lib/log";

import wgsl from "../shaders/curves.wgsl?raw";

const log = logger("gpu");

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const CURVES_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
  lut: 6,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const CURVES_PARAM = {
  curve: "curve",
  mode: "mode",
} as const;

/**
 * Names this node's bulk data within the node, so the buffer cache can key on
 * it and a second instance-data slot could never collide with it.
 */
export const CURVES_LUT_SLOT = "curve-lut";

/**
 * Entries in the transfer LUT: one per 8-bit code.
 *
 * 256 because that is the resolution a curve is *drawn* against — the histogram
 * behind the editor has 256 columns — so a control point dragged onto a code
 * lands on that code exactly. Restated as `LUT_LAST` in the shader.
 */
export const CURVE_LUT_SIZE = 256;

/** Thrown when a node's `curve` parameter cannot be turned into a transfer. */
export class CurveLutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurveLutError";
  }
}

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
 * Read the node's control points, refusing anything that is not a transfer
 * curve.
 *
 * The same four conditions `registry/params.ts` checks when a document is
 * loaded — two or more points, inside the unit square, strictly increasing in
 * x, spanning x = 0 to x = 1 — restated here because this builder is handed a
 * node's parameters by whoever assembled them, and a curve that stops short of
 * x = 1 leaves the brightest pixels with no defined output. Refused rather than
 * extended: extrapolating past the last point would invent a transfer the user
 * never drew, and it would do so silently.
 */
function readCurve(value: ParameterValue | undefined): readonly CurvePoint[] {
  if (value === undefined) {
    throw new CurveLutError(`no value for parameter "${CURVES_PARAM.curve}" on this node`);
  }
  if (!Array.isArray(value) || !value.every(isCurvePoint)) {
    throw new CurveLutError(
      `parameter "${CURVES_PARAM.curve}" is not a list of finite {x, y} control points`,
    );
  }
  const points = value as readonly CurvePoint[];
  if (points.length < 2) {
    throw new CurveLutError(
      `a transfer curve needs at least two control points; this node carries ${points.length}`,
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
        `control point x=${point.x} does not increase; a transfer curve must be a function of x`,
      );
    }
    previousX = point.x;
  }

  const first = points[0];
  const last = points[points.length - 1];
  // Both are present — `points.length >= 2` — but `noUncheckedIndexedAccess`
  // does not know that, and asserting it is cheaper than a non-null assertion
  // that would also silence a real absence.
  if (first === undefined || last === undefined || first.x !== 0 || last.x !== 1) {
    throw new CurveLutError(
      "a transfer curve must span x = 0 to x = 1, or some inputs have no output",
    );
  }
  return points;
}

/**
 * Fritsch–Carlson tangents: the slopes that make a cubic Hermite interpolant
 * stay inside the interval its own control points span.
 *
 * Two rules, both from the 1980 paper. A control point that is a local extremum
 * gets a zero tangent, because any nonzero slope there pushes the curve past
 * the point that was drawn. And a segment whose endpoint tangents are more than
 * three times its secant is rescaled until they are not, which is the exact
 * condition for monotone interpolation.
 */
function hermiteTangents(
  xs: readonly number[],
  ys: readonly number[],
): readonly number[] {
  const n = xs.length;
  const secant: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const y0 = ys[i];
    const y1 = ys[i + 1];
    if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) {
      throw new CurveLutError("control point arrays are ragged");
    }
    secant.push((y1 - y0) / (x1 - x0));
  }

  const tangent: number[] = new Array<number>(n).fill(0);
  const firstSecant = secant[0];
  const lastSecant = secant[n - 2];
  if (firstSecant === undefined || lastSecant === undefined) {
    throw new CurveLutError("a transfer curve needs at least two control points");
  }
  tangent[0] = firstSecant;
  tangent[n - 1] = lastSecant;
  for (let i = 1; i < n - 1; i += 1) {
    const before = secant[i - 1];
    const after = secant[i];
    if (before === undefined || after === undefined) continue;
    // A local extremum. Left as zero so the curve turns around at the point the
    // user placed rather than beyond it.
    tangent[i] = before * after <= 0 ? 0 : (before + after) / 2;
  }

  for (let i = 0; i < n - 1; i += 1) {
    const delta = secant[i];
    const left = tangent[i];
    const right = tangent[i + 1];
    if (delta === undefined || left === undefined || right === undefined) continue;
    if (delta === 0) {
      // A flat segment: any slope at either end would leave the interval, since
      // the interval is a point.
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const alpha = left / delta;
    const beta = right / delta;
    const magnitude = alpha * alpha + beta * beta;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangent[i] = scale * alpha * delta;
      tangent[i + 1] = scale * beta * delta;
    }
  }

  return tangent;
}

/**
 * Sample the spline into the table the shader reads.
 *
 * Pure and deterministic: additions, multiplications, one division per segment
 * and one square root in the limiter, all of which IEEE-754 specifies exactly.
 * That matters more here than it looks — the determinism test renders one frame
 * in two workers and compares bytes, and this table is part of what is hashed.
 */
export function buildCurveLut(points: readonly CurvePoint[]): Float32Array {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const tangent = hermiteTangents(xs, ys);

  const lut = new Float32Array(CURVE_LUT_SIZE);
  const last = CURVE_LUT_SIZE - 1;
  let segment = 0;

  for (let i = 0; i < CURVE_LUT_SIZE; i += 1) {
    const x = i / last;
    // The samples are increasing, so the segment only ever moves forward: the
    // whole table costs one walk over the control points rather than a binary
    // search per entry.
    while (segment < xs.length - 2) {
      const next = xs[segment + 1];
      if (next === undefined || x < next) break;
      segment += 1;
    }

    const x0 = xs[segment];
    const x1 = xs[segment + 1];
    const y0 = ys[segment];
    const y1 = ys[segment + 1];
    const m0 = tangent[segment];
    const m1 = tangent[segment + 1];
    if (
      x0 === undefined ||
      x1 === undefined ||
      y0 === undefined ||
      y1 === undefined ||
      m0 === undefined ||
      m1 === undefined
    ) {
      throw new CurveLutError(`no curve segment covers x = ${x}`);
    }

    const h = x1 - x0;
    const t = (x - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const y = h00 * y0 + h10 * h * m0 + h01 * y1 + h11 * h * m1;

    // The limiter already keeps each segment inside its own endpoints, and both
    // endpoints are in the unit square, so this clamp catches nothing the maths
    // can produce. It is here because the value is an encoded tone on its way to
    // `srgb_to_linear`, and one outside [0, 1] would come back as a colour the
    // curve does not describe.
    lut[i] = Math.min(1, Math.max(0, y));
  }

  return lut;
}

/**
 * The LUT as bytes, which is what an `instance-data` binding takes.
 *
 * A `Float32Array` view is host-endian and so is a WebGPU buffer's contents;
 * every platform WebGPU ships on is little-endian, which is the same assumption
 * `web/src/gpu/uniforms.ts` states explicitly when it writes its fields.
 */
export function buildCurveLutBytes(input: InstanceDataInput): Uint8Array {
  try {
    const lut = buildCurveLut(readCurve(input.params[CURVES_PARAM.curve]));
    return new Uint8Array(lut.buffer);
  } catch (error) {
    // Logged here and rethrown, because `resolveInstanceData` reports the pass
    // and the slot but cannot say which control point was wrong.
    log.error("curve LUT could not be built", {
      node: input.nodeId,
      slot: CURVES_LUT_SLOT,
      error: String(error),
    });
    throw error;
  }
}

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/curves.wgsl`. Three 4-byte scalars occupy 12 bytes and the block
 * rounds up to 16; the tail word is declared as padding in the shader and
 * written by nobody.
 */
export const CURVES_UNIFORMS: UniformLayout = {
  sizeBytes: 16,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: CURVES_PARAM.mode }, type: "u32", offset: 8 },
  ],
};

/** The identity transfer: the diagonal every curve editor opens on. */
export const CURVES_DEFAULT_CURVE: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const CURVES_PARAMS: readonly ParamDescriptor[] = [
  {
    key: CURVES_PARAM.curve,
    label: "Curve",
    type: "curve",
    description: "Transfer curve on the encoded tone scale. The diagonal is no change.",
    // A curve is bulk data rebuilt from its control points, not a number a
    // modulator can ramp. Animating a *shape* is F-AN's keyframe track over the
    // points, which is a different mechanism from a bound modulator.
    animatable: false,
    default: CURVES_DEFAULT_CURVE,
    surprise: {
      // Archetypes, not sampled control points. Drawing points at random
      // produces curves that are legal and useless — flat in the shadows,
      // clipped in the highlights, non-monotonic in the middle — which is
      // F-SM-04's noise-versus-result distinction in its most extreme form.
      archetypes: [
        // The two that read as a deliberate grade, and the ones a dither
        // flatters: an S adds contrast where the palette has the most entries.
        { value: "s-curve", weight: 1.4 },
        { value: "inverse-s", weight: 0.6 },
        { value: "lift", weight: 0.9 },
        { value: "crush", weight: 0.9 },
        // Kept in and kept low: F-SP-08 inverts properly, and drawing it here
        // as well is a curiosity rather than a look.
        { value: "invert", weight: 0.2 },
      ],
      // Enough to make two draws of one archetype different pictures, small
      // enough that an S-curve stays an S-curve.
      jitter: 0.08,
      weight: 1,
    },
  },
  {
    key: CURVES_PARAM.mode,
    label: "Mode",
    type: "enum",
    description: "Run the curve on each channel, or on luminance alone and scale the colour by the ratio.",
    animatable: false,
    // Append-only: the shader reads the ordinal, so inserting a value in the
    // middle renumbers every document already saved.
    values: [
      { value: "per-channel", label: "Per channel" },
      { value: "luma", label: "Luma" },
    ],
    // Per channel, because that is what a curves dialog's composite channel
    // does and therefore what the shape drawn on screen is calibrated against.
    default: "per-channel",
    surprise: {
      values: [
        { value: "per-channel", weight: 1 },
        { value: "luma", weight: 0.7 },
      ],
      weight: 0.6,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. `mode` is an enum, whose
 * document value is a string and whose numeric form is its position in
 * `values`, so the packer cannot resolve it without this.
 */
export const CURVES_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  CURVES_PARAMS.map((param) => [param.key, param]),
);

/**
 * This node's own transfer table.
 *
 * `supplied: "none"` because everything it is built from is a parameter — the
 * uploaded-asset channel is F-PP-07's, not this one's.
 */
const lutBinding: InstanceDataBinding = {
  role: "instance-data",
  binding: CURVES_BINDING.lut,
  slot: CURVES_LUT_SLOT,
  supplied: "none",
  build: buildCurveLutBytes,
};

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: CURVES_BINDING.inputColor },
  { role: "output-color", binding: CURVES_BINDING.outputColor },
  { role: "uniforms", binding: CURVES_BINDING.uniforms },
  lutBinding,
];

const pass: ComputePass = {
  id: "curves/main",
  label: "Curves",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  access: "pointwise",
  bindings,
  uniforms: CURVES_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const CURVES_GPU: GpuEffect = {
  effect: "curves",
  passes: [pass],
};

export default defineEffect({
  id: "curves",
  name: "Curves",
  summary:
    "An editable transfer curve — drag the shape of the tone response by hand.",
  description:
    "The curve maps input tone to output tone on the display-referred scale, so the diagonal is no change and the shape you draw is the shape you get. It is a monotone cubic rather than a Catmull–Rom on purpose: a spline that overshoots between control points inverts local contrast, and a lifted shadow point would produce a dip below black on the way to it — a hard band in the darks that is nowhere in the shape that was drawn. Per channel runs the curve on red, green and blue independently, which is how a colour cast is put in; luma runs it on brightness alone and scales the colour to match.",
  keywords: ["curves", "curve", "tone curve", "s curve", "spline", "transfer", "contrast", "film look", "fade", "crush"],
  concept: "tone-and-colour",
  requirement: "F-PP-05",
  // Preprocess: a transfer curve decides how much of the tone scale the kernel
  // downstream has to work with. After a quantizer it would rewrite every
  // pixel's colour while the index map beside it still named the old palette
  // entries.
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: CURVES_PARAMS,
  // Below levels, which is below brightness/contrast, for the same reason each
  // time: the more freedom a control has, the less often a random draw of it
  // lands on a picture. A curve has the most freedom in the family.
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("curves", () => CURVES_GPU);
