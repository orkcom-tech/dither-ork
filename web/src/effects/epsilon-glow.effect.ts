/**
 * F-SP-01 — Epsilon glow.
 *
 * Light bleeding out of the bright parts of the picture: take what is above a
 * lightness threshold, spread it with a gaussian, add it back either additively
 * or by screening. The four controls are the four stages, and every one of them
 * moves something in `epsilon-glow.wgsl`.
 *
 * Two passes. The blur is separable, so it wants two dispatches anyway, and the
 * composite needs the ORIGINAL pixel that the colour surface no longer holds by
 * then — it ping-pongs between passes — so pass 0 stashes the untouched source
 * in a scratch buffer on its way past. Eight bytes per pixel for the life of
 * the node, which is the honest cost of an effect that reads its own input
 * twice.
 *
 * Slot is `postprocess`. A glow before the dither is quantized away into the
 * halo's own dither pattern; after it, the soft halo sits over hard dithered
 * pixels, which is the phosphor-bloom look this effect exists for. The slot
 * steers Surprise Me's grammar only — F-ST-01 lets the user drag the node
 * anywhere.
 */

import { defineEffect, type ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/epsilon-glow.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
const BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
  stash: 6,
} as const;

const PARAM = {
  threshold: "threshold",
  radius: "radius",
  intensity: "intensity",
  blend: "blend",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `epsilon-glow.wgsl`.
 *
 * Six 4-byte scalars, so nothing needs padding in front of it and the only
 * padding is the tail that rounds 24 up to 32. `blend` is a `u32` because an
 * enum parameter reaches the shader as its ordinal.
 */
export const EPSILON_GLOW_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: PARAM.threshold }, type: "f32", offset: 8 },
    { source: { kind: "param", key: PARAM.radius }, type: "f32", offset: 12 },
    { source: { kind: "param", key: PARAM.intensity }, type: "f32", offset: 16 },
    { source: { kind: "param", key: PARAM.blend }, type: "u32", offset: 20 },
  ],
};

const THRESHOLD: ParamDescriptor = {
  key: PARAM.threshold,
  label: "Threshold",
  type: "float",
  animatable: true,
  // Lightness, not linear luminance: the slider has to mean what the eye sees
  // it mean, and 0.5 linear is already a light grey on screen.
  hint: "Lightness above which a pixel emits. The ramp reaches full at white, so there is no contour.",
  // Stops short of 1: at 1 nothing is above the threshold and the control has
  // switched the effect off, which is what an intensity of 0 is for.
  legal: [0, 0.95],
  default: 0.55,
  step: 0.01,
  surprise: {
    // Below about 0.25 the whole picture emits and the glow reads as a veil
    // rather than as light; above 0.8 only specular highlights survive and most
    // images produce nothing at all (F-SM-04).
    range: [0.25, 0.8],
    distribution: { kind: "uniform" },
    weight: 1,
  },
};

const RADIUS: ParamDescriptor = {
  key: PARAM.radius,
  label: "Radius",
  type: "float",
  animatable: true,
  hint: "How far the light spreads, in pixels. Truncation half-width of the gaussian.",
  // The ceiling is the same number as MAX_BLUR_RADIUS in the shader, so a
  // document can never ask for a radius the loop bound silently refuses.
  legal: [0, 64],
  default: 10,
  step: 0.5,
  surprise: {
    // Under 3 the halo is a rim light rather than a glow; over ~24 it is a
    // wash across the whole frame and the radius has stopped being legible.
    range: [3, 24],
    // Measured in octaves: 3 to 6 is the same visual step as 12 to 24, and
    // uniform sampling would spend most of its draws in the top octave.
    distribution: { kind: "log" },
    weight: 1,
  },
};

const INTENSITY: ParamDescriptor = {
  key: PARAM.intensity,
  label: "Intensity",
  type: "float",
  animatable: true,
  hint: "Gain on the blurred light before it is blended back.",
  legal: [0, 4],
  default: 1,
  step: 0.05,
  surprise: {
    range: [0.4, 1.8],
    // Gain is heard in ratios, so log.
    distribution: { kind: "log" },
    // The highest weight of the four: intensity is what decides whether a
    // reroll reads as "there is a glow here" at all.
    weight: 1.2,
  },
};

const BLEND: ParamDescriptor = {
  key: PARAM.blend,
  label: "Blend",
  type: "enum",
  animatable: false,
  hint: "Additive is physical light adding up. Screen approaches white instead of arriving at it.",
  // Append-only. The shader sees the ordinal, so inserting a value in the
  // middle silently renumbers every document already saved.
  values: [
    { value: "additive", label: "Additive" },
    { value: "screen", label: "Screen" },
  ],
  // Additive: two light sources reaching one pixel add, and that is what a
  // glow is. Screen is the deliberate softer alternative.
  default: "additive",
  surprise: {
    values: [
      { value: "additive", weight: 3 },
      { value: "screen", weight: 2 },
    ],
    // Low: swapping the blend changes how the highlights roll off, not whether
    // the picture has a glow in it.
    weight: 0.5,
  },
};

export default defineEffect({
  id: "epsilon-glow",
  name: "Epsilon glow",
  requirement: "F-SP-01",
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  params: [THRESHOLD, RADIUS, INTENSITY, BLEND],
  // Above an ordinary effect. This is a signature look of the reference
  // product rather than a curiosity, and F-SM-03 wants signature looks to turn
  // up more often than curiosities.
  surpriseWeight: 1.2,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/**
 * The untouched source, kept across the ping-pong.
 *
 * Two u32 per pixel holding four halves — bit for bit what the rgba16float
 * surface it copies holds, so the round trip loses nothing and buys no headroom
 * the source cannot reach.
 *
 * Both passes declare it read-write even though pass 1 only reads: one WGSL
 * file per effect means one declaration of the variable, and a shader's access
 * mode has to match the bind group layout's buffer type in every pass that
 * uses it.
 */
const STASH: PassBinding = {
  role: "scratch",
  binding: BINDING.stash,
  slot: "source",
  access: "read-write",
  size: { kind: "per-pixel", bytesPerPixel: 8 },
};

const BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: BINDING.inputColor },
  { role: "output-color", binding: BINDING.outputColor },
  { role: "uniforms", binding: BINDING.uniforms },
  STASH,
];

const PASSES: readonly ComputePass[] = [
  {
    id: "epsilon-glow/bright-blur-h",
    label: "Epsilon glow bright-pass and horizontal blur",
    wgsl,
    entryPoint: "bright_blur_h",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings: BINDINGS,
    uniforms: EPSILON_GLOW_UNIFORMS,
  },
  {
    id: "epsilon-glow/blur-v-composite",
    label: "Epsilon glow vertical blur and composite",
    wgsl,
    entryPoint: "glow_composite",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings: BINDINGS,
    uniforms: EPSILON_GLOW_UNIFORMS,
  },
];

export const epsilonGlowGpuEffect: GpuEffect = {
  effect: "epsilon-glow",
  passes: PASSES,
};

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * Not optional here: `blend` arrives as a string and only the descriptor knows
 * which ordinal it is, so the packer refuses the node without this map.
 */
export const EPSILON_GLOW_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> =
  new Map<string, ParamDescriptor>([
    [THRESHOLD.key, THRESHOLD],
    [RADIUS.key, RADIUS],
    [INTENSITY.key, INTENSITY],
    [BLEND.key, BLEND],
  ]);
