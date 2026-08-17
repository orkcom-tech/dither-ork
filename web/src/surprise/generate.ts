/**
 * Surprise Me — the whole document, from one seed.
 *
 * F-SM-01 ("a full random document against the current source"), F-SM-02 (one
 * 64-bit seed), F-SM-06 (locks) and F-SM-08 (per-node reroll) meet here. The
 * pieces are elsewhere and each is testable on its own: the legal graph shapes
 * in `shape.ts`, the grammar that composes one in `grammar.ts`, the parameter
 * draws in `params.ts`, the palette in `palette.ts`, the bindings in
 * `animation.ts`, the generator itself in `rng.ts`.
 *
 * # What this emits is a graph
 *
 * Nodes, **edges** and a named output — schema 2 — rather than a chain whose
 * wiring is implied by array order. Most of them are still chains, because most
 * good results are chains and `shape.ts` says why the tame end of the chaos
 * slider stays there; the ones that are not carry a branch into some node's mask
 * port, and that branch is the whole of what a node tool buys over a stack.
 *
 * **Pure and synchronous.** Nothing in this file reads a clock, an RNG that is
 * not derived from the seed, a device, a store or the DOM. It takes a seed, a
 * registry, a base document and a decided palette, and returns a document. That
 * is what makes a surprise reproducible and what makes this file testable
 * against the real sixty-seven-effect catalogue with no browser.
 *
 * # Locks (F-SM-06)
 *
 * "Palette, stack composition, parameters and animation lock independently.
 * Reroll re-randomizes only what is unlocked, so a liked palette survives fifty
 * stack rerolls."
 *
 * Three of the four are obvious. The fourth is a real interaction and is decided
 * here rather than left ambiguous: **with the stack unlocked and parameters
 * locked, the new nodes take their descriptor defaults.** There is nothing else
 * available — a parameter lock preserves the values of nodes that exist, and a
 * freshly composed stack contains effects the previous document never had. Nodes
 * that survive by id *and* effect keep their values and their seeds. The UI says
 * this in one line rather than leaving it to be discovered.
 *
 * # Excludes, which are not locks
 *
 * A lock says **keep this**; an exclude says **do not make this at all**. They
 * are answers to different questions about the same aspect, and asking both at
 * once is a contradiction rather than a precedence puzzle — so
 * {@link generateSurprise} refuses it rather than deciding which wins. See
 * {@link SurpriseExcludes} for why two aspects have an exclude and the other
 * two do not.
 *
 * # What a surprise does not touch
 *
 * - **The source.** F-SM-01 is explicit: the document is generated *against* the
 *   current source, and the reference is carried across unchanged.
 * - **The clock.** Frame count and fps are not part of what a surprise decides;
 *   rolling them would change the length of an export somebody had set up.
 * - **Opacity and blend.** Every node opens at the identity composite. This is a
 *   deliberate omission and not an oversight: `graph/plan.ts` refuses a
 *   composite on a node that resamples, because its output and its own input are
 *   different pixel grids, so randomising blend needs a per-node rule of its
 *   own. The spec's SM section names palette, stack composition, node order,
 *   parameters and bindings; opacity and blend are not on that list, and
 *   shipping a version that sometimes produces an unrenderable stack in order to
 *   add them would be the wrong trade.
 */

import { logger } from "../lib/log";
import type {
  Binding,
  DitherDocument,
  GraphEdge,
  NodeMask,
  Palette,
  StackNode,
} from "../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../types/document";
import type { EffectRegistry } from "../registry";
import { defaultParams, validateGraph } from "../registry";
// The leaf, not the `state` barrel: that barrel re-exports `session.ts`, which
// reaches the render worker and the palette editor, and this module is pure.
import { PRIMARY_INPUT_PORT } from "../types/registry";
import { createStackNode } from "../state/document";
import { retainBindings, sampleBindings } from "./animation";
import { composeGraph, edgesOf, type ComposedGraph } from "./grammar";
import {
  PLAIN_CHAIN,
  decideShape,
  describeShape,
  shapeLoops,
  type GraphShape,
} from "./shape";
import { sampleNodeParams, sampleNodeSeed } from "./params";
import { streamFor } from "./rng";
import { formatSeed } from "./seed";

const log = logger("app");

/** The stream the stack composition draws from. Written once. */
const STACK_STREAM = "surprise/stack";

/**
 * The stream the *shape* is drawn from — which of the legal graph shapes this
 * surprise is.
 *
 * Its own, and not the stack's, for the reason `params.ts` gives one stream per
 * parameter: a change to the shape probabilities then moves which shape a seed
 * produces without also re-rolling every effect and every parameter after it.
 */
const SHAPE_STREAM = "surprise/shape";

export class SurpriseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurpriseError";
  }
}

/** What a reroll leaves alone (F-SM-06). Each is independent of the others. */
export interface SurpriseLocks {
  readonly palette: boolean;
  /** The effect ids and their order. Parameters are the separate lock below. */
  readonly stack: boolean;
  readonly params: boolean;
  readonly animation: boolean;
}

export const NO_LOCKS: SurpriseLocks = {
  palette: false,
  stack: false,
  params: false,
  animation: false,
};

/**
 * What a surprise does not produce at all.
 *
 * A lock keeps the aspect it names; an exclude means the document comes back
 * without it. For animation that is the difference between "the movement I have
 * survives the next press" and "nothing moves", and only the second is an
 * off-switch — which is the thing this feature was missing. Locking animation
 * pins it **on**, which is the opposite of what somebody reaching for the only
 * animation control in the panel wants.
 *
 * # Why this has two fields and `SurpriseLocks` has four
 *
 * An exclude is only offerable where **the absence is a state a document can
 * hold**. That is a fact about `DitherDocument`, not a matter of taste. It is
 * true of animation, it became true of graph shape when step 4 gave the
 * generator shapes to leave out (see {@link SurpriseExcludes.shape}), and it is
 * still false of the other three:
 *
 * - **animation** — `bindings: []` is an ordinary, complete document. It renders
 *   as a still picture, the timeline adopts no tracks from it, and it is what
 *   every document that was never animated already looks like. So "leave it out"
 *   is expressible, renderable and useful. This is the exclude.
 * - **palette** — a document has no state without one. `state/mutations.ts` and
 *   `state/serialize.ts` both refuse a palette with no colours, and
 *   `gpu/resources.ts` refuses to build a buffer from one. "No palette" would
 *   have to mean "the palette that is already there", which is the lock spelled
 *   twice.
 * - **stack** — an empty stack passes `validateStack`, and it is the source
 *   image with nothing done to it: no dither, so the palette means nothing, the
 *   parameters do not exist and there is nothing to bind. That is not one aspect
 *   left out, it is Surprise Me turned into a button that does nothing, and the
 *   way to not have a surprise is to not press surprise.
 * - **parameters** — every node must carry values `validateParams` accepts, so
 *   there is no absence to express. The nearest thing is "all defaults", which is
 *   a *different draw* rather than a missing one, and it is already what a locked
 *   parameter set gives a freshly composed stack. Calling that an exclude would
 *   make the same word mean two different things in two rows of the same panel.
 *
 * A control that produces nonsense is worse than a control that is not there, so
 * the other three are not offered. `ui/surprise/model.ts` is where that shows up
 * on screen, and it reads this shape rather than carrying its own list.
 */
export interface SurpriseExcludes {
  /**
   * No modulator bindings at all — not the base document's, not a fresh draw.
   *
   * The document comes back with `bindings: []`, so `planAnimation` has nothing
   * to resolve, `ui/timeline/model.ts` adopts no tracks (and stops the transport
   * when it had some), and `state/session.ts` renders the still frame itself
   * rather than leaving the viewport to a timeline that is not pumping.
   */
  readonly animation: boolean;
  /**
   * No graph shape: a **plain chain over the document's own image**.
   *
   * The second aspect that passes the test in the block above — the absence is
   * a state a document can hold, and not merely a state but *the* state: a
   * chain is what every `.dork`, preset and share link written before schema 2
   * is, and it is what this generator produced until step 4. So "off" here has
   * something exact to mean, and what it means is the whole of what the graph
   * added: no generator drawn in place of the picture, no branch driving a
   * mask, and **no feedback node**.
   *
   * That last one is why this exists as a control rather than only as a chaos
   * setting. A feedback node reads the previous frame, so a document containing
   * one does not return to its first frame — `animation/plan.ts` marks it
   * non-looping and `animation/seam.ts` skips the seam check it was never going
   * to pass. Somebody who is about to export a loop needs to be able to say
   * *not that* and be obeyed, and a probability that merely falls to zero at
   * one end of a slider is not being obeyed, it is being lucky. With this set,
   * {@link SurpriseSummary.loops} is true by construction.
   *
   * It clears the carried generator prefix as well (see {@link carriedPrefix}),
   * so the sentence the panel prints is the whole truth rather than nearly it.
   * On a blank canvas the picture is still not black: `decideShape` forces a
   * generator there whatever this says, so one is *drawn* rather than carried.
   */
  readonly shape: boolean;
}

export const NO_EXCLUDES: SurpriseExcludes = {
  animation: false,
  shape: false,
};

export interface SurpriseRequest {
  /** The 64-bit seed the whole document derives from (F-SM-02). */
  readonly seed: bigint;
  readonly registry: EffectRegistry;
  /** Tame to wild, `[0, 1]` (F-SM-07). */
  readonly chaos: number;
  readonly locks: SurpriseLocks;
  /**
   * What this surprise must not produce at all (see {@link SurpriseExcludes}).
   *
   * An aspect that is both locked and excluded is refused rather than resolved —
   * "keep it" and "do not make it" are not a precedence question.
   */
  readonly excludes: SurpriseExcludes;
  /**
   * The document being rerolled — the source of everything that is locked, and
   * of the source reference and clock, which a surprise never touches.
   */
  readonly base: DitherDocument;
  /**
   * The palette this surprise decided on (F-SM-05), already resolved. Ignored
   * when the palette lock is set. Decided by `palette.ts` and, for the extracted
   * mode, resolved against the real image by the UI adapter.
   */
  readonly palette: Palette;
  /**
   * Whether this **build** can produce modulator bindings at all (F-SM-09).
   *
   * Not a setting and not a constant: the caller probes the real animated path
   * once — `planAnimation` -> `documentAtFrame` -> `buildRenderGraph` — and
   * passes what it found, so a build that cannot resolve a binding produces
   * none rather than producing a document it cannot draw. In this build the
   * probe passes and this arrives `true`; `ui/surprise/capability.ts` is where
   * the question is asked and `ui/surprise/engine.ts` is what passes the answer.
   *
   * **This is not the user's off-switch** and the two are kept apart on purpose:
   * `excludes.animation` is what a person asked for, this is what the build can
   * do. Collapsing them would make "you turned animation off" and "this build has
   * no modulator" the same fact, and the panel says two different things about
   * them — the second comes with the failing step's own words for why.
   */
  readonly animate: boolean;
  /**
   * True when the picture is a **blank canvas** rather than a photograph.
   *
   * `io/source.ts` gives one `format: "blank"`, and it is transparent black: a
   * document with no generator in it renders nothing at all on one. So this
   * forces a generator at the head of the chain — see
   * {@link ShapeOptions.blankCanvas}, where the argument is written out — and
   * `ui/surprise/engine.ts` is what reads the format and passes it.
   *
   * It is the answer this build can give to "a surprise with no image open".
   * There is no *other* answer available: every extent in the pipeline is
   * derived from the source's, so a document with no source has no size, and
   * `state/render/renderer.ts` refuses a render with none. A blank canvas is
   * that idea in the form the schema can hold.
   */
  readonly blankCanvas: boolean;
}

/** What the surprise did, for the history entry, the UI and the log. */
export interface SurpriseSummary {
  readonly seed: string;
  readonly effects: readonly string[];
  /** Effect display names, in stack order. */
  readonly effectNames: readonly string[];
  /** Effect id of the one dither-slot node, or `"none"` for a locked stack without one. */
  readonly dither: string;
  readonly paletteName: string;
  readonly paletteEntries: number;
  readonly bindings: number;
  readonly chaos: number;
  /** A few words for the shape this document is — see `shape.ts`. */
  readonly shape: string;
  /**
   * Whether this document returns to its first frame — F-AN-03.
   *
   * False exactly when the document contains a feedback node. Reported here
   * rather than left for the export to discover, because the panel says it
   * beside the seed: a person who is about to export a loop should be told by
   * the thing that generated the document, not by the encoder.
   */
  readonly loops: boolean;
  /** Nodes in the mask branch, and the node it masks. Zero and `null` on a chain. */
  readonly branch: number;
  readonly maskedNode: string | null;
}

export interface SurpriseResult {
  readonly document: DitherDocument;
  readonly seed: bigint;
  readonly summary: SurpriseSummary;
}

/** Node ids follow `state/document.ts`'s `n<N>` form so `nextNodeId` agrees. */
function nodeIdAt(index: number): string {
  return `n${index + 1}`;
}

interface Composition {
  readonly effects: readonly string[];
  readonly ids: readonly string[];
  readonly edges: readonly GraphEdge[];
  readonly output: string | null;
  /** Node id to mask, for the one node a branch masks. Empty on every other shape. */
  readonly masks: ReadonlyMap<string, NodeMask>;
  /** Absent when the stack was locked and therefore not composed. */
  readonly composed: ComposedGraph | null;
}

/**
 * The graph this surprise runs on: either the base document's, or a fresh one
 * from the grammar.
 *
 * When the composition is locked the **node ids are kept too**, which is what
 * lets the parameter lock and the animation lock mean anything: a binding names
 * a node id, and a parameter lock that matched on position rather than on
 * identity would move values between nodes on a reorder.
 *
 * A locked stack now keeps its **wiring** as well — the edges, the output and
 * every node's mask. It has to: before step 4 the wiring was implied by the list
 * and re-deriving it was free, and re-deriving it now would silently unwire the
 * branch of any graph document somebody locked, which is the one thing "keep
 * this stack" promises not to do.
 */
function compositionFor(request: SurpriseRequest, shape: GraphShape): Composition {
  if (request.locks.stack) {
    const masks = new Map<string, NodeMask>();
    for (const node of request.base.stack) {
      if (node.mask !== undefined) masks.set(node.id, node.mask);
    }
    return {
      effects: request.base.stack.map((node) => node.effect),
      ids: request.base.stack.map((node) => node.id),
      edges: request.base.edges,
      output: request.base.output,
      masks,
      composed: null,
    };
  }

  // The generator prefix survives a reroll — **on a blank canvas, and there
  // only**. See {@link carriedPrefix} for why the unconditional version was the
  // worst defect in this file.
  const { effects: kept, ids: keptIds } = carriedPrefix(request);

  const composed = composeGraph(streamFor(request.seed, STACK_STREAM), {
    registry: request.registry,
    chaos: request.chaos,
    shape,
  });

  // Ids for the composed part, skipping anything the prefix already holds. Both
  // generators mint `n<k>`, so a base document whose generator happens to be
  // `n2` would otherwise collide with the second composed node and produce a
  // stack with two nodes of one id — which `analyseGraph` refuses, correctly,
  // as an ambiguous edge target.
  const taken = new Set(keptIds);
  let next = 0;
  const freshId = (): string => {
    let id = nodeIdAt(next);
    while (taken.has(id)) {
      next += 1;
      id = nodeIdAt(next);
    }
    next += 1;
    taken.add(id);
    return id;
  };

  const composedIds = composed.nodes.map(() => freshId());
  const edges: GraphEdge[] = [];
  // The carried prefix is a chain, and the first composed node reads the end of
  // it. Only the first: every other composed root — a mask branch's — reads the
  // decoded source, which is what an unwired `in` port already means.
  for (let i = 1; i < keptIds.length; i += 1) {
    const from = keptIds[i - 1];
    const to = keptIds[i];
    if (from !== undefined && to !== undefined) {
      edges.push({ from, to, port: PRIMARY_INPUT_PORT });
    }
  }
  const lastKept = keptIds[keptIds.length - 1];
  const firstComposed = composedIds[0];
  if (lastKept !== undefined && firstComposed !== undefined) {
    edges.push({ from: lastKept, to: firstComposed, port: PRIMARY_INPUT_PORT });
  }
  edges.push(...edgesOf(composed, composedIds));

  const masks = new Map<string, NodeMask>();
  const maskedId = composed.maskAt === null ? undefined : composedIds[composed.maskAt];
  if (maskedId !== undefined && composed.mask !== null) masks.set(maskedId, composed.mask);

  return {
    effects: [...kept, ...composed.nodes.map((node) => node.effect)],
    ids: [...keptIds, ...composedIds],
    edges,
    output: composedIds[composed.outputIndex] ?? lastKept ?? null,
    masks,
    composed,
  };
}

/**
 * The leading run of source nodes in the document being rerolled — **only when
 * the canvas is blank and only when graph shape is allowed**.
 *
 * # Why the carry exists
 *
 * `io/source.ts`'s blank canvas is transparent black. A document with no
 * generator in it renders nothing at all on one, so replacing a stack that
 * *began with* a generator with one that does not leaves a black frame, and the
 * feature the owner uses most would be the one that empties the picture.
 *
 * # Why it is conditional, which it was not
 *
 * Unconditionally, this welded a leading source node onto **every subsequent
 * press** once one had been drawn. The grammar draws a generator with
 * probability 0.04 at chaos 0, so one press in twenty-five put a "Noise field"
 * at the head — and from that press on, every reroll carried it, at every chaos
 * setting, including 0 where the panel promises "a plain chain over your image".
 * Measured in the real application: 29 of 29 consecutive presses kept it, and
 * **the photograph never came back**. The only exit was deleting the node by
 * hand, which nothing in the UI tells anybody to do.
 *
 * That is a ratchet, and the argument for the carry never covered it. The
 * argument is about a canvas with no picture on it; the request already says
 * which case that is, so this reads `blankCanvas` instead of assuming it. With
 * a photograph open, a generator at the head is a *shape* — drawn by
 * `shape.ts`, at the probability the chaos slider states, fresh on every press.
 *
 * `excludes.shape` clears it too, so the panel's sentence is true rather than
 * nearly true. On a blank canvas that costs nothing: `decideShape` forces a
 * generator there whatever the exclude says (a chain over a blank canvas with a
 * generator at its head is still a chain), so the grammar draws one and the
 * frame is not black — it is simply a freshly drawn generator rather than a
 * carried one.
 *
 * Read twice — once to decide the shape, once to build the composition — so it
 * is one function rather than two loops that could come to disagree about where
 * the prefix ends.
 */
function carriedPrefix(request: SurpriseRequest): {
  readonly effects: readonly string[];
  readonly ids: readonly string[];
} {
  const none = { effects: [], ids: [] } as const;
  if (!request.blankCanvas || request.excludes.shape) return none;

  const effects: string[] = [];
  const ids: string[] = [];
  for (const node of request.base.stack) {
    const descriptor = request.registry.get(node.effect);
    if (descriptor === undefined || descriptor.slot !== "source") break;
    effects.push(node.effect);
    ids.push(node.id);
  }
  return { effects, ids };
}

/**
 * Whether a node's mask reads a picture wired to its `mask` port.
 *
 * The one property that makes a document a graph rather than a chain in this
 * generator's vocabulary: the other two mask kinds read the node's own input and
 * need no second edge.
 */
function hasImageMask(node: StackNode): boolean {
  return node.mask !== undefined && node.mask.source.kind === "image";
}

/**
 * Why the document being kept is not a plain chain, in words, or `null` when it
 * is one.
 *
 * Asked only when the stack is locked *and* graph shape is excluded, which is
 * the one place those two settings can contradict each other. It reads the
 * wiring rather than the list order, because a chain somebody reordered in the
 * panel is still a chain and refusing it would be a refusal nobody could act on.
 */
function shapeOfDocument(request: SurpriseRequest): string | null {
  const feedback = request.base.stack.find(
    (node) => request.registry.get(node.effect)?.readsFeedback === true,
  );
  if (feedback !== undefined) {
    return `contains a feedback node (${feedback.id}), which reads the previous frame and stops the document looping`;
  }
  if (request.base.stack.some(hasImageMask)) {
    return "has a branch driving a mask, which is a graph rather than a chain";
  }
  if (request.base.edges.some((edge) => edge.port !== PRIMARY_INPUT_PORT)) {
    return "has an edge into a second image input, which is a graph rather than a chain";
  }
  return null;
}

/**
 * The shape a document already has, for the path where nothing was composed.
 *
 * Derived from the nodes rather than remembered, so a locked stack reports what
 * it *is* — including a feedback node the user added by hand, which is exactly
 * the case where "does this loop" is worth being told.
 */
function observedShape(request: SurpriseRequest, stack: readonly StackNode[]): GraphShape {
  const generator = request.registry.get(stack[0]?.effect ?? "")?.slot === "source";
  return {
    generator,
    newGenerator: false,
    feedback: stack.some(
      (node) => request.registry.get(node.effect)?.readsFeedback === true,
    ),
    branch: stack.some(hasImageMask),
  };
}

/**
 * The node with the composition's mask on it, or with no `mask` key at all.
 *
 * `mask: undefined` and no `mask` are the same value in TypeScript and different
 * bytes to `JSON.stringify`, and `graph/edit.ts` makes the same point from the
 * editor's side: removing the key keeps "not masked" byte-identical to "never
 * masked", which is what stops two identical documents hashing differently.
 */
function withMask(node: StackNode, mask: NodeMask | null): StackNode {
  if (mask !== null) return { ...node, mask };
  if (node.mask === undefined) return node;
  const { mask: _dropped, ...rest } = node;
  return rest;
}

/**
 * Generate a document.
 *
 * @throws SurpriseError when the base document names an effect this build does
 * not have, when a locked stack is one the grammar rejects, or when two settings
 * ask for opposite things. All of them are stated rather than worked around: the
 * first means the document came from a different build, the second means the
 * user locked a stack that cannot render, which they need told about rather than
 * silently un-locked, and the third is a caller that asked for two opposite
 * things — picking a winner would make the panel's state and the document's
 * disagree in a way nobody could see.
 */
export function generateSurprise(request: SurpriseRequest): SurpriseResult {
  const { seed, registry, chaos, locks, excludes, base } = request;

  if (!Number.isFinite(chaos) || chaos < 0 || chaos > 1) {
    throw new SurpriseError(`chaos ${chaos} is outside 0..1`);
  }

  // The UI makes this unrepresentable — one aspect carries one mode, so setting
  // "off" clears "keep" in the same write. It is checked here anyway because
  // this module is pure and public, and an invariant that only holds because one
  // caller is careful is an invariant that holds until the second caller.
  if (locks.animation && excludes.animation) {
    throw new SurpriseError(
      "animation is both locked and excluded; \"keep this\" and \"do not make this at all\" cannot both be asked of one aspect",
    );
  }

  // Shape has no lock of its own — `locks.stack` keeps the wiring along with the
  // effects, which is the same thing said once — so the contradiction is between
  // two *different* aspects and is only real when the kept stack is actually a
  // shape the exclude forbids. Checked against the document rather than assumed,
  // so "keep this chain" plus "chains only" is the agreement it obviously is.
  if (locks.stack && excludes.shape) {
    const kept = shapeOfDocument(request);
    if (kept !== null) {
      throw new SurpriseError(
        `the stack is set to keep and graph shape is set to off, and the stack being kept ${kept}. Set the stack back to reroll, or graph shape back on — leaving the shape out would mean rewiring the stack that was to be kept.`,
      );
    }
  }

  const carriedGenerator = carriedPrefix(request).ids.length > 0;
  // A locked stack composes nothing, so there is no shape to ask for; the shape
  // it *has* is read back off the document below.
  const shape = locks.stack
    ? PLAIN_CHAIN
    : decideShape(streamFor(seed, SHAPE_STREAM), {
        chaos,
        graph: !excludes.shape,
        carriedGenerator,
        blankCanvas: request.blankCanvas,
      });

  const composition = compositionFor(request, shape);
  const previous = new Map(base.stack.map((node) => [node.id, node]));

  const stack: StackNode[] = composition.effects.map((effectId, index) => {
    const descriptor = registry.get(effectId);
    if (descriptor === undefined) {
      throw new SurpriseError(
        `the document names effect "${effectId}", which this build's catalogue does not have`,
      );
    }
    const nodeId = composition.ids[index] ?? nodeIdAt(index);
    const carried = previous.get(nodeId);

    // A node keeps its parameters only when the lock is set *and* what is being
    // kept is the same effect. Carrying a halftone's parameters onto a
    // Floyd-Steinberg would drop every key at `coerceParams` and warn once per
    // key on every render from then on.
    const keep = locks.params && carried !== undefined && carried.effect === effectId;
    const node: StackNode =
      keep && carried !== undefined
        ? carried
        : {
            // `createStackNode` derives the seed from the node id, which would
            // give every surprise of the same length the same seeds. A surprise
            // draws its own, from its own stream.
            ...createStackNode(
              nodeId,
              effectId,
              locks.params
                ? // Parameters are locked but this node is new, so there is
                  // nothing to keep. The descriptor's defaults are what the
                  // stack editor gives a freshly added node; it is the only
                  // honest answer and the UI says so.
                  defaultParams(descriptor)
                : sampleNodeParams({ seed, nodeId, descriptor, chaos }),
            ),
            seed: sampleNodeSeed(seed, nodeId),
          };

    // The mask comes from the composition and overrides whatever the node
    // carried, in **both** directions. A mask is wiring, not a parameter: a node
    // that kept a mask from a previous surprise while this composition wired no
    // picture to its mask port is a document `graph/plan.ts` refuses, and the
    // ids are re-used across rerolls, so that collision is ordinary rather than
    // exotic.
    return withMask(node, composition.masks.get(nodeId) ?? null);
  });

  // The self-check, run on every path rather than only on a freshly composed
  // graph: a locked stack came from somewhere this file did not write, and a
  // document that cannot render should say so here rather than as an error
  // banner over the previous picture.
  //
  // `validateGraph` and not `validateStack`: the latter builds the chain a list
  // implies, which for a document with a branch in it is not this document's
  // wiring at all — it would check a graph nobody is going to render and miss
  // the one that is.
  const verdict = validateGraph(registry, {
    nodes: stack,
    edges: composition.edges,
    output: composition.output,
  });
  if (!verdict.ok) {
    throw new SurpriseError(
      `this graph is one the registry rejects: ${verdict.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  const bindings = bindingsFor(request, stack);
  const palette = locks.palette ? base.palette : request.palette;

  const document: DitherDocument = {
    schema: DOCUMENT_SCHEMA_VERSION,
    source: base.source,
    stack,
    edges: composition.edges,
    output: composition.output,
    palette,
    clock: base.clock,
    bindings,
    surpriseSeed: formatSeed(seed),
  };

  // The shape as **built**, which is the composition's answer where there was
  // one and the document's own where the stack was locked. Read off the nodes
  // rather than off the request, so a requested branch the catalogue could not
  // supply is not reported as one that exists.
  const built: GraphShape = composition.composed?.shape ?? observedShape(request, stack);
  const maskedNode =
    stack.find((node) => node.mask !== undefined && node.mask.source.kind === "image")?.id ??
    null;

  const summary: SurpriseSummary = {
    seed: formatSeed(seed),
    effects: stack.map((node) => node.effect),
    effectNames: stack.map((node) => registry.get(node.effect)?.name ?? node.effect),
    dither:
      composition.composed?.dither ??
      stack.find((node) => registry.get(node.effect)?.slot === "dither")?.effect ??
      "none",
    paletteName: palette.name,
    paletteEntries: palette.colors.length / 3,
    bindings: bindings.length,
    chaos,
    shape: describeShape(built),
    loops: shapeLoops(built),
    branch: composition.composed?.branch ?? 0,
    maskedNode,
  };

  log.info("surprise generated", {
    seed: summary.seed,
    nodes: stack.length,
    dither: summary.dither,
    palette: `${palette.id} (${summary.paletteEntries})`,
    bindings: bindings.length,
    chaos,
    shape: summary.shape,
    // The one consequence of a shape that is not about how it looks. Logged on
    // every surprise, not only the non-looping ones, so "why did my export say
    // it does not loop" is answerable from the line for that document.
    loops: summary.loops,
    branch: summary.branch,
    maskedNode: summary.maskedNode ?? "none",
    lockedPalette: locks.palette,
    lockedStack: locks.stack,
    lockedParams: locks.params,
    lockedAnimation: locks.animation,
    // Zero bindings has three different causes — nothing was drawn, the build
    // has no modulator, the user turned it off — and only this line separates
    // them for whoever reads the log after "why is nothing moving".
    excludedAnimation: excludes.animation,
    excludedShape: excludes.shape,
    buildAnimates: request.animate,
  });

  return { document, seed, summary };
}

function bindingsFor(
  request: SurpriseRequest,
  stack: readonly StackNode[],
): readonly Binding[] {
  // The exclude first, because it outranks every other reason a binding might
  // exist — including one the base document arrived with. This is the whole
  // off-switch: `bindings: []` is what makes `planAnimation` resolve nothing,
  // `ui/timeline/model.ts` adopt no tracks (and stop a transport that was
  // running), and the session draw the still frame itself.
  if (request.excludes.animation) return [];

  // The registry, because a reroll re-uses the node ids `n1..nN` rather than
  // minting new ones: a binding whose id survived onto a different effect names
  // a parameter that effect does not have, and a document carrying one is a
  // document nothing will draw. `retainBindings` says what that costs.
  if (request.locks.animation) {
    return retainBindings(request.base.bindings, stack, request.registry);
  }
  if (!request.animate) return [];
  return sampleBindings({
    seed: request.seed,
    stack,
    registry: request.registry,
    chaos: request.chaos,
  });
}

/**
 * Re-roll one node's parameters and seed — F-SM-08.
 *
 * "A dice control on each node re-randomizes that node's parameters only."
 *
 * A fresh seed rather than the document's, because rerolling the same node twice
 * from the document seed would produce the same parameters twice — a dice that
 * lands on the same face every throw. The document's `surpriseSeed` is
 * deliberately **removed**: the document is no longer the one that seed
 * produces, and leaving it would make a share link reproduce something other
 * than what the sender is looking at.
 */
export function rerollNodeParams(options: {
  readonly document: DitherDocument;
  readonly registry: EffectRegistry;
  readonly nodeId: string;
  readonly seed: bigint;
  readonly chaos: number;
}): DitherDocument {
  const { document, registry, nodeId, seed, chaos } = options;
  const index = document.stack.findIndex((node) => node.id === nodeId);
  const node = document.stack[index];
  if (node === undefined) {
    throw new SurpriseError(`no node "${nodeId}" in the stack`);
  }
  const descriptor = registry.get(node.effect);
  if (descriptor === undefined) {
    throw new SurpriseError(
      `node "${nodeId}" names effect "${node.effect}", which this build's catalogue does not have`,
    );
  }

  const stack = [...document.stack];
  stack[index] = {
    ...node,
    params: sampleNodeParams({ seed, nodeId, descriptor, chaos }),
    seed: sampleNodeSeed(seed, nodeId),
  };

  log.info("node parameters rerolled", {
    nodeId,
    effect: node.effect,
    seed: formatSeed(seed),
    chaos,
  });

  // `exactOptionalPropertyTypes` is on, so the key is omitted rather than set
  // to undefined — a `surpriseSeed: undefined` would not type-check and would
  // serialise as a key that is present and empty.
  const { surpriseSeed: _dropped, ...rest } = document;
  return { ...rest, stack };
}
