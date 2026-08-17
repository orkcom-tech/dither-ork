/**
 * F-PT-10 — Wave field with obstacle interaction.
 *
 * Wavefronts from a source that the picture's subject either bends around or
 * blocks. The construction is in `../shaders/wave-field.wgsl`; the field it
 * reads is F-INF-01's transform half, built in `../gpu/sdf.ts` and scheduled by
 * {@link sdfTransformPasses} in front of this effect's own pass.
 *
 * ## Why this is not the ring pattern with extra controls
 *
 * `concentric-rings` (F-PT-05) and `spiral` (F-PT-06) already draw radial
 * screens, and they read nothing but the pixel's own tone. The requirement's
 * own wording is the argument: this one has to know **where the subject is as a
 * shape** — how far every texel is from it, and in which direction — which is a
 * global property no per-pixel pass can compute. That is a signed distance
 * field, and the fifteen jump-flood passes in front of the draw are what it
 * costs.
 *
 * It is also not `ridgeline` with extra parameters, and for the opposite
 * reason: `ridgeline` displaces by luminance *per texel*, which is a local
 * read.
 *
 * ## Nineteen passes, and what that means for a drag
 *
 * The field is rebuilt whenever any parameter of this node changes, because a
 * pass list is one unit: two to smooth the mask, one to seed its boundary,
 * fifteen to flood, and one to draw. Each flood pass is a full-frame read and
 * write of four bytes a texel. At preview resolution that is real but small; it
 * is the honest cost of the algorithm the requirement names, and everything
 * upstream of the node still caches normally.
 *
 * ## The mask source is a parameter
 *
 * F-INF-01 insists on it and this node exposes it: a luminance threshold or the
 * alpha channel, with an invert and a smoothing radius. **The smoothing is not
 * decoration**: a bare per-texel threshold on a photograph produces a few
 * hundred islands rather than a subject, and the fronts fragment on every one of
 * them. It was measured doing exactly that; the argument is in `../gpu/sdf.ts`
 * beside the passes. The third source the requirement names — a
 * selection over the index map — is not offered, and the reason is written
 * where the enum is, in `../gpu/sdf.ts`: it would make the node illegal
 * anywhere no quantizer precedes it, which is the case it was asked for.
 */

import { defineEffect, staticGpuEffect, type ParamDescriptor } from "../types/registry";
import type { ComputePass, GpuEffect, PassBinding, UniformLayout } from "../types/gpu";
import {
  SDF_MASK_SMOOTH_MAX,
  SDF_MASK_SOURCES,
  SDF_TRANSFORM_BINDINGS,
  SDF_TRANSFORM_UNIFORM_BYTES,
  sdfTransformPasses,
  sdfTransformUniformFields,
} from "../gpu/sdf";

import wgsl from "../shaders/wave-field.wgsl?raw";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
const BINDING = {
  inputColor: 0,
  outputColor: 1,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
} as const;

const PARAM = {
  sourceKind: "sourceKind",
  sourceX: "sourceX",
  sourceY: "sourceY",
  sourceAngle: "sourceAngle",
  wavelength: "wavelength",
  amplitude: "amplitude",
  falloff: "falloff",
  thickness: "thickness",
  mode: "mode",
  strength: "strength",
  phase: "phase",
  invert: "invert",
  maskSource: "maskSource",
  maskThreshold: "maskThreshold",
  maskInvert: "maskInvert",
  maskSmoothing: "maskSmoothing",
} as const;

/** Byte offset at which the shared transform's three fields begin. */
const SDF_FIELDS_AT = 56;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/wave-field.wgsl`.
 *
 * Fourteen 4-byte scalars in one run, then the transform's four, then the
 * padding that rounds 72 up to 80. Every pass of this effect declares **this
 * same layout**, the flood passes included: a flood reads only `width` and
 * `height`, but WebGPU sizes the bound uniform buffer against the whole
 * `Params` struct, so a shorter layout on those passes would fail validation
 * rather than save anything.
 */
export const WAVE_FIELD_UNIFORMS: UniformLayout = {
  sizeBytes: 80,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: PARAM.sourceKind }, type: "u32", offset: 8 },
    { source: { kind: "param", key: PARAM.sourceX }, type: "f32", offset: 12 },
    { source: { kind: "param", key: PARAM.sourceY }, type: "f32", offset: 16 },
    { source: { kind: "param", key: PARAM.sourceAngle }, type: "f32", offset: 20 },
    { source: { kind: "param", key: PARAM.wavelength }, type: "f32", offset: 24 },
    { source: { kind: "param", key: PARAM.amplitude }, type: "f32", offset: 28 },
    { source: { kind: "param", key: PARAM.falloff }, type: "f32", offset: 32 },
    { source: { kind: "param", key: PARAM.thickness }, type: "f32", offset: 36 },
    { source: { kind: "param", key: PARAM.mode }, type: "u32", offset: 40 },
    { source: { kind: "param", key: PARAM.strength }, type: "f32", offset: 44 },
    { source: { kind: "param", key: PARAM.phase }, type: "f32", offset: 48 },
    { source: { kind: "param", key: PARAM.invert }, type: "u32", offset: 52 },
    ...sdfTransformUniformFields(SDF_FIELDS_AT, {
      source: PARAM.maskSource,
      threshold: PARAM.maskThreshold,
      invert: PARAM.maskInvert,
      smooth: PARAM.maskSmoothing,
    }),
  ],
};

// 56 + 12 = 68, rounded up to 80. Asserted rather than trusted, because the
// three transform offsets are produced by a function and a reader cannot see
// them in the list above.
if (SDF_FIELDS_AT + SDF_TRANSFORM_UNIFORM_BYTES > WAVE_FIELD_UNIFORMS.sizeBytes) {
  throw new Error("wave-field uniform block is too small for the SDF transform fields");
}

const SOURCE_KIND: ParamDescriptor = {
  key: PARAM.sourceKind,
  label: "Source",
  type: "enum",
  // A choice, not a quantity: a modulator bound to it would cut between three
  // unrelated patterns rather than animate one.
  animatable: false,
  description:
    "Where the waves come from. A point sends out rings, a line sends out straight fronts across it, and an edge sends them inward from all four sides of the frame.",
  // Append-only. The shader sees the ordinal, so inserting a value in the
  // middle silently renumbers every document already saved.
  values: [
    { value: "point", label: "Point" },
    { value: "line", label: "Line" },
    { value: "edge", label: "Frame edge" },
  ],
  default: "point",
  surprise: {
    values: [
      { value: "point", weight: 3 },
      { value: "line", weight: 2 },
      { value: "edge", weight: 1 },
    ],
    weight: 1,
  },
};

const SOURCE_X: ParamDescriptor = {
  key: PARAM.sourceX,
  label: "Source X",
  type: "float",
  animatable: true,
  description:
    "Where the source sits across the frame, as a fraction of its width. Ignored by the frame-edge source.",
  // Past the edge on purpose: a source travelling on a bound modulator has to
  // be able to leave the frame and come back.
  legal: [-1, 2],
  // Off the middle of the frame in both axes, and that is not a taste choice.
  // A subject is usually near the centre, so a source at (0.5, 0.5) is usually
  // INSIDE it — and a source inside the obstacle shadows the whole picture
  // uniformly, which reads as a wave that is simply weaker with no silhouette
  // in it anywhere. Measured on a centred figure: at the middle the shadow was
  // invisible; off to one side it is the effect.
  default: 0.2,
  step: 0.001,
  surprise: {
    // A source far outside the frame gives near-parallel fronts, which is what
    // the line source is for; kept inside so the rings are visible as rings.
    range: [0.1, 0.9],
    distribution: { kind: "uniform" },
    weight: 0.8,
  },
};

const SOURCE_Y: ParamDescriptor = {
  key: PARAM.sourceY,
  label: "Source Y",
  type: "float",
  animatable: true,
  description:
    "Where the source sits down the frame, as a fraction of its height. 0 is the top edge. Ignored by the frame-edge source.",
  legal: [-1, 2],
  // Off the middle, for the reason on Source X.
  default: 0.15,
  step: 0.001,
  surprise: {
    range: [0.1, 0.9],
    distribution: { kind: "uniform" },
    weight: 0.8,
  },
};

const SOURCE_ANGLE: ParamDescriptor = {
  key: PARAM.sourceAngle,
  label: "Source angle",
  type: "float",
  animatable: true,
  description:
    "Which way a line source runs, in turns. The fronts travel across it. Ignored by the point and frame-edge sources.",
  legal: [0, 1],
  default: 0,
  step: 0.001,
  surprise: {
    range: [0, 1],
    distribution: { kind: "uniform" },
    weight: 0.6,
  },
};

const WAVELENGTH: ParamDescriptor = {
  key: PARAM.wavelength,
  label: "Wavelength",
  type: "float",
  animatable: true,
  description:
    "Texels between one crest and the next. It also sets how far the subject's bending reaches, because a wave bends around an obstacle over a distance of its own order.",
  // Below 3 there is no room for a stroke and a gap; above 400 a frame holds
  // two or three fronts and the field has stopped being one.
  legal: [3, 400],
  default: 28,
  step: 0.5,
  surprise: {
    // Measured in octaves: 12 to 24 is the same visual step as 40 to 80.
    range: [12, 90],
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
    "How strong the wave is at the source. Strength sets the stroke width, so a weak wave draws thin fronts that die out before a strong one does.",
  // The width is clamped at the declared thickness, so 1 is the value at which
  // a front at the source is exactly `thickness` wide and every value above it
  // is range spent before the control moves anything. Above 1 is still useful —
  // it pushes the point at which the falloff starts thinning the stroke further
  // out — which is why the ceiling is not 1.
  legal: [0, 4],
  default: 1,
  step: 0.05,
  surprise: {
    range: [0.8, 2.5],
    // Gain is heard in ratios, so log.
    distribution: { kind: "log" },
    weight: 1,
  },
};

const FALLOFF: ParamDescriptor = {
  key: PARAM.falloff,
  label: "Falloff",
  type: "float",
  animatable: true,
  description:
    "How far the wave carries, as a fraction of the frame's diagonal. Small values leave a burst around the source; large ones fill the frame evenly.",
  // A fraction of the diagonal rather than a count of texels, so the picture is
  // the same at preview resolution and at export resolution (F-UI-03 runs the
  // whole graph at a reduced extent).
  legal: [0.02, 4],
  default: 0.9,
  step: 0.01,
  surprise: {
    // The floor is 0.35 rather than the legal 0.02 because below about a third
    // of the diagonal the wave is a burst around the source with an empty frame
    // around it, which is not a result at any wavelength (F-SM-04).
    range: [0.35, 1.6],
    distribution: { kind: "log" },
    weight: 0.9,
  },
};

const THICKNESS: ParamDescriptor = {
  key: PARAM.thickness,
  label: "Thickness",
  type: "float",
  animatable: true,
  description:
    "Stroke width of a crest in texels, where the wave is at full strength. It thins with distance and with occlusion.",
  legal: [0.5, 32],
  default: 3,
  step: 0.1,
  surprise: {
    range: [1.5, 8],
    distribution: { kind: "log" },
    weight: 0.8,
  },
};

const MODE: ParamDescriptor = {
  key: PARAM.mode,
  label: "Interaction",
  type: "enum",
  animatable: false,
  description:
    "Flow around bends the fronts past the subject and over it, the way contour lines part around a hill. Shadow lets the subject block them, leaving the region behind it empty.",
  // Append-only, as above.
  values: [
    { value: "flow-around", label: "Flow around" },
    { value: "shadow", label: "Shadow" },
  ],
  default: "flow-around",
  surprise: {
    values: [
      { value: "flow-around", weight: 3 },
      { value: "shadow", weight: 2 },
    ],
    weight: 1.1,
  },
};

const STRENGTH: ParamDescriptor = {
  key: PARAM.strength,
  label: "Interaction strength",
  type: "float",
  animatable: true,
  description:
    "How strongly the subject acts on the wave. At 0 the field ignores the picture entirely. Positive delays the wave around the subject so the fronts bulge away from the source; negative advances it and they pinch in. In shadow mode only the magnitude is read, and 1 is fully dark.",
  legal: [-1, 1],
  // High, because at 0.7 a blocked region still draws a stroke two thirds of
  // the way to full width and the shadow does not read as one. Measured on a
  // figure lit from above: 0.7 thinned the fronts, 0.9 put a silhouette in them.
  default: 0.9,
  step: 0.01,
  surprise: {
    // Below about 0.25 in magnitude the interaction is not visible and the node
    // has become a ring pattern, which is what `concentric-rings` already is
    // (F-SM-04). Kept positive: bulging away from the source is what the
    // requirement describes, and pinching in is the deliberate opposite.
    range: [0.4, 1],
    distribution: { kind: "uniform" },
    // The highest weight here: this is what decides whether a reroll shows the
    // thing the effect exists for.
    weight: 1.3,
  },
};

const PHASE: ParamDescriptor = {
  key: PARAM.phase,
  label: "Phase",
  type: "float",
  animatable: true,
  description:
    "Slides the fronts along, in whole cycles. A modulator ramping 0 to 1 advances them by exactly one wavelength and lands back where it started, so the waves travel and the loop closes.",
  legal: [-8, 8],
  default: 0,
  step: 0.01,
  surprise: {
    // A whole cycle is the entire range there is: the pattern repeats.
    range: [0, 1],
    distribution: { kind: "uniform" },
    // Low: which crest falls where is an offset rather than a look. It is here
    // because it is the animation target.
    weight: 0.3,
  },
};

const INVERT: ParamDescriptor = {
  key: PARAM.invert,
  label: "Invert",
  type: "bool",
  animatable: false,
  description:
    "Swaps ink and ground, so the fronts become dark on the palette's lightest colour instead of light on its darkest.",
  default: false,
  surprise: { trueProbability: 0.35, weight: 0.5 },
};

const MASK_SOURCE_LABELS: Readonly<Record<(typeof SDF_MASK_SOURCES)[number], string>> = {
  luminance: "Brightness",
  alpha: "Alpha channel",
};

const MASK_SOURCE: ParamDescriptor = {
  key: PARAM.maskSource,
  label: "Subject from",
  type: "enum",
  animatable: false,
  description:
    "What counts as the subject the waves interact with: everything brighter than the threshold, or everything the alpha channel says is opaque.",
  // Generated from SDF_MASK_SOURCES for the same reason gen-shape generates its
  // figure list: the ordinal that crosses to the shader is the position in that
  // list, and the shared block restates the same numbering. Two hand-written
  // lists would agree until somebody added a source to one of them.
  values: SDF_MASK_SOURCES.map((source) => ({
    value: source,
    label: MASK_SOURCE_LABELS[source],
  })),
  default: "luminance",
  surprise: {
    // **Luminance only, and the omission is the point.** Alpha is a real source
    // and a person can choose it; a reroll cannot, because the generator has no
    // way to know whether the document's picture has a meaningful alpha channel
    // and most do not. On an opaque photograph the alpha mask catches the whole
    // frame, the field has no boundary, and the node quietly stops being
    // subject-aware while every control still reads as though it is — which is
    // exactly the reroll F-SM-04 says must not be drawn.
    values: [{ value: "luminance", weight: 1 }],
    weight: 0.4,
  },
};

const MASK_THRESHOLD: ParamDescriptor = {
  key: PARAM.maskThreshold,
  label: "Subject threshold",
  type: "float",
  animatable: true,
  description:
    "The lightness that separates subject from background. This is the whole of where the subject is: a figure the same brightness as what is behind it cannot be separated by it.",
  // Lightness, not linear luminance: the slider has to mean what the eye sees
  // it mean, and 0.5 linear is already a light grey on screen.
  legal: [0, 1],
  default: 0.42,
  step: 0.01,
  surprise: {
    // Outside this the mask catches the whole frame or none of it, the field
    // has no boundary, and the node draws a plain ring pattern (F-SM-04). The
    // ceiling is 0.6 and not higher for a reason worth stating: 0.7 lightness
    // is linear 0.34, brighter than everything but a specular highlight in a
    // normally exposed photograph, so a reroll landing there finds no subject
    // at all and the node silently stops being subject-aware.
    range: [0.3, 0.6],
    distribution: { kind: "normal", mean: 0.5, sigma: 0.1 },
    weight: 1,
  },
};

const MASK_SMOOTHING: ParamDescriptor = {
  key: PARAM.maskSmoothing,
  label: "Subject smoothing",
  type: "float",
  animatable: true,
  description:
    "How big a feature has to be to count as part of the subject, in texels. Without it a photograph is not one shape but a few hundred islands — every seam and highlight its own outline — and the waves break up on all of them.",
  legal: [0, SDF_MASK_SMOOTH_MAX],
  default: 8,
  step: 0.5,
  surprise: {
    // Below about 3 the interior detail of any real picture survives the
    // threshold and the field has hundreds of boundaries in it (F-SM-04); above
    // about 20 the silhouette itself is rounded off and the subject stops being
    // recognisable as the thing in the photograph.
    range: [4, 18],
    distribution: { kind: "log" },
    weight: 1,
  },
};

const MASK_INVERT: ParamDescriptor = {
  key: PARAM.maskInvert,
  label: "Subject inverted",
  type: "bool",
  animatable: false,
  description:
    "Treats the dark part of the picture as the subject instead of the bright part. On a figure lit against a dark ground, this is the one control that has to be right.",
  default: false,
  surprise: { trueProbability: 0.4, weight: 0.7 },
};

export default defineEffect({
  id: "wave-field",
  name: "Wave field",
  summary:
    "Draws waves from a source that bend around the picture's subject, or are blocked by it and leave a shadow.",
  description:
    "Wavefronts spread from a point, a line or the frame's edge, and the subject of the picture interacts with them. Flow around bends the fronts past the subject and carries them over it, the way contour lines part around a hill; shadow lets the subject block them, so the region behind it relative to the source is left empty with a penumbra that widens with distance. Both need to know where the subject is as a shape — how far every texel is from it and which way it lies — so the node builds a signed distance field out of the picture first, by jump flooding, and that is fifteen passes in front of the one that draws. Which part of the picture counts as the subject is a control, not a guess: a lightness threshold or the alpha channel, with an invert for a figure lit against a dark ground. The waves are drawn as strokes in the palette's lightest and darkest entries, and their strength sets the stroke width, so a wave fades by thinning out rather than by dimming into a colour the palette does not have.",
  keywords: [
    "radio waves",
    "wave field",
    "wavefront",
    "diffraction",
    "obstacle",
    "flow around",
    "shadow",
    "occlusion",
    "sonar",
    "ripple around",
    "interference",
    "subject aware",
    "contour",
    "topographic",
    "distance field",
    "sdf",
    "frequency",
    "ripples",
    "radar",
  ],
  concept: "halftone-screen",
  requirement: "F-PT-10",
  slot: "dither",
  family: "pattern",
  execution: "gpu",
  params: [
    SOURCE_KIND,
    SOURCE_X,
    SOURCE_Y,
    SOURCE_ANGLE,
    WAVELENGTH,
    AMPLITUDE,
    FALLOFF,
    THICKNESS,
    MODE,
    STRENGTH,
    PHASE,
    INVERT,
    MASK_SOURCE,
    MASK_THRESHOLD,
    MASK_SMOOTHING,
    MASK_INVERT,
  ],
  surpriseWeight: 1.1,
  producesIndexMap: true,
  requiresIndexMap: false,
});

/**
 * The draw pass — the sixteenth, after the transform's own fifteen.
 *
 * It binds the two seed buffers alongside the ordinary roles, because the field
 * lives in them: {@link SDF_TRANSFORM_BINDINGS} at 6 and 7, which is why this
 * effect has no scratch of its own to number.
 */
const DRAW_BINDINGS: readonly PassBinding[] = [
  { role: "input-color", binding: BINDING.inputColor },
  { role: "output-color", binding: BINDING.outputColor },
  { role: "output-index", binding: BINDING.outputIndex },
  { role: "palette", binding: BINDING.palette },
  { role: "uniforms", binding: BINDING.uniforms },
  ...SDF_TRANSFORM_BINDINGS,
];

const DRAW: ComputePass = {
  id: "wave-field/draw",
  label: "Wave field",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // The shadow march reads the field along a whole ray, which is as global as a
  // pass gets.
  access: "global",
  bindings: DRAW_BINDINGS,
  uniforms: WAVE_FIELD_UNIFORMS,
};

export const waveFieldGpuEffect: GpuEffect = {
  effect: "wave-field",
  passes: [
    ...sdfTransformPasses({ effect: "wave-field", wgsl, uniforms: WAVE_FIELD_UNIFORMS }),
    DRAW,
  ],
};

/** Parameter descriptors keyed for `packUniforms`. */
export const WAVE_FIELD_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map<
  string,
  ParamDescriptor
>(
  [
    SOURCE_KIND,
    SOURCE_X,
    SOURCE_Y,
    SOURCE_ANGLE,
    WAVELENGTH,
    AMPLITUDE,
    FALLOFF,
    THICKNESS,
    MODE,
    STRENGTH,
    PHASE,
    INVERT,
    MASK_SOURCE,
    MASK_THRESHOLD,
    MASK_SMOOTHING,
    MASK_INVERT,
  ].map((param) => [param.key, param]),
);

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("wave-field", () => waveFieldGpuEffect);
