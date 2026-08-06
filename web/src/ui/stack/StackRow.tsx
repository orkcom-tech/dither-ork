import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { StackNode } from "../../types/document";
import type { EffectDescriptor } from "../../types/registry";
import { EXECUTION_LABEL, SLOT_LABEL } from "./model";

export interface StackRowProps {
  readonly node: StackNode;
  /** Absent when the document names an effect this build does not have. */
  readonly effect: EffectDescriptor | undefined;
  readonly position: number;
  readonly selected: boolean;
  readonly soloed: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  /** Below the solo point, so it is not in the render. */
  readonly excluded: boolean;
  /** A grammar issue this node is the subject of, ready to show. */
  readonly issue: string | null;
  readonly onSelect: () => void;
  readonly onToggleEnabled: () => void;
  readonly onToggleSolo: () => void;
  readonly onDuplicate: () => void;
  readonly onRemove: () => void;
  /** One position earlier (-1) or later (+1) in the stack. */
  readonly onMove: (direction: -1 | 1) => void;
}

/**
 * One node in the stack.
 *
 * F-ST-02 is on this row — enable and solo — because they are properties of the
 * node *as a layer* rather than parameters of the effect, and putting them in
 * the properties panel would mean two places to look for what a row does.
 *
 * **F-ST-03, per-node opacity and blend, is not here.** The fields are in the
 * document schema and round trip, but neither render backend composites: both
 * `state/render/gpu-backend.ts` and `state/render/wasm-backend.ts` refuse a
 * node carrying a non-identity composite by name rather than silently drawing
 * it at full opacity. A row that offered the two controls would therefore have
 * offered a slider whose only effect is to make the next render fail, so they
 * are left out until compositing exists rather than shipped as something that
 * looks like it works.
 */
export function StackRow({
  node,
  effect,
  position,
  selected,
  soloed,
  canMoveUp,
  canMoveDown,
  excluded,
  issue,
  onSelect,
  onToggleEnabled,
  onToggleSolo,
  onDuplicate,
  onRemove,
  onMove,
}: StackRowProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: node.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform) ?? undefined,
    transition: transition ?? undefined,
  };

  const className = [
    "node",
    selected ? "node--selected" : "",
    node.enabled ? "" : "node--off",
    excluded ? "node--excluded" : "",
    isDragging ? "node--dragging" : "",
    issue !== null ? "node--issue" : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  return (
    <li ref={setNodeRef} style={style} className={className}>
      <div className="node__main">
        <button
          type="button"
          className="node__grip"
          title="Drag to reorder, or focus and press space then use the arrow keys"
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>

        <div className="node__steps">
          <button
            type="button"
            className="node__step"
            disabled={!canMoveUp}
            title="Move this node one position earlier"
            aria-label={`Move ${effect?.name ?? node.effect} earlier`}
            onClick={() => onMove(-1)}
          >
            ▲
          </button>
          <button
            type="button"
            className="node__step"
            disabled={!canMoveDown}
            title="Move this node one position later"
            aria-label={`Move ${effect?.name ?? node.effect} later`}
            onClick={() => onMove(1)}
          >
            ▼
          </button>
        </div>

        <button
          type="button"
          className="node__flag"
          aria-pressed={node.enabled}
          title={node.enabled ? "Disable this node" : "Enable this node"}
          onClick={onToggleEnabled}
        >
          {node.enabled ? "◉" : "○"}
        </button>

        <button
          type="button"
          className="node__flag"
          aria-pressed={soloed}
          title={
            soloed
              ? "Stop soloing — render the whole stack"
              : "Solo — render up to and including this node"
          }
          onClick={onToggleSolo}
        >
          S
        </button>

        <button type="button" className="node__name" onClick={onSelect}>
          <span className="node__index">{position + 1}</span>
          <span className="node__title">{effect?.name ?? node.effect}</span>
          {effect === undefined ? (
            <span className="badge badge--warn">unknown</span>
          ) : (
            <>
              <span className="badge">{SLOT_LABEL[effect.slot]}</span>
              <span className="badge">{EXECUTION_LABEL[effect.execution]}</span>
            </>
          )}
        </button>

        <button
          type="button"
          className="node__action"
          title="Duplicate this node"
          onClick={onDuplicate}
        >
          dup
        </button>
        <button
          type="button"
          className="node__action"
          title="Remove this node"
          onClick={onRemove}
        >
          del
        </button>
      </div>

      {issue === null ? null : <p className="node__issue">{issue}</p>}
    </li>
  );
}
