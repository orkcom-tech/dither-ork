import React from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

import { logger } from "../../lib/log";
import { validateStack, type EffectRegistry } from "../../registry";
// `field__note` lives there and the stack's empty state uses it. Imported here
// rather than left to the properties panel's own import, so that this panel
// styles correctly whatever else happens to be registered.
import "../properties/properties.css";
import { AddNodePicker } from "./AddNodePicker";
import { StackRow } from "./StackRow";
import { describeRows, shapeNote } from "./graph-view";
import {
  indexOfNode,
  insertionIndex,
  isExcludedBySolo,
  judgeCandidate,
  liveStack,
  moveItem,
  nodeById,
  stackRefs,
} from "./model";
import type { DocumentStore } from "./store";
import "./stack.css";

const log = logger("app");

export interface StackPanelProps {
  readonly store: DocumentStore;
  readonly registry: EffectRegistry;
}

/**
 * The stack editor — F-ST-01, 02 and 08.
 *
 * Add, remove, duplicate and drag-reorder; per-node enable and solo. The
 * catalogue it adds from is the sealed registry, and the grammar it enforces is
 * `validateStack` — neither is restated here. F-ST-03 (per-node opacity and
 * blend) is on the row, for the reason given on {@link StackRow}.
 *
 * ## What it refuses, and what it does not
 *
 * A node may not be **added** or **reordered** into a position that introduces
 * a grammar problem the stack did not already have; the reason is shown rather
 * than the row silently springing back. Delete and disable are *not* refused,
 * even when they leave a node downstream without the index map it reads: a
 * refusal there is a stack a user cannot get out of, and the issue is already
 * visible on the row it belongs to. So the rule is one sentence — the editor
 * will not build an invalid stack for you, and it will not trap you in one you
 * built yourself.
 */
export function StackPanel({ store, registry }: StackPanelProps): React.ReactElement {
  // Wrapped rather than passed as bare method references: `useSyncExternalStore`
  // calls them unbound, and the store is somebody else's object.
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getSnapshot = React.useCallback(() => store.getSnapshot(), [store]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);

  const [adding, setAdding] = React.useState(false);
  /** The last refusal, kept on screen until the next successful edit. */
  const [refusal, setRefusal] = React.useState<string | null>(null);

  const stack = snapshot.document.stack;
  const refs = React.useMemo(() => stackRefs(stack), [stack]);
  const insertAt = insertionIndex(stack, snapshot.selectedNodeId);

  /**
   * Where each row sits in the wiring, and what a source node discards.
   *
   * The panel is a **view onto the graph**, not a second model of it: it lists
   * every node in the document's own order and this says how each one is
   * connected. On a chain — every document written before schema 2 — every row
   * comes back plain and the panel is exactly what it was. See `./graph-view.ts`
   * for the argument.
   *
   * The shadow analysis comes from here rather than from `registry/stack.ts`'s
   * `analyseSources`, and that swap is a bug fix rather than a preference: that
   * function decides what a source node throws away from its **position in the
   * list**, which stopped being the wiring at schema 2. A generator feeding some
   * node's mask port sits at the end of the list and discards nothing, and the
   * positional answer marks the whole chain as thrown away — a confident, false
   * sentence on every row. The reasoning is on `describeRows`.
   */
  const view = React.useMemo(
    () =>
      describeRows(
        {
          stack,
          edges: snapshot.document.edges,
          output: snapshot.document.output,
        },
        registry,
      ),
    [stack, snapshot.document.edges, snapshot.document.output, registry],
  );
  const shape = shapeNote(view);

  const issues = React.useMemo(() => {
    const validation = validateStack(registry, refs);
    const byNode = new Map<string, string>();
    for (const issue of validation.issues) {
      if (!byNode.has(issue.nodeId)) byNode.set(issue.nodeId, issue.message);
    }
    return byNode;
  }, [registry, refs]);

  const sensors = useSensors(
    // A few pixels of slop so that clicking a row to select it is not read as
    // the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * The one path a reorder takes, whichever gesture asked for it.
   *
   * Both the drag and the step buttons end here, so the grammar is consulted
   * once and a refusal reads the same however it was provoked. Two code paths
   * would eventually be two answers to "may this node go there".
   */
  const reorder = (nodeId: string, from: number, to: number, how: string): void => {
    if (from === -1 || to === -1 || from === to) return;

    const verdict = judgeCandidate(registry, refs, moveItem(refs, from, to));
    if (!verdict.ok) {
      log.warn("reorder refused by the stack grammar", {
        node: nodeId,
        from,
        to,
        how,
        reason: verdict.reason,
      });
      setRefusal(verdict.reason);
      return;
    }

    log.info("node reordered", { node: nodeId, from, to, how });
    setRefusal(null);
    store.moveNode(nodeId, to);
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const activeId = String(event.active.id);
    const overId = event.over === null ? null : String(event.over.id);
    if (overId === null || overId === activeId) return;

    const from = indexOfNode(stack, activeId);
    const to = indexOfNode(stack, overId);
    if (from === -1 || to === -1) {
      log.warn("reorder ignored: a dragged node is no longer in the stack", {
        from: activeId,
        to: overId,
      });
      return;
    }
    reorder(activeId, from, to, "drag");
  };

  /**
   * Move a node one position.
   *
   * The rows carry these as buttons beside the grip, because a drag is not the
   * only way somebody reorders a stack and for some people it is not a way at
   * all: `@dnd-kit`'s keyboard alternative is a chord on a focused handle,
   * which is undiscoverable and which nothing in the UI can announce. One
   * button per direction is the same operation with a name on it.
   */
  const step = (nodeId: string, direction: -1 | 1): void => {
    const from = indexOfNode(stack, nodeId);
    reorder(nodeId, from, from + direction, direction === -1 ? "step-up" : "step-down");
  };

  const add = (effectId: string): void => {
    const created = store.addNode(effectId, insertAt);
    store.selectNode(created);
    setAdding(false);
    setRefusal(null);
    log.info("node added", { effect: effectId, at: insertAt, node: created });
  };

  const duplicate = (nodeId: string): void => {
    const created = store.duplicateNode(nodeId);
    store.selectNode(created);
    setRefusal(null);
    log.info("node duplicated", { from: nodeId, node: created });
  };

  const soloNode = nodeById(stack, snapshot.soloNodeId);
  const rendered = liveStack(stack, snapshot.soloNodeId).length;

  return (
    <div className="stack">
      <div className="stack__bar">
        <button
          type="button"
          className="ui-button"
          aria-pressed={adding}
          onClick={() => setAdding((open) => !open)}
        >
          add node
        </button>
        <span className="stack__count">
          {stack.length} node{stack.length === 1 ? "" : "s"} · {rendered} rendering
        </span>
      </div>

      {/*
        Shown only when there is something to say. A line reading "this is a
        chain" on every document anybody has ever made is noise that teaches
        people to stop reading this bar.
      */}
      {shape === null ? null : <p className="stack__shape">{shape}</p>}

      {soloNode === undefined ? null : (
        <div className="stack__solo">
          <span>
            solo to <b>{registry.get(soloNode.effect)?.name ?? soloNode.effect}</b>
          </span>
          <button
            type="button"
            className="ui-button"
            onClick={() => {
              log.info("solo cleared");
              store.setSolo(null);
            }}
          >
            clear
          </button>
        </div>
      )}

      {refusal === null ? null : (
        <div className="stack__refusal">
          <span>{refusal}</span>
          <button
            type="button"
            className="ui-button"
            onClick={() => setRefusal(null)}
          >
            ok
          </button>
        </div>
      )}

      {adding ? (
        // In place of the list rather than over it. The panel body scrolls, so
        // an overlay would cover one screenful of a stack that is taller than
        // one, and the picker has a scrolling list of its own.
        <AddNodePicker
          registry={registry}
          stack={refs}
          insertAt={insertAt}
          onPick={add}
          onClose={() => setAdding(false)}
        />
      ) : stack.length === 0 ? (
        <p className="field__note stack__empty">
          The stack is empty. Add an effect to start building one.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={stack.map((node) => node.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="stack__list">
              {stack.map((node, position) => (
                <StackRow
                  key={node.id}
                  node={node}
                  effect={registry.get(node.effect)}
                  position={position}
                  selected={node.id === snapshot.selectedNodeId}
                  soloed={node.id === snapshot.soloNodeId}
                  canMoveUp={position > 0}
                  canMoveDown={position < stack.length - 1}
                  onMove={(direction) => step(node.id, direction)}
                  onOpacity={(opacity, continuous) => {
                    store.setNodeOpacity(node.id, opacity, { continuous });
                  }}
                  onBlend={(blend) => {
                    log.info("node blend changed", { node: node.id, blend });
                    store.setNodeBlend(node.id, blend);
                  }}
                  excluded={isExcludedBySolo(stack, snapshot.soloNodeId, position)}
                  shadowed={view.shadowed.get(node.id) ?? null}
                  issue={issues.get(node.id) ?? null}
                  wiring={view.rows.get(node.id) ?? null}
                  onSelect={() => store.selectNode(node.id)}
                  onToggleEnabled={() => {
                    log.info("node enable toggled", {
                      node: node.id,
                      enabled: !node.enabled,
                    });
                    store.setNodeEnabled(node.id, !node.enabled);
                  }}
                  onToggleSolo={() => {
                    const next = snapshot.soloNodeId === node.id ? null : node.id;
                    log.info("solo changed", { node: next ?? "none" });
                    store.setSolo(next);
                  }}
                  onDuplicate={() => duplicate(node.id)}
                  onRemove={() => {
                    log.info("node removed", { node: node.id, effect: node.effect });
                    store.removeNode(node.id);
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
