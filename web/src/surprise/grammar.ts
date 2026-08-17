/**
 * The graph grammar — F-SM-03, and step 4 of `docs/dither-ork-node-graph.md`.
 *
 * "The stack is built to a grammar, not sampled uniformly: an optional
 * preprocessing chain, then exactly one primary dither node, then an optional
 * post-processing and glitch chain. Mutually incompatible combinations are
 * excluded by the grammar rather than filtered after the fact."
 *
 * ## What changed when the document became a graph
 *
 * The sentence above is a sentence about a *line*, and this module now builds
 * something that can branch. Nothing in the paragraph below was relaxed to make
 * that possible — it was tightened, which is the only direction that was ever
 * available. A graph has more shapes than a chain, so a grammar loose enough to
 * cover them all is not a grammar; the legal shapes are therefore enumerated,
 * in full and in one place, in {@link ./shape.ts}, and this module composes one
 * of them and nothing else.
 *
 * The three additions each earn their place:
 *
 * - **A generator at the head**, so the picture is made rather than
 *   photographed. Structurally still a chain; a genuinely new kind of result.
 * - **A feedback node**, which is where trails, smear and endless zoom live —
 *   and which makes the document non-looping, so it is a *shape* decision the
 *   caller can refuse rather than a lucky postprocess draw.
 * - **A branch feeding a mask**, which is the one shape here that is not a
 *   chain, and the composition a node tool is worth having for.
 *
 * **Merging two branches is not generated.** It needs an effect that declares
 * an input port of role `layer`, and no effect in the catalogue does — so a
 * merged graph is a shape nothing can render, and generating one would be
 * generating a document that fails at the pass compiler.
 *
 * The distinction in that last sentence is the whole design of this file.
 * Filtering after the fact means generating a stack, asking `validateStack`
 * whether it is legal, and drawing again if it is not — which is a rejection
 * loop whose termination depends on how much of the catalogue happens to be
 * illegal today, and which quietly biases the result toward whatever combination
 * survives. Excluding by the grammar means **the candidate pool at each step is
 * computed from the state the stack is in at that step**, so an illegal choice is
 * never available to be made.
 *
 * The state is exactly what `registry/stack.ts` walks: which effects are already
 * in the stack (for `excludes`), and whether an index map is live (for
 * `requiresIndexMap` and for the extent rule). It is re-derived here from the
 * same descriptor fields rather than imported, because this walks a stack it is
 * *building* and that one walks a stack that already exists — but the rules are
 * read off the same three declarations, and {@link composeStack} asserts its own
 * output against `validateStack` before returning it. That assertion is not a
 * filter: it never draws again, it throws. A grammar that can emit an illegal
 * stack is a defect, and a defect should stop rather than be retried around.
 *
 * ## Why exactly one dither
 *
 * Two dithers in a row is not illegal — the second quantizes the first's output
 * and `validateStack` accepts it — and it is also almost always mud. The
 * grammar's job is to make the *usable* results likely, which is the same
 * argument that gives every parameter a surprise range narrower than its legal
 * one (F-SM-04). One dither is the shape of the thing being generated.
 *
 * ## Why no effect appears twice
 *
 * F-ST-07 allows any node any number of times, so this is a taste decision
 * rather than a legality one, and it is stated here so it can be found: two
 * copies of the same glitch at different parameters read as one glitch that did
 * not quite work, and they crowd out the twenty other effects that would have
 * made the stack interesting.
 */

import { logger } from "../lib/log";
import type { GraphEdge, MaskChannel, NodeMask, NodeSlot } from "../types/document";
import type { EffectRegistry } from "../registry";
import { validateGraph } from "../registry";
import type { EffectDescriptor } from "../types/registry";
import { MASK_INPUT_PORT, PRIMARY_INPUT_PORT } from "../types/registry";
import type { Weighted } from "../types/registry";
import { portsOf } from "../graph/ports";
import type { GraphShape } from "./shape";
import { lerp } from "./shape";
import type { Pcg32 } from "./rng";
import { weightedChoice } from "./sample";

const log = logger("app");

/**
 * The chaos interpolation, re-exported from where the shape decision needs it.
 *
 * It moved to `shape.ts` because that module is drawn from first and cannot
 * import this one without a cycle; every caller still reads it from here, which
 * is where a reader looking for "what chaos does" will go.
 */
export { lerp } from "./shape";

export class GrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrammarError";
  }
}

/**
 * How much of the catalogue a chaos setting reaches.
 *
 * F-SM-07 names three things the slider controls, and two of them are here:
 * node count and the probability of glitch nodes appearing. The third,
 * parameter deviation, is in `params.ts`.
 *
 * The numbers are the tame and wild ends of each; everything between is a
 * straight interpolation. They are constants in one block rather than literals
 * scattered through the code, because they are the feature's taste and somebody
 * will want to argue with them.
 */
export const CHAOS = {
  /** Most preprocessing nodes at chaos 0 and at chaos 1. */
  preprocessCeiling: [1, 4] as const,
  /** Most postprocessing nodes at chaos 0 and at chaos 1. */
  postprocessCeiling: [1, 5] as const,
  /**
   * Multiplier on a glitch-family effect's declared `surpriseWeight`.
   *
   * Below 1 at the tame end, so a glitch is a rare seasoning; well above it at
   * the wild end, so the postprocess chain becomes mostly glitch. It multiplies
   * the descriptor's own weight rather than replacing it, so a niche glitch
   * stays niche relative to a signature one at every setting.
   */
  glitchWeight: [0.35, 2.5] as const,
  /**
   * Most nodes a mask branch may hold, beyond its root, at each end.
   *
   * Small on purpose and it is the shape rule that matters most: a mask is read
   * as a channel of a picture, so what a branch is *for* is tone structure. One
   * blur on a gradient is a soft falloff; four glitches on a gradient is noise
   * with no structure at all, and coverage that is noise makes the node it
   * masks look broken rather than masked.
   */
  branchCeiling: [1, 2] as const,
} as const;

export interface StackGrammarOptions {
  readonly registry: EffectRegistry;
  /** Tame to wild, `[0, 1]` (F-SM-07). */
  readonly chaos: number;
  /**
   * The shape this composition is to have, already drawn by `shape.ts`.
   *
   * Passed in rather than drawn here so it comes from its own stream — a change
   * to the shape probabilities then moves which shape a seed produces without
   * re-rolling every effect after it.
   *
   * It is a *request*. {@link composeGraph} returns the shape it actually built,
   * which differs only where the catalogue could not satisfy the request — see
   * {@link ComposedGraph.shape}.
   */
  readonly shape: GraphShape;
}

/** Which part of the sentence a composed node is. */
export type GraphPart =
  | "generator"
  | "preprocess"
  | "dither"
  | "feedback"
  | "postprocess"
  | "branch";

export interface ComposedNode {
  readonly effect: string;
  readonly part: GraphPart;
}

/**
 * One edge, by **index into {@link ComposedGraph.nodes}**.
 *
 * Indices rather than ids because the grammar does not mint node ids: a reroll
 * carries some of them across from the document it is rerolling, and only
 * `generate.ts` knows which. Resolving indices to ids is one `map` there and
 * keeps this module free of that entirely.
 */
export interface ComposedEdge {
  readonly from: number;
  readonly to: number;
  readonly port: string;
}

/** The composition: the nodes, how they are wired, and what the grammar decided. */
export interface ComposedGraph {
  /**
   * Main chain first, in evaluation order, then the branch.
   *
   * That order is what the document's node list gets, and it is chosen for the
   * stack panel: `ui/stack/graph-view.ts` reads the *wiring* to label each row,
   * so a branch at the end reads as "feeds the mask of n4" rather than as three
   * rows of chain that are not one.
   */
  readonly nodes: readonly ComposedNode[];
  readonly edges: readonly ComposedEdge[];
  /** Index of the node whose output is the picture. Always on the main chain. */
  readonly outputIndex: number;
  /** Index of the masked node, and its mask, when the shape has a branch. */
  readonly maskAt: number | null;
  readonly mask: NodeMask | null;
  /**
   * The shape that was actually built.
   *
   * Equal to the requested shape except where the catalogue ran out: a branch
   * is dropped when no legal branch could be composed — every candidate for the
   * masked node sits downstream of a resampler, or the preprocess pool is
   * empty. That is the same "the pool ran dry, so the sentence is shorter"
   * outcome an unreachable preprocess count already has, and it is reported
   * rather than retried around.
   */
  readonly shape: GraphShape;
  readonly preprocess: number;
  readonly dither: string;
  readonly postprocess: number;
  /** Nodes in the mask branch. Zero when the shape has none. */
  readonly branch: number;
  /** True when the chosen dither emits an index map, so consumers were eligible. */
  readonly indexMapLive: boolean;
}

/** What the walk knows at each step. The same three facts `validateStack` uses. */
interface GrammarState {
  readonly chosen: readonly EffectDescriptor[];
  readonly indexMapLive: boolean;
}

/**
 * Whether `candidate` may be placed given what is already in the stack.
 *
 * Every clause reads one declared field, and each one is the grammar's copy of a
 * rule `registry/stack.ts` states in prose:
 *
 * - `requiresIndexMap` — outline, dilate/erode and nearest upscale read the
 *   index map, so they are only in the pool while one is live. That is what
 *   keeps a stack whose dither is CMYK halftone (the one dither-slot node that
 *   emits no map) from ever being offered an outline.
 * - `resamples` while a map is live — palette indices are names, not
 *   quantities, so no filter means anything applied to them. A resampler that
 *   does not carry the map across would leave colours and indices naming
 *   different pixel grids.
 * - `excludes` — checked in both directions, because either descriptor may be
 *   the one that names the conflict.
 */
function eligible(candidate: EffectDescriptor, state: GrammarState): boolean {
  if (state.chosen.some((chosen) => chosen.id === candidate.id)) return false;

  if (candidate.requiresIndexMap && !state.indexMapLive) return false;
  if (candidate.resamples === true && state.indexMapLive && !candidate.producesIndexMap) {
    return false;
  }

  for (const chosen of state.chosen) {
    if ((candidate.excludes ?? []).includes(chosen.id)) return false;
    if ((chosen.excludes ?? []).includes(candidate.id)) return false;
  }
  return true;
}

/**
 * The state after placing `descriptor`, by the same transition
 * `registry/stack.ts` walks.
 *
 * A dither-slot node **replaces** the live map rather than adding to it:
 * quantizing is what the slot is for, so whatever indices arrived at it no
 * longer describe the pixels leaving it. That is why CMYK halftone clears the
 * map rather than passing one through.
 */
function advance(state: GrammarState, descriptor: EffectDescriptor): GrammarState {
  const chosen = [...state.chosen, descriptor];
  if (descriptor.slot === "dither") {
    return { chosen, indexMapLive: descriptor.producesIndexMap };
  }
  return {
    chosen,
    indexMapLive: state.indexMapLive || descriptor.producesIndexMap,
  };
}

/** The weight an effect carries in this draw, after the chaos adjustment. */
function weightOf(descriptor: EffectDescriptor, chaos: number): number {
  const glitch = descriptor.family === "glitch" ? lerp(CHAOS.glitchWeight, chaos) : 1;
  return descriptor.surpriseWeight * glitch;
}

/**
 * The candidates for one draw.
 *
 * `also` is the graph grammar's extra clause and it is always a *narrowing*:
 * a branch admits no resampler, an ordinary postprocess draw admits no feedback
 * node. It is a parameter rather than three more fields on {@link GrammarState}
 * because it is a property of the position being filled, not of the graph built
 * so far — and, like every other clause here, it removes the candidate from the
 * pool rather than rejecting a draw that already happened.
 */
function poolFor(
  registry: EffectRegistry,
  slot: NodeSlot,
  state: GrammarState,
  chaos: number,
  also: (descriptor: EffectDescriptor) => boolean = () => true,
): readonly Weighted<EffectDescriptor>[] {
  return registry
    .bySlot(slot)
    .filter((descriptor) => eligible(descriptor, state) && also(descriptor))
    .map((descriptor) => ({ value: descriptor, weight: weightOf(descriptor, chaos) }));
}

/** A node that reads its own previous frame. Exactly one effect declares it. */
function isFeedback(descriptor: EffectDescriptor): boolean {
  return descriptor.readsFeedback === true;
}

/** A node that writes a different extent than it reads. See the extent rule. */
function isResampler(descriptor: EffectDescriptor): boolean {
  return descriptor.resamples === true;
}

/**
 * A generator whose picture has structure at the scale of the frame.
 *
 * The declared answer, from `EffectDescriptor.coverage`, and the third rule the
 * review sheet decided rather than the design — see {@link composeBranch}. The
 * registry validator requires the field on every source-slot effect, so this is a
 * question the catalogue always has an answer to rather than a lookup that
 * silently returns false for an effect nobody remembered.
 */
function masksVisibly(descriptor: EffectDescriptor): boolean {
  return descriptor.coverage === "large-scale";
}

/**
 * How likely each kind of node is to be the one a branch masks.
 *
 * **Measured, not taste** — which is what changed about this table. Every number
 * below comes from rendering each branched document twice, once as generated and
 * once with the branch cut out, and taking the mean absolute RGB difference. Over
 * thirty branched documents at chaos 0.8:
 *
 * | masked node | branches | median difference | invisible (< 0.01) |
 * | --- | --- | --- | --- |
 * | the dither | 12 | 0.145 | **0 of 12** |
 * | a generator at the head | 1 | 0.151 | 0 of 1 |
 * | a postprocess node | 14 | 0.031 | **6 of 14** |
 * | the feedback node | 3 | 0 | 2 of 3, and see below |
 *
 * The dither is the reliable one and always was — the picture is dithered where
 * the branch is bright and continuous where it is dark, which anybody can read
 * off the result, and not one of the twelve came in under 0.02.
 */
const MASK_TARGET_WEIGHT: Readonly<Record<GraphPart, number>> = {
  dither: 3,
  /**
   * A generator at the head, which a mask turns into a composite over the
   * photograph: the made picture here, the photographed one there. A whole-frame
   * figure against a whole-frame image is about as visible as a mask gets.
   */
  generator: 2,
  /**
   * Kept, and it is the one entry not decided by the still.
   *
   * Feedback is the identity at frame 0, so a masked feedback node in a *still*
   * is exactly zero difference however good the coverage is — two of the three
   * measured were precisely 0 for that reason and not because the mask failed.
   * The thumbnail and the first view now render a feedback document at a frame
   * inside the loop (`animation/plan.ts`'s `previewFrameFor`), which is where
   * that node has a history to mask, and the third sample — a document already
   * past frame 0 in its own right — measured 0.118.
   */
  feedback: 2,
  /**
   * **Never**, and this is the number the second review changed.
   *
   * A masked glitch is a coin flip: six of fourteen measured under 0.01 and the
   * median at 0.031, because a mask can only reveal what the node it masks was
   * doing, and a chromatic aberration at 3% strength or a slice repeat that drew
   * the identity was doing nothing to reveal. Two came in at *exactly* zero.
   *
   * The alternative was to declare, per effect, how strongly it changes a
   * picture — fifty-odd new judgements, every one of them arguable, to salvage a
   * placement that at its best is weaker than masking the dither. A capability
   * that does nothing a quarter of the time is worse than one that is narrower
   * and always works.
   */
  postprocess: 0,
  /**
   * **Never**, and this is a rule read off pictures rather than off a
   * descriptor.
   *
   * A masked preprocess node is a blur, or a curve, that happens in half the
   * frame — and then the whole frame is quantized to four colours over the top
   * of it. In the review sheet the pair that masked a blur rendered
   * *indistinguishable* from the same document with no branch at all: one extra
   * node, one extra render, and no difference in the picture. The dither and
   * everything after it are what survives to the output, so they are what a mask
   * can be seen on.
   */
  preprocess: 0,
  // A branch node is never masked by its own branch: that is the second branch
  // this grammar does not generate.
  branch: 0,
};

/**
 * Which channel of the branch picture is read as coverage.
 *
 * `alpha` is legal and deliberately absent: every picture this grammar can put
 * in a branch is opaque, so alpha coverage would be 1 everywhere and the mask
 * would be a mask that does nothing. Luminance leads because tone is what a
 * gradient, a shape and noise all have; the three colour channels are there
 * because a coloured generator has three different maps in it and picking one
 * is free structure.
 */
const MASK_CHANNEL_WEIGHT: readonly Weighted<MaskChannel>[] = [
  { value: "luminance", weight: 6 },
  { value: "red", weight: 1 },
  { value: "green", weight: 1 },
  { value: "blue", weight: 1 },
];

/** Chance the coverage is flipped. Half the masks anybody draws are inverted. */
const MASK_INVERT_PROBABILITY = 0.4;

/**
 * Build a graph.
 *
 * The draw order is fixed and is part of what a seed means:
 *
 * 1. the two chain counts,
 * 2. the dither,
 * 3. the generator, if the shape has a new one,
 * 4. the preprocess chain,
 * 5. the feedback node, if the shape has one,
 * 6. the postprocess chain,
 * 7. where the feedback node sits in it,
 * 8. the branch: which node it masks, its root, its length, its nodes, and the
 *    mask itself.
 *
 * Two of those orderings are load-bearing rather than arbitrary. **The dither
 * comes before both chains** because it decides whether an index map is live and
 * therefore what the postprocess pool contains. **The feedback node is drawn
 * before the postprocess chain** for the same reason one step down: it is a
 * postprocess node, so it has to be in the `chosen` set the rest of that chain
 * is drawn against, or the grammar could put an effect beside it that declares
 * it excluded. Where it *sits* is drawn afterwards, and can be, because feedback
 * neither produces nor consumes an index map and does not resample — its
 * position cannot change any other node's eligibility.
 *
 * @throws GrammarError when the catalogue cannot satisfy the grammar at all —
 * no dither-slot effect — or when the graph it built is one `validateGraph`
 * rejects. Both are build defects and both stop rather than being drawn around.
 * **A grammar that can emit an illegal graph is a bug, not a filtered case.**
 */
export function composeGraph(rng: Pcg32, options: StackGrammarOptions): ComposedGraph {
  const { registry, chaos, shape } = options;

  // Counts first, so the same seed asks for the same shape whatever the
  // catalogue happens to contain. Each is drawn from `0..=ceiling`, so "no
  // preprocessing at all" stays a real outcome at every chaos setting — a bare
  // dither is a legitimate look and the tame end should reach it.
  const preWanted = rng.nextBelow(Math.round(lerp(CHAOS.preprocessCeiling, chaos)) + 1);
  const postWanted = rng.nextBelow(Math.round(lerp(CHAOS.postprocessCeiling, chaos)) + 1);

  const ditherPool = poolFor(registry, "dither", { chosen: [], indexMapLive: false }, chaos);
  if (ditherPool.length === 0) {
    throw new GrammarError(
      "the catalogue has no dither-slot effect; a surprise is exactly one primary dither and cannot be built without one",
    );
  }
  const dither = weightedChoice(rng, ditherPool);

  // The generator, drawn against a state holding the dither so an `excludes`
  // between the two is honoured. A source node writes the same extent it reads
  // — `types/registry.ts` refuses one that does not — so it can never be the
  // resampler that costs the branch its candidates.
  let state: GrammarState = { chosen: [dither], indexMapLive: false };
  let generator: EffectDescriptor | null = null;
  if (shape.newGenerator) {
    const pool = poolFor(registry, "source", state, chaos);
    if (pool.length > 0) {
      generator = weightedChoice(rng, pool);
      state = advance(state, generator);
    }
  }

  // The preprocess chain, drawn with `indexMapLive` false because nothing has
  // quantized yet at the point these nodes run. Position in the graph, not order
  // of drawing, is what the index-map rules are about.
  const preprocess: EffectDescriptor[] = [];
  for (let i = 0; i < preWanted; i += 1) {
    const pool = poolFor(registry, "preprocess", state, chaos);
    if (pool.length === 0) break;
    const picked = weightedChoice(rng, pool);
    preprocess.push(picked);
    state = advance(state, picked);
  }

  // Now walk forward properly: everything chosen so far, with the map the dither
  // actually leaves behind.
  let postState: GrammarState = {
    chosen: state.chosen,
    indexMapLive: dither.producesIndexMap,
  };

  // Feedback, drawn from its own pool and never from the ordinary one. Making it
  // a shape decision rather than a lucky postprocess draw is what lets a chaos
  // setting, and a user, say *no trails* and be obeyed — and what guarantees at
  // most one of them, which two independent draws could not.
  let feedback: EffectDescriptor | null = null;
  if (shape.feedback) {
    const pool = poolFor(registry, "postprocess", postState, chaos, isFeedback);
    if (pool.length > 0) {
      feedback = weightedChoice(rng, pool);
      postState = advance(postState, feedback);
    }
  }

  const postprocess: EffectDescriptor[] = [];
  for (let i = 0; i < postWanted; i += 1) {
    // Feedback is excluded here whether or not the shape asked for one: it is
    // drawn above or it is absent, and a second path to it would put two in a
    // document or one in a document that asked for none.
    const pool = poolFor(
      registry,
      "postprocess",
      postState,
      chaos,
      (descriptor) => !isFeedback(descriptor),
    );
    if (pool.length === 0) break;
    const picked = weightedChoice(rng, pool);
    postprocess.push(picked);
    postState = advance(postState, picked);
  }

  // Where the feedback node sits among the postprocess nodes. Uniform over every
  // position including both ends: straight after the dither is a trail of the
  // quantized picture, at the end it is a trail of the finished frame, and both
  // are things people build on purpose.
  const feedbackAt = feedback === null ? -1 : rng.nextBelow(postprocess.length + 1);

  const main: ComposedNode[] = [];
  if (generator !== null) main.push({ effect: generator.id, part: "generator" });
  for (const descriptor of preprocess) {
    main.push({ effect: descriptor.id, part: "preprocess" });
  }
  main.push({ effect: dither.id, part: "dither" });
  for (let i = 0; i <= postprocess.length; i += 1) {
    if (feedback !== null && i === feedbackAt) {
      main.push({ effect: feedback.id, part: "feedback" });
    }
    const descriptor = postprocess[i];
    if (descriptor !== undefined) main.push({ effect: descriptor.id, part: "postprocess" });
  }

  const nodes: ComposedNode[] = [...main];
  const edges: ComposedEdge[] = [];
  for (let i = 1; i < main.length; i += 1) {
    edges.push({ from: i - 1, to: i, port: PRIMARY_INPUT_PORT });
  }
  const outputIndex = main.length - 1;

  const branch = shape.branch
    ? composeBranch(rng, { registry, chaos, main, state: postState })
    : null;
  if (branch !== null) {
    const first = nodes.length;
    for (const node of branch.nodes) nodes.push({ effect: node.id, part: "branch" });
    for (let i = 1; i < branch.nodes.length; i += 1) {
      edges.push({ from: first + i - 1, to: first + i, port: PRIMARY_INPUT_PORT });
    }
    edges.push({
      from: first + branch.nodes.length - 1,
      to: branch.maskAt,
      port: MASK_INPUT_PORT,
    });
  }

  const built: GraphShape = {
    generator: shape.generator,
    // A requested generator the source pool could not supply is not one, and
    // saying otherwise would make `selfSourced` in the stack panel a lie.
    newGenerator: generator !== null,
    feedback: feedback !== null,
    branch: branch !== null,
  };

  // The self-check, against the validator the application itself runs. Not a
  // filter: it never draws again, it throws. A graph the grammar built and
  // validation rejects is a defect in this file, and it stops here rather than
  // reaching a user as an error banner over a picture that will not render.
  const verdict = validateGraph(registry, {
    nodes: nodes.map((node, index) => ({
      id: `g${index}`,
      effect: node.effect,
      enabled: true,
      ...(branch !== null && index === branch.maskAt ? { mask: branch.mask } : {}),
    })),
    edges: edges.map((edge) => ({
      from: `g${edge.from}`,
      to: `g${edge.to}`,
      port: edge.port,
    })),
    output: `g${outputIndex}`,
  });
  if (!verdict.ok) {
    throw new GrammarError(
      `the surprise grammar produced a graph the registry rejects: ${verdict.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  log.debug("surprise graph composed", {
    nodes: nodes.length,
    preprocess: preprocess.length,
    dither: dither.id,
    postprocess: postprocess.length,
    generator: generator?.id ?? "none",
    feedback: feedback?.id ?? "none",
    branch: branch?.nodes.length ?? 0,
    indexMapLive: dither.producesIndexMap,
    chaos,
    // Stated when a pool ran dry before the count was met, so a graph that is
    // smaller than the chaos setting asked for has a visible reason.
    preShort: preprocess.length < preWanted,
    postShort: postprocess.length < postWanted,
    branchShort: shape.branch && branch === null,
  });

  return {
    nodes,
    edges,
    outputIndex,
    maskAt: branch?.maskAt ?? null,
    mask: branch?.mask ?? null,
    shape: built,
    preprocess: preprocess.length,
    dither: dither.id,
    postprocess: postprocess.length,
    branch: branch?.nodes.length ?? 0,
    indexMapLive: dither.producesIndexMap,
  };
}

interface BranchRequest {
  readonly registry: EffectRegistry;
  readonly chaos: number;
  /** The main chain as built, in evaluation order. */
  readonly main: readonly ComposedNode[];
  /** Everything chosen so far, so the branch honours `excludes` across the graph. */
  readonly state: GrammarState;
}

interface ComposedBranch {
  readonly nodes: readonly EffectDescriptor[];
  /** Index into the main chain of the node this branch masks. */
  readonly maskAt: number;
  readonly mask: NodeMask;
}

/**
 * Compose the branch, or return `null` when the catalogue cannot supply one.
 *
 * `null` is not a rejected draw — nothing is drawn twice. It is the pool having
 * run dry, and the two ways that happens are both stated in the code below:
 * every node on the main chain sits downstream of a resampler, or the branch
 * pool is empty once `excludes` and the main chain have taken their share.
 */
function composeBranch(rng: Pcg32, request: BranchRequest): ComposedBranch | null {
  const { registry, chaos, main } = request;

  // Candidates for the masked node.
  //
  // Two rules, and the second is the extent rule this grammar exists to keep:
  //
  // - the node must *have* a mask port, which `graph/ports.ts` withholds from a
  //   resampler because a mask is a composite and a resampler has no common
  //   pixel grid with its own input;
  // - nothing at or before it may resample, because the branch is rooted at the
  //   decoded source and `_composite.wgsl` reads the mask with `textureLoad` at
  //   the masked node's own coordinates. One `internal-resolution` upstream and
  //   the two pictures are different sizes, so coverage lands on the wrong
  //   pixels — or, where the mask is the smaller of the two, silently on none.
  const candidates: Weighted<number>[] = [];
  let resampled = false;
  for (let i = 0; i < main.length; i += 1) {
    const node = main[i];
    if (node === undefined) continue;
    const descriptor = registry.get(node.effect);
    if (descriptor === undefined) continue;
    if (isResampler(descriptor)) {
      resampled = true;
      continue;
    }
    if (resampled) continue;
    if (!portsOf(descriptor).some((port) => port.key === MASK_INPUT_PORT)) continue;
    const weight = MASK_TARGET_WEIGHT[node.part];
    if (weight > 0) candidates.push({ value: i, weight });
  }
  if (candidates.length === 0) return null;

  const maskAt = weightedChoice(rng, candidates);

  // The branch itself. Drawn against the whole graph's `chosen` set so no effect
  // appears twice and every `excludes` pair is honoured across the branch too —
  // `registry/graph.ts` checks exclusions between *any* two live nodes, on the
  // same path or not, and a branch that reached the picture through a mask port
  // is very much live.
  const wanted = rng.nextBelow(Math.round(lerp(CHAOS.branchCeiling, chaos)) + 1);

  // `indexMapLive` is false and stays false: the branch is rooted at a generator
  // and there is no dither in it — so an index-map consumer is out of the pool by
  // the ordinary rule rather than by a rule of its own.
  let state: GrammarState = { chosen: request.state.chosen, indexMapLive: false };
  const nodes: EffectDescriptor[] = [];

  // **A mask branch is always rooted in a generator, and in one whose picture has
  // large-scale structure.** Two rules, both read off pictures rather than off the
  // design, and the second is what the second review bought.
  //
  // *A generator*, because the alternative was a branch rooted at the decoded
  // source — the picture filtered differently and read back as coverage. It
  // sounds like the more general option and it is the weaker one: coverage
  // computed from the picture's own tone is what a node's `luminance` and `color`
  // mask sources already produce, with no second edge and no second render. Two
  // of the eight branched documents in the first review were rooted that way, and
  // both rendered indistinguishable from the same seed with no branch at all.
  //
  // *Large-scale*, because "a generator" was not enough. A mask multiplies the
  // masked node's opacity per pixel, so coverage that varies at the scale of a
  // pixel blends that node's output with its own input everywhere at once — and
  // the average of two similar pictures is the picture. Measured over ninety-six
  // documents: a branch rooted in the noise field moved the picture by a median
  // 0.017 mean absolute RGB, with six of thirteen under 0.01, against 0.145 for
  // the shape generator and 0.045 for the gradient. So the question is asked of
  // `EffectDescriptor.coverage`, which the registry requires every generator to
  // answer, rather than of a list of effect ids kept here.
  const rootPool = poolFor(registry, "source", state, chaos, masksVisibly);
  // No generator declares large-scale structure, so there is no branch to build.
  // Reported by returning null, exactly as an empty preprocess pool is: the
  // document comes back a chain and `ComposedGraph.shape` says the branch was not
  // built. A capability that would do nothing is better absent than present.
  if (rootPool.length === 0) return null;
  const root = weightedChoice(rng, rootPool);
  nodes.push(root);
  state = advance(state, root);

  for (let i = 0; i < wanted; i += 1) {
    const pool = poolFor(
      registry,
      "preprocess",
      state,
      chaos,
      (descriptor) => !isResampler(descriptor),
    );
    if (pool.length === 0) break;
    const picked = weightedChoice(rng, pool);
    nodes.push(picked);
    state = advance(state, picked);
  }

  const mask: NodeMask = {
    source: { kind: "image", channel: weightedChoice(rng, MASK_CHANNEL_WEIGHT) },
    invert: rng.nextBool(MASK_INVERT_PROBABILITY),
  };
  return { nodes, maskAt, mask };
}

/**
 * The wiring a composed graph implies, as document edges.
 *
 * Kept beside the composition so "index 3 of `nodes`" is turned into a node id
 * in exactly one place. `ids` is the caller's list, in the same order as
 * {@link ComposedGraph.nodes}.
 */
export function edgesOf(
  composed: ComposedGraph,
  ids: readonly string[],
): readonly GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const edge of composed.edges) {
    const from = ids[edge.from];
    const to = ids[edge.to];
    if (from === undefined || to === undefined) {
      throw new GrammarError(
        `the composition names node index ${edge.from}->${edge.to}, and only ${ids.length} id(s) were supplied`,
      );
    }
    edges.push({ from, to, port: edge.port });
  }
  return edges;
}
