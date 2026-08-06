/**
 * Interlace tear (F-GL-16).
 *
 * "Alternating field offset": the frame is cut into horizontal fields
 * `fieldHeight` rows tall and successive fields are shifted horizontally in
 * opposite directions. One row per field is a true interlace comb; taller
 * fields give the block tearing of a dropped frame.
 *
 * Opposite rather than one-sided, because a one-sided shift *moves* the picture
 * as well as tearing it, and moving the picture in seeded slices is already
 * F-GL-02. Two effects that produce the same image from different sliders is
 * the catalogue drifting, not two features.
 *
 * `phase` is measured in field pairs, so a modulator ramping 0 → 1 rolls the
 * comb down the image exactly once and closes the loop by construction — the
 * same reason the ordered dithers measure tile rotation in turns rather than
 * degrees.
 *
 * **No seed.** Which field a row lands in is a function of its y coordinate;
 * there is nothing stochastic to seed, and a seed slider that moves nothing is
 * worse than a missing one (`./error-diffusion` refuses inert controls on the
 * same grounds). The spec's GL preamble asks for a seed on every glitch effect
 * and this one departs from that deliberately; the departure is reported rather
 * than papered over with a control wired to nothing.
 */

import {
  defineEffect,
  type ParamDescriptor,
} from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";

import wgsl from "../shaders/interlace-tear.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
export const INTERLACE_TEAR_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const INTERLACE_TEAR_PARAM = {
  fieldHeight: "fieldHeight",
  wrap: "wrap",
  offset: "offset",
  phase: "phase",
} as const;

/**
 * Tallest field offered, in rows.
 *
 * Past this a "field" is a band rather than a scan line and the comb has become
 * two halves of an image sliding past each other — which is a look, but it is
 * the top of this control rather than somewhere on the way up.
 */
const MAX_FIELD_HEIGHT = 256;

/** Largest shift offered, in pixels. Beyond this the wrap dominates the frame. */
const MAX_OFFSET = 256;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/interlace-tear.wgsl`.
 *
 * Four `u32` then two `f32`, all 4-byte scalars in a run, so the only padding
 * is the tail that rounds 24 up to 32.
 */
export const INTERLACE_TEAR_UNIFORMS: UniformLayout = {
  sizeBytes: 32,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    {
      source: { kind: "param", key: INTERLACE_TEAR_PARAM.fieldHeight },
      type: "u32",
      offset: 8,
    },
    { source: { kind: "param", key: INTERLACE_TEAR_PARAM.wrap }, type: "u32", offset: 12 },
    { source: { kind: "param", key: INTERLACE_TEAR_PARAM.offset }, type: "f32", offset: 16 },
    { source: { kind: "param", key: INTERLACE_TEAR_PARAM.phase }, type: "f32", offset: 20 },
  ],
};

const INTERLACE_TEAR_PARAMS: readonly ParamDescriptor[] = [
  {
    key: INTERLACE_TEAR_PARAM.fieldHeight,
    label: "Field height",
    type: "int",
    // Not animatable: changing the field height re-cuts the image, so
    // consecutive frames are different pictures rather than stages of one
    // movement. `phase` is the axis that animates the comb.
    animatable: false,
    hint: "Rows per field. 1 is a true interlace comb; larger values tear in blocks.",
    legal: [1, MAX_FIELD_HEIGHT],
    // 1: the effect's own name. A default that needed explaining would be the
    // wrong default.
    default: 1,
    surprise: {
      // Log, because field height is measured in octaves — uniform sampling of
      // 1..64 spends most of its draws above 32, where every result is the same
      // two sliding half-images.
      range: [1, 64],
      distribution: { kind: "log" },
      weight: 1,
    },
  },
  {
    key: INTERLACE_TEAR_PARAM.offset,
    label: "Tear offset",
    type: "float",
    animatable: true,
    hint: "Horizontal shift applied to alternating fields, in pixels. Fields move in opposite directions.",
    legal: [-MAX_OFFSET, MAX_OFFSET],
    default: 6,
    surprise: {
      // Under a couple of pixels the comb is invisible at 1:1; past ~48 the two
      // field sets no longer read as one image.
      range: [-48, 48],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: INTERLACE_TEAR_PARAM.phase,
    label: "Phase",
    type: "float",
    animatable: true,
    // Field pairs rather than rows: a shift of two field heights is the
    // identity, so a modulator that ramps 0 -> 1 lands back on frame 0 without
    // the UI having to know that some row count is special.
    hint: "Slides which rows belong to which field, in field pairs. A 0→1 ramp rolls the comb once.",
    legal: [-1, 1],
    default: 0,
    surprise: {
      range: [-0.5, 0.5],
      distribution: { kind: "uniform" },
      // Low: a static phase only decides which of two nearly identical combs
      // you get. It earns its place as an animation target, not as a reroll.
      weight: 0.4,
    },
  },
  {
    key: INTERLACE_TEAR_PARAM.wrap,
    label: "Wrap at the edge",
    type: "bool",
    animatable: false,
    hint: "On, a shifted field wraps around the frame; off, it smears its edge column.",
    // On. A tear caused by a timing shift wraps — the line is still the same
    // length and its content has only moved within it — and that is the tear
    // this effect is imitating.
    default: true,
    surprise: {
      trueProbability: 0.75,
      // Below the numeric controls: the edge policy changes two columns of the
      // image, and a reroll that only flips it looks like nothing happened.
      weight: 0.3,
    },
  },
];

export default defineEffect({
  id: "interlace-tear",
  name: "Interlace tear",
  requirement: "F-GL-16",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  params: INTERLACE_TEAR_PARAMS,
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
});

/**
 * Parameter descriptors keyed for `packUniforms`.
 *
 * No enum here, so the packer never consults it — but it takes the map for
 * every effect, and an effect that omitted it would be the odd one out at the
 * call site.
 */
export const INTERLACE_TEAR_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  INTERLACE_TEAR_PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function interlaceTearDefaults(): Record<string, number | boolean> {
  return {
    [INTERLACE_TEAR_PARAM.fieldHeight]: 1,
    [INTERLACE_TEAR_PARAM.offset]: 6,
    [INTERLACE_TEAR_PARAM.phase]: 0,
    [INTERLACE_TEAR_PARAM.wrap]: true,
  };
}

/** The compute pass. */
export function interlaceTearEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: INTERLACE_TEAR_BINDING.inputColor },
    { role: "output-color", binding: INTERLACE_TEAR_BINDING.outputColor },
    { role: "uniforms", binding: INTERLACE_TEAR_BINDING.uniforms },
  ];

  const pass: ComputePass = {
    id: "interlace-tear/shift",
    label: "Interlace tear shift",
    wgsl,
    entryPoint: "main",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads one texel from its own row at a parameter-bounded distance, so the
    // window is bounded but not its own pixel — it must not alias its input.
    access: "neighbourhood",
    bindings,
    uniforms: INTERLACE_TEAR_UNIFORMS,
  };

  return { effect: "interlace-tear", passes: [pass] };
}
