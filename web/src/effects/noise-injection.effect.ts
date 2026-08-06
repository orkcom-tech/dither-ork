/**
 * Noise injection (F-PP-06).
 *
 * One compute pass, read-your-own-pixel. White, value or gaussian noise, added
 * either as one field to all three channels or as three independent fields, at
 * a controllable feature size and from an explicit seed.
 *
 * **The seed is a parameter, not the builtin.** `StackNode.seed` already gives
 * every node one seed; this effect exposes its own so a reroll can change the
 * field without changing anything else the node seeds, which is what F-AN-05
 * asks for and what the glitch family already does.
 *
 * **The Rust core's noise generators are not used here and could not be.**
 * `core/crates/dither-core/src/noise.rs` has seeded fields, but a compute pass
 * has no sequential RNG state to carry: every invocation has to derive its own
 * value from its own coordinate. What crosses instead is the convention —
 * integers only, hashed rather than drawn, so no float rounding a driver may
 * contract differently can make one device disagree with the next. The hash is
 * the five-shader `seeded hash` block copied verbatim, per CONVENTIONS.md's
 * request that a new shader not add a fifth variant.
 *
 * The arguments that are really about the algorithm — why the noise is added in
 * the sRGB encoding, why white and gaussian are one draw per cell while value
 * noise interpolates, and why the gaussian is clipped at three sigma — are in
 * `../shaders/noise-injection.wgsl`, next to the code they govern.
 *
 * The descriptor and the compute pass are both in this file; see
 * `./posterize.effect.ts` for why.
 */

import {
  defineEffect,
  staticGpuEffect,
  type ParamDescriptor,
} from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/noise-injection.wgsl?raw";

export const NOISE_INJECTION_ID = "noise-injection";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
export const NOISE_INJECTION_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const NOISE_INJECTION_PARAM = {
  seed: "seed",
  kind: "kind",
  channels: "channels",
  amount: "amount",
  scale: "scale",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/noise-injection.wgsl`. Seven 4-byte scalars — 28 bytes in a block
 * WGSL rounds up to 32.
 */
export const NOISE_INJECTION_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    // The node's own `seed` parameter, not the `seed` builtin.
    { source: { kind: "param", key: NOISE_INJECTION_PARAM.seed }, type: "u32", offset: 8 },
    { source: { kind: "param", key: NOISE_INJECTION_PARAM.kind }, type: "u32", offset: 12 },
    { source: { kind: "param", key: NOISE_INJECTION_PARAM.channels }, type: "u32", offset: 16 },
    { source: { kind: "param", key: NOISE_INJECTION_PARAM.amount }, type: "f32", offset: 20 },
    { source: { kind: "param", key: NOISE_INJECTION_PARAM.scale }, type: "f32", offset: 24 },
  ],
};

export const NOISE_INJECTION_PARAMS: readonly ParamDescriptor[] = [
  {
    key: NOISE_INJECTION_PARAM.kind,
    label: "Distribution",
    type: "enum",
    hint: "White is one independent draw per cell; value interpolates between them; gaussian clusters near zero with rare large excursions.",
    // Not animatable: an enum reaches the shader as an ordinal and a modulator
    // produces a continuous number, so interpolating between two distributions
    // would mean nothing even if the packer accepted it.
    animatable: false,
    // Append-only. The shader restates these positions as a `const` block, and
    // inserting a value in the middle renumbers every document already saved.
    values: [
      { value: "white", label: "White" },
      { value: "value", label: "Value" },
      { value: "gaussian", label: "Gaussian" },
    ],
    // White is what "add noise" has meant everywhere, and at the default scale
    // it is the per-pixel field that makes a dither resolve a gradient as
    // texture instead of as a band.
    default: "white",
    surprise: {
      // Gaussian sits lowest: at the same amount it reads as a quieter white
      // noise, so it is the one to reach for on purpose rather than the one to
      // meet by accident (F-SM-03).
      values: [
        { value: "white", weight: 1 },
        { value: "value", weight: 0.8 },
        { value: "gaussian", weight: 0.5 },
      ],
      weight: 1,
    },
  },
  {
    key: NOISE_INJECTION_PARAM.amount,
    label: "Amount",
    type: "float",
    hint: "Largest excursion, measured on the tone as it looks on screen. The same number means the same swing in all three distributions.",
    animatable: true,
    legal: [0, 1],
    // Small. Noise before a dither is there to break the threshold decision, and
    // the amount that does that is a few percent; past about a fifth the noise
    // is the picture.
    default: 0.06,
    step: 0.01,
    surprise: {
      // Log, because the useful range is the bottom fifth: uniform sampling of
      // 0.02..0.25 puts most draws above 0.13, where every result looks the
      // same amount of broken (F-SM-04).
      range: [0.02, 0.25],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: NOISE_INJECTION_PARAM.scale,
    label: "Feature size",
    type: "float",
    hint: "Edge of one noise cell, in pixels. 1 is per-pixel.",
    animatable: true,
    // Below 1 the lattice is finer than the pixel grid, so the field aliases
    // into something that is no longer noise of any size.
    legal: [1, 64],
    default: 1,
    step: 0.1,
    surprise: {
      // Log: this is measured in octaves — 1 to 2 is the same visual step as 4
      // to 8 — so uniform sampling would spend most of its draws above 4, where
      // the field reads as blotches rather than as noise.
      range: [1, 8],
      distribution: { kind: "log" },
      weight: 0.8,
    },
  },
  {
    key: NOISE_INJECTION_PARAM.channels,
    label: "Channels",
    type: "enum",
    hint: "One field added to all three channels, or three independent fields.",
    animatable: false,
    values: [
      { value: "rgb", label: "Per channel" },
      { value: "luma", label: "Luma" },
    ],
    // Luma. One field moves a pixel along the tone axis, which is what a small
    // palette can absorb; three fields move it sideways in colour, and the
    // palette match then has to resolve a hue the picture never had.
    default: "luma",
    surprise: {
      values: [
        { value: "luma", weight: 1 },
        { value: "rgb", weight: 0.5 },
      ],
      weight: 0.6,
    },
  },
  {
    key: NOISE_INJECTION_PARAM.seed,
    label: "Seed",
    type: "seed",
    // Not animatable. A modulator produces a continuous number and a seed is a
    // label, not a quantity — interpolating between two seeds is meaningless,
    // and per-frame variation is the temporal-variation system's job (F-AN-04),
    // where it can be made periodic in the loop length rather than merely
    // different.
    animatable: false,
    hint: "Which field. Every seed is as good as every other; the same seed always gives the same noise.",
    default: 0,
    surprise: { weight: 1 },
  },
];

/**
 * Parameter descriptors keyed for `packUniforms`. `kind` and `channels` are
 * enums, whose document value is a string and whose numeric form is its position
 * in `values`, so the packer cannot resolve them without this.
 */
export const NOISE_INJECTION_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> =
  new Map(NOISE_INJECTION_PARAMS.map((param) => [param.key, param]));

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: NOISE_INJECTION_BINDING.inputColor },
  { role: "output-color", binding: NOISE_INJECTION_BINDING.outputColor },
  { role: "uniforms", binding: NOISE_INJECTION_BINDING.uniforms },
];

const pass: ComputePass = {
  id: `${NOISE_INJECTION_ID}/main`,
  label: "Noise injection",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // The noise comes from the coordinate and the seed; no neighbour is read.
  access: "pointwise",
  bindings,
  uniforms: NOISE_INJECTION_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const NOISE_INJECTION_GPU: GpuEffect = {
  effect: NOISE_INJECTION_ID,
  passes: [pass],
};

export default defineEffect({
  id: NOISE_INJECTION_ID,
  name: "Noise injection",
  requirement: "F-PP-06",
  // Preprocess, and here the slot changes what the effect does rather than only
  // where it is legal. Downstream of a quantizer the noise would produce colours
  // the palette does not contain while the index map beside it still named the
  // old entries. Upstream, it perturbs which side of its threshold each pixel
  // falls on, so the dither renders it as pattern — which is both palette-exact
  // and the reason to want noise in this application at all.
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: NOISE_INJECTION_PARAMS,
  // Slightly below ordinary: noise is a modifier of another effect's result
  // rather than a look of its own, and on a stack with no dither in it there is
  // nothing for the noise to be resolved by.
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/**
 * Resolves this effect's id to its passes; see `registry/gpu-effects.ts`.
 *
 * `staticGpuEffect` is the truthful declaration here: every value this node
 * needs is a scalar the uniform packer can reach from the node's own parameters,
 * so the passes are the same program for every node of this effect and nothing
 * has to be handed over before they can be named.
 */
export const gpu = staticGpuEffect(
  NOISE_INJECTION_ID,
  () => NOISE_INJECTION_GPU,
);
