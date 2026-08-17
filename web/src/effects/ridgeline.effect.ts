/**
 * F-PT-09 — Luminance-displaced line screen (the *Unknown Pleasures* ridgeline).
 *
 * Parallel rows laid across the frame, each one displaced towards the viewer by
 * the picture's luminance along its own baseline, with the row in front hiding
 * what is behind it. The construction and the hidden-line argument are in
 * `../shaders/ridgeline.wgsl`; this file is the controls and why each one has
 * the range it has.
 *
 * ## Why it is a gap and not a duplicate
 *
 * Three effects in the catalogue look like near misses and none of them is
 * close. `line-screen` (F-PT-03) draws parallel lines and varies their *width*
 * with tone — the lines never move. `wave-warp` (F-GL-10) displaces by a
 * geometric function of position, so the picture is dragged around but nothing
 * is drawn. `row-displacement` (F-GL-02) displaces by a seed. **Nothing
 * displaces by the picture**, and that is the whole of the look: the rows stop
 * being a texture over the image and become a reading of it.
 *
 * ## The two controls that decide whether it works
 *
 * `amplitude` is in **pitches**, not texels. What the eye reads is the ratio
 * between how far a row travels and the gap to the next one; fixing that ratio
 * keeps the picture recognisable while the pitch is dragged, and it is what
 * bounds the shader's hidden-line walk to a constant number of rows.
 *
 * `hidden` defaults **on**. With it off the rows cross each other freely and
 * the result is a tangle — which is a real oscilloscope look and is why the
 * control exists, but it is not the ridgeline and it is not what the effect is
 * for.
 *
 * ## Slot, and what to put after it
 *
 * `dither`: it replaces the picture with a two-colour drawing and emits the
 * index map to prove it, exactly as the other pattern screens do. Over a dark
 * two-colour palette with `epsilon-glow` after it, this is the neon reference
 * look — and that combination is not discoverable from either node's controls,
 * so both descriptions say so.
 */

import { defineEffect, staticGpuEffect, type ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";

import wgsl from "../shaders/ridgeline.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
const BINDING = {
  inputColor: 0,
  outputColor: 1,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
} as const;

const PARAM = {
  pitch: "pitch",
  amplitude: "amplitude",
  thickness: "thickness",
  angle: "angle",
  phase: "phase",
  hidden: "hidden",
  invert: "invert",
} as const;

/**
 * The ceiling on `amplitude`, in pitches.
 *
 * **It is a correctness bound, not a taste one.** `SEARCH_ROWS` in
 * `../shaders/ridgeline.wgsl` is the constant that makes the hidden-line walk
 * statically bounded, and it is sufficient only because a row's curve cannot
 * sit more than this many pitches below its own baseline. Raising one without
 * the other makes the walk stop before it has found the front-most row, and the
 * symptom is a row that vanishes where it is steepest rather than an error.
 */
export const RIDGELINE_MAX_AMPLITUDE = 10;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/ridgeline.wgsl`.
 *
 * Nine 4-byte scalars in one run, so nothing needs padding in front of it and
 * the only padding is the tail that rounds 36 up to 48.
 */
export const RIDGELINE_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: PARAM.pitch }, type: "f32", offset: 8 },
    { source: { kind: "param", key: PARAM.amplitude }, type: "f32", offset: 12 },
    { source: { kind: "param", key: PARAM.thickness }, type: "f32", offset: 16 },
    { source: { kind: "param", key: PARAM.angle }, type: "f32", offset: 20 },
    { source: { kind: "param", key: PARAM.phase }, type: "f32", offset: 24 },
    { source: { kind: "param", key: PARAM.hidden }, type: "u32", offset: 28 },
    { source: { kind: "param", key: PARAM.invert }, type: "u32", offset: 32 },
  ],
};

const PITCH: ParamDescriptor = {
  key: PARAM.pitch,
  label: "Pitch",
  type: "float",
  animatable: true,
  description:
    "Texels between one row's baseline and the next. It sets how many rows the picture is read as, and every other distance here is measured in it.",
  // Below 2 there is no room for a stroke and a gap; above 200 a 1080-tall
  // frame has five rows and the picture has stopped being legible.
  legal: [2, 200],
  default: 12,
  step: 0.5,
  surprise: {
    // 6 is a dense weave that reads as a texture; 40 is the sparse album-cover
    // spacing. Outside that it is either a hatch or a handful of lines (F-SM-04).
    range: [6, 40],
    // Measured in octaves: 6 to 12 is the same visual step as 20 to 40.
    distribution: { kind: "log" },
    weight: 1.1,
  },
};

const AMPLITUDE: ParamDescriptor = {
  key: PARAM.amplitude,
  label: "Amplitude",
  type: "float",
  animatable: true,
  description:
    "How far white pushes a row towards the viewer, measured in pitches. Above 1 the rows overlap and start hiding each other, which is where the relief comes from.",
  legal: [0, RIDGELINE_MAX_AMPLITUDE],
  default: 2.5,
  step: 0.05,
  surprise: {
    // Under about 0.8 no row reaches the next one, nothing is ever occluded and
    // the result is a plain line screen with a wobble in it. Over about 6 the
    // rows pile so deep that only the brightest few are visible and the picture
    // is a comb (F-SM-04).
    range: [1.2, 5],
    distribution: { kind: "uniform" },
    // The highest weight here: amplitude is what decides whether a reroll reads
    // as a ridgeline at all.
    weight: 1.3,
  },
};

const THICKNESS: ParamDescriptor = {
  key: PARAM.thickness,
  label: "Thickness",
  type: "float",
  animatable: true,
  description:
    "Stroke width in texels. Wide strokes close the gaps between rows and the drawing becomes a solid relief.",
  legal: [0.5, 16],
  default: 1.5,
  step: 0.1,
  surprise: {
    range: [1, 4],
    distribution: { kind: "log" },
    weight: 0.8,
  },
};

const ANGLE: ParamDescriptor = {
  key: PARAM.angle,
  label: "Direction",
  type: "float",
  animatable: true,
  description:
    "Which way the rows run, in turns. 0 is horizontal rows displaced downwards; 0.25 turns the whole relief on its side.",
  // A whole turn's worth of distinct pictures, centred on zero. Half a turn
  // does not suffice — a row at angle a and one at a + 0.5 run along the same
  // line but are displaced in opposite directions — and centring it is what
  // lets the surprise range sit symmetrically about the horizontal.
  legal: [-0.5, 0.5],
  default: 0,
  step: 0.001,
  surprise: {
    // Kept near the horizontal: the relief reads as terrain when the rows run
    // across the frame, and as a curtain when they run down it. A small tilt is
    // interesting, a random angle mostly is not (F-SM-04).
    range: [-0.06, 0.06],
    distribution: { kind: "normal", mean: 0, sigma: 0.03 },
    weight: 0.6,
  },
};

const PHASE: ParamDescriptor = {
  key: PARAM.phase,
  label: "Phase",
  type: "float",
  animatable: true,
  description:
    "Slides the whole set of rows across, in pitches. A modulator ramping 0 to 1 advances them by exactly one row and lands back where it started.",
  legal: [-8, 8],
  default: 0,
  step: 0.01,
  surprise: {
    // A whole pitch is the entire range there is: the pattern repeats.
    range: [0, 1],
    distribution: { kind: "uniform" },
    // Low: which row a scanline falls on is not a look, it is an offset. It is
    // here because it is the animation target.
    weight: 0.3,
  },
};

const HIDDEN: ParamDescriptor = {
  key: PARAM.hidden,
  label: "Hidden line removal",
  type: "bool",
  // A structural choice rather than a quantity: bound to a modulator it would
  // cut between two unrelated pictures on alternate frames.
  animatable: false,
  description:
    "Rows in front hide the ones behind them. On, the drawing reads as depth; off, the rows cross freely and it reads as an oscilloscope tangle.",
  default: true,
  surprise: {
    // Heavily towards on. Off is a real look and it is not the one this effect
    // exists for, so a reroll should find it occasionally rather than half the
    // time (F-SM-03).
    trueProbability: 0.85,
    weight: 0.9,
  },
};

const INVERT: ParamDescriptor = {
  key: PARAM.invert,
  label: "Invert",
  type: "bool",
  animatable: false,
  description:
    "Swaps ink and ground, so the drawing becomes dark strokes on the palette's lightest colour instead of light strokes on its darkest.",
  default: false,
  surprise: {
    trueProbability: 0.4,
    weight: 0.5,
  },
};

export default defineEffect({
  id: "ridgeline",
  name: "Ridgeline",
  summary:
    "Draws the picture as parallel rows displaced by its own brightness, each row hiding the ones behind it.",
  description:
    "Rows are laid across the frame at a fixed pitch and each one is pushed towards the viewer by the brightness of the picture along its own baseline, so every row becomes a plot of one line of the image and the set of them becomes a relief map — the Unknown Pleasures construction. Hidden line removal is what makes it read as depth rather than as noise: a row in front is opaque and hides what is behind it, and with it switched off the rows cross freely into an oscilloscope tangle. Amplitude is measured in pitches rather than texels, because what the eye reads is how far a row travels relative to the gap to the next one, so the picture survives having the pitch dragged. It draws in the palette's lightest and darkest entries and nothing between them, because a ridgeline is a stroke rather than a tone. Over a dark two-colour palette with epsilon glow after it, this is the neon line look — and that combination is not discoverable from either node's controls alone.",
  keywords: [
    "unknown pleasures",
    "joy division",
    "ridgeline",
    "ridge",
    "contour",
    "terrain",
    "topographic",
    "elevation",
    "displaced lines",
    "luminance displacement",
    "mountain",
    "heightmap",
    "oscilloscope",
    "relief",
    "profile",
    "waveform",
    "frequency",
    "hidden line",
    "plotter",
  ],
  // The screens are the family this belongs to: a regular geometric pattern
  // laid over the frame, reproducing the picture by where the ink falls.
  concept: "halftone-screen",
  requirement: "F-PT-09",
  slot: "dither",
  family: "pattern",
  execution: "gpu",
  params: [PITCH, AMPLITUDE, THICKNESS, ANGLE, PHASE, HIDDEN, INVERT],
  // Above an ordinary screen. This is a signature look rather than a curiosity
  // and F-SM-03 wants signature looks to turn up more often.
  surpriseWeight: 1.2,
  producesIndexMap: true,
  requiresIndexMap: false,
});

const BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: BINDING.inputColor },
  { role: "output-color", binding: BINDING.outputColor },
  { role: "output-index", binding: BINDING.outputIndex },
  { role: "palette", binding: BINDING.palette },
  { role: "uniforms", binding: BINDING.uniforms },
];

const PASSES: readonly ComputePass[] = [
  {
    id: "ridgeline/draw",
    label: "Ridgeline",
    wgsl,
    entryPoint: "main",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Each invocation walks up to thirteen rows and samples the picture once
    // per row, at a point up to `amplitude` pitches away across the frame. That
    // is a window, but not one the scheduler could bound by a radius — it
    // depends on two parameters — so it is declared for what it is.
    access: "global",
    bindings: BINDINGS,
    uniforms: RIDGELINE_UNIFORMS,
  },
];

export const ridgelineGpuEffect: GpuEffect = {
  effect: "ridgeline",
  passes: PASSES,
};

/** Parameter descriptors keyed for `packUniforms`. */
export const RIDGELINE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map<
  string,
  ParamDescriptor
>([
  [PITCH.key, PITCH],
  [AMPLITUDE.key, AMPLITUDE],
  [THICKNESS.key, THICKNESS],
  [ANGLE.key, ANGLE],
  [PHASE.key, PHASE],
  [HIDDEN.key, HIDDEN],
  [INVERT.key, INVERT],
]);

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("ridgeline", () => ridgelineGpuEffect);
