/**
 * Which nodes cannot be cached, and why.
 *
 * The node cache is keyed on a **content hash** over a node's parameters, seed,
 * resolution and its inputs' hashes. That is correct because a node is a pure
 * function of those things. A feedback node is not: its output depends on every
 * frame that came before it, and none of that is in the hash. Two frames of a
 * playing loop produce the *same* hash at a feedback node and different pixels,
 * so a cache that accepted it would serve frame 3's picture for frame 40 and
 * report a hit while doing it.
 *
 * Decision 1 of `docs/dither-ork-node-graph.md`, taken and not to be
 * relitigated: **the feedback node and everything downstream of it are excluded
 * from the content-hash cache, and feedback keeps its own frame store.** The
 * cache stays a cache of pure functions, which is the property that makes it
 * correct at all.
 *
 * Two things follow, and both are the point:
 *
 * - **Downstream too, not just the node.** A node reading a feedback node has a
 *   hash that folds in the feedback node's hash — which does not move — so it
 *   would be a hit on every frame while its input changed underneath it. The
 *   exclusion is therefore transitive over the whole reachable set.
 * - **Upstream is untouched.** Everything before the feedback node is still a
 *   pure function of the document and still caches exactly as it did. In the
 *   stack a person actually builds — a few preprocess nodes, a dither, then
 *   feedback near the end — that is most of the work, and it is why the honest
 *   option costs so much less than it sounds like.
 *
 * The cost is real and is logged rather than left to be discovered: the
 * excluded subgraph re-renders every frame, which is what a real-time tool does
 * anyway.
 *
 * Pure — no cache, no device, no registry lookups beyond the descriptors it is
 * handed — so the rule can be read and tested as set arithmetic.
 */

import type { EffectDescriptor } from "../types/registry";
import type { GraphTopology } from "./topology";
import { expect } from "./errors";

export interface FeedbackAnalysis {
  /** Nodes whose effect declares `readsFeedback`, in scheduling order. */
  readonly feedbackNodes: readonly string[];
  /**
   * Every node that may not be cached: the feedback nodes and everything
   * reachable from them. In scheduling order, so a log line reads as the tail
   * of the stack rather than as an unordered set.
   */
  readonly excluded: ReadonlySet<string>;
  /** Same set, in scheduling order, for logging and reporting. */
  readonly excludedOrder: readonly string[];
}

const NONE: FeedbackAnalysis = {
  feedbackNodes: [],
  excluded: new Set(),
  excludedOrder: [],
};

/** True when this descriptor's node reads its own previous frame. */
export function readsFeedback(descriptor: EffectDescriptor): boolean {
  return descriptor.readsFeedback === true;
}

/**
 * Whether a document's stack contains a feedback node.
 *
 * Takes stack nodes rather than a compiled graph, so the timeline, the seam
 * validator and the export dialog can ask the question before anything is
 * compiled. A **disabled** feedback node does not count: `prepareGraph` wires a
 * disabled node out of the graph entirely and it never runs, so it neither
 * reads a history nor stops the document looping.
 */
export function stackReadsFeedback(
  nodes: readonly { readonly effect: string; readonly enabled: boolean }[],
  effects: ReadonlyMap<string, EffectDescriptor>,
): boolean {
  return nodes.some((node) => {
    if (!node.enabled) return false;
    const descriptor = effects.get(node.effect);
    return descriptor !== undefined && readsFeedback(descriptor);
  });
}

/**
 * The excluded set for one compiled graph.
 *
 * A disabled feedback node is skipped for the reason above. Reachability is
 * computed forwards over the declared edges rather than backwards from the
 * output, because a node that is downstream of feedback but *not* reachable
 * from the output is still downstream of feedback — it just is not rendered
 * this time, and soloing past it must not make it cacheable.
 */
export function analyseFeedback(topology: GraphTopology): FeedbackAnalysis {
  const feedbackNodes: string[] = [];
  for (const nodeId of topology.order) {
    const node = expect(topology.byId.get(nodeId), "invariant", `node ${nodeId} missing`);
    if (!node.enabled) continue;
    const descriptor = expect(
      topology.descriptors.get(nodeId),
      "invariant",
      `descriptor for ${nodeId} missing`,
    );
    if (readsFeedback(descriptor)) feedbackNodes.push(nodeId);
  }

  if (feedbackNodes.length === 0) return NONE;

  // Forward edges, built once. `topology` carries each node's inputs, not its
  // consumers, and walking the whole node list per feedback node would be
  // quadratic on a stack that is long precisely because somebody is building
  // something elaborate.
  const consumers = new Map<string, string[]>();
  for (const nodeId of topology.order) {
    const node = expect(topology.byId.get(nodeId), "invariant", `node ${nodeId} missing`);
    for (const input of node.inputs) {
      const from = input.from.nodeId;
      const list = consumers.get(from);
      if (list === undefined) consumers.set(from, [nodeId]);
      else list.push(nodeId);
    }
  }

  const excluded = new Set<string>();
  const pending = [...feedbackNodes];
  while (pending.length > 0) {
    const nodeId = expect(pending.pop(), "invariant", "walk stack emptied unexpectedly");
    if (excluded.has(nodeId)) continue;
    excluded.add(nodeId);
    for (const consumer of consumers.get(nodeId) ?? []) pending.push(consumer);
  }

  return {
    feedbackNodes,
    excluded,
    excludedOrder: topology.order.filter((nodeId) => excluded.has(nodeId)),
  };
}
