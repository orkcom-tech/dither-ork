/**
 * Planning: what actually has to run, and in what shape.
 *
 * Three decisions live here, and they are the three the architecture cares
 * about.
 *
 * **What re-runs (F-ST-01).** Every node is hashed over its parameters, seed,
 * resolution and its inputs' hashes. The walk then starts at the graph output
 * and goes *backwards*: a node whose hash the cache already holds stops the
 * walk, because nothing upstream of a satisfied node can change its result.
 * "Re-render begins at the earliest changed position" is not a special case in
 * here — it is what a backward walk that stops at cache hits does.
 *
 * **Where the boundary crossings are.** Consecutive parallel nodes are grouped
 * into one GPU submission. Each serial WASM node between two GPU runs costs a
 * readback and an upload, and that count — not the number of passes — is the
 * ceiling on how live the preview feels.
 *
 * **What a disabled node means.** It is not executed and it is not a node that
 * copies its input: it is removed from the wiring entirely, and every edge that
 * read it is rewritten to read what it read. A disabled node therefore has the
 * same hash as its input, which is why toggling one off and on again is free
 * both ways.
 */

import type { BlendMode, NodeMask, Palette } from "../types/document";
import type {
  ContentHash,
  GraphNode,
  InputPort,
  RenderGraph,
} from "../types/graph";
import type { EffectDescriptor, ExecutionKind } from "../types/registry";
import { MASK_INPUT_PORT } from "../types/registry";
import type { GraphTopology } from "./topology";
import { analyseGraph } from "./topology";
import { isFeedbackRole } from "./ports";
import type { FeedbackAnalysis } from "./feedback";
import { analyseFeedback } from "./feedback";
import {
  ASSET_PARAM_KEY,
  MASK_PARAM_KEY,
  PALETTE_PARAM_KEY,
  contentHash,
  paletteDigest,
} from "./hash";
import { maskDigest, maskNeedsImage, maskProblem } from "./mask";
import type { NodeAssets } from "./assets";
import { GraphError, expect } from "./errors";

/**
 * Where a buffer a node reads comes from.
 *
 * `batch` exists so the GPU layer can tell an input it is about to produce
 * itself, inside the submission it is already encoding, from one it has to look
 * up. Without the distinction it would have to guess, and guessing wrong is
 * either a redundant copy or a read of a texture that has not been written yet.
 */
export type InputOrigin =
  /** The decoded source image. */
  | { readonly kind: "source" }
  /** Produced by an earlier node in this same GPU submission. */
  | { readonly kind: "batch"; readonly nodeId: string }
  /** Produced by an earlier step, or restored from the cache. Residency is guaranteed by the renderer. */
  | { readonly kind: "step"; readonly nodeId: string };

export interface ResolvedInput {
  readonly port: InputPort;
  readonly origin: InputOrigin;
}

/**
 * Per-node opacity and blend (F-ST-03).
 *
 * Against the node's own `in` input, never against "the layer below" — a stack
 * node is a filter, not a layer, so 50% of a blur is half-blurred rather than
 * blurred over whatever happened to precede it in the panel.
 *
 * `null` on a node at full opacity in normal blend, where the composite is the
 * identity and running it would be a full-resolution copy for nothing.
 *
 * The arithmetic is in `blend.ts`, and each backend applies it in its own
 * execution kind — `gpu/composite.ts` for the parallel half, `blend.ts`'s own
 * `compositeLinearSurface` for the serial one — so a composite never costs a
 * boundary crossing.
 */
export interface CompositeOp {
  readonly opacity: number;
  readonly blend: BlendMode;
  /**
   * Spatially-varying opacity (F-PP-08), or `null` on an unmasked node.
   *
   * It rides on the composite rather than being a step of its own because that
   * is what it *is*: the coverage multiplies `opacity` per pixel, so a masked
   * node costs the same one dispatch an unmasked composited node costs and
   * needs no extra buffer. See `graph/mask.ts`.
   */
  readonly mask: NodeMask | null;
}

export interface PlannedNode {
  readonly node: GraphNode;
  readonly hash: ContentHash;
  readonly execution: ExecutionKind;
  readonly descriptor: EffectDescriptor;
  /** In {@link PORT_ORDER}. `in` is always present; `mask` only when wired. */
  readonly inputs: readonly ResolvedInput[];
  readonly composite: CompositeOp | null;
  /**
   * True when this node's output may not enter the content-hash cache — it
   * reads its own previous frame, or something upstream of it does.
   *
   * Carried on the planned node rather than looked up by the renderer so the
   * decision is made once, in the one place that has the topology, and so a
   * reader of a plan can see which part of it is re-rendering every frame. See
   * `graph/feedback.ts`.
   */
  readonly cacheable: boolean;
}

/**
 * One unit of work.
 *
 * A `gpu-batch` is a maximal run of consecutive parallel nodes and becomes one
 * `queue.submit`. A `wasm-node` is a single serial kernel; error diffusion
 * cannot be batched with anything, which is the constraint the whole renderer
 * is shaped around.
 */
export type PlanStep =
  | { readonly kind: "gpu-batch"; readonly label: string; readonly nodes: readonly PlannedNode[] }
  | { readonly kind: "wasm-node"; readonly node: PlannedNode };

/** A node the cache already has; read rather than run. */
export interface SeededNode {
  readonly nodeId: string;
  readonly hash: ContentHash;
  readonly effect: string;
  readonly execution: ExecutionKind;
}

export interface RenderPlan {
  readonly steps: readonly PlanStep[];
  /** Cache-satisfied nodes the steps read. Pinned before anything runs. */
  readonly seeded: readonly SeededNode[];
  readonly outputOrigin: InputOrigin;
  readonly outputHash: ContentHash;
  readonly executedNodes: number;
  readonly gpuBatches: number;
  /** Disabled node ids, wired out of the graph (F-ST-02). */
  readonly passthrough: readonly string[];
  /**
   * Executed nodes whose output will not be cached, in scheduling order.
   *
   * Empty for every document with no feedback node in it, which is every
   * document the catalogue could express before this existed. When it is not
   * empty the renderer logs it, because "the tail of this stack re-renders on
   * every frame" is a cost that should be readable rather than mysterious.
   */
  readonly uncached: readonly string[];
  /**
   * How many GPU/CPU crossings this shape implies at minimum: one readback
   * before each serial node fed by the GPU, one upload before each GPU batch
   * fed by the CPU. The renderer counts what actually happened; this is what
   * the shape of the stack costs before anything runs.
   */
  readonly projectedCrossings: number;
}

/**
 * A graph with its topology and hashes computed.
 *
 * Separated from rendering because an animated export prepares every frame up
 * front to find which nodes never move, and re-deriving all of that inside the
 * per-frame render would throw that answer away N times.
 */
export interface PreparedGraph {
  readonly graph: RenderGraph;
  readonly topology: GraphTopology;
  /** Every node, including disabled ones, which carry their input's hash. */
  readonly hashes: ReadonlyMap<string, ContentHash>;
  readonly inputs: ReadonlyMap<string, readonly ResolvedInput[]>;
  /** Where each node id's output really comes from, disabled nodes resolved away. */
  readonly origins: ReadonlyMap<string, InputOrigin>;
  readonly outputOrigin: InputOrigin;
  readonly outputHash: ContentHash;
  readonly sourceHash: ContentHash;
  readonly palette: Palette;
  /**
   * Which nodes read their own previous frame, and which may therefore not be
   * cached. See `graph/feedback.ts`.
   *
   * Computed here rather than at render time because an animated export
   * prepares every frame up front, and the answer is a property of the graph's
   * shape — the same on every frame — so deriving it per frame would be N
   * copies of one fact.
   */
  readonly feedback: FeedbackAnalysis;
}

const SOURCE_ORIGIN: InputOrigin = { kind: "source" };

/**
 * Hash a graph and resolve its wiring.
 *
 * The palette digest is folded into the hash of nodes that consume the palette
 * — the ones that quantize or read the index map — and nowhere else.
 * Downstream nodes pick the change up for free through their input hashes, so
 * a palette edit invalidates exactly the dither node and what follows it, and
 * leaves the preprocessing before it alone. Folding it into every node instead
 * would re-run a blur on every drag of the palette editor.
 *
 * `assets` is the same idea for the other thing that changes a node's pixels
 * without being one of its parameters: bulk data the document carries for one
 * node — F-PP-07's uploaded threshold image. Its digest is folded into that
 * node's hash and nowhere else, so replacing the image invalidates that node
 * and everything after it. Omitting the argument is the ordinary case: no node
 * in the catalogue carries an asset today, and a document with none hashes
 * exactly as it did before this parameter existed.
 */
export function prepareGraph(
  graph: RenderGraph,
  sourceHash: ContentHash,
  palette: Palette,
  effects: ReadonlyMap<string, EffectDescriptor>,
  assets?: NodeAssets,
): PreparedGraph {
  const topology = analyseGraph(graph, effects);
  const digest = paletteDigest(palette);

  const hashes = new Map<string, ContentHash>();
  const inputs = new Map<string, readonly ResolvedInput[]>();
  const origins = new Map<string, InputOrigin>();

  /** The edge on `port`, or the source for an unwired `in`, or nothing. */
  const declaredOrigin = (node: GraphNode, port: InputPort): InputOrigin | null => {
    for (const input of node.inputs) {
      if (input.port === port) return resolveOrigin(input.from.nodeId);
    }
    // A node with no `in` edge is a root and reads the decoded image. A node
    // with no `mask` edge simply is not masked.
    return port === "in" ? SOURCE_ORIGIN : null;
  };

  /** A node id, resolved past any disabled nodes to whatever really produces the pixels. */
  const resolveOrigin = (nodeId: string): InputOrigin => {
    const cached = origins.get(nodeId);
    if (cached !== undefined) return cached;
    const node = expect(
      topology.byId.get(nodeId),
      "unknown-node",
      `node ${nodeId} is not in the graph`,
      { nodeId },
    );
    const origin: InputOrigin = node.enabled
      ? { kind: "step", nodeId }
      : expect(
          declaredOrigin(node, "in"),
          "invariant",
          `disabled node ${nodeId} has no input to pass through`,
          { nodeId },
        );
    origins.set(nodeId, origin);
    return origin;
  };

  const hashOf = (origin: InputOrigin): ContentHash =>
    origin.kind === "source"
      ? sourceHash
      : expect(
          hashes.get(origin.nodeId),
          "invariant",
          `hash for ${origin.nodeId} was read before it was computed; the topological order is wrong`,
          { nodeId: origin.nodeId },
        );

  for (const nodeId of topology.order) {
    const node = expect(topology.byId.get(nodeId), "invariant", `node ${nodeId} missing`);
    const descriptor = expect(
      topology.descriptors.get(nodeId),
      "invariant",
      `descriptor for ${nodeId} missing`,
    );
    const ports = expect(topology.ports.get(nodeId), "invariant", `ports for ${nodeId} missing`);

    // Port order comes from the descriptor, so it is a property of the code
    // rather than of however a document happened to list its edges — which is
    // what `ContentHashInput.inputs` means by "in port order". A **feedback**
    // port is skipped: the previous frame comes out of the frame store, not out
    // of a buffer the plan resolves, and folding a hash for it would be a hash
    // of the node's own output before it exists.
    const resolved: ResolvedInput[] = [];
    for (const port of ports) {
      if (isFeedbackRole(port.role)) continue;
      const origin = declaredOrigin(node, port.key);
      if (origin !== null) resolved.push({ port: port.key, origin });
    }
    inputs.set(nodeId, resolved);

    if (!node.enabled) {
      // Wired out of the graph: same hash as what it passes through, so
      // toggling it costs nothing in either direction.
      hashes.set(nodeId, hashOf(resolveOrigin(nodeId)));
      continue;
    }

    const usesPalette = descriptor.producesIndexMap || descriptor.requiresIndexMap;
    const assetDigest = assets?.digestOf(nodeId) ?? null;
    const mask = node.mask ?? null;
    const params =
      usesPalette || assetDigest !== null || mask !== null
        ? {
            ...node.params,
            ...(usesPalette ? { [PALETTE_PARAM_KEY]: digest } : {}),
            ...(assetDigest === null ? {} : { [ASSET_PARAM_KEY]: assetDigest }),
            ...(mask === null ? {} : { [MASK_PARAM_KEY]: maskDigest(mask) }),
          }
        : node.params;

    hashes.set(
      nodeId,
      contentHash({
        effect: node.effect,
        params,
        seed: node.seed,
        opacity: node.opacity,
        blend: node.blend,
        inputs: resolved.map((input) => hashOf(input.origin)),
        width: graph.width,
        height: graph.height,
      }),
    );
    origins.set(nodeId, { kind: "step", nodeId });
  }

  const outputOrigin = resolveOrigin(graph.output.nodeId);

  return {
    graph,
    topology,
    hashes,
    inputs,
    origins,
    outputOrigin,
    outputHash: hashOf(outputOrigin),
    sourceHash,
    palette,
    feedback: analyseFeedback(topology),
  };
}

/**
 * Decide what runs, and coalesce the parallel runs.
 *
 * `isCached` is a predicate rather than the cache itself so planning cannot
 * disturb the LRU order it is reading, and so the decision is testable without
 * a GPU, a WASM module or a megabyte of pixels.
 */
export function planRender(
  prepared: PreparedGraph,
  isCached: (hash: ContentHash) => boolean,
): RenderPlan {
  const { topology, hashes, inputs, outputOrigin, feedback } = prepared;

  /**
   * Whether a node's output may come from, or go into, the cache.
   *
   * The one place the exclusion enters the backward walk, and it has to be
   * here rather than only at the point of storage: a node downstream of
   * feedback whose hash happened to be resident — from a render before the
   * feedback node was added, or from a sibling branch — would end the walk and
   * be served pixels from a different frame. Consulted before `isCached` so a
   * stale entry cannot even be looked at.
   */
  const cacheable = (nodeId: string): boolean => !feedback.excluded.has(nodeId);

  // Backwards from the output. A node the cache already holds ends the walk:
  // its inputs cannot change what it produces, so nothing upstream re-runs.
  const needed = new Set<string>();
  const satisfied = new Set<string>();
  const pending: InputOrigin[] = [outputOrigin];

  while (pending.length > 0) {
    const origin = expect(pending.pop(), "invariant", "walk stack emptied unexpectedly");
    if (origin.kind === "source") continue;
    const nodeId = origin.nodeId;
    if (needed.has(nodeId)) continue;
    needed.add(nodeId);

    const hash = expect(
      hashes.get(nodeId),
      "invariant",
      `node ${nodeId} has no hash`,
      { nodeId },
    );
    if (cacheable(nodeId) && isCached(hash)) {
      satisfied.add(nodeId);
      continue;
    }
    for (const input of expect(inputs.get(nodeId), "invariant", `node ${nodeId} has no inputs`)) {
      pending.push(input.origin);
    }
  }

  const seeded: SeededNode[] = [];
  const running: string[] = [];
  const passthrough: string[] = [];

  for (const nodeId of topology.order) {
    const node = expect(topology.byId.get(nodeId), "invariant", `node ${nodeId} missing`);
    if (!node.enabled) {
      passthrough.push(nodeId);
      continue;
    }
    if (!needed.has(nodeId)) continue;
    if (satisfied.has(nodeId)) {
      seeded.push({
        nodeId,
        hash: expect(hashes.get(nodeId), "invariant", `node ${nodeId} has no hash`),
        effect: node.effect,
        execution: expect(
          topology.execution.get(nodeId),
          "invariant",
          `node ${nodeId} has no execution kind`,
        ),
      });
      continue;
    }
    running.push(nodeId);
  }

  // Coalescing. Walking the scheduling order and grouping maximal runs of `gpu`
  // nodes is safe by construction: every dependency of a node appears before
  // it, so a dependency inside the same batch was already encoded, and WebGPU
  // orders compute passes within one command buffer.
  const steps: PlanStep[] = [];
  let batch: PlannedNode[] = [];
  let batchIndex = 0;
  const batchMembers = new Set<string>();

  const plannedOf = (nodeId: string, inBatch: ReadonlySet<string>): PlannedNode => {
    const node = expect(topology.byId.get(nodeId), "invariant", `node ${nodeId} missing`);
    const resolved = expect(inputs.get(nodeId), "invariant", `node ${nodeId} has no inputs`);
    const descriptor = expect(
      topology.descriptors.get(nodeId),
      "invariant",
      `node ${nodeId} has no descriptor`,
    );
    return {
      node,
      hash: expect(hashes.get(nodeId), "invariant", `node ${nodeId} has no hash`),
      execution: expect(
        topology.execution.get(nodeId),
        "invariant",
        `node ${nodeId} has no execution kind`,
      ),
      descriptor,
      inputs: resolved.map((input) => ({
        port: input.port,
        origin:
          input.origin.kind === "step" && inBatch.has(input.origin.nodeId)
            ? { kind: "batch" as const, nodeId: input.origin.nodeId }
            : input.origin,
      })),
      composite: compositeOf(node, descriptor, resolved),
      cacheable: cacheable(nodeId),
    };
  };

  const closeBatch = (): void => {
    if (batch.length === 0) return;
    const first = expect(batch[0], "invariant", "an open batch held no nodes");
    const last = expect(batch[batch.length - 1], "invariant", "an open batch held no nodes");
    steps.push({
      kind: "gpu-batch",
      label:
        batch.length === 1
          ? `gpu#${batchIndex} ${first.node.id}`
          : `gpu#${batchIndex} ${first.node.id}..${last.node.id} (${batch.length} nodes)`,
      nodes: batch,
    });
    batchIndex += 1;
    batch = [];
    batchMembers.clear();
  };

  for (const nodeId of running) {
    const kind = expect(
      topology.execution.get(nodeId),
      "invariant",
      `node ${nodeId} has no execution kind`,
    );
    if (kind === "gpu") {
      // Resolved against the batch as it stands, so only nodes already encoded
      // in this submission are marked `batch`.
      batch.push(plannedOf(nodeId, batchMembers));
      batchMembers.add(nodeId);
    } else {
      closeBatch();
      steps.push({ kind: "wasm-node", node: plannedOf(nodeId, new Set()) });
    }
  }
  closeBatch();

  return {
    steps,
    seeded,
    outputOrigin,
    outputHash: prepared.outputHash,
    executedNodes: running.length,
    gpuBatches: steps.filter((step) => step.kind === "gpu-batch").length,
    passthrough,
    uncached: running.filter((nodeId) => !cacheable(nodeId)),
    projectedCrossings: projectCrossings(steps),
  };
}

/**
 * Full opacity in normal blend is the identity composite, so it is `null`
 * rather than a pass that copies a full-resolution buffer onto itself.
 *
 * **A resampling node cannot carry one.** A composite is a node's output
 * blended with its own input, pixel against pixel; a node that writes a
 * different extent than it reads has no pixel-for-pixel correspondence with its
 * input at all, so there is no picture "50% of it" could mean. Refused here,
 * naming the node, rather than at the backend with two textures already
 * allocated — and refused rather than silently ignored, because an opacity
 * slider that has no effect on one node in the stack is precisely the thing
 * this round was for.
 */
function compositeOf(
  node: GraphNode,
  descriptor: EffectDescriptor,
  resolved: readonly ResolvedInput[],
): CompositeOp | null {
  const mask = node.mask ?? null;

  // A mask makes the composite non-identity whatever the opacity is: at full
  // opacity in normal blend an unmasked node emits its own output everywhere,
  // and a masked one emits its input wherever coverage is zero. So the identity
  // shortcut is only available to an unmasked node.
  if (mask === null && node.opacity === 1 && node.blend === "normal") return null;

  if (descriptor.resamples === true) {
    throw new GraphError(
      "unsupported-composite",
      mask === null
        ? `node ${node.id} runs ${descriptor.name}, which writes a different extent than it reads, and asks for opacity ${node.opacity} in blend "${node.blend}"; a composite blends a node's output with its own input pixel for pixel, and those two are different pixel grids`
        : `node ${node.id} runs ${descriptor.name}, which writes a different extent than it reads, and carries a mask; a mask is opacity per pixel and there is no pixel-for-pixel correspondence between this node's output and its own input for the coverage to be of`,
      { nodeId: node.id, effect: node.effect, opacity: node.opacity, blend: node.blend },
    );
  }

  if (mask !== null) {
    // Checked here rather than trusted from the document, because this is the
    // last point before pixels: a mask whose band is empty or whose tolerance
    // is zero renders a node that contributes nothing anywhere, which looks
    // exactly like a broken effect.
    const problem = maskProblem(mask);
    if (problem !== null) {
      throw new GraphError(
        "unsupported-composite",
        `node ${node.id} carries a mask that cannot be evaluated: ${problem}`,
        { nodeId: node.id, effect: node.effect },
      );
    }
    // The two halves of an image mask have to agree. A mask edge with no image
    // mask is an edge that does nothing, and an image mask with no edge is a
    // node asking for coverage from a picture nobody wired — both are refused
    // rather than defaulted to "fully covered", which would be a mask that
    // silently is not one.
    const wired = resolved.some((input) => input.port === MASK_INPUT_PORT);
    if (maskNeedsImage(mask) && !wired) {
      throw new GraphError(
        "unsupported-composite",
        `node ${node.id} takes its coverage from a mask image, and nothing is wired to its "${MASK_INPUT_PORT}" port`,
        { nodeId: node.id, effect: node.effect },
      );
    }
    if (!maskNeedsImage(mask) && wired) {
      throw new GraphError(
        "unsupported-composite",
        `node ${node.id} has a picture wired to its "${MASK_INPUT_PORT}" port but takes its coverage from its own input (${mask.source.kind}); the edge would be read by nothing`,
        { nodeId: node.id, effect: node.effect },
      );
    }
  }

  return { opacity: node.opacity, blend: node.blend, mask };
}

/**
 * Crossings implied by the step shape alone.
 *
 * Every transition between a GPU batch and a serial node is one readback or one
 * upload. This counts the transitions the plan contains; the renderer counts
 * and logs what actually moved, including the crossings a cache hit on the
 * other side of the boundary adds.
 */
function projectCrossings(steps: readonly PlanStep[]): number {
  let crossings = 0;
  let previous: ExecutionKind | null = null;
  for (const step of steps) {
    const kind: ExecutionKind = step.kind === "gpu-batch" ? "gpu" : "wasm";
    if (previous !== null && previous !== kind) crossings += 1;
    previous = kind;
  }
  return crossings;
}

/** Every node in a step, whichever kind it is. */
export function stepNodes(step: PlanStep): readonly PlannedNode[] {
  return step.kind === "gpu-batch" ? step.nodes : [step.node];
}
