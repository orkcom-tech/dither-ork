/**
 * The graph grammar, checked before anything is rendered.
 *
 * This replaces stack validation. `stack.ts` used to walk an array and ask
 * "what is live as this node runs"; the answer to that on a DAG is "whatever
 * arrives on its `in` port", so the walk is over a topological order and the
 * state is per node rather than a single running variable. **Every rule the
 * stack validator refused, this refuses** — an index-map consumer with no
 * producer in front of it, a resampler run while an index map is live, an
 * excluded pair — and it adds the ones a graph makes possible: an edge to a
 * node that is not there, an edge to a port the effect does not declare, a
 * cycle, a mask with nothing wired to it, and a document with no output.
 *
 * `stack.ts` keeps `validateStack` as a thin call into this one, so the six
 * modules that still hold a list have not had to change and there is still
 * exactly one implementation of every rule.
 *
 * ## Why this exists rather than a render-time error
 *
 * Unchanged from the stack version, and it is the whole argument. Every
 * dither-slot node in the catalogue emits an index map except one: CMYK
 * halftone (F-PT-02) does not, because its output colours are ink overprints
 * rather than palette entries. Put it under an outline and the graph is not
 * renderable — the pass compiler refuses an `input-index` binding with nothing
 * to bind — and what the user sees is a `ScheduleError` after they have built
 * the thing. The information needed to know that was in the descriptors the
 * whole time. **A graph that cannot render must be impossible to build.**
 *
 * ## Cycles
 *
 * A cycle of ordinary edges is refused here, naming the nodes in it. A cycle
 * closed by a **feedback** edge is legal and is what feedback is — but no
 * document stores one: a feedback edge is derived from the effect's descriptor
 * (`graph/ports.ts`), so a cycle found in a document's own edge list is always
 * the illegal kind. That is why the check below is a plain reachability walk
 * with no feedback special case in it, and it is worth saying out loud because
 * the *compiled* graph does contain such loops and `graph/topology.ts` does
 * have the special case.
 *
 * ## Disabled nodes
 *
 * A disabled node is not in the render (F-ST-02), so it neither produces an
 * index map nor needs one, and every rule about *effects* skips it. Rules about
 * *wiring* do not: an edge into a disabled node is still an edge, and `plan.ts`
 * resolves a disabled node's consumers past it to whatever fed its `in` port,
 * so the wiring has to be sound whether or not the node is switched on.
 */

import { logger } from "../lib/log";
import type { GraphEdge, StackNode } from "../types/document";
import type { EffectDescriptor } from "../types/registry";
import { MASK_INPUT_PORT, PRIMARY_INPUT_PORT } from "../types/registry";
import { maskNeedsImage, maskProblem, portsOf } from "../graph";
import type { EffectRegistry } from "./registry";

const log = logger("app");

/**
 * The part of a node this cares about.
 *
 * Structural rather than the document's `StackNode` so the editor can check a
 * change it has not committed and Surprise Me can check a candidate it has not
 * finished building. A `StackNode` satisfies it as it stands.
 */
export interface GraphNodeRef {
  readonly id: string;
  readonly effect: string;
  readonly enabled: boolean;
  readonly mask?: StackNode["mask"];
}

export interface GraphRef {
  readonly nodes: readonly GraphNodeRef[];
  readonly edges: readonly GraphEdge[];
  /** The node whose output is the picture. `null` only for an empty graph. */
  readonly output: string | null;
}

export type GraphIssueCode =
  /** A node names an effect this build does not have. */
  | "unknown-effect"
  /** Two nodes share an id, so every edge and binding naming it is ambiguous. */
  | "duplicate-node-id"
  /** An edge endpoint, or the output, names a node that is not in the graph. */
  | "unknown-node"
  /** An edge names a port the destination effect does not declare. */
  | "unknown-port"
  /** Two edges into one port. */
  | "duplicate-port"
  /** The edges close a loop. Only a feedback edge may, and none is ever stored. */
  | "cycle"
  /** A required input port has no edge. */
  | "missing-input"
  /** A node reads the index map with no live quantizer upstream of it. */
  | "index-map-missing"
  /**
   * A node resamples colour while an index map is live, and writes no index map
   * of its own — so the two halves of the buffer would name different pixel
   * grids. See `stack.ts` for the argument, which is unchanged.
   */
  | "index-map-resampled"
  /** Two nodes the grammar declares incompatible. */
  | "excluded-combination"
  /** A mask whose numbers cannot produce coverage. */
  | "invalid-mask"
  /** An image mask with no picture wired to it, or a mask edge nothing reads. */
  | "mask-edge-mismatch"
  /** A mask on a node that resamples, which has no grid for coverage to be of. */
  | "mask-on-resampler"
  /** A graph with nodes and no output names no picture. */
  | "no-output";

export interface GraphIssue {
  readonly code: GraphIssueCode;
  readonly nodeId: string;
  readonly effect: string;
  /** The other node the rule is about, when the rule is about two of them. */
  readonly otherNodeId?: string;
  readonly otherEffect?: string;
  /** Names both nodes; written to be shown to a user as it stands. */
  readonly message: string;
}

export interface GraphValidation {
  readonly ok: boolean;
  readonly issues: readonly GraphIssue[];
}

/**
 * Check a graph against the grammar its descriptors declare.
 *
 * Reports rather than repairs, like `validateParams`: the editor turns the
 * issues into a refusal to drop the node, and Surprise Me discards the
 * candidate and draws again. Neither wants a graph silently rewritten under it.
 */
export function validateGraph(registry: EffectRegistry, graph: GraphRef): GraphValidation {
  const issues: GraphIssue[] = [];
  const push = (issue: GraphIssue): void => {
    issues.push(issue);
  };

  // --- identity and effects ---------------------------------------------
  //
  // Resolved first. A node naming an effect this build does not have makes
  // every later verdict a guess — nothing is known about what it produces,
  // reads or takes as input — so the unknown ids are reported alone rather than
  // alongside consequences invented from their absence.
  const descriptors = new Map<string, EffectDescriptor>();
  const byId = new Map<string, GraphNodeRef>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      push({
        code: "duplicate-node-id",
        nodeId: node.id,
        effect: node.effect,
        message: `two nodes share the id "${node.id}"; every edge and every binding naming it would be ambiguous`,
      });
      continue;
    }
    byId.set(node.id, node);
    const descriptor = registry.get(node.effect);
    if (descriptor === undefined) {
      push({
        code: "unknown-effect",
        nodeId: node.id,
        effect: node.effect,
        message: `node ${node.id} names effect "${node.effect}", which this build does not have`,
      });
      continue;
    }
    descriptors.set(node.id, descriptor);
  }
  if (issues.length > 0) {
    log.warn("graph references unknown effects or duplicate ids", {
      nodes: graph.nodes.length,
      issues: issues.length,
    });
    return { ok: false, issues };
  }

  // --- wiring -------------------------------------------------------------

  /** `nodeId -> port -> producing node id`. Built once; every rule below reads it. */
  const wiring = new Map<string, Map<string, string>>();
  for (const node of graph.nodes) wiring.set(node.id, new Map());

  for (const edge of graph.edges) {
    const consumer = byId.get(edge.to);
    const producer = byId.get(edge.from);
    if (consumer === undefined || producer === undefined) {
      const missing = consumer === undefined ? edge.to : edge.from;
      push({
        code: "unknown-node",
        nodeId: consumer === undefined ? edge.from : edge.to,
        effect: (consumer ?? producer)?.effect ?? "<unknown>",
        message: `an edge names node "${missing}", which is not in this document`,
      });
      continue;
    }
    const descriptor = descriptors.get(consumer.id);
    if (descriptor === undefined) continue;

    const port = portsOf(descriptor).find((candidate) => candidate.key === edge.port);
    if (port === undefined) {
      push({
        code: "unknown-port",
        nodeId: consumer.id,
        effect: consumer.effect,
        otherNodeId: producer.id,
        otherEffect: producer.effect,
        message: `${descriptor.name} (node ${consumer.id}) has no "${edge.port}" input; it takes ${portsOf(descriptor).map((p) => p.key).join(", ") || "no image input"}`,
      });
      continue;
    }

    const ports = wiring.get(consumer.id);
    if (ports === undefined) continue;
    const existing = ports.get(edge.port);
    if (existing !== undefined) {
      push({
        code: "duplicate-port",
        nodeId: consumer.id,
        effect: consumer.effect,
        otherNodeId: producer.id,
        otherEffect: producer.effect,
        message: `${descriptor.name} (node ${consumer.id}) has two pictures wired to its "${edge.port}" input, from ${existing} and ${producer.id}; a port carries one`,
      });
      continue;
    }
    ports.set(edge.port, producer.id);
  }

  // Required ports. `in` is never required — an unwired one is a root reading
  // the decoded source, which is what every single-node document is.
  for (const node of graph.nodes) {
    const descriptor = descriptors.get(node.id);
    if (descriptor === undefined || !node.enabled) continue;
    const ports = wiring.get(node.id);
    for (const port of portsOf(descriptor)) {
      if (!port.required || port.role === "feedback") continue;
      if (ports?.has(port.key) === true) continue;
      push({
        code: "missing-input",
        nodeId: node.id,
        effect: node.effect,
        message: `${descriptor.name} (node ${node.id}) needs a picture on its "${port.label}" input and has none: ${port.description}`,
      });
    }
  }

  // --- cycles -------------------------------------------------------------
  //
  // A plain reachability walk, and no feedback special case, for the reason in
  // the header: a feedback edge is derived from the descriptor and never
  // stored, so any loop in a document's own edge list is a loop of ordinary
  // edges. Reported once, from the node the walk closed on.
  for (const node of graph.nodes) {
    if (!reachesItself(graph.edges, node.id)) continue;
    const descriptor = descriptors.get(node.id);
    push({
      code: "cycle",
      nodeId: node.id,
      effect: node.effect,
      message: `${descriptor?.name ?? node.effect} (node ${node.id}) is wired, through one or more edges, back into itself. Only a feedback input may close a loop, because it reads the previous frame rather than this one.`,
    });
  }

  // --- output -------------------------------------------------------------

  if (graph.output === null) {
    if (graph.nodes.length > 0) {
      const first = graph.nodes[0];
      push({
        code: "no-output",
        nodeId: first?.id ?? "<none>",
        effect: first?.effect ?? "<none>",
        message: `this document has ${graph.nodes.length} node(s) and names none of them as its picture; a graph has no last element, so the output has to be chosen`,
      });
    }
  } else if (!byId.has(graph.output)) {
    push({
      code: "unknown-node",
      nodeId: graph.output,
      effect: "<none>",
      message: `this document's picture is node "${graph.output}", which is not in it`,
    });
  }

  // --- masks --------------------------------------------------------------

  for (const node of graph.nodes) {
    const mask = node.mask ?? null;
    const descriptor = descriptors.get(node.id);
    if (descriptor === undefined) continue;
    const wired = wiring.get(node.id)?.has(MASK_INPUT_PORT) === true;

    if (mask === null) {
      if (wired) {
        push({
          code: "mask-edge-mismatch",
          nodeId: node.id,
          effect: node.effect,
          message: `${descriptor.name} (node ${node.id}) has a picture wired to its mask input and no mask set, so the edge is read by nothing`,
        });
      }
      continue;
    }

    if (descriptor.resamples === true) {
      push({
        code: "mask-on-resampler",
        nodeId: node.id,
        effect: node.effect,
        message: `${descriptor.name} (node ${node.id}) writes a different extent than it reads, so its output and its own input are different pixel grids and there is no picture for a mask's coverage to be of. Mask a node before or after it instead.`,
      });
      continue;
    }

    const problem = maskProblem(mask);
    if (problem !== null) {
      push({
        code: "invalid-mask",
        nodeId: node.id,
        effect: node.effect,
        message: `${descriptor.name} (node ${node.id}) has a mask that produces no coverage: ${problem}`,
      });
    }
    if (maskNeedsImage(mask) && !wired) {
      push({
        code: "mask-edge-mismatch",
        nodeId: node.id,
        effect: node.effect,
        message: `${descriptor.name} (node ${node.id}) takes its coverage from a mask picture and nothing is wired to its mask input`,
      });
    }
    if (!maskNeedsImage(mask) && wired) {
      push({
        code: "mask-edge-mismatch",
        nodeId: node.id,
        effect: node.effect,
        message: `${descriptor.name} (node ${node.id}) takes its coverage from its own input, so the picture wired to its mask input is read by nothing`,
      });
    }
  }

  // Nothing below can be trusted once the wiring is wrong: the index-map walk
  // needs an order, and there is none through a cycle or a dangling edge.
  if (issues.length > 0) {
    log.warn("graph rejected by the grammar", {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      issues: issues.length,
    });
    return { ok: false, issues };
  }

  issues.push(...checkIndexMaps(graph, byId, descriptors, wiring));
  issues.push(...checkExclusions(graph, descriptors));

  if (issues.length > 0) {
    log.warn("graph rejected by the grammar", {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      issues: issues.length,
    });
  } else {
    log.debug("graph accepted", { nodes: graph.nodes.length, edges: graph.edges.length });
  }
  return { ok: issues.length === 0, issues };
}

/** Whether following edges forward from `nodeId` arrives back at it. */
function reachesItself(edges: readonly GraphEdge[], nodeId: string): boolean {
  const seen = new Set<string>();
  const pending = edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to);
  while (pending.length > 0) {
    const at = pending.pop();
    if (at === undefined) continue;
    if (at === nodeId) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const edge of edges) {
      if (edge.from === at) pending.push(edge.to);
    }
  }
  return false;
}

/**
 * The index map, walked over the DAG.
 *
 * The stack version carried one running "who last emitted a map" variable
 * because there was one path. Here each node's answer comes from **the node on
 * its `in` port** — the picture it transforms, and the only input that carries
 * a quantization with it — so the state is a map from node id to the producer
 * live in its output, filled in dependency order.
 *
 * A dither-slot node *replaces* whatever arrived: quantizing is what the slot
 * is for, so indices that reached it no longer describe the pixels leaving it.
 * That is what makes CMYK halftone clear the map rather than pass one through,
 * and it is the whole rule this module was written for.
 *
 * A disabled node is skipped as a producer and as a consumer, and passes
 * whatever arrived on its `in` port straight through — which is what
 * `graph/plan.ts` does with it, and the two have to agree or the grammar would
 * accept graphs that fail to render.
 */
function checkIndexMaps(
  graph: GraphRef,
  byId: ReadonlyMap<string, GraphNodeRef>,
  descriptors: ReadonlyMap<string, EffectDescriptor>,
  wiring: ReadonlyMap<string, ReadonlyMap<string, string>>,
): readonly GraphIssue[] {
  const issues: GraphIssue[] = [];
  /** After this node runs, the node whose index map is live — or `null`. */
  const liveAfter = new Map<string, string | null>();
  /** After this node runs, the dither that cleared the map, for the message. */
  const clearedAfter = new Map<string, string | null>();

  for (const nodeId of dependencyOrder(graph)) {
    const node = byId.get(nodeId);
    const descriptor = descriptors.get(nodeId);
    if (node === undefined || descriptor === undefined) continue;

    const upstream = wiring.get(nodeId)?.get(PRIMARY_INPUT_PORT) ?? null;
    let producer = upstream === null ? null : (liveAfter.get(upstream) ?? null);
    let cleared = upstream === null ? null : (clearedAfter.get(upstream) ?? null);

    if (!node.enabled) {
      // Not in the render: passes its input's state through untouched.
      liveAfter.set(nodeId, producer);
      clearedAfter.set(nodeId, cleared);
      continue;
    }

    if (descriptor.requiresIndexMap && producer === null) {
      const blameDescriptor = cleared === null ? undefined : descriptors.get(cleared);
      issues.push({
        code: "index-map-missing",
        nodeId,
        effect: node.effect,
        ...(cleared === null
          ? {}
          : { otherNodeId: cleared, otherEffect: byId.get(cleared)?.effect ?? "" }),
        message:
          cleared === null || blameDescriptor === undefined
            ? `${descriptor.name} (node ${nodeId}) reads the index map, and nothing upstream of it quantizes — add a dither that emits one`
            : `${descriptor.name} (node ${nodeId}) reads the index map, but the dither upstream of it is ${blameDescriptor.name} (node ${cleared}), which emits none`,
      });
    }

    // Extents. Checked before the producer is updated, because what matters is
    // the map that is live *as this node runs* — a resampler that writes its
    // own map (nearest upscale) is legal precisely because it replaces the one
    // it was handed rather than leaving it behind.
    if (descriptor.resamples === true && producer !== null && !descriptor.producesIndexMap) {
      const producerDescriptor = descriptors.get(producer);
      issues.push({
        code: "index-map-resampled",
        nodeId,
        effect: node.effect,
        otherNodeId: producer,
        otherEffect: byId.get(producer)?.effect ?? "",
        message:
          producerDescriptor === undefined
            ? `${descriptor.name} (node ${nodeId}) resamples the image while the index map from node ${producer} is still live, and writes no index map of its own`
            : `${descriptor.name} (node ${nodeId}) resamples the image while the index map from ${producerDescriptor.name} (node ${producer}) is still live, and writes no index map of its own — palette indices cannot be interpolated, so the colours and the indices would end up naming different pixel grids. Move it upstream of ${producerDescriptor.name}, or use Nearest upscale, which carries the map across.`,
      });
    }

    if (descriptor.slot === "dither") {
      producer = descriptor.producesIndexMap ? nodeId : null;
      cleared = descriptor.producesIndexMap ? null : nodeId;
    } else if (descriptor.producesIndexMap) {
      producer = nodeId;
    }
    liveAfter.set(nodeId, producer);
    clearedAfter.set(nodeId, cleared);
  }

  return issues;
}

/**
 * Node ids in an order where every node's producers come first.
 *
 * Kahn again, but a small honest one: this module runs on a graph that has
 * already been checked for cycles and dangling edges, so it cannot get stuck —
 * and if it somehow did, the remaining nodes are appended in document order
 * rather than dropped, because an index-map rule silently not running on part
 * of a graph is worse than running it on a questionable order.
 */
function dependencyOrder(graph: GraphRef): readonly string[] {
  const indegree = new Map<string, number>();
  const consumers = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.id, 0);
    consumers.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!indegree.has(edge.to) || !consumers.has(edge.from)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    consumers.get(edge.from)?.push(edge.to);
  }

  const order: string[] = [];
  const ready = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) continue;
    order.push(id);
    for (const consumer of consumers.get(id) ?? []) {
      const left = (indegree.get(consumer) ?? 0) - 1;
      indegree.set(consumer, left);
      if (left === 0) ready.push(consumer);
    }
  }
  if (order.length === graph.nodes.length) return order;
  const seen = new Set(order);
  return [...order, ...graph.nodes.filter((node) => !seen.has(node.id)).map((node) => node.id)];
}

/**
 * Effects declared incompatible (F-SM-03).
 *
 * Any two **live** nodes, whether or not they are on the same path. That is the
 * stack rule carried over unchanged and it is deliberate: `excludes` is about
 * two looks that must not appear in one picture, and two branches that both
 * reach the output both appear in it. Reported once per pair, from the later
 * node in document order, so a graph with the same conflict twice does not read
 * as four problems.
 */
function checkExclusions(
  graph: GraphRef,
  descriptors: ReadonlyMap<string, EffectDescriptor>,
): readonly GraphIssue[] {
  const issues: GraphIssue[] = [];
  const live = graph.nodes.filter((node) => node.enabled);

  for (let i = 0; i < live.length; i += 1) {
    const later = live[i];
    if (later === undefined) continue;
    const laterDescriptor = descriptors.get(later.id);
    if (laterDescriptor === undefined) continue;

    for (let j = 0; j < i; j += 1) {
      const earlier = live[j];
      if (earlier === undefined) continue;
      const earlierDescriptor = descriptors.get(earlier.id);
      if (earlierDescriptor === undefined) continue;

      const excluded =
        (laterDescriptor.excludes ?? []).includes(earlier.effect) ||
        (earlierDescriptor.excludes ?? []).includes(later.effect);
      if (!excluded) continue;

      issues.push({
        code: "excluded-combination",
        nodeId: later.id,
        effect: later.effect,
        otherNodeId: earlier.id,
        otherEffect: earlier.effect,
        message: `${laterDescriptor.name} (node ${later.id}) and ${earlierDescriptor.name} (node ${earlier.id}) exclude one another; the grammar does not allow them in one document`,
      });
    }
  }
  return issues;
}
