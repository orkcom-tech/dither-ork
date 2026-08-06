import React from "react";

import { formatHex, inkOn } from "./color";
import type { Swatch } from "./model";

/**
 * The swatch grid — the selectable, reorderable body of F-CO-05.
 *
 * Reordering is a drag, and the drop dispatches a *move* rather than a
 * rewritten list, so the store can emit the permutation that keeps index maps
 * addressing the right entries. The same move is on the keyboard through the
 * inspector's arrows, because a reorder that exists only as a mouse gesture is
 * a reorder half the users of this panel cannot perform.
 *
 * A swatch's inline `background` is the only place this panel writes a colour
 * that is not a theme custom property, and it is not a style decision: it is
 * the datum. The ink drawn on top of it *is* a theme decision, and comes from
 * the theme's own inks, picked by the swatch's perceptual lightness.
 */

export interface SwatchGridProps {
  readonly swatches: readonly Swatch[];
  readonly selected: number;
  readonly onSelect: (index: number) => void;
  readonly onMove: (from: number, to: number) => void;
  readonly onToggleLock: (index: number, locked: boolean) => void;
}

export function SwatchGrid({
  swatches,
  selected,
  onSelect,
  onMove,
  onToggleLock,
}: SwatchGridProps): React.ReactElement {
  const [dragging, setDragging] = React.useState<number | null>(null);
  const [over, setOver] = React.useState<number | null>(null);

  const end = (): void => {
    setDragging(null);
    setOver(null);
  };

  return (
    <ul className="pal__grid">
      {swatches.map((swatch, index) => {
        const hex = formatHex(swatch.rgb);
        const detail =
          swatch.population === null
            ? `${index} · ${hex}`
            : `${index} · ${hex} · ${swatch.population.toLocaleString()} px`;
        const ink = inkOn(swatch.rgb);

        return (
          <li
            key={index}
            className="pal__cell"
            data-over={index === over && dragging !== null && dragging !== index}
            data-dragging={index === dragging}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", String(index));
              event.dataTransfer.effectAllowed = "move";
              setDragging(index);
              onSelect(index);
            }}
            onDragOver={(event) => {
              // Without this the drop never fires: the default for a drag over
              // an element is to refuse it.
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setOver(index);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const from = Number.parseInt(event.dataTransfer.getData("text/plain"), 10);
              end();
              if (Number.isInteger(from) && from !== index) onMove(from, index);
            }}
            onDragEnd={end}
          >
            <button
              type="button"
              className="pal__swatch"
              style={{ background: hex }}
              aria-pressed={index === selected}
              aria-label={detail}
              title={`${detail}${swatch.locked ? " · locked" : ""}`}
              onClick={() => onSelect(index)}
            >
              <span className="pal__swatch-index" data-ink={ink}>
                {index}
              </span>
            </button>
            <button
              type="button"
              className="pal__lock"
              data-locked={swatch.locked}
              data-ink={ink}
              aria-label={
                swatch.locked
                  ? `unlock swatch ${index}`
                  : `lock swatch ${index} against re-extraction`
              }
              title={
                swatch.locked
                  ? "locked against re-extraction — click to unlock"
                  : "lock against re-extraction"
              }
              onClick={() => onToggleLock(index, !swatch.locked)}
            >
              {swatch.locked ? "L" : "·"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
