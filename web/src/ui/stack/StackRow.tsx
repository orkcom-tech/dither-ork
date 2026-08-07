import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { BlendMode, StackNode } from "../../types/document";
import type { EffectDescriptor } from "../../types/registry";
import { NumberField } from "../properties";
import { BLEND_LABEL, BLEND_MODES, EXECUTION_LABEL, SLOT_LABEL } from "./model";

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
  /** `continuous` while the slider is being dragged, so a drag is one undo step. */
  readonly onOpacity: (opacity: number, continuous: boolean) => void;
  readonly onBlend: (blend: BlendMode) => void;
}

/**
 * One node in the stack.
 *
 * F-ST-02 is on this row — enable and solo — because they are properties of the
 * node *as a layer* rather than parameters of the effect, and putting them in
 * the properties panel would mean two places to look for what a row does.
 *
 * **F-ST-03, per-node opacity and blend, is here too**, and for the same
 * reason: they say how much of this node's result reaches the picture, which is
 * a property of the node as a layer rather than a parameter of the effect. Both
 * backends composite — `graph/blend.ts` holds the arithmetic and each execution
 * kind applies it — so both controls move the picture.
 *
 * **They are hidden on a node that resamples** (internal resolution, nearest
 * upscale). A composite blends a node's output with its own input pixel for
 * pixel, and a node that writes a different extent than it reads has no
 * pixel-for-pixel correspondence with its input at all; `graph/plan.ts` refuses
 * that combination by name. Offering a slider that can only produce an error is
 * the thing this row was cleaned up to stop doing, so the row does not offer
 * it — a hidden control rather than a disabled one, because there is nothing
 * the user could change to make it apply.
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
  onOpacity,
  onBlend,
}: StackRowProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: node.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform) ?? undefined,
    transition: transition ?? undefined,
  };

  // A node whose output is a different shape than its input cannot composite
  // against that input at all — see the note above the component. An unknown
  // effect gets no controls either: nothing is known about what it writes.
  const composites = effect !== undefined && effect.resamples !== true;

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

      {composites ? (
        <div className="node__controls">
          {/*
            The same numeric control the properties panel uses, in its `dense`
            variant — one line instead of two, which is what it was built for.
            Reusing it rather than a native range input is not cosmetic: it is
            what brackets the drag with `beginInteraction`/`endInteraction` on
            the viewport, under the name below, so an opacity drag is visible to
            the preview-quality policy exactly as a parameter drag is.
          */}
          <NumberField
            label="Opacity"
            value={node.opacity}
            min={0}
            max={1}
            step={0.01}
            interaction={`opacity:${node.id}`}
            dense
            onChange={(value) => onOpacity(value, true)}
          />
          <select
            className="select select--dense"
            aria-label={`${effect?.name ?? node.effect} blend mode`}
            value={node.blend}
            onChange={(event) => onBlend(event.currentTarget.value as BlendMode)}
          >
            {BLEND_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {BLEND_LABEL[mode]}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {issue === null ? null : <p className="node__issue">{issue}</p>}
    </li>
  );
}
