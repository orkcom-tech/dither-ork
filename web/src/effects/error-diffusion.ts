/**
 * F-ED-CTL — the controls every error-diffusion kernel shares, and the factory
 * that stamps a descriptor from them.
 *
 * Not an `.effect.ts` file, so the registry glob passes over it (see
 * `registry/discovery.ts`). The fourteen kernels each get their own module;
 * this is the one place their common parameter set lives, because F-ED-CTL says
 * they are *shared* controls and fourteen copies is fourteen places for one of
 * them to drift.
 *
 * **Every control here moves something.** Each maps to a property of
 * `DitherOptions` at the WASM boundary, which the core reads in
 * `diffusion.rs`. When only strength, serpentine and metric crossed that
 * boundary, this file's ancestor deliberately declared only those two — a
 * control in the properties panel that moves nothing is worse than a missing
 * one. The boundary now carries jitter, the overshoot clamp and the channel
 * mode as well, so they are declared.
 *
 * The metric is not here. It is a property of the palette
 * (`Palette.metric` in the document), not of the node, for the same reason it
 * travels inside the GPU palette buffer rather than in each effect's uniform
 * block: a palette swap must not be able to leave a stale metric behind.
 *
 * The jitter *seed* is not here either. `StackNode.seed` already gives every
 * node one, and that is what feeds `DitherOptions.seed`; a `seed` parameter is
 * for effects that need a second independent stochastic axis, and diffusion has
 * only the one.
 */

import type { EffectDescriptor, ParamDescriptor } from "../types/registry";

/** Parameter keys, in one place so the descriptors and the caller agree. */
export const DIFFUSION_PARAM = {
  strength: "strength",
  serpentine: "serpentine",
  jitter: "jitter",
  overshootLimit: "overshootLimit",
  channels: "channels",
} as const;

/**
 * Ceiling offered for the overshoot clamp.
 *
 * The core takes any finite non-negative value; a UI range has to end
 * somewhere. Two units of headroom past the palette's own range is already
 * more than a run of accumulated error reaches in practice, so 4 is the point
 * beyond which the control has stopped doing anything — a legal maximum that
 * cannot be mistaken for a working one.
 */
const OVERSHOOT_CEILING = 4;

const STRENGTH: ParamDescriptor = {
  key: DIFFUSION_PARAM.strength,
  label: "Diffusion strength",
  type: "float",
  animatable: true,
  description:
    "How much of the difference between a pixel and the palette colour it became is handed to its neighbours. At 1 the picture keeps its overall tone and gains grain; at 0 nothing is handed on and the result is flat nearest-colour banding with no texture at all.",
  legal: [0, 1],
  default: 1,
  step: 0.01,
  surprise: {
    // Legal goes to 0, but below about 0.6 the error stops carrying and the
    // result is posterization with texture on top rather than a dither — the
    // same picture whichever kernel produced it. The surprise range stops where
    // the kernel is still recognisably itself (F-SM-04).
    range: [0.6, 1],
    // Clustered near full strength, which is the canonical look; reduced
    // strength is the interesting deviation, not the norm.
    distribution: { kind: "normal", mean: 0.92, sigma: 0.12 },
    weight: 1,
  },
};

const SERPENTINE: ParamDescriptor = {
  key: DIFFUSION_PARAM.serpentine,
  label: "Serpentine scan",
  type: "bool",
  animatable: false,
  description:
    "Alternates the direction of travel every row, so error stops drifting consistently to one side. Off, the leftover error walks the same way on every line and the grain organises itself into diagonal worms.",
  default: true,
  surprise: {
    // Off is a real look — it is what most period implementations did — but it
    // reads as an artifact more often than as a choice, so it stays rare.
    trueProbability: 0.9,
    // Below the numeric controls: a reroll that only flips the scan direction
    // looks like nothing happened.
    weight: 0.4,
  },
};

const JITTER: ParamDescriptor = {
  key: DIFFUSION_PARAM.jitter,
  label: "Threshold jitter",
  type: "float",
  animatable: true,
  description:
    "Adds seeded noise to the value each palette match is taken from, which scatters the kernel's regular texture into something closer to film grain. Past about a quarter every kernel converges on the same look, which defeats the point of choosing one.",
  legal: [0, 1],
  // Off. Jitter is a departure from the published kernel, and a kernel should
  // render as itself unless asked otherwise — the goldens pin the zero case.
  default: 0,
  step: 0.01,
  surprise: {
    // Past roughly a quarter the jitter dominates and every kernel converges on
    // the same grain, which is the opposite of what picking a kernel is for.
    range: [0, 0.25],
    distribution: { kind: "uniform" },
    // Low: a small jitter is a texture change, not a new picture.
    weight: 0.5,
  },
};

const OVERSHOOT_LIMIT: ParamDescriptor = {
  key: DIFFUSION_PARAM.overshootLimit,
  label: "Overshoot clamp",
  type: "float",
  animatable: true,
  description:
    "Caps how far a running total may travel beyond the palette's own range. A large flat area of a colour the palette cannot reach builds up error with nowhere to spend it, and it leaks out of the region as a bright or dark drag; at 0 that drag is gone and the region ends cleanly, at the cost of the tone being slightly wrong.",
  legal: [0, OVERSHOOT_CEILING],
  // The core's own default: one full unit of headroom.
  default: 1,
  step: 0.05,
  surprise: {
    // The whole visible span. 0 is a distinct, usable look (no drag at all) and
    // above ~1.5 nothing further happens, so the musical range is exactly the
    // part of the legal range where the control does something.
    range: [0, 1.5],
    distribution: { kind: "uniform" },
    weight: 0.6,
  },
};

const CHANNELS: ParamDescriptor = {
  key: DIFFUSION_PARAM.channels,
  label: "Error channels",
  type: "enum",
  animatable: false,
  description:
    "Per channel carries red, green and blue error separately, which lets a small palette mix colours it does not contain — this is what people mean by a colour dither. Luma carries one brightness term, so flats stay clean and gradients band.",
  values: [
    { value: "per-channel", label: "Per channel" },
    { value: "luma", label: "Luma" },
  ],
  default: "per-channel",
  surprise: {
    // Per-channel is what lets a small palette reconstruct colours it does not
    // contain, and it is what people mean by a colour dither. Luma is the
    // deliberate deviation — clean flats, banded gradients — so it is drawn,
    // but rarely.
    values: [
      { value: "per-channel", weight: 4 },
      { value: "luma", weight: 1 },
    ],
    weight: 0.5,
  },
};

/**
 * The shared set, in properties-panel order.
 *
 * Riemersma takes {@link DIFFUSION_CONTROLS_NO_SERPENTINE} instead: it walks a
 * Hilbert curve rather than scanning in rows, so the core ignores serpentine
 * there, and declaring an inert control is the thing this file exists to avoid.
 */
export const DIFFUSION_CONTROLS: readonly ParamDescriptor[] = [
  STRENGTH,
  SERPENTINE,
  JITTER,
  OVERSHOOT_LIMIT,
  CHANNELS,
];

/** The same set without the scan-direction toggle. */
export const DIFFUSION_CONTROLS_NO_SERPENTINE: readonly ParamDescriptor[] = [
  STRENGTH,
  JITTER,
  OVERSHOOT_LIMIT,
  CHANNELS,
];

export interface DiffusionEffectSpec {
  /** Must equal the kernel id in `diffusion.rs`; the WASM call passes it through. */
  readonly id: string;
  readonly name: string;
  readonly requirement: string;
  /**
   * F-UI-15's three fields, per kernel.
   *
   * They are per-kernel rather than shared because what the fifteen have in
   * common is already written once in `EFFECT_CONCEPTS["error-diffusion"]`, and
   * what is left is exactly the thing a person choosing between them needs: how
   * this kernel's grain differs from its neighbours'. A shared paragraph here
   * would tell a reader nothing at the moment they are picking.
   */
  readonly summary: string;
  readonly description: string;
  readonly keywords: readonly string[];
  /** False only for Riemersma. */
  readonly serpentine?: boolean;
}

/**
 * Search terms every diffusion kernel answers to, on top of its own.
 *
 * A user hunting for this family types "dither", "diffusion" or "grain" long
 * before they type "Stucki", and the spelling of a surname is exactly what they
 * will not have. Merged into each kernel's own keywords by the factory below so
 * that no kernel can forget them.
 */
const DIFFUSION_KEYWORDS: readonly string[] = [
  "dither",
  "dithering",
  "error diffusion",
  "diffusion",
  "grain",
  "quantize",
  "halftone alternative",
];

/**
 * Build the descriptor for one diffusion kernel.
 *
 * Everything that varies between the fourteen is in {@link DiffusionEffectSpec}
 * and everything else is fixed by what error diffusion *is*: it runs serially
 * on the CPU, it quantizes, and it emits the index map the rest of the pipeline
 * reads.
 *
 * `surpriseWeight` is 1 for all of them and is not a parameter here. The
 * kernels are peers — differentiation in Surprise Me comes from niche effects
 * sitting below 1.0, not from ranking Floyd-Steinberg against Stucki.
 */
export function errorDiffusionEffect(spec: DiffusionEffectSpec): EffectDescriptor {
  return {
    id: spec.id,
    name: spec.name,
    summary: spec.summary,
    description: spec.description,
    // Deduplicated because the kernel's own list may legitimately repeat a
    // shared term, and the validator rejects a keyword declared twice.
    keywords: [...new Set([...spec.keywords, ...DIFFUSION_KEYWORDS])],
    concept: "error-diffusion",
    requirement: spec.requirement,
    // Error diffusion quantizes, so it is the primary node of a stack.
    slot: "dither",
    family: "error-diffusion",
    // Serial by definition — that constraint is why the renderer is split in
    // two at all. The registry validator rejects any other value here.
    execution: "wasm",
    producesIndexMap: true,
    requiresIndexMap: false,
    surpriseWeight: 1,
    params:
      spec.serpentine === false ? DIFFUSION_CONTROLS_NO_SERPENTINE : DIFFUSION_CONTROLS,
  };
}
