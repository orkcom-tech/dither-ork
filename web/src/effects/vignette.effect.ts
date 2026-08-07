/**
 * Vignette (F-SP-12).
 *
 * One compute pass, read-your-own-pixel. Three controls, exactly the three the
 * requirement names: radius, softness, strength.
 *
 * The two decisions worth stating are in `../shaders/vignette.wgsl`, above the
 * code that makes them — that the attenuation is a multiply in linear light,
 * because a lens vignette is lost light and lost light is multiplicative, and
 * that the contour is an ellipse with the frame's aspect ratio rather than a
 * circle in pixels.
 *
 * The descriptor and the compute pass are both in this file; see
 * `./invert.effect.ts` for why.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/vignette.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const VIGNETTE_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const VIGNETTE_PARAM = {
  radius: "radius",
  softness: "softness",
  strength: "strength",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/vignette.wgsl`. Five 4-byte scalars — 20 bytes in a block WGSL
 * rounds up to 32.
 */
export const VIGNETTE_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: VIGNETTE_PARAM.radius }, type: "f32", offset: 8 },
    { source: { kind: "param", key: VIGNETTE_PARAM.softness }, type: "f32", offset: 12 },
    { source: { kind: "param", key: VIGNETTE_PARAM.strength }, type: "f32", offset: 16 },
  ],
};

export const VIGNETTE_PARAMS: readonly ParamDescriptor[] = [
  {
    key: VIGNETTE_PARAM.radius,
    label: "Radius",
    type: "float",
    // 1 is the edge midpoint and sqrt(2) the corners, so the legal range has to
    // go past 1 for "corners only" to be reachable at all.
    description: "Where the falloff starts. 1 reaches the middle of each edge, 1.41 the corners.",
    animatable: true,
    legal: [0, 2],
    default: 0.7,
    surprise: {
      // Below about 0.3 the falloff eats the subject; above 1.1 only the corners
      // are touched and on most images that is indistinguishable from off.
      range: [0.35, 1],
      distribution: { kind: "uniform" },
      weight: 1,
    },
    step: 0.01,
  },
  {
    key: VIGNETTE_PARAM.softness,
    label: "Softness",
    type: "float",
    description: "How far the falloff takes to complete, in the same units as the radius.",
    animatable: true,
    // Strictly positive: `smoothstep` with a zero-width band is indeterminate in
    // WGSL, and a hard-edged vignette is a circular mask, not this effect.
    legal: [0.01, 2],
    default: 0.45,
    surprise: {
      // Log, because this is a width: uniform sampling of 0.1..1.2 spends most
      // of its draws above 0.6, where every result is the same broad wash.
      range: [0.15, 1],
      distribution: { kind: "log" },
      weight: 0.8,
    },
    step: 0.01,
  },
  {
    key: VIGNETTE_PARAM.strength,
    label: "Strength",
    type: "float",
    description: "How dark the far edge gets. 1 takes it to black.",
    animatable: true,
    legal: [0, 1],
    // Not 1: a vignette that goes fully black at the edge is a spotlight, and
    // the thing this control is usually reached for is the last 30%.
    default: 0.65,
    surprise: {
      // Below about 0.25 a dithered result cannot show it — the darkening does
      // not move a single pixel across a palette boundary.
      range: [0.3, 1],
      distribution: { kind: "uniform" },
      weight: 1,
    },
    step: 0.01,
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. All three are floats, so this
 * map is only ever consulted to confirm that — but the packer takes it for every
 * effect and it is one place to look when a field stops matching its parameter.
 */
export const VIGNETTE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  VIGNETTE_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: VIGNETTE_BINDING.inputColor },
  { role: "output-color", binding: VIGNETTE_BINDING.outputColor },
  { role: "uniforms", binding: VIGNETTE_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "vignette/main",
  label: "Vignette",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // The attenuation comes from the coordinate, not from a neighbour.
  access: "pointwise",
  bindings,
  uniforms: VIGNETTE_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const VIGNETTE_GPU: GpuEffect = {
  effect: "vignette",
  passes: [pass],
};

export default defineEffect({
  id: "vignette",
  name: "Vignette",
  summary:
    "Darkens the frame towards its edges, the way a lens loses light off-axis.",
  description:
    "The attenuation is a multiply in linear light, because a lens vignette is lost light and lost light is multiplicative; darkening the encoded value instead gives a muddier falloff that does not read as optics. The contour is an ellipse matched to the frame's aspect ratio rather than a circle measured in pixels, so radius 1 reaches the middle of each edge and about 1.41 reaches the corners. Placed before a dither it changes which palette colours the edges land on, which is a far stronger effect than the same darkening applied after.",
  keywords: ["vignette", "edges", "corners", "darken", "falloff", "lens", "frame", "border", "spotlight", "fade", "burn"],
  concept: "optical",
  requirement: "F-SP-12",
  // Preprocess, and this is the more interesting half of the decision rather
  // than a formality. Downstream of a quantizer the multiply would produce
  // colours the palette does not contain while the index map beside it still
  // named the old entries — the same trap gradient-map and invert both avoid by
  // sitting here — and it would also mean the darkening never gets dithered.
  // Upstream, the falloff is resolved by the dither into a density gradient of
  // palette colours, which is what this application is for.
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: VIGNETTE_PARAMS,
  surpriseWeight: 0.7,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("vignette", () => VIGNETTE_GPU);
