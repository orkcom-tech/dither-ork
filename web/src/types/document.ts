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

/**
 * How a node's output is combined with the node's own input (F-ST-03).
 *
 * The arithmetic is in `web/src/graph/blend.ts`, evaluated in linear light like
 * everything else in the pipeline — which is what makes the three pivoted modes
 * (`overlay`, `hard-light`, `soft-light`) look different here than in a
 * gamma-space compositor. That is argued where the formulas are.
 *
 * **Append-only.** A mode's position in `BLEND_MODES` is the ordinal that
 * crosses into the composite shader, so inserting one in the middle renumbers
 * the modes after it and every saved document naming one renders differently.
 */
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "hard-light"
  | "soft-light"
  | "darken"
  | "lighten"
  | "difference"
  | "exclusion"
  | "add"
  | "subtract";

export type ColorMetric = "oklab" | "srgb";

/**
 * Packed 8-bit sRGB, the same layout as {@link Palette.colors} and the WASM
 * boundary.
 *
 * Defined here rather than in the registry because it is a **serialised** shape
 * first: `.dork` has to be able to write one down, and the registry's `color`
 * parameter kind then re-exports this rather than declaring a second triplet
 * that has to be kept byte-compatible with it by hand.
 */
export type SrgbTriplet = readonly [r: number, g: number, b: number];

/** One control point of a transfer curve, both coordinates in `[0, 1]`. */
export interface CurvePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Everything a node parameter can be, and therefore everything `.dork` has to
 * round-trip.
 *
 * The composite members are not decoration. The registry declares `color` and
 * `curve` parameter kinds (`web/src/types/registry.ts`), so a schema of `number
 * | boolean | string` meant a document containing either could be written and
 * then not read back — the effect's own value would come back as the descriptor
 * default with a coercion warning, which is a document that silently stopped
 * being the one that was saved.
 *
 * Both are **JSON-native and match the shape the rest of the pipeline already
 * uses**: a colour is the same three integers the palette is packed from, and a
 * curve is the point list the editor draws. Neither is encoded as a string. A
 * hex colour would need a parser on both sides and would not be the palette's
 * layout; a comma-joined curve would need one too, and a parser between the
 * document and the registry is where the two drift apart.
 *
 * The two are distinguishable without the descriptor — a colour is three
 * numbers, a curve is objects — but nothing relies on that: the descriptor
 * names the kind, and `registry/params.ts` checks the value against it.
 */
export type ParameterValue =
  | number
  | boolean
  | string
  | SrgbTriplet
  | readonly CurvePoint[];

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
