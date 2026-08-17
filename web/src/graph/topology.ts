/**
 * Graph topology: validation, cycle detection and scheduling order.
 *
 * The stack used to be a list and this could have been a loop over an array. It
 * is a DAG walk because masking (F-PP-08), blending two chains and displacing
 * one picture by another all need a second image edge — and because a feedback
 * edge makes a *cycle*, which is the one thing a topological sort is normally
 * built to refuse.
 *
 * ## Cycles are legal now, and only feedback edges may make them
 *
 * "No cycles" was an invariant. It is now a property that exactly one kind of
 * edge may violate: an edge into a port whose declared role is `feedback` reads
 * the producer's **previous frame**, so it creates no dependency within the
 * frame being rendered and cannot deadlock the order. Every other cycle is
 * still refused, naming the nodes, because a graph that cannot render must be
 * impossible to build rather than an error discovered at render time.
 *
 * Mechanically that is one line — a feedback edge contributes nothing to
 * in-degree — and the consequence is exact: Kahn's algorithm runs on the
 * feedback-free subgraph, so a remaining cycle is a cycle of ordinary edges and
 * the existing refusal is unchanged.
 *
 * The limit is stated where it bites, in `derivedFeedbackPorts`: the only
 * feedback edge that exists is a node reading **its own** previous output,
 * because the frame store is keyed by node id and records that node's own
 * composited result. A general delay edge — B reading A's previous frame —
 * would need a history for A that nothing keeps, so it is refused here rather
 * than accepted and then rendered from pixels nobody wrote.
 *
 * ## The order is deterministic, and that is a guarantee rather than an accident
 *
 * A DAG has no single topological order. The project guarantees the same
 * document gives the same picture, and the node cache is keyed on hashes that
 * fold in input hashes — so an order that varied between runs would vary the
 * *plan*, the batching and the boundary crossings, and would do it silently.
 *
 * Two rules, applied in this order, and neither consults an object's iteration
 * order:
 *
 * 1. **Prefer the execution kind just scheduled.** Every switch between the
 *    serial WASM path and the parallel GPU path costs a readback plus an upload
 *    — the performance ceiling named in docs/ARCHITECTURE.md — so keeping GPU
 *    runs together is the difference between two crossings and six on a graph
 *    with branches.
 * 2. **Then the node's position in `graph.nodes`.** A total order over the
 *    ready set, taken from the document's own list, which is data rather than
 *    an iteration accident. A `Set` or `Map` insertion order would *also* be
 *    deterministic today, which is precisely why relying on it is dangerous:
 *    it is deterministic for reasons nobody wrote down and a refactor is free
 *    to change it.
 */

import type { EffectDescriptor, ExecutionKind, InputPortDescriptor } from "../types/registry";
import type { GraphNode, InputPort, RenderGraph } from "../types/graph";
import { GraphError, expect } from "./errors";
import { isFeedbackRole, portsOf } from "./ports";

export interface GraphTopology {
  readonly byId: ReadonlyMap<string, GraphNode>;
  /**
   * Node ids in scheduling order. Every node's inputs appear before it, except
   * across a feedback edge, which by definition reads a frame that is already
   * finished.
   */
  readonly order: readonly string[];
  readonly execution: ReadonlyMap<string, ExecutionKind>;
  readonly descriptors: ReadonlyMap<string, EffectDescriptor>;
  /** Each node's ports, resolved once. See `graph/ports.ts`. */
  readonly ports: ReadonlyMap<string, readonly InputPortDescriptor[]>;
  /**
   * Edges that close a loop: `nodeId -> the ports of that node fed by a
   * feedback edge`. Empty for every document with no feedback node in it.
   *
   * Reported rather than left to be recomputed, because three readers want it
   * and each would derive it slightly differently: the planner skips these
   * ports, the editor draws them as a loop, and the validator uses them to
   * explain why one cycle is legal and another is not.
   */
  readonly feedbackPorts: ReadonlyMap<string, readonly string[]>;
}

/**
 * Validate the graph and produce its scheduling order.
 *
 * Everything that can be wrong with a compiled graph is rejected here, loudly
 * and with the offending ids named: a cycle of ordinary edges, an edge to a
 * node that is not in the graph, an edge to a port the node does not declare, a
 * feedback edge from anything but the node itself, two nodes sharing an id, a
 * node wired to the same port twice, an effect the registry does not know. None
 * of these is a condition to branch on at render time — each one means the
 * document or the compiler that produced the graph is broken, and a renderer
 * that limped past them would produce a plausible wrong image instead of a
 * message naming the problem.
 */
export function analyseGraph(
  graph: RenderGraph,
  effects: ReadonlyMap<string, EffectDescriptor>,
): GraphTopology {
  const byId = new Map<string, GraphNode>();
  const execution = new Map<string, ExecutionKind>();
  const descriptors = new Map<string, EffectDescriptor>();
  const ports = new Map<string, readonly InputPortDescriptor[]>();
  /** Position in `graph.nodes`: the deterministic tie-break. */
  const position = new Map<string, number>();

  for (const [index, node] of graph.nodes.entries()) {
    if (byId.has(node.id)) {
      throw new GraphError(
        "duplicate-node-id",
        `node id ${node.id} appears twice; edges to it would be ambiguous`,
        { nodeId: node.id },
      );
    }
    const descriptor = effects.get(node.effect);
    if (descriptor === undefined) {
      throw new GraphError(
        "unknown-effect",
        `node ${node.id} names effect ${node.effect}, which the registry does not have`,
        { nodeId: node.id, effect: node.effect },
      );
    }
    byId.set(node.id, node);
    execution.set(node.id, descriptor.execution);
    descriptors.set(node.id, descriptor);
    ports.set(node.id, portsOf(descriptor));
    position.set(node.id, index);
  }

  if (!byId.has(graph.output.nodeId)) {
    throw new GraphError(
      "unknown-node",
      `the graph output names node ${graph.output.nodeId}, which is not in the graph`,
      { nodeId: graph.output.nodeId },
    );
  }

  // Kahn's algorithm over the **feedback-free** subgraph. `consumers` keeps
  // duplicates on purpose: a node wired to another through two ports
  // contributes two to that node's in-degree and must decrement it twice.
  const consumers = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const feedbackPorts = new Map<string, string[]>();
  for (const node of graph.nodes) {
    consumers.set(node.id, []);
    indegree.set(node.id, 0);
  }

  for (const node of graph.nodes) {
    const declared = expect(ports.get(node.id), "invariant", `ports for ${node.id} missing`);

    // The feedback loop, derived from the descriptor rather than read off the
    // graph. A node whose effect declares a `feedback` port reads its own
    // previous output, and where that comes from is a fact about the effect —
    // the frame store is keyed by node id and records that node's own
    // composited result — so no document, and no graph compiler, has any say in
    // it. Recording it here is what makes the loop visible to the cycle rule,
    // to an editor drawing the graph, and to a reader of a topology, without
    // anything upstream having to invent an edge. See `graph/ports.ts`.
    for (const port of declared) {
      if (!isFeedbackRole(port.role)) continue;
      const existing = feedbackPorts.get(node.id);
      if (existing === undefined) feedbackPorts.set(node.id, [port.key]);
      else if (!existing.includes(port.key)) existing.push(port.key);
    }

    const seen = new Set<InputPort>();
    for (const input of node.inputs) {
      if (seen.has(input.port)) {
        throw new GraphError(
          "duplicate-port",
          `node ${node.id} is wired to its ${input.port} port twice`,
          { nodeId: node.id, port: input.port },
        );
      }
      seen.add(input.port);

      const port = declared.find((candidate) => candidate.key === input.port);
      if (port === undefined) {
        throw new GraphError(
          "unknown-port",
          `node ${node.id} is wired to a port "${input.port}", which ${node.effect} does not declare; its ports are ${declared.map((p) => p.key).join(", ") || "(none)"}`,
          { nodeId: node.id, port: input.port, effect: node.effect },
        );
      }

      const producer = input.from.nodeId;
      if (!byId.has(producer)) {
        throw new GraphError(
          "unknown-node",
          `node ${node.id} reads ${producer} on its ${input.port} port, and ${producer} is not in the graph`,
          { nodeId: node.id, port: input.port, from: producer },
        );
      }

      if (isFeedbackRole(port.role)) {
        // The one edge that may close a loop, and the one that contributes no
        // ordering constraint: it reads a frame that finished before this one
        // began. Its producer must be the node itself — see `graph/ports.ts`
        // for why nothing else has a history to read.
        if (producer !== node.id) {
          throw new GraphError(
            "unsupported-feedback",
            `node ${node.id} reads ${producer} on its feedback port "${input.port}"; a feedback edge reads the previous frame out of the frame store, and the store is keyed by node id and records each node's own composited output — so the only previous frame that exists is the node's own. Wire ${producer} into an ordinary port instead.`,
            { nodeId: node.id, port: input.port, from: producer },
          );
        }
        // Already recorded from the descriptor above; an explicit edge simply
        // restates it, and restating it with the wrong producer is refused.
        continue;
      }

      expect(consumers.get(producer), "invariant", "consumer list missing").push(node.id);
      indegree.set(node.id, expect(indegree.get(node.id), "invariant", "in-degree missing") + 1);
    }
  }

  // The ready set as an array kept in document order. Selection below is a
  // scan, not a pop: see the header on why the tie-break is data rather than
  // insertion order.
  const ready: string[] = [];
  const insertReady = (nodeId: string): void => {
    const at = expect(position.get(nodeId), "invariant", `position for ${nodeId} missing`);
    let index = 0;
    while (
      index < ready.length &&
      expect(position.get(ready[index] ?? ""), "invariant", "position missing") < at
    ) {
      index += 1;
    }
    ready.splice(index, 0, nodeId);
  };

  for (const node of graph.nodes) {
    if (indegree.get(node.id) === 0) insertReady(node.id);
  }

  const order: string[] = [];
  let preferred: ExecutionKind | null = null;

  while (ready.length > 0) {
    // Rule 1 then rule 2: the first ready node matching the preferred execution
    // kind, and `ready` is in document order, so "first" is the lowest
    // position. With no preference the first entry is the lowest position too.
    let pick = 0;
    if (preferred !== null) {
      const matching = ready.findIndex((id) => execution.get(id) === preferred);
      if (matching >= 0) pick = matching;
    }
    const id = expect(
      ready.splice(pick, 1)[0],
      "invariant",
      "ready queue was empty after a length check",
    );
    order.push(id);

    const node = expect(byId.get(id), "invariant", `node ${id} vanished from the index`);
    // A disabled node never runs, so it neither ends a GPU run nor starts one.
    // Letting it set the preference would break a coalesced batch in half over
    // a node that costs nothing.
    if (node.enabled) {
      preferred = expect(execution.get(id), "invariant", `execution kind missing for ${id}`);
    }

    for (const consumer of expect(consumers.get(id), "invariant", "consumer list missing")) {
      const left = expect(indegree.get(consumer), "invariant", "in-degree missing") - 1;
      indegree.set(consumer, left);
      if (left === 0) insertReady(consumer);
    }
  }

  if (order.length !== graph.nodes.length) {
    const stuck = graph.nodes
      .filter((node) => (indegree.get(node.id) ?? 0) > 0)
      .map((node) => node.id);
    throw new GraphError(
      "cycle",
      `the graph has a cycle of ordinary edges; ${stuck.length} node(s) could not be ordered: ${stuck.join(", ")}. Only a feedback edge may close a loop, because it reads the previous frame and so imposes no order within this one.`,
      { nodes: stuck.join(","), ordered: order.length, total: graph.nodes.length },
    );
  }

  return {
    byId,
    order,
    execution,
    descriptors,
    ports,
    feedbackPorts: new Map(
      [...feedbackPorts].map(([nodeId, keys]) => [nodeId, keys] as const),
    ),
  };
}

/**
 * Solo, or render-up-to (F-ST-02).
 *
 * Solo is not a mode the renderer has: it is the same graph with its output
 * moved upstream. Everything else — which nodes are required, which are
 * reused from the cache — falls out of the backward walk from the output, so
 * soloing a node mid-graph costs nothing and re-uses every cached buffer
 * already computed for it.
 */
export function renderUpTo(graph: RenderGraph, nodeId: string): RenderGraph {
  if (!graph.nodes.some((node) => node.id === nodeId)) {
    throw new GraphError(
      "unknown-node",
      `cannot render up to ${nodeId}; it is not in the graph`,
      { nodeId },
    );
  }
  return { ...graph, output: { nodeId, port: "out" } };
}
