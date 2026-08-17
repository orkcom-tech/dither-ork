/**
 * Working the graph without a pointer.
 *
 * A node editor that only works with a mouse excludes people, and this
 * application already respects `prefers-reduced-motion` and keyboard focus
 * everywhere else. So every gesture the editor has exists twice, and the second
 * one is not a consolation: selecting, connecting, disconnecting, deleting,
 * duplicating, choosing the output and panning are all reachable from the
 * keyboard, and connecting in particular is a **first-class path** rather than a
 * drag simulated with arrow keys.
 *
 * The arithmetic lives here so it can be tested without a DOM — the component
 * turns key events into calls on these functions and does nothing else with
 * them.
 *
 * ## Why moving is geometric rather than following the wiring
 *
 * Left and right could mean "the node I read" and "a node that reads me". They
 * mean "the nearest card that way" instead, and the two agree almost always,
 * because the layout **is** the wiring: a node sits one column right of
 * everything it reads (`layout.ts`). Where they differ is a node with two
 * consumers, and there the wiring rule has to invent a tie-break that the user
 * cannot see, while the geometric one moves to the card they are looking at.
 *
 * ## Why connecting steps a list rather than aiming
 *
 * Aiming a wire with arrow keys is a drag with worse ergonomics. Instead,
 * starting a connection produces every port that wire could be dropped on — the
 * same {@link DropTarget}s the pointer path snaps to, judged by the same code —
 * and the arrows step through them in reading order while the refusal or the
 * consequence is shown for the one under the cursor. Illegal targets are
 * included and landed on, exactly as the effect picker includes effects that
 * cannot go where the caret is: the reason is the thing worth reaching.
 */

import type { EditorGraph, EditorNode, DropTarget } from "./model";

/** The four arrow directions, as the component names them. */
export type Direction = "left" | "right" | "up" | "down";

/**
 * The node an arrow key moves to, or `null` when there is nothing that way.
 *
 * Clamped rather than wrapped, like the picker's row stepping: wrapping from the
 * last column to the first in a graph reads as a jump to somewhere else rather
 * than as a move.
 */
export function stepSelection(
  graph: EditorGraph,
  currentId: string | null,
  direction: Direction,
): string | null {
  if (graph.nodes.length === 0) return null;
  const current = currentId === null ? undefined : graph.byId.get(currentId);
  if (current === undefined) {
    // Nothing selected: the first card in reading order, which is the leftmost
    // top-most one and therefore where the graph starts.
    return graph.nodes[0]?.id ?? null;
  }

  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "right" || direction === "down" ? 1 : -1;

  const candidates = graph.nodes.filter((node) => {
    if (node.id === current.id) return false;
    const primary = horizontal
      ? node.layout.column - current.layout.column
      : node.layout.row - current.layout.row;
    if (sign > 0 ? primary <= 0 : primary >= 0) return false;
    // Vertical movement stays in the column. A graph's columns are its stages,
    // and jumping between stages when asked to move down is the one thing that
    // would make arrow navigation impossible to predict.
    return horizontal || node.layout.column === current.layout.column;
  });

  let best: EditorNode | null = null;
  let bestKey: readonly [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  for (const node of candidates) {
    const key: readonly [number, number] = horizontal
      ? [
          Math.abs(node.layout.column - current.layout.column),
          Math.abs(node.layout.row - current.layout.row),
        ]
      : [
          Math.abs(node.layout.row - current.layout.row),
          Math.abs(node.layout.column - current.layout.column),
        ];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = node;
      bestKey = key;
    }
  }
  return best?.id ?? null;
}

/**
 * Move the connection cursor by `delta` targets.
 *
 * Clamped, and it lands on refused targets: their refusal is written to be read,
 * and a cursor that skipped them would make an illegal port look like a port
 * that does not exist.
 */
export function stepTarget(
  targets: readonly DropTarget[],
  current: number,
  delta: number,
): number {
  if (targets.length === 0) return -1;
  const from = current < 0 ? (delta > 0 ? -1 : targets.length) : current;
  const next = from + delta;
  return next < 0 ? 0 : next > targets.length - 1 ? targets.length - 1 : next;
}

/**
 * Where the connection cursor opens.
 *
 * The first target that could actually be committed, so the commonest wiring is
 * one key away; the first target of any kind when none is legal, because
 * something has to be on screen for the refusal to be attached to.
 */
export function firstConnectable(targets: readonly DropTarget[]): number {
  const legal = targets.findIndex((target) => target.refusal === null);
  if (legal >= 0) return legal;
  return targets.length === 0 ? -1 : 0;
}

/**
 * The keyboard reference the editor prints.
 *
 * Written here rather than in the component because it has to stay true, and the
 * only way it does is by sitting next to the functions the keys call. It is
 * shown in the editor rather than hidden in documentation nobody opens — F-UI-13
 * is the same argument for hover help.
 */
export interface Shortcut {
  readonly keys: string;
  readonly what: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: "Arrows", what: "move between nodes" },
  { keys: "C", what: "start a connection from the selected node" },
  { keys: "Arrows, Enter", what: "choose the port and connect" },
  { keys: "Esc", what: "abandon the connection" },
  { keys: "X", what: "disconnect the selected node's inputs" },
  { keys: "Enter", what: "make the selected node the picture" },
  { keys: "D", what: "duplicate" },
  { keys: "Delete", what: "remove" },
  { keys: "+ / -", what: "zoom" },
  { keys: "0", what: "fit the whole graph" },
];
