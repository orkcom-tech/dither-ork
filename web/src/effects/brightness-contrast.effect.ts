/**
 * Brightness, contrast, exposure (F-PP-02).
 *
 * One pointwise compute pass. The interesting content is not in this file — it
 * is the domain each of the three controls is defined in, argued in full at the
 * top of `../shaders/brightness-contrast.wgsl`. Short version: exposure is a
 * multiply in linear light because that is what a stop *is*; brightness and
 * contrast are a translate and a gain on the sRGB-encoded value, because an
 * affine transfer only means what its name says where the steps are evenly
 * spaced to the eye. The contrast pivot is 0.5 in that encoded domain — visual
 * mid-grey, linear 0.2140 — and it is fixed rather than exposed, because an
 * arbitrary pivot with an arbitrary gain is what the levels node (F-PP-03) is.
 *
 * First member of the `preprocess` **family**, which until now had no
 * descriptors at all while the `preprocess` **slot** was full of `special`.
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

import wgsl from "../shaders/brightness-contrast.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const BRIGHTNESS_CONTRAST_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const BRIGHTNESS_CONTRAST_PARAM = {
  exposure: "exposure",
  contrast: "contrast",
  brightness: "brightness",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/brightness-contrast.wgsl`. Five 4-byte scalars occupy 20 bytes;
 * the block is declared at 32 because WGSL rounds a uniform struct up to a
 * multiple of 16, and the shader states the three pad members explicitly rather
 * than leaving the size to be inferred from that rule.
 */
export const BRIGHTNESS_CONTRAST_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    {
      source: { kind: "param", key: BRIGHTNESS_CONTRAST_PARAM.exposure },
      type: "f32",
      offset: 8,
    },
    {
      source: { kind: "param", key: BRIGHTNESS_CONTRAST_PARAM.contrast },
      type: "f32",
      offset: 12,
    },
    {
      source: { kind: "param", key: BRIGHTNESS_CONTRAST_PARAM.brightness },
      type: "f32",
      offset: 16,
    },
  ],
};

export const BRIGHTNESS_CONTRAST_PARAMS: readonly ParamDescriptor[] = [
  {
    key: BRIGHTNESS_CONTRAST_PARAM.exposure,
    label: "Exposure",
    type: "float",
    description: "Stops of light, applied in linear light. +1 doubles the scene, -1 halves it.",
    animatable: true,
    // Eight stops either way is 256:1, which is the whole useful travel of a
    // float buffer in both directions; past that everything is clipped white or
    // indistinguishable from black.
    legal: [-8, 8],
    // Identity. This node is a correction before it is a look, and one that
    // altered the picture the moment it was added could not be added without
    // committing to a change.
    default: 0,
    step: 0.05,
    surprise: {
      // A stop and a half either way is the range in which the picture is still
      // the same picture. Past two stops down a dither downstream has nothing
      // left to resolve, and past two up the highlights are one flat field.
      range: [-1.5, 1.5],
      // Clustered on no change: most stacks want a nudge, and the tails are
      // where the deliberate under- and over-exposure looks live.
      distribution: { kind: "normal", mean: 0, sigma: 0.6 },
      weight: 0.8,
    },
  },
  {
    key: BRIGHTNESS_CONTRAST_PARAM.contrast,
    label: "Contrast",
    type: "float",
    description: "Gain about visual mid-grey, applied to the encoded value. 0 flattens to mid-grey; above 1 steepens.",
    animatable: true,
    // Zero is legal and is the flat mid-grey field, which is the honest bottom
    // of a gain rather than a special case. Four is where an ordinary photo has
    // become two tones and the control has nothing left to do.
    legal: [0, 4],
    default: 1,
    step: 0.01,
    surprise: {
      // Below 0.6 the frame is fog and the kernel downstream sees no edges;
      // above 2 it is already posterized before any dither runs (F-SM-04).
      range: [0.6, 2],
      // A gain is multiplicative: halving and doubling are the same size of
      // step, and uniform sampling would spend most of its draws above 1.
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: BRIGHTNESS_CONTRAST_PARAM.brightness,
    label: "Brightness",
    type: "float",
    description: "Offset on the encoded value, applied after contrast. ±1 is the full display range.",
    animatable: true,
    // The full display range in each direction. Anything beyond it is a frame
    // that is entirely black or entirely white whatever the input was.
    legal: [-1, 1],
    default: 0,
    step: 0.005,
    surprise: {
      // Fifteen percent of the display range is a visible lift or drop that
      // still leaves both ends of the tone scale occupied.
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
export const BRIGHTNESS_CONTRAST_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> =
  new Map(BRIGHTNESS_CONTRAST_PARAMS.map((param) => [param.key, param]));

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: BRIGHTNESS_CONTRAST_BINDING.inputColor },
  { role: "output-color", binding: BRIGHTNESS_CONTRAST_BINDING.outputColor },
  { role: "uniforms", binding: BRIGHTNESS_CONTRAST_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "brightness-contrast/main",
  label: "Brightness / contrast",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  access: "pointwise",
  bindings,
  uniforms: BRIGHTNESS_CONTRAST_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const BRIGHTNESS_CONTRAST_GPU: GpuEffect = {
  effect: "brightness-contrast",
  passes: [pass],
};

export default defineEffect({
  id: "brightness-contrast",
  name: "Brightness / contrast",
  summary:
    "Exposure, contrast and brightness — the three coarse tonal controls, applied before anything quantizes.",
  description:
    "Exposure is a multiply in linear light, so +1 is one photographic stop and behaves the way opening the aperture does. Contrast and brightness act on the tone as the screen shows it, which is the only domain in which 'more contrast' means what people expect; the contrast pivot is fixed at visual mid grey, because an arbitrary pivot with an arbitrary gain is what the levels node is. How much contrast reaches the dither decides most of what the dither looks like, so this is usually the first node in a stack.",
  keywords: ["brightness", "contrast", "exposure", "stops", "gain", "tone", "punch", "darken", "lighten", "flat"],
  concept: "tone-and-colour",
  requirement: "F-PP-02",
  // Preprocess, and not merely by convention: the tone that reaches a dither
  // kernel decides how much of the picture the kernel has to work with. Placed
  // after a quantizer it would rewrite every pixel's colour while the index map
  // beside it still named the old palette entries.
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: BRIGHTNESS_CONTRAST_PARAMS,
  // Ordinary. The tone reaching a kernel decides more about the result than the
  // choice of kernel does, so this earns a full weight despite being a
  // correction rather than a look of its own.
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("brightness-contrast", () => BRIGHTNESS_CONTRAST_GPU);
