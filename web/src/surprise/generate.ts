/**
 * Surprise Me — the whole document, from one seed.
 *
 * F-SM-01 ("a full random document against the current source"), F-SM-02 (one
 * 64-bit seed), F-SM-06 (locks) and F-SM-08 (per-node reroll) meet here. The
 * pieces are elsewhere and each is testable on its own: the stack grammar in
 * `grammar.ts`, the parameter draws in `params.ts`, the palette in `palette.ts`,
 * the bindings in `animation.ts`, the generator itself in `rng.ts`.
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
 * {@link SurpriseExcludes} for why exactly one aspect has an exclude and the
 * other three do not.
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
import type { Binding, DitherDocument, Palette, StackNode } from "../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../types/document";
import type { EffectRegistry } from "../registry";
import { defaultParams, validateStack } from "../registry";
// The leaf, not the `state` barrel: that barrel re-exports `session.ts`, which
// reaches the render worker and the palette editor, and this module is pure.
import { createStackNode } from "../state/document";
import { retainBindings, sampleBindings } from "./animation";
import { composeStack, type ComposedStack } from "./grammar";
import { sampleNodeParams, sampleNodeSeed } from "./params";
import { streamFor } from "./rng";
import { formatSeed } from "./seed";

const log = logger("app");

/** The stream the stack composition draws from. Written once. */
const STACK_STREAM = "surprise/stack";

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
 * # Why this has one field and `SurpriseLocks` has four
 *
 * An exclude is only offerable where **the absence is a state a document can
 * hold**. That is a fact about `DitherDocument`, not a matter of taste, and it
 * is true of exactly one of the four aspects:
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
}

export const NO_EXCLUDES: SurpriseExcludes = {
  animation: false,
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
  /** Absent when the stack was locked and therefore not composed. */
  readonly composed: ComposedStack | null;
}

/**
 * The stack this surprise runs on: either the base document's composition, or a
 * fresh one from the grammar.
 *
 * When the composition is locked the **node ids are kept too**, which is what
 * lets the parameter lock and the animation lock mean anything: a binding names
 * a node id, and a parameter lock that matched on position rather than on
 * identity would move values between nodes on a reorder.
 */
function compositionFor(request: SurpriseRequest): Composition {
  if (request.locks.stack) {
    return {
      effects: request.base.stack.map((node) => node.effect),
      ids: request.base.stack.map((node) => node.id),
      composed: null,
    };
  }

  // The generator prefix survives a reroll.
  //
  // Surprise Me's grammar is a sentence about a photograph — preprocess, one
  // dither, postprocess — and `poolFor` only ever draws from those three slots,
  // so it composes no source node and never will until the graph grammar of
  // step 4 exists. That is fine for a document with an image in it and wrong
  // for one without: on a blank canvas, replacing a stack that *began with a
  // generator* with one that does not leaves a black frame, and the feature the
  // owner uses most would be the one that empties the picture.
  //
  // So the leading run of source nodes is carried across. Only the leading run:
  // a source node further down is a composite over the picture rather than the
  // thing making it, and it is rerolled away with everything else. The node ids
  // come with it, which is what keeps the parameter lock and any binding
  // pointing at the same node — and the effect ids come with it too, so the
  // generator's own parameters are resampled like every other node's. The look
  // rerolls; the fact that there is a picture at all does not.
  const kept: string[] = [];
  const keptIds: string[] = [];
  for (const node of request.base.stack) {
    const descriptor = request.registry.get(node.effect);
    if (descriptor === undefined || descriptor.slot !== "source") break;
    kept.push(node.effect);
    keptIds.push(node.id);
  }

  const composed = composeStack(streamFor(request.seed, STACK_STREAM), {
    registry: request.registry,
    chaos: request.chaos,
  });

  // Ids for the composed tail, skipping anything the prefix already holds. Both
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

  return {
    effects: [...kept, ...composed.effects],
    ids: [...keptIds, ...composed.effects.map(() => freshId())],
    composed,
  };
}

/**
 * Generate a document.
 *
 * @throws SurpriseError when the base document names an effect this build does
 * not have, when a locked stack is one the grammar rejects, or when an aspect is
 * both locked and excluded. All three are stated rather than worked around: the
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

  const composition = compositionFor(request);
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
    if (keep && carried !== undefined) return carried;

    // `createStackNode` derives the seed from the node id, which would give
    // every surprise of the same length the same seeds. A surprise draws its
    // own, from its own stream.
    return {
      ...createStackNode(
        nodeId,
        effectId,
        locks.params
          ? // Parameters are locked but this node is new, so there is nothing to
            // keep. The descriptor's defaults are what the stack editor gives a
            // freshly added node; it is the only honest answer and the UI says so.
            defaultParams(descriptor)
          : sampleNodeParams({ seed, nodeId, descriptor, chaos }),
      ),
      seed: sampleNodeSeed(seed, nodeId),
    };
  });

  // The self-check, run on every path rather than only on a freshly composed
  // stack: a locked stack came from somewhere this file did not write, and a
  // document that cannot render should say so here rather than as an error
  // banner over the previous picture.
  const verdict = validateStack(registry, stack);
  if (!verdict.ok) {
    throw new SurpriseError(
      `this stack is one the registry rejects: ${verdict.issues
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
    palette,
    clock: base.clock,
    bindings,
    surpriseSeed: formatSeed(seed),
  };

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
  };

  log.info("surprise generated", {
    seed: summary.seed,
    nodes: stack.length,
    dither: summary.dither,
    palette: `${palette.id} (${summary.paletteEntries})`,
    bindings: bindings.length,
    chaos,
    lockedPalette: locks.palette,
    lockedStack: locks.stack,
    lockedParams: locks.params,
    lockedAnimation: locks.animation,
    // Zero bindings has three different causes — nothing was drawn, the build
    // has no modulator, the user turned it off — and only this line separates
    // them for whoever reads the log after "why is nothing moving".
    excludedAnimation: excludes.animation,
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
