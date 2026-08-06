/**
 * F-SP-05 — Emboss: angle, depth.
 *
 * A directional derivative of lightness rendered as relief — bright where
 * lightness rises towards the light, dark where it falls away, flat mid-grey
 * where the picture is flat. Colour is discarded, which is what makes it an
 * emboss rather than a directional sharpen, and is why it carries the lowest
 * surprise weight of the five special effects in this group.
 *
 * Two controls, exactly the two the requirement names. The tap distance is
 * fixed at one pixel rather than exposed: a control that moved it would be a
 * second radius with nothing distinguishing it from a blur, and the requirement
 * does not ask for one.
 *
 * Slot is `preprocess`. Run after a dither, the derivative finds the dither's
 * own texture rather than the picture's relief — every pixel is a step edge by
 * then. Run before it, the grey relief dithers into exactly the kind of
 * engraved plate this application exists to make. The slot steers Surprise Me's
 * grammar only; F-ST-01 lets the user drag the node anywhere.
 */

import { defineEffect, type ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/emboss.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
const BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
} as const;

const PARAM = {
  angle: "angle",
  depth: "depth",
} as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `emboss.wgsl`.
 *
 * Four 4-byte scalars are exactly the 16 bytes WGSL rounds a uniform struct up
 * to, so this layout needs no tail padding.
 */
export const EMBOSS_UNIFORMS: UniformLayout = {
  sizeBytes: 16,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: PARAM.angle }, type: "f32", offset: 8 },
    { source: { kind: "param", key: PARAM.depth }, type: "f32", offset: 12 },
  ],
};

const ANGLE: ParamDescriptor = {
  key: PARAM.angle,
  label: "Light angle",
  type: "float",
  animatable: true,
  // Turns, not degrees, for the same reason the ordered dithers' tile rotation
  // is: a modulator ramping 0 -> 1 lands back where it started, so an animated
  // sweep loops without the UI having to know that 360 is special.
  hint: "Direction the light comes from, in turns counter-clockwise from the right.",
  legal: [0, 1],
  // Upper left, which is where every engraving convention puts the light.
  default: 0.375,
  step: 0.005,
  surprise: {
    // The only parameter here whose surprise range is its whole legal range,
    // and deliberately: an angle has no unmusical values, it has one value per
    // direction and they are all equally good. Narrowing it would only mean
    // every random emboss is lit from the same side.
    range: [0, 1],
    distribution: { kind: "uniform" },
    weight: 1,
  },
};

const DEPTH: ParamDescriptor = {
  key: PARAM.depth,
  label: "Depth",
  type: "float",
  animatable: true,
  hint: "Gain on the lightness difference between the two taps. High values clip to solid black and white.",
  legal: [0, 8],
  default: 1.5,
  step: 0.05,
  surprise: {
    // Under about 0.6 the relief is a flat grey field with a hint of structure
    // in it; over 3 everything but the flats has clipped and the result is a
    // two-tone outline (F-SM-04).
    range: [0.6, 3],
    // Gain is heard in ratios, so log.
    distribution: { kind: "log" },
    weight: 1,
  },
};

export default defineEffect({
  id: "emboss",
  name: "Emboss",
  requirement: "F-SP-05",
  slot: "preprocess",
  family: "special",
  execution: "gpu",
  params: [ANGLE, DEPTH],
  // The lowest of this group. It throws away colour and most of the tonal
  // range, so a random stack should reach it rarely and on purpose (F-SM-03).
  surpriseWeight: 0.5,
  producesIndexMap: false,
  requiresIndexMap: false,
});

const BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: BINDING.inputColor },
  { role: "output-color", binding: BINDING.outputColor },
  { role: "uniforms", binding: BINDING.uniforms },
];

const PASSES: readonly ComputePass[] = [
  {
    id: "emboss/relief",
    label: "Emboss relief",
    wgsl,
    entryPoint: "relief",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads two bilinear taps either side of the centre, so input and output
    // must not alias.
    access: "neighbourhood",
    bindings: BINDINGS,
    uniforms: EMBOSS_UNIFORMS,
  },
];

export const embossGpuEffect: GpuEffect = { effect: "emboss", passes: PASSES };

/** Parameter descriptors keyed for `packUniforms`. */
export const EMBOSS_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> =
  new Map<string, ParamDescriptor>([
    [ANGLE.key, ANGLE],
    [DEPTH.key, DEPTH],
  ]);
