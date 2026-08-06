import React from "react";

import { logger } from "../../lib/log";
import type { EffectFilter, EffectRegistry, StackNodeRef } from "../../registry";
import type { NodeSlot } from "../../types/document";
import { EXECUTION_LABEL, SLOT_LABEL } from "./model";
import { buildPicker, firstAvailable, flatten, stepHighlight } from "./picker";

const log = logger("app");

const SLOT_FILTERS: readonly (NodeSlot | null)[] = [
  null,
  "preprocess",
  "dither",
  "postprocess",
];

export interface AddNodePickerProps {
  readonly registry: EffectRegistry;
  /** The stack a candidate is judged against. */
  readonly stack: readonly StackNodeRef[];
  readonly insertAt: number;
  readonly onPick: (effectId: string) => void;
  readonly onClose: () => void;
}

/**
 * The add-node panel — F-ST-08.
 *
 * Search over the whole catalogue, grouped by family, with each effect's slot
 * and execution on the row. Everything on screen comes from the sealed
 * registry; there is no list of effects in this file and no per-effect rule.
 *
 * An effect that cannot legally go at the insertion point is shown, disabled,
 * with the reason — rather than hidden. Hiding it produces the worse question:
 * the user knows the effect exists, cannot find it, and has nothing to read.
 */
export function AddNodePicker({
  registry,
  stack,
  insertAt,
  onPick,
  onClose,
}: AddNodePickerProps): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [slot, setSlot] = React.useState<NodeSlot | null>(null);
  const [highlighted, setHighlighted] = React.useState<string | null>(null);
  const search = React.useRef<HTMLInputElement | null>(null);
  const rows = React.useRef(new Map<string, HTMLButtonElement>());

  const filter: EffectFilter = slot === null ? {} : { slot };
  // `filter` is rebuilt every render and is derived entirely from `slot`, which
  // is what the dependency list names. Listing the object itself would defeat
  // the memo, and this rebuilds the whole grouped model.
  const model = React.useMemo(
    () => buildPicker({ registry, stack, insertAt, query, filter }),
    [registry, stack, insertAt, query, slot],
  );
  const entries = React.useMemo(() => flatten(model), [model]);

  // The highlight follows the results: a query that no longer contains the
  // highlighted effect must not leave Enter committing something off screen.
  React.useEffect(() => {
    setHighlighted((current) => {
      if (current !== null && entries.some((e) => e.effect.id === current)) {
        return current;
      }
      return firstAvailable(model)?.id ?? entries[0]?.effect.id ?? null;
    });
  }, [entries, model]);

  React.useEffect(() => {
    search.current?.focus();
  }, []);

  React.useEffect(() => {
    if (highlighted === null) return;
    rows.current.get(highlighted)?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const commit = (effectId: string): void => {
    const entry = entries.find((candidate) => candidate.effect.id === effectId);
    if (entry === undefined) {
      log.warn("add refused: effect is not in the current results", {
        effect: effectId,
      });
      return;
    }
    if (!entry.available) {
      log.warn("add refused by the stack grammar", {
        effect: effectId,
        insertAt,
        reason: entry.reason,
      });
      return;
    }
    onPick(effectId);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlighted(stepHighlight(entries, highlighted, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlighted(stepHighlight(entries, highlighted, -1));
        break;
      case "Enter":
        event.preventDefault();
        if (highlighted !== null) commit(highlighted);
        break;
      case "Escape":
        event.preventDefault();
        onClose();
        break;
      default:
        break;
    }
  };

  // Why the highlighted effect cannot be added, when it cannot. Shown at the
  // foot rather than only in a tooltip, because a keyboard user reaching a
  // blocked row with the arrow keys never sees a tooltip.
  const blockedReason =
    highlighted === null
      ? null
      : (entries.find((entry) => entry.effect.id === highlighted)?.reason ?? null);

  return (
    <div className="picker" onKeyDown={onKeyDown}>
      <div className="picker__head">
        <input
          ref={search}
          className="picker__search"
          type="search"
          spellCheck={false}
          placeholder={`Search ${model.total} effects — name, family, or F-XX-NN`}
          aria-label="Search effects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="ui-button" onClick={onClose}>
          close
        </button>
      </div>

      <div className="picker__slots">
        {SLOT_FILTERS.map((candidate) => (
          <button
            key={candidate ?? "all"}
            type="button"
            className="ui-button"
            aria-pressed={slot === candidate}
            onClick={() => setSlot(candidate)}
          >
            {candidate === null ? "all" : SLOT_LABEL[candidate]}
          </button>
        ))}
      </div>

      <div className="picker__list ui-scroll">
        {model.groups.length === 0 ? (
          <p className="field__note picker__none">
            Nothing matches <b>{query}</b>.
          </p>
        ) : (
          model.groups.map((group) => (
            <section key={group.family} className="picker__group">
              <h3 className="picker__family">{group.label}</h3>
              {group.entries.map((entry) => (
                <button
                  key={entry.effect.id}
                  type="button"
                  ref={(element) => {
                    if (element === null) rows.current.delete(entry.effect.id);
                    else rows.current.set(entry.effect.id, element);
                  }}
                  className={`picker__row${
                    highlighted === entry.effect.id ? " picker__row--on" : ""
                  }${entry.available ? "" : " picker__row--blocked"}`}
                  disabled={!entry.available}
                  title={entry.reason ?? `Add ${entry.effect.name}`}
                  onPointerEnter={() => setHighlighted(entry.effect.id)}
                  onClick={() => commit(entry.effect.id)}
                >
                  <span className="picker__name">{entry.effect.name}</span>
                  <span className="badge">{SLOT_LABEL[entry.effect.slot]}</span>
                  <span className="badge">
                    {EXECUTION_LABEL[entry.effect.execution]}
                  </span>
                  <span className="badge badge--quiet">
                    {entry.effect.requirement}
                  </span>
                </button>
              ))}
            </section>
          ))
        )}
      </div>

      <footer className="picker__foot">
        <span className="field__note">
          {model.matched} of {model.total}
          {model.unavailable > 0
            ? ` — ${model.unavailable} cannot go here`
            : ""}
        </span>
      </footer>

      {blockedReason === null ? null : (
        <p className="picker__reason">{blockedReason}</p>
      )}
    </div>
  );
}
