/**
 * Film grain (F-SP-16).
 *
 * One compute pass, read-your-own-pixel. Seeded value noise at a controllable
 * scale, added with an amplitude that follows the tone the way silver-halide
 * grain does.
 *
 * **The seed is explicit and it is the whole point.** The noise is a hash of the
 * lattice coordinate and this parameter and of nothing else — no clock, no frame
 * counter, no `normalized-time` — so the same document renders the same grain in
 * the preview, in a batch worker and in an export (F-AN-05). The seed is a
 * parameter rather than only `StackNode.seed` because grain is one of the
 * effects people reroll on its own, and F-AN-05 asks for that control.
 *
 * The three arguments that are really about the algorithm — why the noise is
 * added in the sRGB encoding rather than in linear light, why the amplitude
 * follows the midtones, and why it is interpolated value noise rather than one
 * hash per pixel — are in `../shaders/grain.wgsl`, next to the code they govern.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/grain.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const GRAIN_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const GRAIN_PARAM = {
  seed: "seed",
  size: "size",
  intensity: "intensity",
  tonalResponse: "tonalResponse",
  monochrome: "monochrome",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/grain.wgsl`. Seven 4-byte scalars — 28 bytes in a block WGSL
 * rounds up to 32.
 */
export const GRAIN_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    // The node's own `seed` parameter, not the `seed` builtin. The builtin
    // carries the resolved document seed for the node; this effect exposes its
    // own so a reroll can change the grain without changing anything else the
    // node seeds.
    { source: { kind: "param", key: GRAIN_PARAM.seed }, type: "u32", offset: 8 },
    { source: { kind: "param", key: GRAIN_PARAM.size }, type: "f32", offset: 12 },
    { source: { kind: "param", key: GRAIN_PARAM.intensity }, type: "f32", offset: 16 },
    { source: { kind: "param", key: GRAIN_PARAM.tonalResponse }, type: "f32", offset: 20 },
    { source: { kind: "param", key: GRAIN_PARAM.monochrome }, type: "u32", offset: 24 },
  ],
};

export const GRAIN_PARAMS: readonly ParamDescriptor[] = [
  {
    key: GRAIN_PARAM.seed,
    label: "Seed",
    type: "seed",
    // Not animatable. A modulator produces a continuous number and a seed is a
    // label, not a quantity — interpolating between two seeds is meaningless,
    // and per-frame variation is the temporal-variation system's job, where it
    // can be made periodic in the loop length rather than merely different.
    animatable: false,
    hint: "Which grain. Every seed is as good as every other; the same seed always gives the same field.",
    default: 0,
    surprise: { weight: 1 },
  },
  {
    key: GRAIN_PARAM.size,
    label: "Grain size",
    type: "float",
    hint: "Diameter of one grain, in pixels.",
    animatable: true,
    // Below 1 the lattice is finer than the pixel grid, so the field aliases
    // into something that is no longer grain of any size.
    legal: [1, 32],
    default: 1.4,
    surprise: {
      // Log, because this is measured in octaves: uniform sampling of 1..8
      // spends most of its draws above 4, where the grain reads as blotches and
      // every result looks the same.
      range: [1, 6],
      distribution: { kind: "log" },
      weight: 1,
    },
    step: 0.1,
  },
  {
    key: GRAIN_PARAM.intensity,
    label: "Intensity",
    type: "float",
    // Amplitude of the noise in the sRGB encoding at full tonal response, so 1
    // swings a midtone pixel across the entire display range.
    hint: "How strong the grain is. 1 swings a midtone across the whole range.",
    animatable: true,
    legal: [0, 1],
    default: 0.12,
    surprise: {
      // Log: the useful range is the bottom fifth, and uniform sampling of
      // 0.03..0.35 puts most draws in the top half where the picture is gone.
      range: [0.04, 0.3],
      distribution: { kind: "log" },
      weight: 1,
    },
    step: 0.01,
  },
  {
    key: GRAIN_PARAM.tonalResponse,
    label: "Tonal response",
    type: "float",
    hint: "How much the grain follows the midtones. 0 is a flat field, 1 is film.",
    animatable: true,
    legal: [0, 1],
    // Not 1: pure midtone weighting leaves clean highlights and clean shadows,
    // and a little grain everywhere is what a scanned negative actually looks
    // like once the base fog is in it.
    default: 0.75,
    surprise: {
      // Below about 0.4 the grain sits on top of the picture instead of in it,
      // which is the digital-noise look rather than the film look.
      range: [0.45, 1],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
    step: 0.01,
  },
  {
    key: GRAIN_PARAM.monochrome,
    label: "Monochrome",
    type: "bool",
    hint: "One noise field for all channels, or three independent ones as colour film has.",
    animatable: false,
    // True: one field moves a pixel along the tone axis, which is what a small
    // palette can absorb. Three fields move it sideways in colour, and the
    // palette match then has to resolve a hue the picture never had.
    default: true,
    surprise: {
      trueProbability: 0.75,
      weight: 0.5,
    },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. None of these is an enum, so
 * the packer resolves every one from its value alone — but it takes the map for
 * every effect, and this is one place to look when a field stops matching its
 * parameter.
 */
export const GRAIN_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  GRAIN_PARAMS.map((param) => [param.key, param]),
);

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: GRAIN_BINDING.inputColor },
  { role: "output-color", binding: GRAIN_BINDING.outputColor },
  { role: "uniforms", binding: GRAIN_BINDING.uniforms },
];

const pass: ComputePass = {
  id: "grain/main",
  label: "Film grain",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // The noise comes from the coordinate and the seed; no neighbour is read.
  access: "pointwise",
  bindings,
  uniforms: GRAIN_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const GRAIN_GPU: GpuEffect = {
  effect: "grain",
  passes: [pass],
};

export default defineEffect({
  id: "grain",
  name: "Film grain",
  requirement: "F-SP-16",
  // Preprocess, and here it changes what the effect does rather than only where
  // it is legal. Downstream of a quantizer the noise would produce colours the
  // palette does not contain while the index map beside it still named the old
  // entries. Upstream, the grain perturbs which side of its threshold each pixel
  // falls on, so the dither renders it as pattern — which is both palette-exact
  // and the reason to want grain in this application at all.
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: GRAIN_PARAMS,
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("grain", () => GRAIN_GPU);
