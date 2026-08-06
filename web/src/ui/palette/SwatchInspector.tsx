import React from "react";

import type { SrgbTriplet } from "../../types/document";
import { formatHex, parseHex } from "./color";
import { Action } from "./controls";
import { MAX_SWATCHES, MIN_SWATCHES } from "./model";
import type { Swatch } from "./model";

/**
 * Everything F-CO-05 does to one swatch: edit by hex or by picker, lock,
 * move, duplicate, remove.
 *
 * The hex field and the native picker write the same edit. They are both here
 * because they are not the same tool — the picker is how a colour is chosen,
 * the hex field is how a colour is *transcribed*, and a palette editor without
 * the second one cannot take a value off a hardware datasheet.
 *
 * The hex field commits on blur or Enter and refuses what it cannot parse.
 * It does not substitute black for a typo, which is the failure that gets
 * discovered at export rather than at the keyboard.
 */

export interface SwatchInspectorProps {
  readonly swatches: readonly Swatch[];
  readonly index: number;
  readonly onSet: (index: number, rgb: SrgbTriplet) => void;
  readonly onLock: (index: number, locked: boolean) => void;
  readonly onMove: (from: number, to: number) => void;
  readonly onAdd: (rgb: SrgbTriplet) => void;
  readonly onRemove: (index: number) => void;
}

export function SwatchInspector({
  swatches,
  index,
  onSet,
  onLock,
  onMove,
  onAdd,
  onRemove,
}: SwatchInspectorProps): React.ReactElement | null {
  const swatch = swatches[index];
  const hex = swatch === undefined ? "" : formatHex(swatch.rgb);
  const [draft, setDraft] = React.useState(hex);
  const [invalid, setInvalid] = React.useState(false);

  React.useEffect(() => {
    setDraft(hex);
    setInvalid(false);
  }, [hex]);

  if (swatch === undefined) return null;

  const commitHex = (): void => {
    const parsed = parseHex(draft);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(formatHex(parsed));
    onSet(index, parsed);
  };

  const atStart = index === 0;
  const atEnd = index === swatches.length - 1;
  const full = swatches.length >= MAX_SWATCHES;
  const last = swatches.length <= MIN_SWATCHES;

  return (
    <div className="pal__inspector">
      <div className="pal__row">
        <input
          className="pal__picker"
          type="color"
          value={hex}
          aria-label={`colour of swatch ${index}`}
          title="pick a colour"
          onChange={(event) => {
            const parsed = parseHex(event.target.value);
            if (parsed !== null) onSet(index, parsed);
          }}
        />
        <input
          className="pal__input pal__input--hex"
          type="text"
          spellCheck={false}
          value={draft}
          aria-label={`hex value of swatch ${index}`}
          aria-invalid={invalid}
          title={invalid ? "expected #rgb or #rrggbb" : "hex value — Enter to apply"}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitHex}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitHex();
            }
            if (event.key === "Escape") {
              setDraft(hex);
              setInvalid(false);
            }
          }}
        />
        <button
          type="button"
          className="ui-button"
          aria-pressed={swatch.locked}
          title={
            swatch.locked
              ? "locked: re-extraction keeps this colour and its position"
              : "lock this colour against re-extraction"
          }
          onClick={() => onLock(index, !swatch.locked)}
        >
          lock
        </button>
      </div>

      {invalid ? <p className="pal__error">expected #rgb or #rrggbb</p> : null}

      <div className="pal__row">
        <Action
          label="◀"
          title="move this swatch one position earlier"
          onClick={() => onMove(index, index - 1)}
          {...(atStart ? { blocked: "already the first swatch" } : {})}
        />
        <Action
          label="▶"
          title="move this swatch one position later"
          onClick={() => onMove(index, index + 1)}
          {...(atEnd ? { blocked: "already the last swatch" } : {})}
        />
        <Action
          label="duplicate"
          title="add a copy of this colour to the end"
          onClick={() => onAdd(swatch.rgb)}
          {...(full ? { blocked: `a palette tops out at ${MAX_SWATCHES} colours` } : {})}
        />
        <Action
          label="remove"
          title="remove this swatch"
          onClick={() => onRemove(index)}
          {...(last ? { blocked: `a palette needs at least ${MIN_SWATCHES} colours` } : {})}
        />
      </div>

      <p className="pal__readout">
        <span>swatch {index}</span>
        <span>{hex}</span>
        <span>
          {swatch.population === null
            ? "no population"
            : `${swatch.population.toLocaleString()} px`}
        </span>
      </p>
    </div>
  );
}
