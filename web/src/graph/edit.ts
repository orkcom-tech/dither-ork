/**
 * Editing a graph: add a node, connect an edge, ask what is legal, refuse.
 *
 * This is the whole surface a node editor drives. It is pure — no registry
 * loading, no device, no store — and it works on the three fields of a document
 * that describe wiring, so a caller can check a connection it has not
 * committed, preview a drop target, or drive the real mutation with the same
 * code.
 *
 * ## Refusals are values, not exceptions
 *
 * A UI asks "may I connect these?" far more often than it connects: on every
 * mouse move while a wire is being dragged. Answering that with a thrown error
 * would make the ordinary case — hovering over a port that is not legal — cost
 * a stack capture, and would force the editor to wrap every hover in a
 * `try`. So {@link connectionProblem} returns `null` or a
 * {@link ConnectionRefusal} with a code and a sentence written to be shown, and
 * {@link connect} is the committing call that throws the same sentence when it
 * is given a connection that was already refusable.
 *
 * That is the same split `validateStack` already uses — report, do not repair —
 * and the same reason: the editor turns a refusal into a cursor and a tooltip,
 * and Surprise Me turns it into "draw again".
 *
 * ## What this deliberately does not do
 *
 * It does not check the *grammar* — index maps, extents, exclusions. Those are
 * about a combination of effects rather than about one edge, they need the
 * whole graph, and they live in `registry/graph.ts`. An editor calls both: this
 * one per hover, that one per committed change.
 */

import type { DitherDocument, GraphEdge, NodeMask, StackNode } from "../types/document";
import type { EffectDescriptor, InputPortDescriptor } from "../types/registry";
import { MASK_INPUT_PORT, PRIMARY_INPUT_PORT } from "../types/registry";
import { logger } from "../lib/log";
import { GraphError } from "./errors";
import { isFeedbackRole, portsOf } from "./ports";
import { maskNeedsImage } from "./mask";

const log = logger("graph");

/**
 * The part of a document this module edits.
 *
 * Structural rather than `DitherDocument` so an editor can check a change it
 * has not committed and so nothing here needs a palette, a clock or a source. A
 * `DitherDocument` satisfies it as it stands.
 */
export interface GraphDraft {
  readonly stack: readonly StackNode[];
  readonly edges: readonly GraphEdge[];
  readonly output: string | null;
}

/** How to look an effect up. The registry satisfies it; a `Map` does too. */
export interface EffectLookup {
  get(id: string): EffectDescriptor | undefined;
}

export type ConnectionRefusalCode =
  /** One of the two endpoints is not in the graph. */
  | "unknown-node"
  /** The destination node's effect declares no such port. */
  | "unknown-port"
  /** The port is already wired. Disconnect it first, or replace the edge. */
  | "port-occupied"
  /** The edge would close a loop of ordinary edges. */
  | "would-cycle"
  /** A feedback edge whose producer is not the consumer itself. */
  | "unsupported-feedback"
  /** A node cannot read itself except across a feedback port. */
  | "self-edge"
  /** A mask edge on a node that does not take its coverage from a picture. */
  | "mask-not-wanted"
  /** A node names an effect this build does not have. */
  | "unknown-effect";

/** Why a connection was refused, in words meant to be shown to a person. */
export interface ConnectionRefusal {
  readonly code: ConnectionRefusalCode;
  readonly from: string;
  readonly to: string;
  readonly port: string;
  readonly message: string;
}

/** One port a given producer may legally be wired into. */
export interface LegalConnection {
  readonly to: string;
  readonly port: InputPortDescriptor;
  /** True when that port already carries an edge, which connecting replaces. */
  readonly occupied: boolean;
}

function nodeOf(draft: GraphDraft, id: string): StackNode | undefined {
  return draft.stack.find((node) => node.id === id);
}

function edgeInto(draft: GraphDraft, to: string, port: string): GraphEdge | undefined {
  return draft.edges.find((edge) => edge.to === to && edge.port === port);
}

/**
 * Whether `from` is reachable from `to` across ordinary edges.
 *
 * The cycle test, and it runs **forwards from the destination**: if the
 * destination already feeds the producer, adding an edge from producer to
 * destination closes the loop. Feedback edges are not in the document's edge
 * list at all, so nothing here has to exclude them — see `graph/ports.ts`.
 */
function reaches(draft: GraphDraft, from: string, to: string): boolean {
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length > 0) {
    const at = pending.pop();
    if (at === undefined || seen.has(at)) continue;
    seen.add(at);
    if (at === to) return true;
    for (const edge of draft.edges) {
      if (edge.from === at) pending.push(edge.to);
    }
  }
  return false;
}

/**
 * May this edge be drawn? `null` when it may.
 *
 * Cheap enough to call on every mouse move: the only non-constant part is the
 * reachability walk, and that is over a graph a person is holding in their head.
 */
export function connectionProblem(
  draft: GraphDraft,
  effects: EffectLookup,
  from: string,
  to: string,
  port: string,
): ConnectionRefusal | null {
  const refuse = (code: ConnectionRefusalCode, message: string): ConnectionRefusal => ({
    code,
    from,
    to,
    port,
    message,
  });

  const producer = nodeOf(draft, from);
  const consumer = nodeOf(draft, to);
  if (producer === undefined) {
    return refuse("unknown-node", `there is no node "${from}" in this document`);
  }
  if (consumer === undefined) {
    return refuse("unknown-node", `there is no node "${to}" in this document`);
  }

  const descriptor = effects.get(consumer.effect);
  if (descriptor === undefined) {
    return refuse(
      "unknown-effect",
      `node ${to} names effect "${consumer.effect}", which this build does not have, so nothing is known about its ports`,
    );
  }

  const declared = portsOf(descriptor).find((candidate) => candidate.key === port);
  if (declared === undefined) {
    const names = portsOf(descriptor)
      .map((candidate) => candidate.key)
      .join(", ");
    return refuse(
      "unknown-port",
      `${descriptor.name} has no "${port}" input; it takes ${names || "no image input"}`,
    );
  }

  if (isFeedbackRole(declared.role)) {
    return from === to
      ? null
      : refuse(
          "unsupported-feedback",
          `"${declared.label}" is the previous frame of ${to} itself. The frame store keys a history by node id and records that node's own output, so there is no previous frame of ${from} to read.`,
        );
  }

  if (from === to) {
    return refuse(
      "self-edge",
      `a node cannot read its own output within one frame; only a feedback port can, because it reads the frame before`,
    );
  }

  if (port === MASK_INPUT_PORT) {
    const mask = consumer.mask ?? null;
    if (mask === null || !maskNeedsImage(mask)) {
      return refuse(
        "mask-not-wanted",
        `${descriptor.name} is not taking its coverage from a picture, so a mask edge would be read by nothing. Set its mask to "mask image" first.`,
      );
    }
  }

  if (reaches(draft, to, from)) {
    return refuse(
      "would-cycle",
      `${to} already feeds ${from}, so this edge would close a loop. Only a feedback port may close one, because it reads the previous frame.`,
    );
  }

  const existing = edgeInto(draft, to, port);
  if (existing !== undefined && existing.from !== from) {
    return refuse(
      "port-occupied",
      `"${declared.label}" on ${to} already reads ${existing.from}. One picture per port — disconnect it first, or use replace.`,
    );
  }

  return null;
}

/**
 * Every port a given node's output may be wired into, right now.
 *
 * What a node editor highlights while a wire is being dragged out of an output.
 * A port already carrying an edge is included and marked `occupied`, because
 * "you may drop here, and it will replace what is there" is a different answer
 * from "you may not drop here" and an editor that conflated them would grey out
 * the commonest rewiring gesture there is.
 */
export function legalConnections(
  draft: GraphDraft,
  effects: EffectLookup,
  from: string,
): readonly LegalConnection[] {
  const legal: LegalConnection[] = [];
  for (const node of draft.stack) {
    const descriptor = effects.get(node.effect);
    if (descriptor === undefined) continue;
    for (const port of portsOf(descriptor)) {
      const existing = edgeInto(draft, node.id, port.key);
      const occupied = existing !== undefined;
      // Asked against a draft with the occupying edge removed, so an occupied
      // port is judged on whether the *replacement* is legal rather than on
      // whether a second edge would be.
      const without: GraphDraft = occupied
        ? { ...draft, edges: draft.edges.filter((edge) => edge !== existing) }
        : draft;
      if (connectionProblem(without, effects, from, node.id, port.key) !== null) continue;
      legal.push({ to: node.id, port, occupied });
    }
  }
  return legal;
}

/**
 * Connect, replacing whatever the destination port held.
 *
 * Replacing rather than refusing because that is what dropping a wire on an
 * occupied port means everywhere it exists, and because the alternative —
 * disconnect, then connect — is two undo steps for one gesture.
 *
 * Throws when the connection is refusable. The refusal message is the one
 * {@link connectionProblem} would have returned, so an editor that checked
 * first never sees this and one that did not gets the same sentence.
 */
export function connect(
  draft: GraphDraft,
  effects: EffectLookup,
  from: string,
  to: string,
  port: string,
): GraphDraft {
  const without: GraphDraft = {
    ...draft,
    edges: draft.edges.filter((edge) => !(edge.to === to && edge.port === port)),
  };
  const problem = connectionProblem(without, effects, from, to, port);
  if (problem !== null) {
    throw new GraphError("unknown-port", problem.message, {
      code: problem.code,
      from,
      to,
      port,
    });
  }
  const replaced = draft.edges.length - without.edges.length;
  log.info("edge connected", { from, to, port, replaced });
  return { ...without, edges: [...without.edges, { from, to, port }] };
}

/** Remove the edge on one port. A port with no edge is not an error to clear. */
export function disconnect(draft: GraphDraft, to: string, port: string): GraphDraft {
  const edges = draft.edges.filter((edge) => !(edge.to === to && edge.port === port));
  if (edges.length === draft.edges.length) return draft;
  log.info("edge disconnected", { to, port });
  return { ...draft, edges };
}

/**
 * Add a node, wired into the chain after `after`, or as a root when `after` is
 * `null`.
 *
 * The convenience the editor wants most often, and the one the old stack
 * mutations were: inserting into a chain rewires one edge rather than two
 * gestures. Everything that read `after`'s output now reads the new node, and
 * the new node reads `after` — which is exactly what "insert below this row"
 * did when the document was a list, and is now a statement about edges rather
 * than about array indices.
 *
 * The node itself is built by the caller (`state/document.ts` derives its id
 * and seed), because this module knows nothing about defaults or the registry's
 * parameter descriptors.
 */
export function addGraphNode(
  draft: GraphDraft,
  node: StackNode,
  after: string | null,
): GraphDraft {
  if (draft.stack.some((existing) => existing.id === node.id)) {
    throw new GraphError(
      "duplicate-node-id",
      `node id ${node.id} is already in this document; every edge naming it would be ambiguous`,
      { nodeId: node.id },
    );
  }
  const stack = [...draft.stack, node];

  if (after === null) {
    // A root. It reads the decoded source, like the first node of every linear
    // document, and it is the output only when there was none.
    return {
      stack,
      edges: draft.edges,
      output: draft.output ?? node.id,
    };
  }
  if (!draft.stack.some((existing) => existing.id === after)) {
    throw new GraphError("unknown-node", `cannot insert after ${after}; it is not in this document`, {
      nodeId: after,
    });
  }

  const edges: GraphEdge[] = [
    // Everything that read `after` now reads the new node instead.
    ...draft.edges.map((edge) =>
      edge.from === after ? { ...edge, from: node.id } : edge,
    ),
    { from: after, to: node.id, port: PRIMARY_INPUT_PORT },
  ];

  log.info("node inserted", { nodeId: node.id, after, edges: edges.length });
  return {
    stack,
    edges,
    // The document's picture follows the insertion when the node it was
    // inserted after was the picture; otherwise nothing about the output moved.
    output: draft.output === after ? node.id : draft.output,
  };
}

/**
 * Remove a node and heal the chain through it.
 *
 * Every consumer of the removed node is rewired to whatever fed its `in` port,
 * which is what makes deleting a node from the middle of a chain leave a chain.
 * A consumer of a node that was a root becomes a root itself — it reads the
 * source, which is what the removed node was reading.
 *
 * ## The mask a removal orphans
 *
 * A root has nothing feeding its `in` port, so a consumer of one cannot be
 * healed — it simply becomes a root too. That is right for a picture and wrong
 * for a **mask**: a node whose coverage comes from a picture keeps saying so
 * while the edge that carried the picture is gone, and `graph/plan.ts` refuses
 * exactly that combination. The result was a document that would not render,
 * reachable by deleting one generator, repairable only by undo — and not at all
 * once the autosave had been reloaded, because nothing in the editor can clear
 * a mask.
 *
 * So a mask edge that cannot be healed takes the mask with it, which is the
 * same pairing `setNodeMask` enforces from the other direction: coverage that
 * reads a picture and the edge carrying it are one fact, and neither half is
 * allowed to outlive the other.
 */
export function removeGraphNode(draft: GraphDraft, nodeId: string): GraphDraft {
  if (!draft.stack.some((node) => node.id === nodeId)) {
    throw new GraphError("unknown-node", `no node "${nodeId}" in this document`, { nodeId });
  }
  const upstream = draft.edges.find(
    (edge) => edge.to === nodeId && edge.port === PRIMARY_INPUT_PORT,
  );

  const edges: GraphEdge[] = [];
  /** Consumers whose mask edge was dropped rather than rewired. */
  const orphanedMasks = new Set<string>();
  for (const edge of draft.edges) {
    if (edge.to === nodeId) continue;
    if (edge.from !== nodeId) {
      edges.push(edge);
      continue;
    }
    if (upstream === undefined) {
      // The consumer becomes a root. A picture can be read from the source; a
      // mask cannot, so the mask goes with the edge.
      if (edge.port === MASK_INPUT_PORT) orphanedMasks.add(edge.to);
      continue;
    }
    edges.push({ ...edge, from: upstream.from });
  }

  const stack = draft.stack
    .filter((node) => node.id !== nodeId)
    .map((node) =>
      orphanedMasks.has(node.id) && node.mask !== undefined && maskNeedsImage(node.mask)
        ? stripMask(node)
        : node,
    );
  const output =
    draft.output === nodeId
      ? (upstream?.from ?? stack[stack.length - 1]?.id ?? null)
      : draft.output;

  if (orphanedMasks.size > 0) {
    log.info("mask cleared; the picture it read was removed", {
      nodeId,
      cleared: [...orphanedMasks].join(","),
    });
  }
  log.info("node removed", { nodeId, healed: upstream?.from ?? "<root>", nodes: stack.length });
  return { stack, edges, output };
}

/** Point the document's picture at a node. */
export function setOutput(draft: GraphDraft, nodeId: string | null): GraphDraft {
  if (nodeId !== null && !draft.stack.some((node) => node.id === nodeId)) {
    throw new GraphError("unknown-node", `cannot output ${nodeId}; it is not in this document`, {
      nodeId,
    });
  }
  return { ...draft, output: nodeId };
}

/**
 * Set or clear a node's mask (F-PP-08).
 *
 * Clearing one that took its coverage from a picture **also drops the mask
 * edge**, because that edge would then be read by nothing and `graph/plan.ts`
 * refuses exactly that. Doing it here rather than leaving the editor to
 * remember is the difference between one gesture and a document that will not
 * render until a second one.
 */
export function setNodeMask(
  draft: GraphDraft,
  nodeId: string,
  mask: NodeMask | null,
): GraphDraft {
  const node = nodeOf(draft, nodeId);
  if (node === undefined) {
    throw new GraphError("unknown-node", `no node "${nodeId}" in this document`, { nodeId });
  }

  const next: StackNode =
    mask === null
      ? stripMask(node)
      : { ...node, mask };

  const keepsEdge = mask !== null && maskNeedsImage(mask);
  const edges = keepsEdge
    ? draft.edges
    : draft.edges.filter((edge) => !(edge.to === nodeId && edge.port === MASK_INPUT_PORT));

  if (edges.length !== draft.edges.length) {
    log.info("mask edge dropped; this node no longer reads a mask picture", { nodeId });
  }
  return {
    ...draft,
    stack: draft.stack.map((entry) => (entry.id === nodeId ? next : entry)),
    edges,
  };
}

/**
 * The node without its `mask` key at all.
 *
 * `mask: undefined` and no `mask` are the same value in TypeScript and
 * different bytes to `JSON.stringify` — the canonical encoder skips an absent
 * key and writes `"mask": undefined` as nothing, but an explicit `undefined`
 * survives a structured clone and shows up in a deep-equality check. Removing
 * the key keeps "unmask a node" byte-identical to "never masked it".
 */
function stripMask(node: StackNode): StackNode {
  const { mask: _dropped, ...rest } = node;
  return rest;
}

/**
 * The wiring a list of nodes implies: a chain, in list order.
 *
 * The schema-1 semantics, written down once. Anything that builds a document
 * from a list — the starter presets, Surprise Me, a preset applied over another
 * document, the migration's test fixtures — goes through this, so "a stack is a
 * chain" is one function rather than the same three lines in six modules
 * drifting apart.
 */
export function chainOf(nodes: readonly { readonly id: string }[]): {
  readonly edges: readonly GraphEdge[];
  readonly output: string | null;
} {
  const edges: GraphEdge[] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const from = nodes[i - 1];
    const to = nodes[i];
    if (from === undefined || to === undefined) continue;
    edges.push({ from: from.id, to: to.id, port: PRIMARY_INPUT_PORT });
  }
  return { edges, output: nodes[nodes.length - 1]?.id ?? null };
}

/** Whether a document's own wiring is a plain chain, which every schema-1 one is. */
export function isLinearChain(draft: GraphDraft): boolean {
  if (draft.stack.length === 0) return draft.edges.length === 0;
  if (draft.edges.length !== draft.stack.length - 1) return false;
  for (let i = 1; i < draft.stack.length; i += 1) {
    const from = draft.stack[i - 1]?.id;
    const to = draft.stack[i]?.id;
    if (from === undefined || to === undefined) return false;
    const edge = draft.edges.find(
      (candidate) => candidate.to === to && candidate.port === PRIMARY_INPUT_PORT,
    );
    if (edge === undefined || edge.from !== from) return false;
  }
  return draft.output === draft.stack[draft.stack.length - 1]?.id;
}

/** Convenience for a caller holding a whole document. */
export function draftOf(document: DitherDocument): GraphDraft {
  return { stack: document.stack, edges: document.edges, output: document.output };
}
