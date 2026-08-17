/**
 * The node editor's model — everything it decides that is not drawing.
 *
 * Same split, and the same reason, as `ui/stack/model.ts`: this repository runs
 * no DOM tests (`web/vitest.config.ts`), and connection legality, snapping and
 * "what does dropping here actually do" are exactly the places where a plausible
 * mistake silently rewires somebody's document.
 *
 * Nothing here restates a rule. Legality is `graph/edit.ts`'s
 * `connectionProblem`, the ports of a node are `graph/ports.ts`'s `portsOf`, the
 * grammar is `registry/graph.ts` — this module resolves those answers against a
 * layout so the editor can draw them, and adds the one thing none of them can
 * know: what a *gesture* means.
 *
 * ## The one place the editor is more permissive than the engine, and why
 *
 * `connectionProblem` refuses a wire into the `mask` port of a node that is not
 * taking its coverage from a picture — "Set its mask to 'mask image' first."
 * That refusal is correct for the engine: such an edge would be read by nothing
 * and `graph/plan.ts` rejects it.
 *
 * It is the wrong answer to a *drag*. Dropping a branch on a mask port is the
 * gesture that means "mask this node with this picture", and answering it with
 * an instruction to go and do something else first is the difference between a
 * feature people use and a feature people are told about. So the editor reads
 * that one refusal, classifies it (see {@link maskAction}), and where the node
 * has no mask at all it performs both halves — set image coverage, connect — as
 * one undoable step. Nothing is bypassed: after the first half the connection is
 * legal on the engine's own terms, and it is still `connect` that commits it.
 *
 * A node that *already* has a luminance or colour mask is a different case and
 * is still refused, because completing that gesture would throw away numbers the
 * user chose. The refusal names what it would cost and offers the swap as an
 * explicit action.
 */

import type { GraphEdge, NodeMask, StackNode } from "../../types/document";
import type { EffectDescriptor, InputPortDescriptor, InputRole } from "../../types/registry";
import { MASK_INPUT_PORT, PRIMARY_INPUT_PORT } from "../../types/registry";
import type { ConnectionRefusal, EffectLookup, GraphDraft } from "../../graph/edit";
import { connectionProblem } from "../../graph/edit";
import { isFeedbackRole, portsOf } from "../../graph/ports";
import {
  boundsOf,
  inputPoint,
  nearest,
  outputPoint,
  type Bounds,
  type Point,
} from "./geometry";
import { layoutGraph, type LayoutNode } from "./layout";
import { SNAP_RADIUS } from "./metrics";

// --- the drawn graph ----------------------------------------------------

export interface EditorPort {
  readonly key: string;
  readonly label: string;
  readonly role: InputRole;
  /** From the descriptor. The editor never writes a port's explanation itself. */
  readonly description: string;
  readonly required: boolean;
  /** The node whose picture arrives here, or `null` for an unwired port. */
  readonly from: string | null;
  /**
   * True for a port that reads this node's own previous frame.
   *
   * Derived from the descriptor, never from an edge — no document stores a
   * feedback edge (`graph/ports.ts`). Drawn as a loop so a node that behaves as
   * though it reads itself visibly does.
   */
  readonly feedback: boolean;
  /** World units. */
  readonly point: Point;
}

export interface EditorNode {
  readonly id: string;
  readonly node: StackNode;
  /** Absent when the document names an effect this build does not have. */
  readonly effect: EffectDescriptor | undefined;
  readonly layout: LayoutNode;
  readonly ports: readonly EditorPort[];
  readonly outputPoint: Point;
  /** The node whose picture the document is. */
  readonly isOutput: boolean;
  /** No edge into `in`: it reads the image the document opened. */
  readonly isRoot: boolean;
  /** False when nothing this node produces can reach the picture. */
  readonly reachesOutput: boolean;
}

export interface EditorEdge {
  readonly from: string;
  readonly to: string;
  readonly port: string;
  readonly role: InputRole;
  readonly a: Point;
  readonly b: Point;
}

/** A feedback loop, drawn from the descriptor rather than from an edge. */
export interface EditorLoop {
  readonly nodeId: string;
  readonly port: string;
  readonly portIndex: number;
}

export interface EditorGraph {
  readonly nodes: readonly EditorNode[];
  readonly byId: ReadonlyMap<string, EditorNode>;
  readonly edges: readonly EditorEdge[];
  readonly loops: readonly EditorLoop[];
  readonly bounds: Bounds;
}

/**
 * Resolve a document into what the editor draws.
 *
 * Pure, and cheap enough to run on every document revision: the only walks are
 * over the edge list and one backward reachability pass from the output.
 */
export function buildEditorGraph(
  draft: GraphDraft,
  effects: EffectLookup,
): EditorGraph {
  const descriptors = new Map<string, EffectDescriptor | undefined>();
  for (const node of draft.stack) descriptors.set(node.id, effects.get(node.effect));

  const portsFor = (nodeId: string): readonly InputPortDescriptor[] => {
    const descriptor = descriptors.get(nodeId);
    return descriptor === undefined ? [] : portsOf(descriptor);
  };

  const layout = layoutGraph(
    { nodes: draft.stack, edges: draft.edges, output: draft.output },
    (nodeId) => portsFor(nodeId).length,
  );

  const wiredFrom = new Map<string, string>();
  for (const edge of draft.edges) wiredFrom.set(edgeKey(edge.to, edge.port), edge.from);

  const reaching = reachesOutput(draft);

  const nodes: EditorNode[] = [];
  const byId = new Map<string, EditorNode>();
  const loops: EditorLoop[] = [];

  for (const laid of layout.order) {
    const node = draft.stack.find((candidate) => candidate.id === laid.id);
    if (node === undefined) continue;
    const declared = portsFor(node.id);
    const ports: EditorPort[] = declared.map((port, index) => {
      const feedback = isFeedbackRole(port.role);
      if (feedback) loops.push({ nodeId: node.id, port: port.key, portIndex: index });
      return {
        key: port.key,
        label: port.label,
        role: port.role,
        description: port.description,
        required: port.required,
        // A feedback port's producer is the node itself and is never stored, so
        // it is filled in here rather than looked up in an edge list that by
        // construction does not contain it.
        from: feedback ? node.id : (wiredFrom.get(edgeKey(node.id, port.key)) ?? null),
        feedback,
        point: inputPoint(laid, index),
      };
    });

    const editor: EditorNode = {
      id: node.id,
      node,
      effect: descriptors.get(node.id),
      layout: laid,
      ports,
      outputPoint: outputPoint(laid),
      isOutput: draft.output === node.id,
      isRoot: !wiredFrom.has(edgeKey(node.id, PRIMARY_INPUT_PORT)),
      reachesOutput: reaching.has(node.id),
    };
    nodes.push(editor);
    byId.set(node.id, editor);
  }

  const edges: EditorEdge[] = [];
  for (const edge of draft.edges) {
    const producer = byId.get(edge.from);
    const consumer = byId.get(edge.to);
    if (producer === undefined || consumer === undefined) continue;
    const port = consumer.ports.find((candidate) => candidate.key === edge.port);
    if (port === undefined) continue;
    edges.push({
      from: edge.from,
      to: edge.to,
      port: edge.port,
      role: port.role,
      a: producer.outputPoint,
      b: port.point,
    });
  }

  return {
    nodes,
    byId,
    edges,
    loops,
    bounds: boundsOf(nodes.map((node) => node.layout)),
  };
}

function edgeKey(to: string, port: string): string {
  return `${to}\u0000${port}`;
}

/**
 * Every node whose output can reach the document's picture.
 *
 * A backward walk from `output`. Nodes outside it contribute nothing to the
 * frame — a branch left over from a rewiring, or one that was built and never
 * connected — and the editor dims them for the same reason the stack panel dims
 * the rows below a solo point: not being in the picture is a fact worth seeing,
 * and it is not an error.
 */
function reachesOutput(draft: GraphDraft): ReadonlySet<string> {
  const reaching = new Set<string>();
  if (draft.output === null) return reaching;
  const pending = [draft.output];
  while (pending.length > 0) {
    const at = pending.pop();
    if (at === undefined || reaching.has(at)) continue;
    reaching.add(at);
    for (const edge of draft.edges) {
      if (edge.to === at) pending.push(edge.from);
    }
  }
  return reaching;
}

// --- dropping a wire ----------------------------------------------------

/**
 * What committing a drop on a mask port actually does.
 *
 * The three cases a mask port can be in, named rather than inferred at three
 * call sites: the highlight while dragging, the sentence under the cursor, and
 * the commit all read this one answer.
 */
export type MaskAction =
  /** The node already reads a picture as coverage: an ordinary connect. */
  | { readonly kind: "wire" }
  /**
   * The node has no mask. Connecting sets image coverage and wires it, as one
   * undo step — the gesture means "mask this with that", and asking for a
   * separate first step is how a feature becomes undiscoverable.
   */
  | { readonly kind: "enable" }
  /**
   * The node takes its coverage from a luminance band or a colour. Wiring a
   * picture would discard those numbers, so it is refused and offered.
   */
  | { readonly kind: "replace"; readonly existing: "luminance" | "color" };

export function maskAction(node: StackNode): MaskAction {
  const mask = node.mask;
  if (mask === undefined) return { kind: "enable" };
  // Switched on the source rather than tested with `maskNeedsImage`, because the
  // `replace` case has to carry *which* of the two coverages would be lost and
  // only the narrowed union has it. `maskNeedsImage` stays the answer everywhere
  // the question is a yes or no.
  switch (mask.source.kind) {
    case "image":
      return { kind: "wire" };
    case "luminance":
    case "color":
      return { kind: "replace", existing: mask.source.kind };
  }
}

/**
 * The mask a node is given when a drop on its empty mask port is committed.
 *
 * Luminance is the channel a picture used as a mask is read by everywhere else
 * in the application, and it is the one that behaves as expected for a
 * greyscale branch — which is what a mask branch nearly always is.
 *
 * **It is also the only mask this build can produce.** `mask.ts` evaluates all
 * three coverages F-PP-08 names and `store.setNodeMask` can set any of them,
 * but no control calls it: there is no channel picker, no invert, and no way to
 * reach a luminance-band or colour mask except by writing the document by hand.
 * Wiring a picture into a mask port is the whole of the masking UI. Said here
 * rather than left to be discovered, and recorded as the unbuilt half of
 * F-PP-08 in `registry/unbuilt.ts`.
 */
export const IMAGE_MASK: NodeMask = {
  source: { kind: "image", channel: "luminance" },
  invert: false,
};

/** What connecting to this port would do, and whether it may be done at all. */
export interface DropTarget {
  readonly to: string;
  readonly port: EditorPort;
  /** Null when the drop may be committed. */
  readonly refusal: ConnectionRefusal | null;
  /** Set only for the mask port. */
  readonly mask: MaskAction | null;
  /** True when the port already carries an edge that committing would replace. */
  readonly occupied: boolean;
  /** World-unit distance from the pointer. Zero for a keyboard-chosen target. */
  readonly distance: number;
}

/**
 * Judge one port as a drop target.
 *
 * Exported because both paths need it and must give the same answer: the
 * pointer path asks about whichever port is nearest, and the keyboard path asks
 * about every port in turn.
 */
export function judgeDrop(
  draft: GraphDraft,
  effects: EffectLookup,
  from: string,
  to: string,
  port: EditorPort,
  distance = 0,
): DropTarget {
  const consumer = draft.stack.find((node) => node.id === to);
  const existing = draft.edges.find((edge) => edge.to === to && edge.port === port.key);
  const occupied = existing !== undefined;

  // Judged against a draft with the occupying edge removed: dropping on an
  // occupied port replaces what is there, so the question is whether the
  // *replacement* is legal, not whether a second edge would be. `connect`
  // commits it the same way. This mirrors `legalConnections`.
  const without: GraphDraft = occupied
    ? { ...draft, edges: draft.edges.filter((edge) => edge !== existing) }
    : draft;

  const mask = port.key === MASK_INPUT_PORT && consumer !== undefined
    ? maskAction(consumer)
    : null;

  // Ask the engine with the mask already in the state committing would put it
  // in. For `enable` that is the whole of the difference between the engine's
  // answer and the editor's: the refusal it would give is about a mask that is
  // not set yet, and the gesture sets it.
  const judged: GraphDraft =
    mask?.kind === "enable" && consumer !== undefined
      ? {
          ...without,
          stack: without.stack.map((node) =>
            node.id === to ? { ...node, mask: IMAGE_MASK } : node,
          ),
        }
      : without;

  const refusal =
    mask?.kind === "replace"
      ? replaceMaskRefusal(from, to, port, nameOf(effects, consumer, to), mask.existing)
      : connectionProblem(judged, effects, from, to, port.key);

  return { to, port, refusal, mask, occupied, distance };
}

/** An effect's display name, falling back to the id and then to the node id. */
function nameOf(
  effects: EffectLookup,
  node: StackNode | undefined,
  fallback: string,
): string {
  if (node === undefined) return fallback;
  return effects.get(node.effect)?.name ?? node.effect;
}

/**
 * The one refusal this module writes itself.
 *
 * Everything else a person reads while wiring comes from `connectionProblem`,
 * which is where the rules are and therefore where their wording belongs. This
 * case is not a rule — the connection is legal — it is a **cost**: the node's
 * existing coverage would be discarded. Only the editor knows that, because
 * only the editor was about to perform two edits as one gesture, so only the
 * editor can say it. It is written in the same voice as the engine's refusals:
 * what is in the way, why, and what to do instead.
 */
function replaceMaskRefusal(
  from: string,
  to: string,
  port: EditorPort,
  name: string,
  existing: "luminance" | "color",
): ConnectionRefusal {
  const what = existing === "luminance" ? "a luminance band" : "a colour";
  return {
    code: "mask-not-wanted",
    from,
    to,
    port: port.key,
    message: `${name} already takes its coverage from ${what}, and a picture would replace it — those numbers would be gone. Clear its mask first if that is what you want.`,
  };
}

/**
 * Every port a wire out of `from` could be dropped on, in reading order.
 *
 * This is `legalConnections` plus the two things the editor needs and it does
 * not carry: the **sentence** for a port that must be refused (the picker's
 * precedent — an unavailable row is shown with its reason rather than hidden,
 * because the user knows the port is there and has nothing to read otherwise),
 * and the mask classification above. It walks the same ports in the same way,
 * so the two cannot disagree about what is legal.
 *
 * Order is the layout's: by column, then row, then the port's own order on the
 * node — which is the order `graph/ports.ts` fixes and the order the hash means
 * by "port order". That makes keyboard stepping move left to right and top to
 * bottom, which is how the graph is read.
 */
export function dropTargets(
  graph: EditorGraph,
  draft: GraphDraft,
  effects: EffectLookup,
  from: string,
): readonly DropTarget[] {
  const targets: DropTarget[] = [];
  for (const node of graph.nodes) {
    for (const port of node.ports) {
      // Feedback ports are excluded here for the same reason they are excluded
      // from the pointer's snap: their producer is the node itself by
      // construction, no edge is ever stored for one, and offering it as
      // something to aim at could only ever end in a refusal or in a stored
      // edge that restates the descriptor.
      if (port.feedback) continue;
      targets.push(judgeDrop(draft, effects, from, node.id, port));
    }
  }
  return targets;
}

/**
 * The port a drop at this point lands on — the forgiving snap.
 *
 * Nearest port within {@link SNAP_RADIUS}, judged; `null` when the pointer is
 * over open canvas. A port that must be refused is still returned, because the
 * refusal is what the user needs to read and a target that vanishes when it
 * becomes illegal gives them nothing to aim at and nothing to learn from.
 */
export function dropTargetAt(
  graph: EditorGraph,
  draft: GraphDraft,
  effects: EffectLookup,
  from: string,
  world: Point,
  radius: number = SNAP_RADIUS,
): DropTarget | null {
  const candidates: { readonly node: EditorNode; readonly port: EditorPort }[] = [];
  for (const node of graph.nodes) {
    for (const port of node.ports) {
      // A feedback port is not a drop target. Its producer is the node itself
      // by construction and no edge may be stored for it, so offering it as
      // something to aim at could only ever end in a refusal.
      if (port.feedback) continue;
      candidates.push({ node, port });
    }
  }
  const hit = nearest(candidates, (candidate) => candidate.port.point, world, radius);
  if (hit === null) return null;
  return judgeDrop(
    draft,
    effects,
    from,
    hit.candidate.node.id,
    hit.candidate.port,
    hit.distance,
  );
}

/** The node card under a point, or `null`. Topmost is irrelevant: cards never overlap. */
export function nodeAt(graph: EditorGraph, world: Point): EditorNode | null {
  for (const node of graph.nodes) {
    const { x, y, width, height } = node.layout;
    if (world.x >= x && world.x <= x + width && world.y >= y && world.y <= y + height) {
      return node;
    }
  }
  return null;
}

// --- what a node's ports say --------------------------------------------

/**
 * The sentence shown under an unwired `in` port.
 *
 * A root reads the image the document opened, and that is invisible: the port
 * simply looks empty, which in every other node editor means "not connected
 * yet". Saying it is the difference between a first-time reader understanding
 * where the picture comes from and concluding the graph is broken.
 */
export const ROOT_INPUT_NOTE =
  "Unwired, so this node reads the image the document opened.";

/** Whether an edge into this port carries a picture that is composited as colour. */
export function isColourRole(role: InputRole): boolean {
  return role === "image" || role === "layer";
}

/**
 * A short word for what a wire carries, drawn beside it.
 *
 * Roles come from the registry and each one is a different contract; a graph
 * where every wire looks the same makes a mask edge and an image edge
 * indistinguishable, which is exactly the confusion masking exists inside of.
 */
export const ROLE_LABEL: Readonly<Record<InputRole, string>> = {
  image: "image",
  mask: "mask",
  layer: "layer",
  displace: "displace",
  feedback: "previous frame",
};

/** Every port of every node, flattened — what the keyboard steps through. */
export function allPorts(
  graph: EditorGraph,
): readonly { readonly node: EditorNode; readonly port: EditorPort }[] {
  const flat: { node: EditorNode; port: EditorPort }[] = [];
  for (const node of graph.nodes) {
    for (const port of node.ports) flat.push({ node, port });
  }
  return flat;
}

/** The document's edges with one removed — what disconnecting a port produces. */
export function withoutEdge(
  edges: readonly GraphEdge[],
  to: string,
  port: string,
): readonly GraphEdge[] {
  return edges.filter((edge) => !(edge.to === to && edge.port === port));
}
