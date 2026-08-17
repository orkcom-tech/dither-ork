import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { BlendMode, StackNode } from "../../types/document";
import type { EffectDescriptor } from "../../types/registry";
import { helpFor } from "../help";
import { NumberField } from "../properties";
import {
  BLEND_LABEL,
  BLEND_MODES,
  EXECUTION_COST,
  EXECUTION_LABEL,
  SLOT_LABEL,
} from "./model";

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
  /**
   * Set when a source node later in the stack replaces the picture outright, so
   * nothing this node produces reaches the frame. Carries the sentence to show,
   * naming the node doing the discarding — see `registry/stack.ts`.
   *
   * Separate from {@link issue}: this is not a grammar error and the stack is
   * not refused. It is a fact about what the render will do, and the row is the
   * only honest place to put it.
   */
  readonly shadowed: string | null;
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
  shadowed,
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
    // The same dimming as below-the-solo-point, because it is the same fact:
    // this row is not in the picture. The note below says which of the two it
    // is, so the shared styling does not make them indistinguishable.
    shadowed !== null ? "node--excluded" : "",
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

        {/*
          Enabled is the ordinary state of a node, so it is drawn in the
          ordinary ink. Twenty accent-coloured dots down the panel would say
          "twenty things are happening here" when what is happening is nothing
          at all — the accent is spent on solo below, which really is a state
          the document is unusually in.
        */}
        <button
          type="button"
          className="node__flag node__flag--enable"
          aria-pressed={node.enabled}
          title={node.enabled ? "Disable this node" : "Enable this node"}
          onClick={onToggleEnabled}
        >
          {node.enabled ? "◉" : "○"}
        </button>

        <button
          type="button"
          className="node__flag node__flag--solo"
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

        {/*
          The name is the first thing to lose width on a narrow panel, so it
          carries its own full text as a tooltip: an ellipsis with nothing
          behind it would make two effects in the same family indistinguishable
          without selecting each of them in turn.
        */}
        {/*
          The name button is this row's help anchor (F-UI-13) — but only when the
          effect is one this build has. A `data-help` naming an id the sealed
          registry does not carry resolves to nothing and the panel would simply
          fail to open, which reads as help being broken rather than as the node
          being unknown; the `unknown` badge already says the true thing.
        */}
        <button
          type="button"
          className="node__name"
          title={effect?.name ?? node.effect}
          {...(effect === undefined ? {} : helpFor({ kind: "effect", effect: effect.id }))}
          onClick={onSelect}
        >
          <span className="node__index">{position + 1}</span>
          <span className="node__title">{effect?.name ?? node.effect}</span>
          {effect === undefined ? (
            <span className="badge badge--warn">unknown</span>
          ) : (
            <>
              <span className="badge badge--slot">{SLOT_LABEL[effect.slot]}</span>
              {/*
                Execution, shown as what it costs. A `cpu` node is a serial
                kernel, and one sitting between GPU nodes is a readback plus an
                upload — docs/ARCHITECTURE.md asks for that ceiling to be
                visible in the UI rather than discovered by profiling, so the
                expensive badge is the loud one and `gpu` is the quiet one.
              */}
              <span
                className={`badge badge--exec badge--exec-${effect.execution}`}
                title={EXECUTION_COST[effect.execution]}
              >
                {EXECUTION_LABEL[effect.execution]}
              </span>
            </>
          )}
        </button>

        {/*
          Duplicate and remove as marks rather than as the words `dup` and `del`.
          The two words cost 58px of a 248px row, which is the difference
          between an effect name being readable and being an ellipsis — and the
          words are still there, in the tooltip and in the accessible name, so
          nothing is lost but the width.
        */}
        <button
          type="button"
          className="node__action"
          title="Duplicate this node"
          aria-label={`Duplicate ${effect?.name ?? node.effect}`}
          onClick={onDuplicate}
        >
          ⧉
        </button>
        <button
          type="button"
          className="node__action"
          title="Remove this node"
          aria-label={`Remove ${effect?.name ?? node.effect}`}
          onClick={onRemove}
        >
          ✕
        </button>
      </div>

      {/*
        The second line, and it is present on every row that knows its effect —
        which is what makes twenty of them scannable. Two things live on it.

        The **requirement id**, first and therefore in a column: a stack is read
        as a whole, and a fixed column of spec ids is how you see at a glance
        that six of these nodes came out of the same section of the spec. It is
        here rather than beside the name because on a 260px panel it and the
        name cannot both have the room, and of the two it is the one that is
        still legible when it is not next to what it describes.

        Then **opacity and blend**, when the node can composite at all.
      */}
      {effect === undefined ? null : (
        <div className="node__controls">
          <span
            className="badge badge--req node__req"
            title={`Implements spec requirement ${effect.requirement}`}
          >
            {effect.requirement}
          </span>

          {composites ? (
            <>
              {/*
                The same numeric control the properties panel uses, in its
                `dense` variant — one line instead of two, which is what it was
                built for. Reusing it rather than a native range input is not
                cosmetic: it is what brackets the drag with
                `beginInteraction`/`endInteraction` on the viewport, under the
                name below, so an opacity drag is visible to the preview-quality
                policy exactly as a parameter drag is.
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
                aria-label={`${effect.name} blend mode`}
                value={node.blend}
                onChange={(event) => onBlend(event.currentTarget.value as BlendMode)}
              >
                {BLEND_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {BLEND_LABEL[mode]}
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>
      )}

      {shadowed === null ? null : <p className="node__shadowed">{shadowed}</p>}
      {issue === null ? null : <p className="node__issue">{issue}</p>}
    </li>
  );
}
