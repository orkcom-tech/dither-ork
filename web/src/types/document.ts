/**
 * The `.dork` document schema.
 *
 * A document is Source + Stack + Palette + Clock + Bindings. It is the unit
 * that is saved, shared by URL, applied across a batch, and generated whole by
 * Surprise Me. The full field-by-field contract is in docs/API.md.
 */

/**
 * The schema this build writes and is the ceiling for reading (F-DO-08).
 *
 * - **1** — a linear stack. Nodes in an array, node *i* reading node *i-1*, the
 *   last one being the picture. Every document, preset and share link produced
 *   before multi-input is this.
 * - **2** — nodes plus **edges**, plus the node the graph outputs, plus
 *   per-node masks. The wiring stops being implied by array order.
 *
 * A version 1 document is migrated on load by `io/document/migrate.ts` and is
 * never refused; a version above this is refused rather than read as far as it
 * goes, because a field this build does not know about would be dropped on the
 * next save.
 */
export const DOCUMENT_SCHEMA_VERSION = 2 as const;

/** The first schema, kept named because the migration is written against it. */
export const DOCUMENT_SCHEMA_LINEAR_STACK = 1 as const;

/**
 * Where a node may sit in the stack. Surprise Me's grammar reads this.
 *
 * `source` is the one that is not a filter. Every other node takes an image and
 * returns one; a source node **produces an image from its parameters alone** —
 * noise, a gradient, a shape — so a composition can exist without a photograph.
 *
 * It is a slot rather than a new {@link ExecutionKind} or a boolean because the
 * fact being declared is *positional*: a node that ignores the picture handed
 * to it belongs at the head, and everything live in front of it is discarded
 * unless the node's own opacity and blend (F-ST-03) put it back. `slot` is
 * already the vocabulary every positional reader consults — Surprise Me's
 * grammar, the picker's filter, the row badge, the guide — so a second
 * declaration beside it would be a second answer those readers could disagree
 * about. `execution` still says `gpu`, because that is still true and still
 * what it costs.
 *
 * The consequences are checked rather than assumed: `types/registry.ts` refuses
 * a source node that reads an index map or resamples, and `gpu/compiler.ts`
 * refuses a `source` effect whose pass binds `input-color` — and a pass that
 * binds none on an effect that is not a source. See `registry/stack.ts` for
 * what "discarded" means and how it is shown.
 */
export type NodeSlot = "source" | "preprocess" | "dither" | "postprocess";

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

// --- masking (F-PP-08) ---------------------------------------------------
//
// A mask is **not an effect**, and that is the decision the whole shape follows
// from. F-PP-08 says "limit *any* node", and a node that limits another node
// would have to sit somewhere in the wiring and would then only limit whatever
// happened to be next to it. What a mask actually is, is the thing per-node
// opacity already is — how much of this node's result reaches the picture —
// with a value per pixel instead of one for the frame.
//
// So it lives beside `opacity` and `blend` on the node, it is applied by the
// same composite those two are applied by, and every node in the catalogue is
// maskable for free. The three sources F-PP-08 names differ only in where the
// coverage comes from.

/** Which channel of a wired mask picture is read as coverage. */
export type MaskChannel = "luminance" | "alpha" | "red" | "green" | "blue";

/**
 * Where a node's coverage comes from.
 *
 * `luminance` and `color` read **the node's own input** — the same picture the
 * composite blends against — so they need no second edge and work on any node
 * in any document. `image` reads the node's `mask` port, which is where a
 * second branch of the graph arrives.
 */
export type MaskSource =
  /**
   * Coverage from the input's tone.
   *
   * Full inside `[low, high]`, falling to nothing across `feather` on either
   * side. A band rather than a threshold because "the shadows" and "the
   * highlights" are both bands, and a threshold is the special case where one
   * bound is at an end of the range.
   */
  | {
      readonly kind: "luminance";
      /** Both in `[0, 1]`, `low <= high`, measured in linear light. */
      readonly low: number;
      readonly high: number;
      /** Half-width of the falloff either side of the band, in the same units. */
      readonly feather: number;
    }
  /**
   * Coverage from nearness to a colour.
   *
   * Distance is measured in OKLab, like every other perceptual comparison in
   * the pipeline — `tolerance` in sRGB units would mean something different in
   * the shadows than in the highlights, which is exactly the complaint that
   * makes a colour-range mask hard to aim.
   */
  | {
      readonly kind: "color";
      readonly color: SrgbTriplet;
      /** OKLab distance at which coverage reaches full. `> 0`. */
      readonly tolerance: number;
      /** Falloff beyond the tolerance, in the same units. */
      readonly feather: number;
    }
  /** Coverage from the picture wired into this node's `mask` port. */
  | {
      readonly kind: "image";
      readonly channel: MaskChannel;
    };

/**
 * One node's mask: spatially-varying opacity (F-PP-08).
 *
 * Multiplied into `opacity` per pixel, so a node at 50% opacity behind a mask
 * that reads 0.5 contributes a quarter. That composition is deliberate: the two
 * controls answer different questions — how much of this node overall, and
 * where — and making one override the other would make an opacity slider that
 * sometimes does nothing.
 */
export interface NodeMask {
  readonly source: MaskSource;
  /** Coverage becomes `1 - coverage`. The commonest single thing a mask needs. */
  readonly invert: boolean;
}

/** One effect instance in the graph. */
export interface StackNode {
  /** Stable per-instance id; bindings and edges reference it. */
  readonly id: string;
  /** Effect id from the node registry, e.g. "floyd-steinberg". */
  readonly effect: string;
  readonly enabled: boolean;
  readonly opacity: number;
  readonly blend: BlendMode;
  readonly params: Readonly<Record<string, ParameterValue>>;
  /** Per-node seed. No node reads an unseeded RNG. */
  readonly seed: number;
  /**
   * Spatially-varying opacity (F-PP-08), or absent for an unmasked node.
   *
   * Optional rather than a `null` field because absence is the ordinary case
   * and every schema-1 document is unmasked — an optional field is one the
   * canonical encoder simply does not write, so a migrated document is the same
   * bytes it would have been if masking had always existed and this node had
   * never used it.
   */
  readonly mask?: NodeMask;
}

/**
 * One image edge: `from`'s output into `to`'s `port`.
 *
 * The whole of what schema 2 adds to the wiring. In schema 1 this was implied
 * by array order — node *i* read node *i-1* — which is why there could only
 * ever be one image edge per node and why F-PP-08 was recorded as unbuilt for
 * three phases.
 *
 * There is one output port per node, so an edge names no source port. That is a
 * deliberate omission and not an oversight: `OutputPort` in `types/graph.ts`
 * exists so a node can grow a second output without a schema change, and on the
 * day one does, this gains a field with a default.
 *
 * **Feedback edges are not stored here.** A node whose effect declares
 * `readsFeedback` reads its own previous frame, and that edge is derived from
 * the descriptor by `graph/ports.ts` rather than saved — a saved copy would be
 * a second place the same fact is written, and a document could then disagree
 * with its own catalogue about whether a node loops.
 */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** An input port key the destination node declares. See `graph/ports.ts`. */
  readonly port: string;
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
  /**
   * Every node in the document.
   *
   * Still called `stack`, and the name is now about the *list* rather than
   * about the wiring: it is the order the editor shows nodes in, the order the
   * canonical encoder writes them in, and the tie-break that makes the
   * topological sort deterministic (`graph/topology.ts`). What it is no longer
   * is the wiring — that is {@link DitherDocument.edges}.
   *
   * Kept as `stack` rather than renamed to `nodes` because the rename touches
   * 29 modules and 91 call sites for no behavioural gain, and every one of
   * those is a chance to change a meaning by accident during a schema change.
   * It is a rename that can be done on its own day.
   */
  readonly stack: readonly StackNode[];
  /**
   * The wiring. Order is irrelevant to meaning and canonical for the bytes.
   *
   * A node with no edge into its `in` port is a **root** and reads the decoded
   * source, which is what the first node of every linear document is.
   */
  readonly edges: readonly GraphEdge[];
  /**
   * The node whose output is the picture, or `null` for a document with no
   * nodes.
   *
   * Explicit because a DAG has no last element. In schema 1 this was the end of
   * the array; in a graph, two branches can both end somewhere and only one of
   * them is the picture. Solo (F-ST-02) does not live here — it moves the
   * *render's* output upstream without changing the document.
   */
  readonly output: string | null;
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
