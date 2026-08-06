/**
 * F-GL-07 — Datamosh smear: directional pixel drag.
 *
 * The algorithm, and why it is a gated back-trace rather than a directional
 * blur, is documented in `web/src/shaders/datamosh-smear.wgsl` next to the
 * arithmetic.
 *
 * This one does carry a `seed` parameter, unlike the other two glitch effects
 * in this batch. `StackNode.seed` already gives every node one, but the glitch
 * family exposes the seed as a control in its own right (see `SeedParam` in
 * `web/src/types/registry.ts`), and here it is not decorative: it selects the
 * per-trail reach that `jitter` scales, which is the difference between a
 * ragged smear and a comb.
 *
 * Descriptor, uniform layout and compute pass are in this one file so that
 * adding an effect edits nothing central — see `web/src/registry/README.md`.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/datamosh-smear.wgsl?raw";

/** Registry id. Used for the pass id and the shader file name. */
export const DATAMOSH_SMEAR_ID = "datamosh-smear";

/**
 * Longest drag the shader will walk, in pixels.
 *
 * Restated as `MAX_STEPS` in the WGSL, which bounds its loop at compile time.
 * The legal range of `dragLength` ends here so the two agree: a legal range
 * that reached further would produce drags that silently stop short.
 */
export const DATAMOSH_MAX_DRAG = 128;

/** Canonical binding numbers, restated from CONVENTIONS.md. */
export const DATAMOSH_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const DATAMOSH_PARAM = {
  angle: "angle",
  dragLength: "dragLength",
  threshold: "threshold",
  source: "source",
  decay: "decay",
  jitter: "jitter",
  seed: "seed",
} as const;

/**
 * Which pixels drag, in the order the shader's ordinals expect.
 *
 * Append-only: the packer sends an enum as its position in this list, so
 * inserting a value in the middle renumbers every saved document.
 */
const SOURCE_VALUES = [
  { value: "bright", label: "Bright" },
  { value: "dark", label: "Dark" },
] as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `datamosh-smear.wgsl`.
 *
 * All 4-byte scalars, integers first, so no field needs padding in front of it
 * and the only padding is the tail that rounds 36 up to 48.
 */
export const DATAMOSH_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    // The effect's own seed parameter, not the `seed` builtin: the builtin
    // carries the node's document seed, and this control is the one the user
    // rerolls.
    { source: { kind: "param", key: DATAMOSH_PARAM.seed }, type: "u32", offset: 8 },
    { source: { kind: "param", key: DATAMOSH_PARAM.source }, type: "u32", offset: 12 },
    { source: { kind: "param", key: DATAMOSH_PARAM.angle }, type: "f32", offset: 16 },
    { source: { kind: "param", key: DATAMOSH_PARAM.dragLength }, type: "f32", offset: 20 },
    { source: { kind: "param", key: DATAMOSH_PARAM.threshold }, type: "f32", offset: 24 },
    { source: { kind: "param", key: DATAMOSH_PARAM.decay }, type: "f32", offset: 28 },
    { source: { kind: "param", key: DATAMOSH_PARAM.jitter }, type: "f32", offset: 32 },
  ],
};

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: DATAMOSH_PARAM.angle,
    label: "Drag angle",
    type: "float",
    // Turns, not degrees: a modulator ramping 0 -> 1 sweeps a full rotation and
    // lands back where it started, so an animated drag closes its loop by
    // construction rather than by the UI knowing that 360 is special.
    hint: "Direction the picture is dragged, in turns. 0 drags to the right.",
    animatable: true,
    legal: [-1, 1],
    default: 0,
    surprise: {
      // Near-horizontal. A mosh follows the codec's macroblock motion, which is
      // dominated by horizontal panning; steep diagonals read as motion blur
      // rather than as a mosh, so they stay a deliberate choice (F-SM-04).
      range: [-0.15, 0.15],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: DATAMOSH_PARAM.dragLength,
    label: "Drag length",
    type: "float",
    hint: "How far a source pixel may be carried, in pixels.",
    animatable: true,
    // The upper bound is the shader's compile-time loop bound. See
    // DATAMOSH_MAX_DRAG.
    legal: [0, DATAMOSH_MAX_DRAG],
    default: 24,
    step: 1,
    surprise: {
      // Measured in octaves — uniform sampling of 4..64 spends most of its
      // draws above 32, where the whole frame is one streak.
      range: [4, 64],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: DATAMOSH_PARAM.threshold,
    label: "Threshold",
    type: "float",
    // Stated in display terms and converted to linear light inside the shader,
    // because 0.5 has to mean mid grey. See the note in the WGSL.
    hint: "Lightness that separates the pixels that drag from the ones they drag over. 0.5 is mid grey.",
    animatable: true,
    legal: [0, 1],
    default: 0.5,
    step: 0.01,
    surprise: {
      // Outside this the threshold takes either almost every pixel — nothing
      // drags because everything is a source — or almost none, and both ends
      // are the input image back again.
      range: [0.2, 0.8],
      distribution: { kind: "normal", mean: 0.5, sigma: 0.15 },
      weight: 1,
    },
  },
  {
    key: DATAMOSH_PARAM.source,
    label: "Drag source",
    type: "enum",
    hint: "Whether the pixels that smear forward are the ones above the threshold or below it.",
    // Not animatable: it is a choice between two pictures, not a quantity, and
    // a modulator on an ordinal would flicker between them.
    animatable: false,
    values: SOURCE_VALUES,
    default: "bright",
    surprise: {
      // Both are real looks and the better one depends entirely on the image,
      // so the draw is close to even; bright leads only because most photographs
      // have more dark area for a bright drag to travel across.
      values: [
        { value: "bright", weight: 3 },
        { value: "dark", weight: 2 },
      ],
      weight: 0.7,
    },
  },
  {
    key: DATAMOSH_PARAM.decay,
    label: "Decay",
    type: "float",
    hint: "Per-pixel falloff of the carried colour. 1 is a hard drag for the whole length.",
    animatable: true,
    legal: [0, 1],
    // 1 is the plain definition of the effect: a drag that carries the source
    // colour intact. Anything less is a departure and should be asked for.
    default: 1,
    step: 0.005,
    surprise: {
      // Per *pixel*, so the useful range is compressed hard against 1: at 0.9 a
      // drag is dead after twenty pixels, and below about 0.8 nothing reaches
      // far enough to be a smear at all.
      range: [0.85, 1],
      distribution: { kind: "uniform" },
      weight: 0.7,
    },
  },
  {
    key: DATAMOSH_PARAM.jitter,
    label: "Length jitter",
    type: "float",
    hint: "Seeded variation of the drag length from trail to trail. 0 gives every trail the same reach.",
    animatable: true,
    legal: [0, 1],
    // Off. A uniform reach is the honest base case and the one a golden image
    // can pin; ragged edges are the addition.
    default: 0,
    step: 0.01,
    surprise: {
      // 1 lets a trail draw a reach of zero, which punches holes in the smear.
      // Short of that the edge is ragged rather than broken.
      range: [0, 0.7],
      distribution: { kind: "uniform" },
      weight: 0.8,
    },
  },
  {
    key: DATAMOSH_PARAM.seed,
    label: "Seed",
    type: "seed",
    hint: "Selects which trails reach furthest. Only does anything with jitter above zero.",
    // Not animatable: stepping a seed across a loop produces a new picture per
    // frame rather than a moving one, and it cannot close the seam.
    animatable: false,
    default: 0,
    surprise: { weight: 1 },
  },
];

/**
 * The compute pass.
 *
 * `neighbourhood`, not `pointwise`: the walk reads up to
 * {@link DATAMOSH_MAX_DRAG} texels back along the drag direction, so the input
 * must be a finished texture and cannot alias the output.
 */
export function datamoshSmearEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: DATAMOSH_BINDING.inputColor },
    { role: "output-color", binding: DATAMOSH_BINDING.outputColor },
    { role: "uniforms", binding: DATAMOSH_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: `${DATAMOSH_SMEAR_ID}/drag`,
    label: "Datamosh smear",
    wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings,
    uniforms: DATAMOSH_UNIFORMS,
  };

  return { effect: DATAMOSH_SMEAR_ID, passes: [pass] };
}

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * Load-bearing here: `source` is an enum, and its numeric form is its position
 * in `values`, which only the descriptor knows.
 */
export const DATAMOSH_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

export default defineEffect({
  id: DATAMOSH_SMEAR_ID,
  name: "Datamosh smear",
  requirement: "F-GL-07",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  // Strong and specific: it takes over a picture rather than decorating it, so
  // it should turn up less often than the effects that layer with anything.
  surpriseWeight: 0.7,
  producesIndexMap: false,
  // It moves whole palette colours around rather than mixing them, so applied
  // to a quantized image the result is still on-palette — but the index map
  // that describes which entry is where would need dragging too, and this pass
  // does not write one. The graph reconciles that; the descriptor states only
  // that this node neither reads nor writes one.
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("datamosh-smear", () => datamoshSmearEffect());
