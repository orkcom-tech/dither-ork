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
  hint: "How much of each pixel's quantization error is passed on. 0 is plain nearest-colour quantization.",
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
  hint: "Alternate the scan direction each row, which removes the directional worming of left-to-right-only scanning.",
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
  hint: "Seeded noise on the value the palette match is taken from. Breaks up the kernel's regular texture.",
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
  hint: "How far past the palette's range an accumulated value may travel. 0 kills the bright/dark drag out of saturated regions.",
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
  hint: "Diffuse three independent error channels, or one luminance term.",
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
  /** False only for Riemersma. */
  readonly serpentine?: boolean;
}

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
