/**
 * Graph topology: validation, cycle detection and scheduling order.
 *
 * The document's stack is linear today, and this module could have been a loop
 * over an array. It is a DAG walk instead because node groups (F-ST-05) and
 * node masking (F-PP-08) both introduce a second input edge, and retrofitting a
 * topological sort onto a renderer that assumed a list is a rewrite of
 * everything downstream of it. The cost of being general here is one Kahn loop.
 *
 * The ordering is not just *a* valid order. Consecutive parallel nodes are
 * coalesced into a single GPU submission, and every switch between the serial
 * WASM path and the parallel GPU path costs a readback plus an upload — the
 * performance ceiling named in docs/ARCHITECTURE.md. Where the DAG leaves a
 * choice, this picks the ready node whose execution kind matches the one just
 * scheduled, which keeps GPU runs together and so keeps the crossing count
 * down. On today's linear stack the preference never fires; on a masked or
 * grouped stack it is the difference between two crossings and six.
 */

import type { EffectDescriptor, ExecutionKind } from "../types/registry";
import type { GraphNode, InputPort, RenderGraph } from "../types/graph";
import { GraphError, expect } from "./errors";

/**
 * Port evaluation order.
 *
 * `ContentHashInput.inputs` is specified as "in port order", so that order has
 * to be a property of the code rather than of however the document happened to
 * list a node's edges — otherwise two identical documents hash differently.
 */
export const PORT_ORDER: readonly InputPort[] = ["in", "mask"];

export interface GraphTopology {
  readonly byId: ReadonlyMap<string, GraphNode>;
  /** Node ids in scheduling order. Every node's inputs appear before it. */
  readonly order: readonly string[];
  readonly execution: ReadonlyMap<string, ExecutionKind>;
  readonly descriptors: ReadonlyMap<string, EffectDescriptor>;
}

/**
 * Validate the graph and produce its scheduling order.
 *
 * Everything that can be wrong with a compiled graph is rejected here, loudly
 * and with the offending ids named: a cycle, an edge to a node that is not in
 * the graph, two nodes sharing an id, a node wired to the same port twice, an
 * effect the registry does not know. None of these is a condition to branch on
 * at render time — each one means the document or the compiler that produced
 * the graph is broken, and a renderer that limped past them would produce a
 * plausible wrong image instead of a message naming the problem.
 */
export function analyseGraph(
  graph: RenderGraph,
  effects: ReadonlyMap<string, EffectDescriptor>,
): GraphTopology {
  const byId = new Map<string, GraphNode>();
  const execution = new Map<string, ExecutionKind>();
  const descriptors = new Map<string, EffectDescriptor>();

  for (const node of graph.nodes) {
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
  }

  if (!byId.has(graph.output.nodeId)) {
    throw new GraphError(
      "unknown-node",
      `the graph output names node ${graph.output.nodeId}, which is not in the graph`,
      { nodeId: graph.output.nodeId },
    );
  }

  // Kahn's algorithm. `consumers` keeps duplicates on purpose: a node wired to
  // another through both `in` and `mask` contributes two to that node's
  // in-degree and must decrement it twice.
  const consumers = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of graph.nodes) {
    consumers.set(node.id, []);
    indegree.set(node.id, 0);
  }

  for (const node of graph.nodes) {
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

      const producer = input.from.nodeId;
      if (!byId.has(producer)) {
        throw new GraphError(
          "unknown-node",
          `node ${node.id} reads ${producer} on its ${input.port} port, and ${producer} is not in the graph`,
          { nodeId: node.id, port: input.port, from: producer },
        );
      }
      expect(consumers.get(producer), "invariant", "consumer list missing").push(node.id);
      indegree.set(node.id, expect(indegree.get(node.id), "invariant", "in-degree missing") + 1);
    }
  }

  const ready: string[] = [];
  for (const node of graph.nodes) {
    if (indegree.get(node.id) === 0) ready.push(node.id);
  }

  const order: string[] = [];
  let preferred: ExecutionKind | null = null;

  while (ready.length > 0) {
    let pick = 0;
    if (preferred !== null) {
      const matching = ready.findIndex((id) => execution.get(id) === preferred);
      if (matching >= 0) pick = matching;
    }
    const id = expect(ready.splice(pick, 1)[0], "invariant", "ready queue was empty after a length check");
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
      if (left === 0) ready.push(consumer);
    }
  }

  if (order.length !== graph.nodes.length) {
    const stuck = graph.nodes
      .filter((node) => (indegree.get(node.id) ?? 0) > 0)
      .map((node) => node.id);
    throw new GraphError(
      "cycle",
      `the graph is not acyclic; ${stuck.length} node(s) could not be ordered: ${stuck.join(", ")}`,
      { nodes: stuck.join(","), ordered: order.length, total: graph.nodes.length },
    );
  }

  return { byId, order, execution, descriptors };
}

/**
 * Solo, or render-up-to (F-ST-02).
 *
 * Solo is not a mode the renderer has: it is the same graph with its output
 * moved upstream. Everything else — which nodes are required, which are
 * reused from the cache — falls out of the backward walk from the output, so
 * soloing a node mid-stack costs nothing and re-uses every cached buffer
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
