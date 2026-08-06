/**
 * Chromatic aberration (F-GL-05).
 *
 * Lateral chromatic aberration in two modes, both in one pointwise pass.
 *
 *   radial — the displacement points away from a centre and grows with
 *            distance from it, which is what a lens does. `falloff` is the
 *            exponent on the normalised radius, so the fringe can be kept out
 *            of the middle of the frame the way a real one is.
 *   linear — one constant displacement along an angle. Prism separation rather
 *            than lens aberration, and the look to reach for when the fringe
 *            should be even across the frame.
 *
 * **Green does not move.** That is the optical model — a lens focuses the ends
 * of the spectrum away from the middle — and it is also what keeps the picture
 * sharp while the fringes appear. Red and blue separate in opposite directions
 * about it.
 *
 * **Strength is a fraction of the image**, of the half-diagonal in radial mode
 * so it means the same thing at any aspect ratio, of the width in linear mode.
 * Preview and export are the same graph at two resolutions, so a pixel-valued
 * displacement would export a different picture than the one on screen.
 *
 * **The seed drives `jitter`.** Both modes are fully determined by their
 * numbers, so the family's seed requirement needs a stochastic axis to act on:
 * `jitter` gives each scanline its own extra separation. At 0 it is off and the
 * seed does nothing, which is stated on the control rather than left to be
 * discovered.
 */

import type { EffectDescriptor, ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/chromatic-aberration.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
export const CHROMATIC_ABERRATION_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const CHROMATIC_ABERRATION_PARAM = {
  mode: "mode",
  strength: "strength",
  angle: "angle",
  centerX: "centerX",
  centerY: "centerY",
  falloff: "falloff",
  jitter: "jitter",
  edge: "edge",
  seed: "seed",
} as const;

/**
 * `struct Params` in `chromatic-aberration.wgsl`, byte for byte.
 *
 * Twelve 4-byte scalars, so nothing needs padding in front of it and the only
 * padding is the tail that rounds 44 up to 48. Keeping the block to scalars is
 * not laziness — a `vec2f` for the centre would align to 8 and put a hole after
 * `angle` that both sides then have to agree about.
 */
export const CHROMATIC_ABERRATION_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: CHROMATIC_ABERRATION_PARAM.seed }, type: "u32", offset: 8 },
    { source: { kind: "param", key: CHROMATIC_ABERRATION_PARAM.mode }, type: "u32", offset: 12 },
    { source: { kind: "param", key: CHROMATIC_ABERRATION_PARAM.edge }, type: "u32", offset: 16 },
    {
      source: { kind: "param", key: CHROMATIC_ABERRATION_PARAM.strength },
      type: "f32",
      offset: 20,
    },
    { source: { kind: "param", key: CHROMATIC_ABERRATION_PARAM.angle }, type: "f32", offset: 24 },
    {
      source: { kind: "param", key: CHROMATIC_ABERRATION_PARAM.centerX },
      type: "f32",
      offset: 28,
    },
    {
      source: { kind: "param", key: CHROMATIC_ABERRATION_PARAM.centerY },
      type: "f32",
      offset: 32,
    },
    {
      source: { kind: "param", key: CHROMATIC_ABERRATION_PARAM.falloff },
      type: "f32",
      offset: 36,
    },
    { source: { kind: "param", key: CHROMATIC_ABERRATION_PARAM.jitter }, type: "f32", offset: 40 },
  ],
};

/**
 * The edge rule.
 *
 * Restated here rather than imported from a neighbouring effect: one effect is
 * one file, and an effect file that imports from another makes deleting either
 * of them a two-file edit. The order is load-bearing — it is the shader's
 * `EDGE_*` constants, and the packer sends the ordinal, so inserting a value in
 * the middle renumbers every document already saved.
 */
const EDGE_VALUES = [
  { value: "clamp", label: "Hold edge" },
  { value: "wrap", label: "Wrap" },
  { value: "mirror", label: "Mirror" },
] as const;

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: CHROMATIC_ABERRATION_PARAM.mode,
    label: "Mode",
    type: "enum",
    hint: "Radial grows the fringe away from a centre; linear separates the whole frame along one angle.",
    animatable: false,
    // Order is load-bearing: the shader reads the ordinal, so inserting a value
    // in the middle renumbers every document already saved.
    values: [
      { value: "radial", label: "Radial" },
      { value: "linear", label: "Linear" },
    ],
    default: "radial",
    surprise: {
      // Radial is what a lens does and flatters more images; linear is the
      // deliberate one (F-SM-03).
      values: [
        { value: "radial", weight: 1 },
        { value: "linear", weight: 0.5 },
      ],
      weight: 0.8,
    },
  },
  {
    key: CHROMATIC_ABERRATION_PARAM.strength,
    label: "Strength",
    type: "float",
    hint: "Separation at the corners, as a fraction of the half-diagonal — of the width in linear mode.",
    animatable: true,
    legal: [0, 0.2],
    // Roughly a texel at preview size: visible as fringing rather than as a
    // second copy of the picture.
    default: 0.008,
    surprise: {
      // Log, because it is measured in octaves: uniform sampling of
      // 0.002..0.05 spends most of its draws above 0.025, where the fringe has
      // already become a separate image (F-SM-04).
      range: [0.002, 0.05],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: CHROMATIC_ABERRATION_PARAM.angle,
    label: "Angle",
    type: "float",
    // Turns, not degrees: a modulator ramping 0 -> 1 lands back where it
    // started, so an animated angle loops without the UI having to know that
    // 360 is special.
    hint: "Direction of the linear separation, in turns. Ignored in radial mode.",
    animatable: true,
    legal: [-1, 1],
    default: 0,
    surprise: { range: [-0.5, 0.5], distribution: { kind: "uniform" }, weight: 0.7 },
  },
  {
    key: CHROMATIC_ABERRATION_PARAM.centerX,
    label: "Centre X",
    type: "float",
    hint: "Optical centre, as a fraction of image width. Ignored in linear mode.",
    animatable: true,
    legal: [0, 1],
    default: 0.5,
    surprise: {
      // Near the middle. An optical centre in the corner is a look, but it is
      // one you ask for rather than one a reroll should hand you.
      range: [0.3, 0.7],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
  },
  {
    key: CHROMATIC_ABERRATION_PARAM.centerY,
    label: "Centre Y",
    type: "float",
    hint: "Optical centre, as a fraction of image height. Ignored in linear mode.",
    animatable: true,
    legal: [0, 1],
    default: 0.5,
    surprise: { range: [0.3, 0.7], distribution: { kind: "uniform" }, weight: 0.6 },
  },
  {
    key: CHROMATIC_ABERRATION_PARAM.falloff,
    label: "Falloff",
    type: "float",
    hint: "Exponent on the radius. 1 grows the fringe evenly from the centre; 2 keeps it in the corners.",
    animatable: true,
    legal: [0.25, 4],
    // Quadratic: the photographic look, and the reason the middle of the frame
    // stays clean.
    default: 2,
    surprise: { range: [1, 3], distribution: { kind: "log" }, weight: 0.8 },
  },
  {
    key: CHROMATIC_ABERRATION_PARAM.jitter,
    label: "Line wobble",
    type: "float",
    // This is what the seed drives; without it both modes are fully determined
    // and a seed control would move nothing.
    hint: "Seeded per-scanline extra separation, as a fraction of width. 0 is off, and then the seed has no effect.",
    animatable: true,
    legal: [0, 0.25],
    default: 0,
    step: 0.001,
    surprise: {
      range: [0, 0.02],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
  },
  {
    key: CHROMATIC_ABERRATION_PARAM.edge,
    label: "Edge",
    type: "enum",
    hint: "What a channel shows where it has been displaced off the frame.",
    animatable: false,
    values: [...EDGE_VALUES],
    // Holding the edge is the only one of the three that does not invent
    // structure at the border out of the far side of the image, and a lens
    // fringe at the frame edge is exactly where the other two would show.
    default: "clamp",
    surprise: {
      values: [
        { value: "clamp", weight: 1 },
        { value: "mirror", weight: 0.4 },
        { value: "wrap", weight: 0.25 },
      ],
      weight: 0.4,
    },
  },
  {
    key: CHROMATIC_ABERRATION_PARAM.seed,
    label: "Seed",
    type: "seed",
    hint: "Reroll the line wobble. No effect while wobble is 0.",
    animatable: false,
    default: 0,
    surprise: { weight: 0.8 },
  },
];

const descriptor: EffectDescriptor = {
  id: "chromatic-aberration",
  name: "Chromatic aberration",
  requirement: "F-GL-05",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  // Above 1: at low strength it flatters almost anything and composes with
  // everything else in the stack rather than dominating it.
  surpriseWeight: 1.1,
  producesIndexMap: false,
  requiresIndexMap: false,
};

export default descriptor;

const ABERRATE: ComputePass = {
  id: "chromatic-aberration/aberrate",
  label: "Chromatic aberration",
  wgsl,
  entryPoint: "main",
  // 64 invocations, well under the 256 guaranteed everywhere.
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Reads two arbitrary points, so it is not pointwise in the scheduler's sense
  // even though it is one dispatch: it must not alias its input.
  access: "global",
  bindings: [
    { role: "input-color", binding: CHROMATIC_ABERRATION_BINDING.inputColor },
    { role: "output-color", binding: CHROMATIC_ABERRATION_BINDING.outputColor },
    { role: "uniforms", binding: CHROMATIC_ABERRATION_BINDING.uniforms },
  ],
  uniforms: CHROMATIC_ABERRATION_UNIFORMS,
};

export const chromaticAberrationGpuEffect: GpuEffect = {
  effect: descriptor.id,
  passes: [ABERRATE],
};

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const CHROMATIC_ABERRATION_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);
