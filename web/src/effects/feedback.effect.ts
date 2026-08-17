/**
 * Feedback (F-FB-01).
 *
 * **Frame N reads frame N-1.** This node composites its own output from the
 * previous frame back over its current input, decayed and optionally moved.
 * Trails, decay, growth, smear, endless zoom and the whole family of "living"
 * textures are that one sentence; nothing else in the catalogue can produce any
 * of them, because every other node is a pure function of the picture handed to
 * it.
 *
 * ## Not in the numbered spec, and that is deliberate
 *
 * `F-FB-01` is an id this build assigns. The spec covers Dither Boy parity for
 * still images and has no requirement for feedback; the decision to build it,
 * and the three consequences it forces, are in
 * `docs/dither-ork-node-graph.md` — cache exclusion, a document that does not
 * loop, and frames that must be rendered in order. Each of the three is
 * implemented where it belongs and each names that document.
 *
 * ## What this costs, stated where a reader will meet it
 *
 * - **This node and everything after it stop being cached.** A content hash
 *   cannot describe a node whose output depends on every frame before it, so
 *   `graph/feedback.ts` excludes the node and its downstream from the node
 *   cache and logs what it excluded. Everything *upstream* caches exactly as it
 *   did, which is most of the win in a typical stack.
 * - **A document containing this node does not loop.** F-AN-03 guarantees frame
 *   N equals frame 0 by construction; a decaying trail cannot. Animated export
 *   says so before encoding rather than failing a seam check the document was
 *   never going to pass.
 * - **Scrubbing backwards re-renders from zero.** Frame 40 is the product of
 *   frames 0..40. The frame store refuses a frame it cannot serve rather than
 *   showing one the export would not produce.
 *
 * ## Frame 0
 *
 * The history buffer is **cleared to transparent black** when a chain begins,
 * not left holding whatever the texture pool last had in it. With the default
 * `screen` blend — and with `add`, `lighten`, `difference` and `exclusion` —
 * that makes this pass the identity on frame 0, so a feedback document's first
 * frame is its input exactly.
 *
 * ## No seed
 *
 * Nothing here is stochastic. The state that makes each frame different from
 * the last is the previous frame, which is data rather than a draw, so there is
 * nothing to reroll — the same argument `ghost-echo` makes for the same reason.
 * That also means F-AN-05 is untouched: no clock is read and no unseeded number
 * is drawn anywhere on this path.
 */

import {
  defineEffect,
  type ParamDescriptor,
  staticGpuEffect,
} from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";
import { BLEND_MODES } from "../graph/blend";

import wgsl from "../shaders/feedback.wgsl?raw";

/** Canonical binding numbers, restated from CONVENTIONS.md. */
export const FEEDBACK_BINDING = {
  inputColor: 0,
  outputColor: 1,
  uniforms: 5,
  /**
   * The previous frame. 6 is the first effect-specific slot, and it is the same
   * number `_composite.wgsl` gives its second colour input — there is one
   * conventional colour input and this is not it.
   */
  feedbackColor: 6,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const FEEDBACK_PARAM = {
  decay: "decay",
  blend: "blend",
  opacity: "opacity",
  offsetX: "offsetX",
  offsetY: "offsetY",
  scale: "scale",
  rotate: "rotate",
} as const;

/**
 * Largest per-frame offset offered, in pixels.
 *
 * A trail is drawn by the *accumulation* of the offset, not by one step of it:
 * at 8 px a frame a 48-frame loop has moved the oldest surviving ghost 384 px.
 * Past about 64 the successive copies stop overlapping at all and the effect
 * reads as a row of stamps rather than as a smear, so this is where the control
 * stops doing what it is named for.
 */
const MAX_OFFSET = 64;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/feedback.wgsl`.
 *
 * Three `u32` and six `f32` in one run, so nothing needs padding in front of
 * it; the only padding is the twelve bytes that round 36 up to 48.
 */
export const FEEDBACK_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: FEEDBACK_PARAM.blend }, type: "u32", offset: 8 },
    { source: { kind: "param", key: FEEDBACK_PARAM.decay }, type: "f32", offset: 12 },
    { source: { kind: "param", key: FEEDBACK_PARAM.opacity }, type: "f32", offset: 16 },
    { source: { kind: "param", key: FEEDBACK_PARAM.offsetX }, type: "f32", offset: 20 },
    { source: { kind: "param", key: FEEDBACK_PARAM.offsetY }, type: "f32", offset: 24 },
    { source: { kind: "param", key: FEEDBACK_PARAM.scale }, type: "f32", offset: 28 },
    { source: { kind: "param", key: FEEDBACK_PARAM.rotate }, type: "f32", offset: 32 },
  ],
};

/**
 * The blend enum's values, generated from `BLEND_MODES`.
 *
 * Generated rather than written out for the reason `BLEND_ORDINAL` is: the
 * ordinal a value crosses to the shader as is its **position in this list**,
 * and the shader's `const` block restates `BLEND_MODES`' numbering. Two
 * hand-written lists would agree until somebody added a mode to one of them,
 * and the symptom would be a saved document rendering with a different blend.
 */
const BLEND_LABELS: Readonly<Record<(typeof BLEND_MODES)[number], string>> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  "hard-light": "Hard light",
  "soft-light": "Soft light",
  darken: "Darken",
  lighten: "Lighten",
  difference: "Difference",
  exclusion: "Exclusion",
  add: "Add",
  subtract: "Subtract",
};

const FEEDBACK_PARAMS: readonly ParamDescriptor[] = [
  {
    key: FEEDBACK_PARAM.decay,
    label: "Decay",
    type: "float",
    animatable: true,
    // The name is the one every feedback system uses and it names a *retained*
    // fraction, so the description says which way round it runs rather than
    // leaving a reader to find out by dragging. Higher keeps more.
    description:
      "How much of the previous frame survives into this one. 0 leaves no trail at all; 0.98 leaves one that barely fades over a whole loop.",
    legal: [0, 1],
    default: 0.9,
    step: 0.01,
    surprise: {
      // Below ~0.5 the trail is gone within three frames and the node stops
      // being distinguishable from an ordinary glow; at 1 nothing ever fades
      // and a bright source saturates the frame within a second (F-SM-04).
      range: [0.6, 0.96],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: FEEDBACK_PARAM.blend,
    label: "Combine",
    type: "enum",
    // A choice, not a quantity: binding a modulator to it would turn a trail
    // into a stutter of hard cuts between arithmetics.
    animatable: false,
    description:
      "How the decayed previous frame is combined with the current one. Screen and add build light up, darken and multiply eat it away, difference turns a trail into an edge.",
    values: BLEND_MODES.map((mode) => ({ value: mode, label: BLEND_LABELS[mode] })),
    // Screen is the trail everyone means: it accumulates light without the
    // blow-out `add` reaches in a handful of frames, and it is the identity on
    // frame 0 against the cleared buffer.
    default: "screen",
    surprise: {
      values: [
        { value: "screen", weight: 4 },
        { value: "lighten", weight: 2 },
        { value: "add", weight: 1 },
        { value: "difference", weight: 1 },
        { value: "darken", weight: 1 },
        // `normal` replaces the picture with its own history and, at full
        // opacity, freezes frame 0 on screen forever. Legal, occasionally
        // wanted, never worth generating.
        { value: "normal", weight: 0.1 },
      ],
      weight: 0.8,
    },
  },
  {
    key: FEEDBACK_PARAM.opacity,
    label: "Trail opacity",
    type: "float",
    animatable: true,
    // Named "trail" because the stack row already has an opacity slider, and
    // that one blends the whole node against its input. This one blends the
    // history against the current frame, inside the node.
    description:
      "How strongly the combined trail replaces the current frame. At 0 this node is the identity whatever else is set.",
    legal: [0, 1],
    default: 1,
    step: 0.01,
    surprise: {
      range: [0.4, 1],
      distribution: { kind: "uniform" },
      weight: 0.8,
    },
  },
  {
    key: FEEDBACK_PARAM.offsetX,
    label: "Drift X",
    type: "float",
    animatable: true,
    description:
      "How far the previous frame moves right before it is combined, in pixels per frame. What turns a glow into a smear.",
    legal: [-MAX_OFFSET, MAX_OFFSET],
    // Zero: a node added to a stack should do the thing it is named for and
    // nothing else, and the thing it is named for is the trail. Motion is what
    // the next four controls are.
    default: 0,
    step: 0.1,
    surprise: {
      range: [-6, 6],
      distribution: { kind: "normal", mean: 0, sigma: 3 },
      weight: 1,
    },
  },
  {
    key: FEEDBACK_PARAM.offsetY,
    label: "Drift Y",
    type: "float",
    animatable: true,
    description:
      "How far the previous frame moves down before it is combined, in pixels per frame. Negative drifts it upward.",
    legal: [-MAX_OFFSET, MAX_OFFSET],
    default: 0,
    step: 0.1,
    surprise: {
      range: [-6, 6],
      distribution: { kind: "normal", mean: 0, sigma: 3 },
      weight: 1,
    },
  },
  {
    key: FEEDBACK_PARAM.scale,
    label: "Zoom",
    type: "float",
    animatable: true,
    description:
      "How much the previous frame grows before it is combined, per frame. Above 1 the trail expands outward into an endless zoom; below 1 it collapses toward the middle.",
    // The range is per *frame* and compounds: 1.05 over 48 frames is a factor
    // of nine, which is already past the point where the oldest surviving
    // history is one texel stretched across the frame. The legal ends are where
    // one loop stops being a zoom and becomes a wash.
    legal: [0.9, 1.1],
    default: 1,
    step: 0.001,
    surprise: {
      range: [0.985, 1.02],
      distribution: { kind: "uniform" },
      weight: 1,
    },
  },
  {
    key: FEEDBACK_PARAM.rotate,
    label: "Spin",
    type: "float",
    animatable: true,
    // Turns, not degrees — CONVENTIONS.md. A parameter ramping 0 -> 1 lands
    // where it started, which is what lets an animated spin close its own loop
    // even though the document as a whole does not.
    description:
      "How far the previous frame turns before it is combined, in turns per frame. Combined with zoom this is the spiral.",
    legal: [-0.05, 0.05],
    default: 0,
    step: 0.0005,
    surprise: {
      range: [-0.01, 0.01],
      distribution: { kind: "normal", mean: 0, sigma: 0.004 },
      weight: 0.9,
    },
  },
];

export default defineEffect({
  id: "feedback",
  name: "Feedback",
  summary:
    "Composites the previous frame back over this one, decayed and optionally drifting — trails, smear and endless zoom.",
  description:
    "The only node that reads something other than the picture handed to it: its own output from the frame before. The previous frame is moved by the drift, zoom and spin controls, faded by the decay, and combined with the current frame using the chosen blend, so each frame is laid over a fading stack of the ones before it. Decay is what turns that into a trail rather than a smudge — near 1 the history lingers for the whole loop, near 0 it is gone in a frame or two — and the transform is what turns a trail into motion: a drift smears, a zoom above 1 opens into an endless tunnel, and a spin with a zoom makes a spiral. Two consequences are real and are stated wherever they bite: this node and everything after it stop being cached, because a content hash cannot describe a picture that depends on every frame before it; and a document containing it does not return to its starting frame, so animated export reports it as non-looping instead of failing a seam check. Frames must be rendered in order, and scrubbing backwards re-renders from the beginning.",
  keywords: [
    "feedback",
    "trail",
    "trails",
    "decay",
    "echo",
    "smear",
    "motion trail",
    "long exposure",
    "endless zoom",
    "tunnel",
    "spiral",
    "recursion",
    "recursive",
    "previous frame",
    "video feedback",
    "camera into monitor",
    "accumulate",
    "persistence",
    "phosphor",
    "slit scan",
    "growth",
    "reaction diffusion",
    "touchdesigner",
  ],
  concept: "optical",
  requirement: "F-FB-01",
  // Postprocess: it accumulates whatever the stack produced, and putting it
  // before the dither would feed the dither a picture that is already a
  // composite of its own past output — legal, and a completely different and
  // much noisier thing than what anybody means by "trails".
  slot: "postprocess",
  family: "special",
  execution: "gpu",
  // The only effect in the catalogue that declares two image inputs, and the
  // second one is its own previous output. Declaring it makes the loop a real
  // edge in the graph — drawable by the editor, and the one edge the cycle rule
  // in `graph/topology.ts` permits — rather than a hidden read of a frame store
  // that nothing in the wiring hints at. The edge itself is derived rather than
  // saved: see `graph/ports.ts`.
  inputs: [
    {
      key: "in",
      label: "Image",
      role: "image",
      description:
        "The picture this frame's trail is laid over. Unwired, the node is a root and reads the image the document opened.",
      required: false,
    },
    {
      key: "history",
      label: "Previous frame",
      role: "feedback",
      description:
        "This node's own output one frame ago, decayed and optionally drifted. It is what turns a filter into a system that evolves, and it is why the document does not loop.",
      required: false,
    },
  ],
  params: FEEDBACK_PARAMS,
  // Below ordinary. It is the loudest node in the catalogue — it changes what
  // the document *is* (non-looping, uncached downstream), not just what it
  // looks like — so a random stack should reach for it sometimes rather than
  // often.
  surpriseWeight: 0.4,
  producesIndexMap: false,
  requiresIndexMap: false,
  // The declaration the cache, the seam validator and the frame store all read.
  // `gpu/compiler.ts` checks it against the pass's bindings, both ways.
  readsFeedback: true,
});

/** Parameter descriptors keyed for `packUniforms`, which needs them for enums. */
export const FEEDBACK_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  FEEDBACK_PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function feedbackDefaults(): Record<string, number | string> {
  return {
    [FEEDBACK_PARAM.decay]: 0.9,
    [FEEDBACK_PARAM.blend]: "screen",
    [FEEDBACK_PARAM.opacity]: 1,
    [FEEDBACK_PARAM.offsetX]: 0,
    [FEEDBACK_PARAM.offsetY]: 0,
    [FEEDBACK_PARAM.scale]: 1,
    [FEEDBACK_PARAM.rotate]: 0,
  };
}

/** The compute pass. */
export function feedbackEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: FEEDBACK_BINDING.inputColor },
    { role: "output-color", binding: FEEDBACK_BINDING.outputColor },
    { role: "uniforms", binding: FEEDBACK_BINDING.uniforms },
    { role: "feedback-color", binding: FEEDBACK_BINDING.feedbackColor },
  ];

  const pass: ComputePass = {
    id: "feedback/accumulate",
    label: "Feedback accumulate",
    wgsl,
    entryPoint: "main",
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    // Reads its input at its own pixel and its *history* at a transformed one,
    // which is a window bounded by the offset, zoom and spin. Never dependent
    // on a value read from another pixel of the same buffer, and it must not
    // alias its input — which is what this declaration tells the scheduler.
    access: "neighbourhood",
    bindings,
    uniforms: FEEDBACK_UNIFORMS,
  };

  return { effect: "feedback", passes: [pass] };
}

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("feedback", () => feedbackEffect());
