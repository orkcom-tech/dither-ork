/**
 * The animation plan, and the document a frame renders.
 *
 * This is the seam between this module and the render path. A plan is built once
 * per document edit and holds everything that does not depend on the frame — the
 * checked clock, the resolved bindings, the resolved variations. Then
 * {@link documentAtFrame} turns a frame index into an ordinary
 * {@link DitherDocument} with every bound parameter already a concrete number
 * and **no bindings left in it**.
 *
 * That last detail is the whole integration, and it is deliberate. The existing
 * `state/render/graph.ts` refuses a document that carries bindings, because
 * rendering one with its unbound defaults would silently produce a picture that
 * is not the document. A document that came out of here has nothing left to
 * resolve, so that refusal stays exactly as strict as it is and still passes:
 *
 * ```ts
 * const plan = planAnimation(document, registry, { timing, variations });
 * const graphForFrame = (frame: number) =>
 *   buildRenderGraph(documentAtFrame(plan, frame), { width, height, quality, frame, solo });
 * await renderAnimation({ frames: plan.clock.frames, graphForFrame, source, palette, onFrame }, deps);
 * ```
 *
 * `graph/animate.ts` then does the rest: it hashes every frame up front, finds
 * the nodes whose hash never changes, pins them, and reuses them for the whole
 * export. It works out which nodes those are by **comparing hashes** rather than
 * by reading the binding list, which is why nothing in that file needed to learn
 * about modulators or temporal variation for this to work — and why
 * {@link AnimationPlan.animatedNodes} here is a prediction for the UI rather
 * than an input to the renderer.
 *
 * ## Where temporal variations live
 *
 * They are a plan option rather than a document field, because `.dork` has no
 * place for them yet: `DitherDocument` carries `stack`, `palette`, `clock` and
 * `bindings`, and a variation is none of those. The type is defined in
 * `temporal.ts` and is ready to be serialised; adding it to the schema is a
 * change to a file this module does not own.
 */

import type { DitherDocument, StackNode } from "../types/document";
import type { EffectDescriptor } from "../types/registry";
import type { EffectRegistry } from "../registry/registry";
import { logger } from "../lib/log";
import type { LoopClock } from "./clock";
import { loopClock, loopFrame, loopTime } from "./clock";
import type { GlobalTiming, ResolvedBinding } from "./binding";
import { DEFAULT_DOCUMENT_SEED, DEFAULT_TIMING, bindingValueAt, resolveBindings } from "./binding";
import { AnimationError } from "./errors";
import type { ResolvedVariation, TemporalVariation } from "./temporal";
import { applyTemporalState, resolveVariation, temporalStateAt } from "./temporal";

export interface AnimationOptions {
  /** F-AN-10. Defaults to speed 1, no phase offset — the document as written. */
  readonly timing?: GlobalTiming;
  /** F-AN-04. At most one per node. */
  readonly variations?: readonly TemporalVariation[];
  /** F-AN-05. Folded into every modulator's noise seed. */
  readonly documentSeed?: number;
}

export interface AnimationPlan {
  readonly document: DitherDocument;
  readonly clock: LoopClock;
  readonly timing: GlobalTiming;
  readonly documentSeed: number;
  readonly bindings: readonly ResolvedBinding[];
  readonly variations: readonly ResolvedVariation[];
  /**
   * Nodes this plan expects to move, in stack order.
   *
   * A prediction, for a timeline that wants to mark its tracks before anything
   * renders. The renderer does not read it: `graph/animate.ts` decides what is
   * invariant by comparing content hashes, which stays correct for any future
   * source of movement without that file being told about it.
   */
  readonly animatedNodes: readonly string[];
  /**
   * Enabled nodes that read their own previous frame (F-FB-01), in stack order.
   *
   * Empty for every document that has none, which is every document this
   * application could express before feedback existed. When it is not empty two
   * things are true of the whole plan and both are stated rather than inferred:
   * the document **does not loop** (see {@link loops}), and its frames must be
   * rendered in order from zero.
   */
  readonly feedbackNodes: readonly string[];
  /**
   * Whether frame N is frame 0.
   *
   * True for every document without a feedback node in it, and that is not a
   * hope — F-AN-03 makes cycles-per-loop an integer in the type system, so the
   * modulators return to their starting phase by construction and F-AN-06
   * hash-validates it before any animated export.
   *
   * **False the moment a feedback node is enabled anywhere in the stack**, and
   * that is a fact about the document rather than a failure of it. A decaying
   * trail is the product of every frame before it; nothing that accumulates can
   * return to its own beginning after N frames, and no arrangement of the
   * controls makes it. So the guarantee narrows honestly here — the loop-seam
   * report says the document does not close *and why*, and animated export
   * states it before the user commits to encoding — rather than staying
   * absolute and quietly becoming false. Decision 2 of
   * `docs/dither-ork-node-graph.md`.
   *
   * F-AN-03 keeps its full strength everywhere else: `validateLoopSeam` still
   * checks every binding's phase, and a non-periodic modulator is still an
   * error in a non-looping document, because "this document does not close" is
   * not a licence for a binding to be wrong as well.
   */
  readonly loops: boolean;
}

const log = logger("graph");

interface NodeContext {
  readonly node: StackNode;
  readonly descriptor: EffectDescriptor;
}

function nodeContexts(
  document: DitherDocument,
  registry: EffectRegistry,
): ReadonlyMap<string, NodeContext> {
  const contexts = new Map<string, NodeContext>();
  for (const node of document.stack) {
    if (contexts.has(node.id)) {
      throw new AnimationError(
        "unknown-node",
        `two stack nodes share the id "${node.id}"; a binding could not name either one`,
        { nodeId: node.id },
      );
    }
    const descriptor = registry.get(node.effect);
    if (descriptor === undefined) {
      throw new AnimationError(
        "unknown-effect",
        `node ${node.id} names effect "${node.effect}", which this build does not have`,
        { nodeId: node.id, effect: node.effect },
      );
    }
    contexts.set(node.id, { node, descriptor });
  }
  return contexts;
}

/**
 * Build the plan.
 *
 * Throws on anything that cannot be rendered as written: an unknown node, a
 * parameter that is not animatable, two bindings on one parameter, a variation
 * whose lever the effect does not have. It does **not** throw for a seam that
 * closes badly — that is `validateLoopSeam`'s job and it reports rather than
 * refuses, because a stuttering loop is still a loop and the person editing it
 * may be halfway through choosing the numbers.
 */
export function planAnimation(
  document: DitherDocument,
  registry: EffectRegistry,
  options: AnimationOptions = {},
): AnimationPlan {
  const clock = loopClock(document.clock);
  const timing = options.timing ?? DEFAULT_TIMING;
  const documentSeed = options.documentSeed ?? DEFAULT_DOCUMENT_SEED;
  const contexts = nodeContexts(document, registry);

  const bindings = resolveBindings(document, registry, timing, documentSeed);

  const variations: ResolvedVariation[] = [];
  const varied = new Set<string>();
  for (const variation of options.variations ?? []) {
    const context = contexts.get(variation.nodeId);
    if (context === undefined) {
      throw new AnimationError(
        "unknown-node",
        `temporal variation targets node "${variation.nodeId}", which is not in the stack`,
        { nodeId: variation.nodeId, mode: variation.mode },
      );
    }
    if (varied.has(variation.nodeId)) {
      throw new AnimationError(
        "duplicate-variation",
        `node ${variation.nodeId} has two temporal variations; they drive the same pattern and ` +
          `whichever won would be an accident of order`,
        { nodeId: variation.nodeId, mode: variation.mode },
      );
    }
    varied.add(variation.nodeId);
    variations.push(resolveVariation(variation, context.node, context.descriptor, clock));
  }

  const moving = new Set<string>();
  for (const binding of bindings) moving.add(binding.nodeId);
  for (const variation of variations) {
    if (variation.variation.mode !== "static") moving.add(variation.nodeId);
  }

  // A **disabled** feedback node does not count. `prepareGraph` wires a
  // disabled node out of the graph entirely, so it reads no history and cannot
  // stop the document closing; marking a document non-looping because of a node
  // that never runs would narrow the guarantee for nothing.
  const feedbackNodes = document.stack
    .filter((node) => node.enabled && contexts.get(node.id)?.descriptor.readsFeedback === true)
    .map((node) => node.id);

  if (feedbackNodes.length > 0) {
    log.info("document does not loop", {
      feedbackNodes: feedbackNodes.join(","),
      frames: clock.frames,
      why: "a feedback node's output is the product of every frame before it, so frame N is not frame 0 (F-AN-03 narrows; see docs/dither-ork-node-graph.md decision 2)",
    });
  }

  return {
    document,
    clock,
    timing,
    documentSeed,
    bindings,
    variations,
    animatedNodes: document.stack.filter((node) => moving.has(node.id)).map((node) => node.id),
    feedbackNodes,
    loops: feedbackNodes.length === 0,
  };
}

/**
 * The stack as it renders on one frame.
 *
 * A node that nothing drives is returned **by identity**, not copied. That is
 * not micro-optimisation: it is the property `graph/animate.ts` depends on, and
 * returning an equal-but-new record for every node on every frame would be
 * correct and would still hash the same, so the identity is the cheap way to
 * make the intent visible and the copy count testable.
 *
 * Bindings are applied first, then temporal variation on top of the result. A
 * parameter that is both modulated and varied — a rotation carrying a sine and a
 * `bayer-rotation` — gets the variation added to the modulated value. Stated
 * here, applied here, and asserted in `plan.test.ts`.
 */
export function stackAtFrame(plan: AnimationPlan, frame: number): readonly StackNode[] {
  // Validates the index and reports it in loop terms; the value is unused
  // because every evaluator wraps for itself.
  loopFrame(plan.clock, frame);

  const byNode = new Map<string, ResolvedBinding[]>();
  for (const binding of plan.bindings) {
    const list = byNode.get(binding.nodeId);
    if (list === undefined) byNode.set(binding.nodeId, [binding]);
    else list.push(binding);
  }
  const variationByNode = new Map<string, ResolvedVariation>();
  for (const variation of plan.variations) variationByNode.set(variation.nodeId, variation);

  return plan.document.stack.map((node) => {
    const bindings = byNode.get(node.id);
    const variation = variationByNode.get(node.id);
    if (bindings === undefined && variation === undefined) return node;

    let next = node;
    if (bindings !== undefined) {
      const params: Record<string, StackNode["params"][string]> = { ...node.params };
      for (const binding of bindings) {
        params[binding.param] = bindingValueAt(binding, plan.clock, frame);
      }
      next = { ...node, params };
    }
    if (variation !== undefined) {
      next = applyTemporalState(
        next,
        variation.descriptor,
        temporalStateAt(variation.variation, plan.clock, frame, variation.baseSeed),
      );
    }
    return next;
  });
}

/**
 * The document one frame renders.
 *
 * Carries no bindings, because there is nothing left to resolve. Hand it
 * straight to `buildRenderGraph`.
 */
export function documentAtFrame(plan: AnimationPlan, frame: number): DitherDocument {
  return { ...plan.document, stack: stackAtFrame(plan, frame), bindings: [] };
}

/** Normalized loop time for a frame — F-AN-01's `t`, in `[0, 1)`. */
export function planTime(plan: AnimationPlan, frame: number): number {
  return loopTime(plan.clock, frame);
}

/**
 * Fraction of the loop a feedback still is taken at.
 *
 * A quarter. Far enough in that a decay of 0.5 has accumulated four frames and a
 * trail is a trail; short enough that the replay behind it is a quarter of the
 * loop and not the whole of it, which is what the still costs.
 *
 * A fraction rather than a frame count so a 12-frame loop and a 240-frame loop
 * both show a still a quarter of the way through their own movement, instead of
 * the short one being shown near its end and the long one at its very start.
 */
export const FEEDBACK_STILL_FRACTION = 0.25;

/**
 * Which frame a **still** of this document should be rendered at.
 *
 * Zero for every document that loops, which is every document without a feedback
 * node — frame 0 is the picture, and rendering any other frame of a looping
 * document would cost a replay to show the same thing.
 *
 * **Not zero for a feedback document**, and that is the whole reason this
 * function exists. A feedback node blends the previous frame at its own position
 * into this one; at frame 0 there is no previous frame, so the node is the
 * identity and the picture is the picture *without* the trail. Every still in the
 * application was showing that: the viewport's first view of a fresh surprise, and
 * the history thumbnail beside it, were pictures the animation does not contain.
 * The judge's note on the review is exact — the still lies about feedback, and it
 * lies in the direction of "this shape bought nothing", because at frame 0 it
 * genuinely bought nothing.
 *
 * The cost is stated rather than hidden: frame N of a feedback document is the
 * product of frames 0..N, so a still at frame N is N+1 renders. That is why the
 * fraction is a quarter and not a half, and why the callers that pay it —
 * `ui/surprise/engine.ts` for the thumbnail, `state/session.ts` for the viewport —
 * report the replay the same way `ui/timeline/preview.ts` already does.
 */
export function stillFrameFor(plan: AnimationPlan): number {
  if (plan.feedbackNodes.length === 0) return 0;
  // At least one, so a document with a very short clock still shows a frame that
  // has a history — and never past the last frame of the loop.
  const last = Math.max(0, plan.clock.frames - 1);
  return Math.min(last, Math.max(1, Math.round(plan.clock.frames * FEEDBACK_STILL_FRACTION)));
}
