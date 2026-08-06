/**
 * F-GL-09 — CRT mask.
 *
 * Three tube families, three mask geometries, one effect: the aperture grille's
 * vertical stripes, the shadow mask's delta lattice of round dots, and the slot
 * mask's staggered slots. They are one effect because a stack never wants two
 * of them at once — a tube has one mask — and because pitch, phosphor size,
 * strength and registration mean the same thing in all three. The geometry that
 * is actually drawn is a parameter, and the shader branches on it once.
 *
 * The geometries themselves, and why each is the shape it is, are documented in
 * `web/src/shaders/crt-mask.wgsl` next to the arithmetic.
 *
 * There is no seed. The mask is a fixed physical structure; a seed here would
 * be a control in the properties panel that moves nothing, which is the failure
 * `web/src/effects/error-diffusion.ts` argues against at length.
 *
 * Descriptor, uniform layout and compute pass are in this one file so that
 * adding an effect edits nothing central — see `web/src/registry/README.md`.
 */

import { defineEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/crt-mask.wgsl?raw";

/** Registry id. Used for the pass id and the shader file name. */
export const CRT_MASK_ID = "crt-mask";

/**
 * Canonical binding numbers, restated from CONVENTIONS.md.
 *
 * A colour filter: no palette to search, no index map to read or write. The
 * numbers do not close up when a role is absent.
 */
export const CRT_MASK_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const CRT_MASK_PARAM = {
  geometry: "geometry",
  pitch: "pitch",
  aspect: "aspect",
  duty: "duty",
  strength: "strength",
  softness: "softness",
  boost: "boost",
  offsetX: "offsetX",
  offsetY: "offsetY",
} as const;

/**
 * Mask geometries, in the order the shader's ordinals expect.
 *
 * The packer sends an enum as its position in this list, so it is append-only:
 * inserting a value in the middle silently renumbers every document already
 * saved.
 */
const GEOMETRY_VALUES = [
  { value: "aperture-grille", label: "Aperture grille" },
  { value: "shadow-mask", label: "Shadow mask" },
  { value: "slot-mask", label: "Slot mask" },
] as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `crt-mask.wgsl`.
 *
 * Twelve 4-byte scalars. Keeping it to scalars is not laziness — a `vec2f` for
 * the offset pair would align to 8 and put a hole in the middle that both sides
 * would have to agree about.
 */
export const CRT_MASK_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: CRT_MASK_PARAM.geometry }, type: "u32", offset: 8 },
    { source: { kind: "param", key: CRT_MASK_PARAM.pitch }, type: "f32", offset: 12 },
    { source: { kind: "param", key: CRT_MASK_PARAM.aspect }, type: "f32", offset: 16 },
    { source: { kind: "param", key: CRT_MASK_PARAM.duty }, type: "f32", offset: 20 },
    { source: { kind: "param", key: CRT_MASK_PARAM.strength }, type: "f32", offset: 24 },
    { source: { kind: "param", key: CRT_MASK_PARAM.softness }, type: "f32", offset: 28 },
    { source: { kind: "param", key: CRT_MASK_PARAM.boost }, type: "f32", offset: 32 },
    { source: { kind: "param", key: CRT_MASK_PARAM.offsetX }, type: "f32", offset: 36 },
    { source: { kind: "param", key: CRT_MASK_PARAM.offsetY }, type: "f32", offset: 40 },
  ],
};

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: CRT_MASK_PARAM.geometry,
    label: "Mask geometry",
    type: "enum",
    hint: "Which tube family's mask to draw. Aperture grille has no vertical structure.",
    // Not animatable: crossfading between two lattices produces a third
    // pattern that is neither, and a modulator on an ordinal would step through
    // them as though they were a scale.
    animatable: false,
    values: GEOMETRY_VALUES,
    default: "aperture-grille",
    surprise: {
      // The grille is the one that survives being scaled down — the other two
      // need enough pixels per triad to resolve their vertical structure, so
      // they read as noise more often at small pitches.
      values: [
        { value: "aperture-grille", weight: 3 },
        { value: "shadow-mask", weight: 2 },
        { value: "slot-mask", weight: 2 },
      ],
      weight: 1.2,
    },
  },
  {
    key: CRT_MASK_PARAM.pitch,
    label: "Triad pitch",
    type: "float",
    hint: "Width of one R/G/B triad, in pixels. 3 puts one pixel under each phosphor.",
    animatable: true,
    // Below 3 the three phosphors share fewer than three pixels and the mask
    // turns into colour noise; above ~48 it is decorative stripes rather than a
    // mask. Both ends are reachable on purpose.
    legal: [1, 64],
    default: 3,
    step: 0.5,
    surprise: {
      // Measured in octaves: uniform sampling of 3..24 spends most of its draws
      // above 12, where the mask stops reading as a mask.
      range: [3, 12],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: CRT_MASK_PARAM.aspect,
    label: "Vertical aspect",
    type: "float",
    // Inert for the aperture grille, and that is a property of the geometry
    // rather than an oversight: a grille's stripes are continuous from the top
    // of the tube to the bottom, so there is no vertical period to set.
    hint: "Vertical period as a multiple of the pitch. 1 is the physical delta lattice. Ignored by the aperture grille.",
    animatable: true,
    legal: [0.5, 8],
    default: 1,
    surprise: {
      // Octaves again, and the range stays near 1 because a badly stretched
      // lattice reads as a moiré artifact rather than as a tube.
      range: [0.7, 2.5],
      distribution: { kind: "log" },
      weight: 0.7,
    },
  },
  {
    key: CRT_MASK_PARAM.duty,
    label: "Phosphor size",
    type: "float",
    hint: "Phosphor size relative to its cell. 1 makes them touch; below that the gaps are unlit mask.",
    animatable: true,
    // Above 1 the phosphors overlap, which no real mask does but which is the
    // only way to keep the geometry visible at a large pitch without also
    // losing most of the light.
    legal: [0.1, 1.4],
    default: 1,
    step: 0.01,
    surprise: {
      range: [0.6, 1.1],
      distribution: { kind: "uniform" },
      weight: 0.8,
    },
  },
  {
    key: CRT_MASK_PARAM.strength,
    label: "Strength",
    type: "float",
    hint: "How much light the unlit mask takes. 1 passes nothing between the phosphors.",
    animatable: true,
    legal: [0, 1],
    // Not 1. A full-strength mask costs two thirds of the picture's light and
    // most images need the boost turned up before that reads as a tube rather
    // than as an underexposure.
    default: 0.7,
    step: 0.01,
    surprise: {
      range: [0.4, 0.95],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: CRT_MASK_PARAM.softness,
    label: "Edge softness",
    type: "float",
    // Also the anti-aliasing control: a hard-edged lattice sampled on a pixel
    // grid at a non-integer pitch beats against it.
    hint: "Width of each phosphor's edge, as a fraction of its own half-width. 0 is a hard edge.",
    animatable: true,
    legal: [0, 1],
    default: 0.3,
    step: 0.01,
    surprise: {
      range: [0.1, 0.8],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
  },
  {
    key: CRT_MASK_PARAM.boost,
    label: "Brightness boost",
    type: "float",
    hint: "Multiplies the masked picture back up. A full-strength mask costs about two thirds of the light.",
    animatable: true,
    legal: [1, 3],
    // 1 is the unmodified physics. Compensation is a decision, and it is one
    // the picture should show being made rather than have applied for it.
    default: 1,
    step: 0.05,
    surprise: {
      // Stops short of full compensation: at a strength of 0.7 that would be
      // about 1.9, and landing exactly there every time removes the reason the
      // control exists.
      range: [1, 1.8],
      distribution: { kind: "uniform" },
      weight: 0.6,
    },
  },
  {
    key: CRT_MASK_PARAM.offsetX,
    label: "Offset X",
    type: "float",
    // The primary registration control, and the reason it is animatable: a mask
    // one pixel off the pixel grid is a different picture, and drifting it is
    // what makes a still image look like a live tube.
    hint: "Shifts the mask horizontally, in pixels.",
    animatable: true,
    legal: [-1024, 1024],
    default: 0,
    surprise: {
      // A shift larger than a triad is the same picture again, so the range is
      // about one triad at the pitches the pitch control favours.
      range: [-6, 6],
      distribution: { kind: "uniform" },
      weight: 0.5,
    },
  },
  {
    key: CRT_MASK_PARAM.offsetY,
    label: "Offset Y",
    type: "float",
    hint: "Shifts the mask vertically, in pixels. Ignored by the aperture grille.",
    animatable: true,
    legal: [-1024, 1024],
    default: 0,
    surprise: {
      range: [-6, 6],
      distribution: { kind: "uniform" },
      weight: 0.5,
    },
  },
];

/**
 * The compute pass.
 *
 * Pointwise: every geometry is a function of the pixel's own coordinate, so no
 * invocation reads a texel other than its own.
 */
export function crtMaskEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: CRT_MASK_BINDING.inputColor },
    { role: "output-color", binding: CRT_MASK_BINDING.outputColor },
    { role: "uniforms", binding: CRT_MASK_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: `${CRT_MASK_ID}/mask`,
    label: "CRT mask",
    wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "pointwise",
    bindings,
    uniforms: CRT_MASK_UNIFORMS,
  };

  return { effect: CRT_MASK_ID, passes: [pass] };
}

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * Needed rather than incidental here: `geometry` is an enum, and its numeric
 * form is its position in `values`, which only the descriptor knows.
 */
export const CRT_MASK_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

export default defineEffect({
  id: CRT_MASK_ID,
  name: "CRT mask",
  requirement: "F-GL-09",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: PARAMS,
  // A signature look, but it needs enough resolution to resolve its triads, so
  // it sits a little below the effects that work at any scale.
  surpriseWeight: 0.9,
  producesIndexMap: false,
  // Attenuating each channel independently moves pixels off their palette
  // entries, so an index map carried past this node no longer describes them.
  // The graph reconciles that; the descriptor states only that this node
  // neither reads nor writes one.
  requiresIndexMap: false,
});
