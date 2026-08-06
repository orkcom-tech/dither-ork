/**
 * The `.dork` document schema.
 *
 * A document is Source + Stack + Palette + Clock + Bindings. It is the unit
 * that is saved, shared by URL, applied across a batch, and generated whole by
 * Surprise Me. The full field-by-field contract is in docs/API.md.
 */

export const DOCUMENT_SCHEMA_VERSION = 1 as const;

/** Where a node may sit in the stack. Surprise Me's grammar reads this. */
export type NodeSlot = "preprocess" | "dither" | "postprocess";

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "difference";

export type ColorMetric = "oklab" | "srgb";

export type ParameterValue = number | boolean | string;

/** One effect instance in the stack. */
export interface StackNode {
  /** Stable per-instance id; bindings reference it. */
  readonly id: string;
  /** Effect id from the node registry, e.g. "floyd-steinberg". */
  readonly effect: string;
  readonly enabled: boolean;
  readonly opacity: number;
  readonly blend: BlendMode;
  readonly params: Readonly<Record<string, ParameterValue>>;
  /** Per-node seed. No node reads an unseeded RNG. */
  readonly seed: number;
}

export type ModulatorShape =
  | "sine"
  | "triangle"
  | "saw"
  | "square"
  | "smooth-noise"
  | "stepped-random";

/**
 * Attaches a modulator to one numeric parameter.
 *
 * `cyclesPerLoop` is an integer by construction — that constraint is what makes
 * frame N equal frame 0, so the loop closes without a crossfade.
 */
export interface Binding {
  readonly nodeId: string;
  readonly param: string;
  readonly shape: ModulatorShape;
  readonly amount: number;
  readonly cyclesPerLoop: number;
  readonly phase: number;
  readonly bipolar: boolean;
}

export interface Clock {
  /** Frame count. Normalized time is frame / frames, so t never reaches 1. */
  readonly frames: number;
  readonly fps: number;
}

export interface Palette {
  readonly id: string;
  readonly name: string;
  /** Packed 8-bit sRGB triplets: [r, g, b, r, g, b, ...]. */
  readonly colors: readonly number[];
  readonly metric: ColorMetric;
}

export interface SourceRef {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Present only in the self-contained document variant (F-DO-02). */
  readonly dataUrl?: string;
}

export interface DitherDocument {
  readonly schema: typeof DOCUMENT_SCHEMA_VERSION;
  readonly source: SourceRef | null;
  readonly stack: readonly StackNode[];
  readonly palette: Palette;
  readonly clock: Clock;
  readonly bindings: readonly Binding[];
  /** Set when the document came from Surprise Me; reproduces it exactly. */
  readonly surpriseSeed?: string;
}

/** Normalized loop time for a frame index. */
export function normalizedTime(clock: Clock, frame: number): number {
  return (frame % clock.frames) / clock.frames;
}
