/**
 * The stack panel, once the document stopped being a list.
 *
 * ## The decision this file is
 *
 * The stack panel does not disappear and does not become a second model of the
 * document. It becomes a **view onto the graph**: the same store, the same
 * nodes, the same selection, showing the document's own list order — which is
 * what the canonical encoder writes, what the topological sort breaks ties on,
 * and what the picker inserts into — and saying, per row, where that node sits
 * relative to the picture.
 *
 * The alternative designs were considered and are worse:
 *
 * - **Replace the stack with the editor.** Most documents are chains, most
 *   people think in chains, and every `.dork`, preset and share link in
 *   existence is one. A list is better than a graph at reading twenty nodes in a
 *   260px column, at dragging an order, and at carrying per-node opacity and
 *   blend. Throwing that away to gain a second image edge is a trade nobody
 *   asked for.
 * - **Open the editor only when a document stops being linear.** That makes the
 *   editor a punishment for using masking, and it makes the moment a document
 *   becomes non-linear a moment the interface rearranges itself underneath the
 *   user. It also cannot work in the other direction: unwiring the last mask
 *   would have to take the editor away mid-gesture.
 * - **Show only the chain, and hide branches.** A panel that silently omits
 *   nodes is the worst option available — the node count would not match the
 *   rows, and a node that exists and is not listed is unreachable.
 *
 * So the stack lists **every** node, always, and this module computes the one
 * thing a list cannot show for itself: how each row is connected. A chain reads
 * exactly as it did before schema 2, because on a chain every row is `chain` and
 * the notes are empty.
 *
 * ## What it deliberately does not do
 *
 * It does not reorder rows into evaluation order. The list order is a document
 * field with meaning of its own, and a panel that showed a different order from
 * the one that is saved would make "drag to reorder" incomprehensible.
 *
 * ## Why the shadow analysis is here and not `registry/stack.ts`'s
 *
 * `analyseSources` answers "which rows does a source node throw away", and it
 * answers it **positionally**: everything earlier in the list than the last
 * replacing source node is discarded. That was exactly right while the list was
 * the wiring. It is wrong now, and wrong in the way that matters — a generator
 * wired into some node's mask port sits at the end of the list and discards
 * nothing at all, and the positional answer marks the whole chain as thrown
 * away. Three rows of a confident, false sentence.
 *
 * So {@link describeRows} computes it from the wiring instead: a node is
 * shadowed when **every path from it to the picture passes through a replacing
 * source node's `in` port**, which is the same statement the positional rule was
 * making about a chain and is still true when the document is not one. On a
 * chain the two agree node for node; the tests below check that.
 */

import type { GraphEdge, StackNode } from "../../types/document";
import type { EffectDescriptor, InputPortDescriptor, InputRole } from "../../types/registry";
import { PRIMARY_INPUT_PORT } from "../../types/registry";
import { portsOf } from "../../graph/ports";

/** How to look an effect up. The registry satisfies it. */
export interface EffectLookup {
  get(id: string): EffectDescriptor | undefined;
}

export interface GraphViewInput {
  readonly stack: readonly StackNode[];
  readonly edges: readonly GraphEdge[];
  readonly output: string | null;
}

/** Where one row sits relative to the picture. */
export type RowPlacement =
  /** On the chain of `in` edges that ends at the picture. */
  | { readonly kind: "chain"; readonly step: number }
  /**
   * Reaches the picture, but through some other node's second input — a mask, a
   * layer, a displacement source. The branch that makes masking possible.
   */
  | {
      readonly kind: "feeds";
      readonly into: string;
      readonly port: string;
      readonly portLabel: string;
      readonly role: InputRole;
    }
  /** Reaches the picture along `in` edges, but not on the chain from the output. */
  | { readonly kind: "branch" }
  /** Nothing this node produces reaches the picture at all. */
  | { readonly kind: "detached" };

export interface RowNote {
  readonly placement: RowPlacement;
  /**
   * A few characters for the row, or `null` on a chain row — a badge on every
   * row of a twenty-node chain says nothing and costs the width the effect name
   * needs.
   */
  readonly badge: string | null;
  /** One sentence, ready to show. `null` where the badge would only repeat it. */
  readonly note: string | null;
}

export interface GraphView {
  readonly rows: ReadonlyMap<string, RowNote>;
  /**
   * Nodes whose work a replacing source node throws away, and the sentence
   * saying which one and what to do about it.
   *
   * Not a grammar issue: the document renders exactly as it is built, and moving
   * the generator or lowering its opacity is a choice rather than a repair. What
   * is owed is visibility. See the note at the top of the file for why this is
   * computed from the wiring rather than from the list.
   */
  readonly shadowed: ReadonlyMap<string, string>;
  /** True when the wiring is a plain chain in list order: what every schema-1 document is. */
  readonly linear: boolean;
  /** Nodes that reach the picture through a second input. Zero on a chain. */
  readonly branches: number;
  /** Nodes that reach the picture not at all. */
  readonly detached: number;
}

/**
 * Describe every row.
 *
 * Pure, and cheap enough to run on every document revision: a handful of walks
 * over the edge list, on a graph a person is holding in their head.
 */
export function describeRows(input: GraphViewInput, effects: EffectLookup): GraphView {
  const byId = new Map<string, StackNode>();
  for (const node of input.stack) byId.set(node.id, node);

  const nameOf = (nodeId: string): string => {
    const node = byId.get(nodeId);
    if (node === undefined) return nodeId;
    return effects.get(node.effect)?.name ?? node.effect;
  };

  // The spine: back from the picture along `in` edges. It is what a person means
  // by "the stack" — everything else hangs off it.
  const spine = new Map<string, number>();
  {
    const seen = new Set<string>();
    let at = input.output;
    let step = 0;
    while (at !== null && !seen.has(at)) {
      seen.add(at);
      spine.set(at, step);
      step += 1;
      const upstream = input.edges.find(
        (edge) => edge.to === at && edge.port === PRIMARY_INPUT_PORT,
      );
      at = upstream?.from ?? null;
    }
  }

  /** Every node whose output can reach the picture at all. */
  const reaching = walkBack(input, input.output, () => true);

  const rows = new Map<string, RowNote>();
  let branches = 0;
  let detached = 0;

  for (const node of input.stack) {
    const onSpine = spine.get(node.id);
    if (onSpine !== undefined) {
      rows.set(node.id, {
        placement: { kind: "chain", step: onSpine },
        badge: null,
        note: null,
      });
      continue;
    }

    if (!reaching.has(node.id)) {
      detached += 1;
      rows.set(node.id, {
        placement: { kind: "detached" },
        badge: "off-graph",
        note: "Nothing this node makes reaches the picture. Wire its output into a node that does, or make it the picture in the node editor.",
      });
      continue;
    }

    // It reaches the picture, so it feeds something. Name the nearest consumer
    // whose port is not `in` when there is one, because that is the interesting
    // fact — a branch exists *because* of a second input, and which one it is
    // ("mask of Blur") is the whole reason the row is not on the chain.
    const secondary = input.edges.find(
      (edge) => edge.from === node.id && edge.port !== PRIMARY_INPUT_PORT,
    );
    if (secondary !== undefined) {
      const port = portOf(byId.get(secondary.to), effects, secondary.port);
      branches += 1;
      rows.set(node.id, {
        placement: {
          kind: "feeds",
          into: secondary.to,
          port: secondary.port,
          portLabel: port?.label ?? secondary.port,
          role: port?.role ?? "image",
        },
        badge: `→ ${(port?.label ?? secondary.port).toLowerCase()}`,
        note: `Feeds the ${(port?.label ?? secondary.port).toLowerCase()} input of ${nameOf(secondary.to)}. It is in the picture, but not on the chain — open the node editor to see the wiring.`,
      });
      continue;
    }

    branches += 1;
    rows.set(node.id, {
      placement: { kind: "branch" },
      badge: "branch",
      note: `Feeds ${nameOf(input.edges.find((edge) => edge.from === node.id)?.to ?? node.id)} rather than the row below it. Open the node editor to see the wiring.`,
    });
  }

  return {
    rows,
    shadowed: describeShadowing(input, effects, spine, reaching, nameOf),
    linear: isChainInListOrder(input),
    branches,
    detached,
  };
}

/**
 * Which live nodes a replacing source node throws away, and which one does it.
 *
 * A **replacing source** is an enabled node in the `source` slot at full opacity
 * in normal blend — the identity composite, and the only case where its input is
 * genuinely gone. That is the same condition `graph/plan.ts` uses to skip the
 * composite entirely, and it has to be, or the panel would mark rows the
 * renderer still uses.
 *
 * The rule, stated over the wiring: a node is shadowed when every path from it
 * to the picture passes through such a node's `in` port. Mechanically that is
 * one backward walk from the output that refuses to cross those ports —
 * everything that reaches the picture at all but not through this walk is behind
 * a barrier.
 *
 * Which barrier gets the blame is the one nearest the picture, because that is
 * the one that throws the work away last and therefore the one whose opacity or
 * wiring is worth changing.
 */
function describeShadowing(
  input: GraphViewInput,
  effects: EffectLookup,
  spine: ReadonlyMap<string, number>,
  reaching: ReadonlySet<string>,
  nameOf: (nodeId: string) => string,
): ReadonlyMap<string, string> {
  const barriers = input.stack.filter((node) => {
    if (!node.enabled) return false;
    if (effects.get(node.effect)?.slot !== "source") return false;
    return node.opacity === 1 && node.blend === "normal";
  });
  if (barriers.length === 0) return new Map();

  const barrierIds = new Set(barriers.map((node) => node.id));
  const surviving = walkBack(input, input.output, (edge) => {
    // The one edge the walk will not cross: the picture a replacing source node
    // was handed, which it discards.
    return !(barrierIds.has(edge.to) && edge.port === PRIMARY_INPUT_PORT);
  });

  // Nearest the picture first. A barrier that is not on the chain to the output
  // — a generator feeding a mask branch — still discards its own upstream, and
  // sorts after the ones that are, in list order.
  const ordered = [...barriers].sort((a, b) => {
    const byStep = (spine.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (spine.get(b.id) ?? Number.MAX_SAFE_INTEGER);
    if (byStep !== 0) return byStep;
    return input.stack.indexOf(a) - input.stack.indexOf(b);
  });

  const shadowed = new Map<string, string>();
  for (const barrier of ordered) {
    const feeding = input.edges.find(
      (edge) => edge.to === barrier.id && edge.port === PRIMARY_INPUT_PORT,
    );
    if (feeding === undefined) continue; // nothing wired in, so nothing discarded
    const behind = walkBack(input, feeding.from, () => true);
    const name = nameOf(barrier.id);
    for (const nodeId of behind) {
      if (!reaching.has(nodeId) || surviving.has(nodeId)) continue;
      if (shadowed.has(nodeId)) continue;
      shadowed.set(
        nodeId,
        `${name} (node ${barrier.id}) makes its own image and replaces the picture on its input outright, so nothing this node produces reaches the frame. Lower ${name}'s opacity or change its blend so the two are combined, or rewire it so it no longer sits between this node and the picture.`,
      );
    }
  }
  return shadowed;
}

/** Backward reachability from one node, over the edges a predicate admits. */
function walkBack(
  input: GraphViewInput,
  from: string | null,
  admits: (edge: GraphEdge) => boolean,
): ReadonlySet<string> {
  const seen = new Set<string>();
  if (from === null) return seen;
  const pending = [from];
  while (pending.length > 0) {
    const at = pending.pop();
    if (at === undefined || seen.has(at)) continue;
    seen.add(at);
    for (const edge of input.edges) {
      if (edge.to !== at || !admits(edge)) continue;
      pending.push(edge.from);
    }
  }
  return seen;
}

function portOf(
  node: StackNode | undefined,
  effects: EffectLookup,
  key: string,
): InputPortDescriptor | undefined {
  if (node === undefined) return undefined;
  const descriptor = effects.get(node.effect);
  if (descriptor === undefined) return undefined;
  return portsOf(descriptor).find((port) => port.key === key);
}

/**
 * Whether the wiring is a chain **in list order**.
 *
 * The same question `graph/edit.ts`'s `isLinearChain` answers, asked here over
 * the same three fields so the panel does not have to build a `GraphDraft` to
 * ask it. It is restated rather than imported for one reason: this module's
 * whole subject is the relationship between the list and the wiring, and the
 * answer is four lines. If it grows past that it should import instead.
 */
function isChainInListOrder(input: GraphViewInput): boolean {
  if (input.stack.length === 0) return input.edges.length === 0;
  if (input.edges.length !== input.stack.length - 1) return false;
  for (let i = 1; i < input.stack.length; i += 1) {
    const from = input.stack[i - 1]?.id;
    const to = input.stack[i]?.id;
    if (from === undefined || to === undefined) return false;
    const edge = input.edges.find(
      (candidate) => candidate.to === to && candidate.port === PRIMARY_INPUT_PORT,
    );
    if (edge === undefined || edge.from !== from) return false;
  }
  return input.output === input.stack[input.stack.length - 1]?.id;
}

/**
 * What the panel's bar says about the document's shape.
 *
 * One sentence, and it is only shown when there is something to say — a chain
 * needs no explanation, and a line reading "this is a chain" on every document
 * anybody has ever made is noise that trains people to stop reading the bar.
 */
export function shapeNote(view: GraphView): string | null {
  if (view.linear) return null;
  const parts: string[] = [];
  if (view.branches > 0) {
    parts.push(
      `${view.branches} node${view.branches === 1 ? "" : "s"} feed${view.branches === 1 ? "s" : ""} the picture through a branch`,
    );
  }
  if (view.detached > 0) {
    parts.push(
      `${view.detached} reach${view.detached === 1 ? "es" : ""} it not at all`,
    );
  }
  const shape = parts.length === 0 ? "the wiring is not a plain chain" : parts.join(", and ");
  return `This document is a graph — ${shape}. Rows stay in the document's own order; dragging one changes that order and the evaluation tie-break, not the wiring. The wiring is in the node editor.`;
}
