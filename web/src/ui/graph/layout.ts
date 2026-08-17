/**
 * Where every node sits — computed from the wiring, never stored.
 *
 * ## Why positions are not in the document
 *
 * A migrated document has no positions: schema 1 was a list, and every `.dork`,
 * preset and share link in existence is one. Something has to decide where the
 * nodes go, and there are only two honest answers — put a position field in the
 * schema and migrate one in, or compute it. This is the second.
 *
 * It is not a stopgap. The consequence people meet is that **a node cannot be
 * dragged to a new place**, and the editor says so rather than offering a drag
 * whose result would be lost on reload. That is the same rule the opacity and
 * blend sliders were held to when they were removed for being inert: a control
 * that appears to work and does not is worse than one that is absent with a
 * reason. What is bought for it is worth more than hand-placement is in a tool
 * whose documents are chains of five to fifteen nodes:
 *
 * - **The same document lays out identically on every machine**, which is what
 *   step 3 asked for. There is no clock, no `Math.random`, no `Set` iteration
 *   order and no floating-point accumulation anywhere below; every tie is broken
 *   by the node's index in the document's own list, which is data.
 * - **A document nobody has ever opened in the editor still reads correctly.**
 *   Stored positions would have to be invented for every migrated document
 *   anyway, and the invention would then be saved — freezing this function's
 *   output into the file, where it could never be improved.
 * - **The wiring cannot lie.** A stored position survives a rewiring, so a node
 *   can sit visually upstream of something it now reads from. Here it cannot:
 *   position *is* the wiring.
 *
 * Adding stored positions later is small and additive — an optional field on
 * `StackNode`, absent meaning "computed", and this function as the fallback. It
 * is a schema change, and schema 2 has just shipped, so it is not made here.
 *
 * ## The layout
 *
 * Two passes, both of them ordinary and both of them total orders.
 *
 * 1. **Column = longest path from a root.** A node sits one column to the right
 *    of the furthest-right node it reads, so every edge points rightwards and a
 *    chain comes out as a single row. Longest rather than shortest path: with
 *    the shortest, a node that reads both the first and the fifth node of a
 *    chain would be placed at column 1 and its second wire would run backwards.
 * 2. **Row = the row of the picture it transforms.** A node wants to sit level
 *    with whatever arrives on its `in` port, because that is the picture it is a
 *    step in; a node with no `in` edge — a root, or a generator — wants the
 *    average of whatever else it reads, and failing that the top. Within a
 *    column those wishes are granted in order and never overlap: each node takes
 *    the first row at or below the one it asked for.
 *
 *    On a chain this is row 0 for everything. On a masked chain it keeps the
 *    chain on row 0 and pushes the branch that feeds the mask onto its own row
 *    below it — which is the picture a person draws on paper when they explain
 *    what a mask is. Ranking by the `in` port rather than by the mean of every
 *    input is what makes the *chain* the thing that stays straight: a node's
 *    place in the picture is where its picture comes from, and a second input is
 *    a decoration hanging off it.
 *
 * Both passes walk columns left to right, so a node's producers always have
 * their rows already; no iteration to a fixed point, and no order that depends
 * on how a `Map` happened to be filled.
 */

import type { GraphEdge } from "../../types/document";
import { PRIMARY_INPUT_PORT } from "../../types/registry";
import {
  COLUMN_GAP,
  NODE_WIDTH,
  ROW_GAP,
  nodeHeight,
} from "./metrics";

/** The part of a document this reads. A `GraphDraft` satisfies it as it stands. */
export interface LayoutInput {
  /** In the document's own list order, which is the tie-break for everything. */
  readonly nodes: readonly { readonly id: string }[];
  readonly edges: readonly GraphEdge[];
  /**
   * The node whose output is the picture, when the caller has one.
   *
   * Used for one thing: **the chain that ends at the picture takes the top
   * row.** Two roots asking for the same row have to be ordered somehow, and
   * ordering them by list position puts a generator that feeds a mask above the
   * chain it modifies as often as not. The chain to the picture is the spine of
   * the document and belongs on top; everything else hangs below it.
   *
   * Optional because it is a preference rather than a constraint — a caller with
   * no output still gets a laid-out graph, ordered by list position.
   */
  readonly output?: string | null;
}

export interface LayoutNode {
  readonly id: string;
  /** Longest distance in edges from a root. Roots are 0. */
  readonly column: number;
  /** Position within the column, from the top. */
  readonly row: number;
  /** World units, top-left of the card. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GraphLayout {
  readonly nodes: ReadonlyMap<string, LayoutNode>;
  /** Nodes in draw order: by column, then row. Stable, and what the DOM lists. */
  readonly order: readonly LayoutNode[];
  readonly columns: number;
  readonly rows: number;
  /** Extent of every card together, world units. Zero on an empty graph. */
  readonly width: number;
  readonly height: number;
}

const EMPTY: GraphLayout = {
  nodes: new Map(),
  order: [],
  columns: 0,
  rows: 0,
  width: 0,
  height: 0,
};

/**
 * Lay a graph out.
 *
 * `portCount` gives each node's number of input ports, which is what decides
 * how tall its card is. It is a function rather than a registry because this
 * module has no business resolving effects, and because a test can then state a
 * height in one number instead of building a descriptor.
 *
 * An edge naming a node that is not in `nodes` is ignored rather than refused:
 * validation is `registry/graph.ts`'s job and it reports such an edge properly,
 * and a layout that throws would take the whole editor down instead of drawing
 * the document that has the problem in it.
 */
export function layoutGraph(
  input: LayoutInput,
  portCount: (nodeId: string) => number,
): GraphLayout {
  if (input.nodes.length === 0) return EMPTY;

  const position = new Map<string, number>();
  for (const [index, node] of input.nodes.entries()) position.set(node.id, index);

  const producers = new Map<string, string[]>();
  /** The producer on the `in` port: the picture this node is a step in. */
  const primary = new Map<string, string>();
  for (const node of input.nodes) producers.set(node.id, []);
  for (const edge of input.edges) {
    const into = producers.get(edge.to);
    if (into === undefined || !position.has(edge.from)) continue;
    into.push(edge.from);
    if (edge.port === PRIMARY_INPUT_PORT) primary.set(edge.to, edge.from);
  }

  const column = columnsOf(input, producers, position);

  // Group by column, then place each column's nodes on the rows they ask for.
  // Columns are processed in ascending order and every producer is in a strictly
  // earlier column, so the rows a wish reads are always already assigned.
  const byColumn = new Map<number, string[]>();
  let columns = 0;
  for (const node of input.nodes) {
    const at = column.get(node.id) ?? 0;
    columns = Math.max(columns, at + 1);
    const bucket = byColumn.get(at);
    if (bucket === undefined) byColumn.set(at, [node.id]);
    else bucket.push(node.id);
  }

  // The chain that ends at the picture. Everything on it outranks everything
  // else at the same wished-for row, which is what puts the document's spine on
  // the top row and hangs the branches below it.
  const spine = spineOf(input, primary);

  const row = new Map<string, number>();
  let rows = 0;
  for (let at = 0; at < columns; at += 1) {
    // In document order to begin with, which is what column 0 keeps and what
    // every tie in a later column falls back to.
    const bucket = (byColumn.get(at) ?? []).slice();
    const wish = new Map<string, number>();
    for (const id of bucket) wish.set(id, preferredRow(id, primary, producers, row));
    bucket.sort((a, b) => {
      const byWish = (wish.get(a) ?? 0) - (wish.get(b) ?? 0);
      if (byWish !== 0) return byWish;
      const bySpine = (spine.has(a) ? 0 : 1) - (spine.has(b) ? 0 : 1);
      if (bySpine !== 0) return bySpine;
      return (position.get(a) ?? 0) - (position.get(b) ?? 0);
    });
    // Granted in that order, and never overlapping: each node takes the row it
    // asked for, or the first one below if that is taken. Because the list is
    // sorted by the wish, this never moves a node above one that asked for less.
    let free = 0;
    for (const id of bucket) {
      const line = Math.max(free, wish.get(id) ?? 0);
      row.set(id, line);
      free = line + 1;
      rows = Math.max(rows, line + 1);
    }
  }

  // One stride for every row, taken from the tallest card in the document.
  // Per-row heights would pack tighter and would make a card's y depend on how
  // many ports the nodes above it happen to have — so adding a mask port to one
  // node would move every node below it. A regular grid is worth the whitespace.
  let tallest = 0;
  for (const node of input.nodes) {
    tallest = Math.max(tallest, nodeHeight(portCount(node.id)));
  }
  const rowStride = tallest + ROW_GAP;
  const columnStride = NODE_WIDTH + COLUMN_GAP;

  const nodes = new Map<string, LayoutNode>();
  const order: LayoutNode[] = [];
  for (const node of input.nodes) {
    const at = column.get(node.id) ?? 0;
    const line = row.get(node.id) ?? 0;
    const laid: LayoutNode = {
      id: node.id,
      column: at,
      row: line,
      x: at * columnStride,
      y: line * rowStride,
      width: NODE_WIDTH,
      height: nodeHeight(portCount(node.id)),
    };
    nodes.set(node.id, laid);
    order.push(laid);
  }
  order.sort((a, b) => (a.column - b.column) || (a.row - b.row));

  return {
    nodes,
    order,
    columns,
    rows,
    width: columns === 0 ? 0 : (columns - 1) * columnStride + NODE_WIDTH,
    height: rows === 0 ? 0 : (rows - 1) * rowStride + tallest,
  };
}

/**
 * Longest path from a root, per node.
 *
 * Kahn's algorithm over the edges the document stores, with the ready set kept
 * in list order — the same tie-break `graph/topology.ts` uses, for the same
 * reason: it is data rather than an iteration accident.
 *
 * Feedback edges are not in a document's edge list at all (they are derived from
 * the descriptor, see `graph/ports.ts`), so there is nothing here to exclude and
 * the walk cannot be caught in a legal loop. An *illegal* loop — which
 * validation refuses and the editor therefore never commits, but which a
 * hand-edited file could still contain — leaves its nodes unvisited, and they
 * fall back to column 0 rather than hanging the editor.
 */
function columnsOf(
  input: LayoutInput,
  producers: ReadonlyMap<string, readonly string[]>,
  position: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const indegree = new Map<string, number>();
  const consumers = new Map<string, string[]>();
  for (const node of input.nodes) {
    indegree.set(node.id, producers.get(node.id)?.length ?? 0);
    consumers.set(node.id, []);
  }
  for (const edge of input.edges) {
    const list = consumers.get(edge.from);
    if (list === undefined || !position.has(edge.to)) continue;
    list.push(edge.to);
  }

  const ready: string[] = [];
  const insert = (id: string): void => {
    const at = position.get(id) ?? 0;
    let index = 0;
    while (index < ready.length && (position.get(ready[index] ?? "") ?? 0) < at) index += 1;
    ready.splice(index, 0, id);
  };
  for (const node of input.nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) insert(node.id);
  }

  const column = new Map<string, number>();
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    const at = column.get(id) ?? 0;
    column.set(id, at);
    for (const consumer of consumers.get(id) ?? []) {
      // Longest path: a consumer is pushed right of every producer it has, not
      // right of the first one to reach it.
      column.set(consumer, Math.max(column.get(consumer) ?? 0, at + 1));
      const left = (indegree.get(consumer) ?? 0) - 1;
      indegree.set(consumer, left);
      if (left === 0) insert(consumer);
    }
  }

  return column;
}

/**
 * The chain of `in` edges that ends at the picture.
 *
 * Bounded by a seen-set rather than by trust: an illegal cycle in a hand-edited
 * document would otherwise walk for ever, and the editor has to open such a
 * document to be any use in fixing it.
 */
function spineOf(
  input: LayoutInput,
  primary: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const spine = new Set<string>();
  let at = input.output ?? null;
  while (at !== null && !spine.has(at)) {
    spine.add(at);
    at = primary.get(at) ?? null;
  }
  return spine;
}

/**
 * The row a node asks for.
 *
 * The row of the picture it transforms, when it has one — that is what keeps a
 * chain straight, and it is why this is not a plain barycentre over every input:
 * averaging a node's `in` row with its mask's row bends the chain around the
 * decoration instead of hanging the decoration off the chain.
 *
 * With no `in` edge it falls back to the mean of whatever else it reads, which
 * is the ordinary barycentre and is what places a node that only has secondary
 * inputs; with no inputs at all it asks for the top, and column 0's roots then
 * stack in list order.
 */
function preferredRow(
  id: string,
  primary: ReadonlyMap<string, string>,
  producers: ReadonlyMap<string, readonly string[]>,
  row: ReadonlyMap<string, number>,
): number {
  const picture = primary.get(id);
  if (picture !== undefined) {
    const at = row.get(picture);
    if (at !== undefined) return at;
  }
  const from = producers.get(id) ?? [];
  let total = 0;
  let counted = 0;
  for (const producer of from) {
    const at = row.get(producer);
    // A producer with no row yet is one in this same column or a later one,
    // which a DAG makes impossible — but a document with an illegal cycle in it
    // reaches here, and skipping keeps the rest of the layout sane.
    if (at === undefined) continue;
    total += at;
    counted += 1;
  }
  return counted === 0 ? 0 : Math.round(total / counted);
}
