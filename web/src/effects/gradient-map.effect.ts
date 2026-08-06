/**
 * Gradient map / duotone (F-SP-09) — a three-stop editable ramp indexed by
 * tone.
 *
 * One compute pass, read-your-own-pixel.
 *
 * ## Why the stops are nine floats and not three colours
 *
 * F-SP-09 asks for an *editable gradient*, and the registry cannot express one
 * as a single parameter. Two separate walls, both in the current contracts:
 *
 * - The `curve` kind (`web/src/types/registry.ts`) is a scalar transfer curve —
 *   `CurvePoint` is `{x, y}` in the unit square. It has no colour in it at all,
 *   so it cannot describe a ramp no matter how many points it carries.
 * - The `color` kind can describe one stop, but a colour cannot reach a shader.
 *   `ParameterValue` in `web/src/types/document.ts` is `number | boolean |
 *   string`, so a `.dork` file has nowhere to put a triplet — `params.ts` says
 *   as much in the comment on `EffectParamValue` — and `resolveParam` in
 *   `web/src/gpu/uniforms.ts` handles only numbers, booleans and enum strings.
 *   A `color` parameter wired to a uniform field throws `UniformPackError` on
 *   every pack. Same for `curve`, doubly.
 *
 * So the stops are declared as what actually survives the whole path: floats.
 * Three per stop, in **OKLCh** — lightness, chroma, hue — rather than as R, G
 * and B, because that is the axis set `ColorSurprise` already argues for.
 * Sampling sRGB channels independently clumps around muddy mid-greys and gives
 * uneven perceptual lightness; sampling lightness, chroma and hue does not, and
 * a gradient map whose random draws are all mud is a gradient map nobody
 * reaches for twice.
 *
 * What this costs is the UI: three sliders per stop where a swatch belongs.
 * That is a real cost and it is the reason the gap is written up rather than
 * absorbed — see the note at the bottom of this file for the shape the fix
 * needs.
 *
 * Three stops and not N: the parameter list is fixed-arity by construction —
 * every parameter is one declared key — so "editable" here means every stop's
 * colour and the middle stop's position are editable, not that stops can be
 * added. A variable-length gradient needs the same missing machinery as a
 * colour picker does.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/gradient-map.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const GRADIENT_MAP_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const GRADIENT_MAP_PARAM = {
  shadowLightness: "shadowLightness",
  shadowChroma: "shadowChroma",
  shadowHue: "shadowHue",
  midLightness: "midLightness",
  midChroma: "midChroma",
  midHue: "midHue",
  highlightLightness: "highlightLightness",
  highlightChroma: "highlightChroma",
  highlightHue: "highlightHue",
  midPosition: "midPosition",
  amount: "amount",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/gradient-map.wgsl`.
 *
 * Thirteen 4-byte scalars — 52 bytes in a block WGSL rounds up to 64. All
 * scalars deliberately: packing a stop as a `vec3f` would align it to 16 and
 * put holes between the stops that both sides would have to agree about.
 */
export const GRADIENT_MAP_UNIFORMS: UniformLayout = {
  sizeBytes: 64,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.shadowLightness }, type: "f32", offset: 8 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.shadowChroma }, type: "f32", offset: 12 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.shadowHue }, type: "f32", offset: 16 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.midLightness }, type: "f32", offset: 20 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.midChroma }, type: "f32", offset: 24 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.midHue }, type: "f32", offset: 28 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.highlightLightness }, type: "f32", offset: 32 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.highlightChroma }, type: "f32", offset: 36 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.highlightHue }, type: "f32", offset: 40 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.midPosition }, type: "f32", offset: 44 },
    { source: { kind: "param", key: GRADIENT_MAP_PARAM.amount }, type: "f32", offset: 48 },
  ],
};

/**
 * Upper bound offered for a stop's chroma.
 *
 * sRGB tops out near 0.33 in OKLab chroma, which is what `CHROMA_CEILING` in
 * the registry records. Offering more would let the UI ask for colours that
 * come back clipped, so the legal range stops where the gamut does.
 */
const MAX_CHROMA = 0.33;

/** Full turn, in the degrees the hue parameters are measured in. */
const FULL_TURN = 360;

export const GRADIENT_MAP_PARAMS: readonly ParamDescriptor[] = [
  {
    key: GRADIENT_MAP_PARAM.shadowLightness,
    label: "Shadow lightness",
    type: "float",
    hint: "OKLab lightness of the stop the darkest tones map to.",
    animatable: true,
    legal: [0, 1],
    default: 0,
    step: 0.01,
    surprise: {
      // A shadow stop above about a third is not a shadow stop; the ramp comes
      // out with no dark end and the picture reads as flat.
      range: [0, 0.35],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: GRADIENT_MAP_PARAM.shadowChroma,
    label: "Shadow chroma",
    type: "float",
    hint: "OKLab chroma of the shadow stop. 0 is neutral.",
    animatable: true,
    legal: [0, MAX_CHROMA],
    default: 0,
    step: 0.005,
    surprise: {
      // Dark and saturated is where OKLab most often names a colour sRGB cannot
      // show, and the shader clips it. Kept low so a random gradient is not
      // pinned against a face of the cube in its bottom third.
      range: [0, 0.12],
      distribution: { kind: "uniform" },
      weight: 0.8,
    },
  },
  {
    key: GRADIENT_MAP_PARAM.shadowHue,
    label: "Shadow hue",
    type: "float",
    hint: "OKLab hue of the shadow stop, in degrees.",
    animatable: true,
    legal: [0, FULL_TURN],
    default: 0,
    step: 1,
    surprise: {
      // The one place a surprise range is not narrower than its legal range,
      // and for the same reason a seed's is not: no arc of the hue circle is
      // more musical than another, and narrowing it would be a palette
      // preference disguised as sampling metadata. What keeps the result usable
      // is the chroma range above, not a restricted hue.
      range: [0, FULL_TURN],
      distribution: { kind: "uniform" },
      weight: 0.9,
    },
  },
  {
    key: GRADIENT_MAP_PARAM.midLightness,
    label: "Mid lightness",
    type: "float",
    hint: "OKLab lightness of the stop the mid tones map to.",
    animatable: true,
    legal: [0, 1],
    default: 0.5,
    step: 0.01,
    surprise: {
      // Kept between the shadow and highlight surprise ranges so a random ramp
      // rises monotonically. Nothing enforces the ordering — a ramp that dips
      // in the middle is a legal and occasionally wanted look — but it is not
      // what a reroll should hand you by default.
      range: [0.35, 0.7],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: GRADIENT_MAP_PARAM.midChroma,
    label: "Mid chroma",
    type: "float",
    hint: "OKLab chroma of the mid stop. This is where a duotone gets its colour.",
    animatable: true,
    legal: [0, MAX_CHROMA],
    default: 0,
    step: 0.005,
    surprise: {
      // The mid tones are where the gamut is widest, so this one is allowed
      // further than the two end stops.
      range: [0, 0.16],
      distribution: { kind: "uniform" },
      weight: 0.8,
    },
  },
  {
    key: GRADIENT_MAP_PARAM.midHue,
    label: "Mid hue",
    type: "float",
    hint: "OKLab hue of the mid stop, in degrees.",
    animatable: true,
    legal: [0, FULL_TURN],
    default: 0,
    step: 1,
    surprise: {
      range: [0, FULL_TURN],
      distribution: { kind: "uniform" },
      weight: 0.9,
    },
  },
  {
    key: GRADIENT_MAP_PARAM.highlightLightness,
    label: "Highlight lightness",
    type: "float",
    hint: "OKLab lightness of the stop the brightest tones map to.",
    animatable: true,
    legal: [0, 1],
    default: 1,
    step: 0.01,
    surprise: {
      range: [0.7, 1],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: GRADIENT_MAP_PARAM.highlightChroma,
    label: "Highlight chroma",
    type: "float",
    hint: "OKLab chroma of the highlight stop. 0 is neutral.",
    animatable: true,
    legal: [0, MAX_CHROMA],
    default: 0,
    step: 0.005,
    surprise: {
      // Light and saturated leaves the cube even sooner than dark and
      // saturated, so this is the tightest of the three.
      range: [0, 0.1],
      distribution: { kind: "uniform" },
      weight: 0.8,
    },
  },
  {
    key: GRADIENT_MAP_PARAM.highlightHue,
    label: "Highlight hue",
    type: "float",
    hint: "OKLab hue of the highlight stop, in degrees.",
    animatable: true,
    legal: [0, FULL_TURN],
    default: 0,
    step: 1,
    surprise: {
      range: [0, FULL_TURN],
      distribution: { kind: "uniform" },
      weight: 0.9,
    },
  },
  {
    key: GRADIENT_MAP_PARAM.midPosition,
    label: "Mid position",
    type: "float",
    hint: "Where along the tonal range the mid stop sits.",
    animatable: true,
    // Not [0, 1]: at either end the mid stop coincides with an end stop and one
    // half of the ramp has zero width. The shader floors it anyway, because a
    // hand-edited document can carry anything, but the UI never offers it.
    legal: [0.05, 0.95],
    default: 0.5,
    step: 0.01,
    surprise: {
      range: [0.3, 0.7],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
  },
  {
    key: GRADIENT_MAP_PARAM.amount,
    label: "Amount",
    type: "float",
    hint: "Blend between the source colours and the mapped ramp.",
    animatable: true,
    legal: [0, 1],
    default: 1,
    step: 0.01,
    surprise: {
      // Below about 0.6 the source colour dominates and the ramp reads as a
      // tint rather than as a gradient map.
      range: [0.6, 1],
      distribution: { kind: "uniform" },
      weight: 0.5,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * Every parameter here is a float, so this map is only ever consulted to
 * confirm that — but the packer takes one for every effect, and supplying it is
 * what makes adding an enum stop-interpolation mode later an edit rather than a
 * runtime failure.
 */
export const GRADIENT_MAP_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  GRADIENT_MAP_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: GRADIENT_MAP_BINDING.inputColor },
  { role: "output-color", binding: GRADIENT_MAP_BINDING.outputColor },
  { role: "uniforms", binding: GRADIENT_MAP_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "gradient-map/main",
  label: "Gradient map",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  access: "pointwise",
  bindings,
  uniforms: GRADIENT_MAP_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const GRADIENT_MAP_GPU: GpuEffect = {
  effect: "gradient-map",
  passes: [pass],
};

export default defineEffect({
  id: "gradient-map",
  name: "Gradient map",
  requirement: "F-SP-09",
  // Preprocess: this rewrites every colour in the frame, so downstream of a
  // quantizer it would leave the index map describing an image that no longer
  // exists. Recolouring an already-indexed image is F-CO-07's per-node palette
  // override and F-SP-11's index-map work, not this node's.
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: GRADIENT_MAP_PARAMS,
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
});

// --- what the registry would need to express this properly ---------------
//
// Two changes, in the order they have to happen, both outside this file:
//
// 1. `ParameterValue` in web/src/types/document.ts has to be able to carry a
//    composite value, or `.dork` has to state how a colour and a curve are
//    serialised. `registry/params.ts` already names this gap in the comment on
//    `EffectParamValue` and deliberately does not invent a packing, which is
//    the right call — it is a schema decision, not a helper's.
// 2. `UniformField` in web/src/types/gpu.ts needs a source that can fill a
//    `vec3f` from a `color` parameter (converted to linear light on the CPU,
//    like the palette buffer's entries already are), and `resolveParam` in
//    web/src/gpu/uniforms.ts needs the matching case.
//
// With both, this effect's nine float parameters collapse to three `color`
// parameters and the surprise metadata becomes three `ColorSurprise` blocks
// saying exactly what the nine say now. A variable-length gradient needs one
// thing more — an array-shaped parameter kind, or a small per-node storage
// buffer role — and that is a bigger decision than this effect should force.

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("gradient-map", () => GRADIENT_MAP_GPU);
