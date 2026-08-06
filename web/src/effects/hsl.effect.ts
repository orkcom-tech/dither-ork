/**
 * Hue, saturation, lightness (F-PP-04).
 *
 * One pointwise compute pass, and the decision the file exists to record is
 * **OKLab, not HSL** — argued in full at the top of `../shaders/hsl.wgsl`.
 * Short version: HSL's lightness is `(max + min) / 2` of the sRGB channels,
 * which puts pure yellow and pure blue at the same number while one is roughly
 * nine times brighter; its hue is an angle on a hexagon, so a constant rotation
 * is not a constant perceptual step and an animated sweep visibly accelerates;
 * and every other colour decision in this repository is already made in OKLab,
 * so editing colour in a second space is how a hue rotation walks a picture off
 * the palette it was chosen for.
 *
 * The descriptor, the uniform layout and the compute pass are all in this file;
 * see `./invert.effect.ts` for why they may not be separated.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/hsl.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const HSL_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const HSL_PARAM = {
  hue: "hue",
  saturation: "saturation",
  lightness: "lightness",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/hsl.wgsl`. Five 4-byte scalars occupy 20 bytes; the block is
 * declared at 32 because WGSL rounds a uniform struct up to a multiple of 16,
 * and the shader states the three pad members explicitly rather than leaving
 * the size to be inferred from that rule.
 */
export const HSL_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: HSL_PARAM.hue }, type: "f32", offset: 8 },
    { source: { kind: "param", key: HSL_PARAM.saturation }, type: "f32", offset: 12 },
    { source: { kind: "param", key: HSL_PARAM.lightness }, type: "f32", offset: 16 },
  ],
};

export const HSL_PARAMS: readonly ParamDescriptor[] = [
  {
    key: HSL_PARAM.hue,
    label: "Hue",
    type: "float",
    // Turns, not degrees, per CONVENTIONS.md: a modulator ramping 0 -> 1 lands
    // exactly back where it started, so an animated rotation closes the loop by
    // construction and the UI never has to know that 360 is special.
    hint: "Rotation of the OKLab hue plane, in turns. 0.5 is the opposite hue; 0.95 is a small shift backwards.",
    animatable: true,
    legal: [0, 1],
    default: 0,
    step: 0.005,
    surprise: {
      // The whole legal range, deliberately, and for the same reason emboss's
      // light angle uses its whole range: a hue rotation is a rigid rotation of
      // the colour plane, so every setting produces a coherent picture and none
      // is unmusical. Narrowing it would only mean every random recolour landed
      // in the same quadrant.
      range: [0, 1],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: HSL_PARAM.saturation,
    label: "Saturation",
    type: "float",
    hint: "Gain on OKLab chroma at constant lightness. 0 is neutral grey; above 1 pushes colour out of gamut.",
    animatable: true,
    // Zero is legal and is the greyscale conversion, which is a real setting
    // rather than an edge case. Three is well past the sRGB gamut for anything
    // already saturated, so the ceiling is where the control stops changing the
    // picture rather than where it stops being defined.
    legal: [0, 3],
    default: 1,
    step: 0.01,
    surprise: {
      // Down to a third — where the frame reads as tinted monochrome and a
      // small palette still has something to match against — and up to 1.8,
      // past which most of the frame is clipped to the gamut boundary and every
      // draw looks like every other.
      range: [0.3, 1.8],
      // A gain is multiplicative: halving and doubling are the same size of
      // step, and uniform sampling would spend most of its draws above 1.
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: HSL_PARAM.lightness,
    label: "Lightness",
    type: "float",
    hint: "Offset on OKLab lightness. Perceptually even, so ±0.1 is the same visible step at every hue.",
    animatable: true,
    // OKLab L spans [0, 1] across the display range, so a full-range offset in
    // either direction is the most that can move the picture.
    legal: [-1, 1],
    default: 0,
    step: 0.005,
    surprise: {
      // A tenth of the perceptual range either way is a visible lift or drop
      // that still leaves both ends of the tone scale occupied.
      range: [-0.15, 0.15],
      distribution: { kind: "normal", mean: 0, sigma: 0.07 },
      weight: 0.7,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. Every field here is numeric,
 * so the packer does not strictly need them; supplied anyway so a later enum —
 * whose document value is a string and whose numeric form is its ordinal —
 * cannot be added without the map that resolves it already being in place.
 */
export const HSL_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  HSL_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: HSL_BINDING.inputColor },
  { role: "output-color", binding: HSL_BINDING.outputColor },
  { role: "uniforms", binding: HSL_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "hsl/main",
  label: "Hue / saturation / lightness",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  access: "pointwise",
  bindings,
  uniforms: HSL_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const HSL_GPU: GpuEffect = {
  effect: "hsl",
  passes: [pass],
};

export default defineEffect({
  id: "hsl",
  name: "Hue / saturation / lightness",
  requirement: "F-PP-04",
  // Preprocess. Placed after a quantizer this would rewrite every pixel's
  // colour while the index map beside it still named the old palette entries —
  // and rotating hue before the palette match is the point anyway, since it
  // changes which entry each pixel lands on rather than repainting the result.
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: HSL_PARAMS,
  // Below the tone controls. A hue rotation is a strong, legible move that
  // rarely wants to be combined with much else, so it should turn up often
  // enough to be a look and not so often that it is the house style.
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("hsl", () => HSL_GPU);
