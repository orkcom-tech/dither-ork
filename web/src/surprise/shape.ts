/**
 * What *shape* a surprise is, decided before a single effect is drawn.
 *
 * Step 4 of `docs/dither-ork-node-graph.md`, and the note calls it the sleeper
 * risk in as many words: *"Surprise Me is the feature the owner uses most. A
 * graph generator that produces mush would lose the best thing in the
 * product."* So the first thing this file does is state what it will **not**
 * generate.
 *
 * ## The legal shapes, in full
 *
 * ```text
 * document := main [branch]
 * main     := generator? preprocess{0..P} dither feedback? postprocess{0..Q}
 * branch   := generator preprocess{0..B}   -> mask port of one main node
 *                                             that is not a preprocess node
 * ```
 *
 * Everything not on those four lines is refused, and each refusal is a
 * decision rather than an omission:
 *
 * - **At most one branch, and it drives a mask.** Two branches double the ways
 *   a picture can turn to mud and halve how legible the result is. A `layer`
 *   port would let two branches *merge* — that is the other composition a node
 *   tool is for — but **no effect in the catalogue declares one**, so a merged
 *   graph is a shape nothing can render and is not generated. When one does,
 *   this is the line that changes.
 * - **A branch is rooted in a generator, and never masks a preprocess node.**
 *   Both of those came out of looking at renders rather than out of the design,
 *   and `grammar.ts` carries the evidence beside each. In short: coverage
 *   computed from the picture's own tone is what a node's built-in `luminance`
 *   and `color` masks already give, for free; and a mask on a node upstream of
 *   the dither is erased by the quantization that follows it.
 * - **A branch is at most three nodes and contains no dither.** A mask is read
 *   as a channel of a picture, so what matters about it is its *tone
 *   structure*. Quantizing a mask to four palette entries makes coverage with
 *   four values — a stencil, not a mask — and a five-node chain of glitches
 *   makes coverage that reads as noise. Both are legal and neither is worth
 *   generating.
 * - **No resampling node in a branch, and none upstream of the masked node.**
 *   `shaders/_composite.wgsl` reads the mask with `textureLoad` at the masked
 *   node's own coordinates, so the two pictures must be the same extent. A node
 *   that writes a different extent than it reads breaks that, and the symptom
 *   is coverage landing on the wrong pixels — or, where the mask is smaller,
 *   silently zero. `grammar.ts` computes the candidate set from this rather
 *   than filtering afterwards.
 * - **Feedback sits on the main chain, after the dither, and never in a
 *   branch.** It is what the effect's own descriptor argues for, and a feedback
 *   node in a mask branch would make the *document* non-looping for a reason
 *   invisible in the picture.
 * - **Exactly one feedback node, or none.** Two of them is two uncached
 *   subgraphs and one look.
 *
 * ## Why the shape is drawn first, and separately
 *
 * The same reason `grammar.ts` draws the dither before either chain: the pool
 * at every later step depends on it. A branch forbids resamplers upstream of
 * the node it masks; feedback is drawn from a pool the ordinary postprocess
 * draw excludes. Deciding the shape after the nodes exist would mean generating
 * a graph and then asking whether it was allowed, which is the rejection loop
 * this whole feature is written to avoid.
 *
 * Drawing it from **its own stream** is the second half: a change to the shape
 * probabilities moves which shape a seed produces without also re-rolling every
 * effect and every parameter, exactly as one stream per parameter keeps a new
 * control from disturbing its neighbours (`params.ts`).
 *
 * ## Complexity is not quality
 *
 * F-SM-07's chaos slider now governs shape as well as size, and it governs it
 * in one direction: **at the tame end a surprise is a chain**, because a chain
 * is legible and most good results are chains. The probabilities below start
 * near zero and the feedback one starts *at* zero, so a tame document also
 * loops (F-AN-03). That is the whole of what chaos means here — not "more
 * nodes", but "more ways for the picture to be built".
 */

import type { Pcg32 } from "./rng";

/**
 * Linear interpolation across a chaos setting.
 *
 * Here rather than in `grammar.ts` because the shape decision is the first
 * thing chaos does and `grammar.ts` imports this module; `grammar.ts` re-exports
 * it so every caller still reads it from the same place it always did.
 */
export function lerp(range: readonly [number, number], t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return range[0] + (range[1] - range[0]) * clamped;
}

/**
 * How likely each shape is, at chaos 0 and at chaos 1.
 *
 * Three probabilities, drawn independently, and the numbers are the feature's
 * taste — stated in one block so they can be argued with rather than hunted
 * for.
 *
 * The one that is *not* taste is `feedback`'s tame end. It is exactly zero
 * because a feedback document does not return to its first frame, and a person
 * at the tame end of the slider is asking for the ordinary, predictable thing.
 * A document that will not close a loop is not that.
 */
export const SHAPE_CHAOS = {
  /**
   * A generator heads the main chain, so the picture is made rather than
   * photographed.
   *
   * Low at the tame end because the commonest reason to press this button is to
   * see *your image* done differently, and a generator replaces it outright.
   */
  generator: [0.04, 0.3] as const,
  /**
   * The document reads its own previous frame — trails, smear, endless zoom.
   *
   * Zero at the tame end. See above: this is the one shape that changes what
   * the document *is* rather than what it looks like.
   */
  feedback: [0, 0.4] as const,
  /**
   * A second branch drives the mask port of one node on the main chain.
   *
   * The only shape that is not a chain, so this number alone decides how often
   * a surprise is a graph at all: about one in twenty at the tame end, a little
   * under half at the wild one.
   */
  branch: [0.05, 0.45] as const,
} as const;

/** Which of the four shapes this surprise is going to be. */
export interface GraphShape {
  /**
   * A source-slot node produces the picture, so the document needs no
   * photograph of its own to show something.
   */
  readonly generator: boolean;
  /**
   * True when {@link generator} is a node this surprise will *draw*, false when
   * it is one carried across from the document being rerolled.
   *
   * The distinction matters exactly once — the grammar draws a source node only
   * in the first case — and it is carried on the shape rather than recomputed,
   * so "why is there a generator" has one answer.
   */
  readonly newGenerator: boolean;
  /** One feedback node on the main chain. **This document does not loop.** */
  readonly feedback: boolean;
  /** A branch feeding the mask port of one main-chain node. */
  readonly branch: boolean;
}

/** A plain chain over the document's own image: what every schema-1 document is. */
export const PLAIN_CHAIN: GraphShape = {
  generator: false,
  newGenerator: false,
  feedback: false,
  branch: false,
};

export interface ShapeOptions {
  /** Tame to wild, `[0, 1]` (F-SM-07). */
  readonly chaos: number;
  /**
   * Whether graph shapes are allowed at all.
   *
   * `false` is `excludes.shape` — "make a chain, like it always was". It is not
   * a chaos setting: chaos makes a graph *less likely*, this makes it
   * impossible, and the difference is the difference between a slider and an
   * off switch.
   */
  readonly graph: boolean;
  /**
   * True when the picture is a **blank canvas** rather than a photograph.
   *
   * `io/source.ts`'s `blankSource` is transparent black and declares
   * `format: "blank"`, which is how this build expresses "no image open": every
   * extent in the pipeline comes from the source, so a document with no image
   * would have no size, and a stated empty canvas is the honest form of the
   * same idea.
   *
   * On one, a document with no generator in it renders **nothing** — the
   * transparency checkerboard, and a dither of zeroes. So the generator stops
   * being a shape the slider reaches for sometimes and becomes the only shape
   * that produces a picture at all. That is not chaos and it is not taste; it is
   * the difference between the button working and the button not working.
   */
  readonly blankCanvas: boolean;
  /**
   * True when the document being rerolled begins with a generator **and that
   * generator is being carried across**.
   *
   * `generate.ts` carries the leading run of source nodes so that a reroll on a
   * blank canvas does not go black, and it does that on a blank canvas only —
   * with a photograph open, a generator at the head is a shape this file draws
   * fresh on every press rather than a node welded on for good. That carried
   * node **is** this shape's generator: drawing a second one would put two
   * pictures in a document that shows one.
   */
  readonly carriedGenerator: boolean;
}

/**
 * Draw a shape.
 *
 * Every draw happens on every path, including the ones whose probability is
 * zero — `Pcg32.nextBool` is written to consume its number either way, and for
 * the same reason: a setting that turns one decision off must not silently
 * re-roll every decision after it.
 */
export function decideShape(rng: Pcg32, options: ShapeOptions): GraphShape {
  const { chaos, graph, carriedGenerator, blankCanvas } = options;
  const drewGenerator = rng.nextBool(graph ? lerp(SHAPE_CHAOS.generator, chaos) : 0);
  const feedback = rng.nextBool(graph ? lerp(SHAPE_CHAOS.feedback, chaos) : 0);
  const branch = rng.nextBool(graph ? lerp(SHAPE_CHAOS.branch, chaos) : 0);

  // A blank canvas forces one, and `excludes.shape` does not override it: "make
  // a plain chain" is a request about *shape*, and a chain over a blank canvas
  // with a generator at its head is still a plain chain. Refusing the generator
  // there would honour the letter of the exclude by handing back an empty
  // picture.
  const wantsGenerator = drewGenerator || blankCanvas;

  // A carried generator counts as the generator and suppresses the drawn one.
  // The carry only ever happens on a blank canvas, and `generate.ts` decides
  // that — this reads the answer rather than the condition.
  const newGenerator = wantsGenerator && !carriedGenerator;
  return {
    generator: carriedGenerator || wantsGenerator,
    newGenerator,
    feedback,
    branch,
  };
}

/**
 * Whether a document of this shape returns to its first frame — F-AN-03.
 *
 * The guarantee narrowed rather than became false when feedback landed
 * (`docs/dither-ork-node-graph.md`, collision 2), and this is the narrowing
 * stated where the generator can act on it: feedback and only feedback stops a
 * document closing. `animation/plan.ts` decides the same thing from the nodes
 * that actually ended up in the document, and the two must agree — the tests
 * check that they do rather than trusting it.
 */
export function shapeLoops(shape: GraphShape): boolean {
  return !shape.feedback;
}

/** A few words for the log, the summary and the history entry. */
export function describeShape(shape: GraphShape): string {
  const parts: string[] = [];
  if (shape.generator) parts.push("generated");
  parts.push(shape.branch ? "masked branch" : "chain");
  if (shape.feedback) parts.push("feedback");
  return parts.join(" + ");
}
