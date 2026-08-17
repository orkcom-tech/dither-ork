import React from "react";

import { logger } from "../../lib/log";
import {
  describeMiss,
  type EffectFilter,
  type EffectRegistry,
  type StackNodeRef,
} from "../../registry";
import type { NodeSlot } from "../../types/document";
import { EFFECT_CONCEPTS } from "../../types/registry";
import { helpFor } from "../help";
// `.badge` and `.field__note` live there and this panel wears both. Imported
// here rather than left to the properties panel's own import, so that the picker
// styles correctly whatever else happens to be registered — the same reason
// `StackPanel` imports it.
import "../properties/properties.css";
import { EXECUTION_LABEL, SLOT_LABEL, SLOT_ORDER } from "../stack/model";
import type { MatchReason, Segment } from "./match";
import {
  buildPicker,
  entryOf,
  firstAvailable,
  flatten,
  stepHighlight,
  type PickerEntry,
} from "./model";
import "./picker.css";

const log = logger("app");

/**
 * The filter chips: "all", then the slots in the order a stack runs in.
 *
 * The order comes from `SLOT_ORDER` rather than being written out again here,
 * so adding a slot cannot give the picker a different reading order than the
 * badge and the guide have.
 */
const SLOT_FILTERS: readonly (NodeSlot | null)[] = [null, ...SLOT_ORDER];

export interface EffectPickerProps {
  readonly registry: EffectRegistry;
  /** The stack a candidate is judged against. */
  readonly stack: readonly StackNodeRef[];
  readonly insertAt: number;
  readonly onPick: (effectId: string) => void;
  readonly onClose: () => void;
}

/**
 * The effect picker — F-ST-08, and where F-UI-13 and F-UI-15 are actually used.
 *
 * This is the most-used control in the application and it was, for a while, the
 * one that cost the most time. Four things it does are answers to a specific
 * failure rather than to a design preference:
 *
 * - **It searches everything an effect says about itself**, not its name. The
 *   glow effect is called "Epsilon glow" after the reference product, so a search
 *   over names does not find "glow" — and every reader who types "glow" concludes
 *   the tool has no glow.
 * - **It shows why each result appeared.** Matching a keyword or a sentence of
 *   prose puts rows on screen whose connection to the query is invisible, and an
 *   unexplained result is only slightly better than no result.
 * - **It shows the one-line summary.** Sixty-seven bare names is a list, not a
 *   picker; the name is the least informative thing an effect carries.
 * - **It admits its gaps.** When the query names something the spec has and this
 *   build does not, it says so — even when it also has plausible results to show,
 *   because the plausible near-miss is exactly what wasted an afternoon.
 *
 * An effect that cannot legally go at the insertion point is shown, refused,
 * with the reason — rather than hidden. Hiding it produces the worse question:
 * the user knows the effect exists, cannot find it, and has nothing to read.
 *
 * Everything on screen comes from the sealed registry. There is no list of
 * effects in this file and no per-effect rule.
 */
export function EffectPicker({
  registry,
  stack,
  insertAt,
  onPick,
  onClose,
}: EffectPickerProps): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [slot, setSlot] = React.useState<NodeSlot | null>(null);
  const [highlighted, setHighlighted] = React.useState<string | null>(null);
  const search = React.useRef<HTMLInputElement | null>(null);
  const rows = React.useRef(new Map<string, HTMLElement>());
  const domId = React.useId();

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

  // Typing is the first thing anybody does here, so the caret starts in the box
  // and every key below is handled without leaving it.
  React.useEffect(() => {
    search.current?.focus();
  }, []);

  React.useEffect(() => {
    if (highlighted === null) return;
    rows.current.get(highlighted)?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const current = entryOf(entries, highlighted);

  const commit = (effectId: string): void => {
    const entry = entryOf(entries, effectId);
    if (entry === undefined) {
      log.warn("add refused: effect is not in the current results", {
        effect: effectId,
      });
      return;
    }
    if (!entry.available) {
      // Not silent, and not a disabled control either: the row is reachable so
      // that the reason under it can be read, and pressing it moves the reason
      // into view rather than doing nothing.
      log.warn("add refused by the stack grammar", {
        effect: effectId,
        insertAt,
        reason: entry.reason,
      });
      setHighlighted(effectId);
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
      case "Home":
        event.preventDefault();
        setHighlighted(entries[0]?.effect.id ?? null);
        break;
      case "End":
        event.preventDefault();
        setHighlighted(entries[entries.length - 1]?.effect.id ?? null);
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

  /** Put an effect's name in the box, which is how a suggestion is taken up. */
  const lookUp = (name: string): void => {
    setQuery(name);
    search.current?.focus();
  };

  const concept = current?.effect.concept;
  // Suggestions to offer under "nothing matched". `unknown` is the one miss with
  // nothing to offer, and the union says so by not carrying the field at all;
  // and a named gap has already listed the same effects a few lines above, where
  // they read as alternatives to the missing feature rather than as an
  // afterthought.
  const missNearest =
    model.miss === null || model.miss.kind === "unknown" || model.unbuilt !== null
      ? []
      : model.miss.nearest;

  return (
    <div className="effect-picker" onKeyDown={onKeyDown}>
      <div className="effect-picker__head">
        <input
          ref={search}
          id={`${domId}-search`}
          className="effect-picker__search"
          type="search"
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={true}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={`${domId}-list`}
          aria-activedescendant={highlighted === null ? undefined : `${domId}-${highlighted}`}
          placeholder={`Search ${model.total} effects`}
          aria-label="Search effects by name, description or what you call it"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="ui-button" onClick={onClose}>
          close
        </button>
      </div>

      <div className="effect-picker__slots">
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
        <span className="field__note effect-picker__counts">
          {model.matched} of {model.total}
          {model.unavailable > 0 ? ` · ${model.unavailable} cannot go here` : ""}
        </span>
      </div>

      {model.unbuilt === null ? null : (
        // Announced, not merely drawn: it appears above results that look like
        // answers, and somebody reading by ear would otherwise be told only the
        // near misses.
        <div className="effect-picker__gap" role="status">
          <p className="effect-picker__gap-head">
            <b>{model.unbuilt.name}</b> ({model.unbuilt.requirement}) is specified but
            not built.
          </p>
          <p className="effect-picker__gap-body">{model.unbuilt.summary}</p>
          <p className="effect-picker__gap-body">{model.unbuilt.reason}</p>
          {model.unbuiltNearest.length === 0 ? null : (
            <p className="effect-picker__gap-body">
              {model.groups.length > 0 ? "Also worth a look: " : "The closest built effects are: "}
              {model.unbuiltNearest.map((effect, index) => (
                <React.Fragment key={effect.id}>
                  {index === 0 ? null : " "}
                  <button
                    type="button"
                    className="effect-picker__chip"
                    onClick={() => lookUp(effect.name)}
                  >
                    {effect.name}
                  </button>
                </React.Fragment>
              ))}
            </p>
          )}
        </div>
      )}

      <div
        className="effect-picker__list ui-scroll"
        id={`${domId}-list`}
        role="listbox"
        aria-label="Effects"
      >
        {model.groups.map((group) => (
          <section
            key={group.family}
            className="effect-picker__group"
            role="group"
            aria-labelledby={`${domId}-family-${group.family}`}
          >
            <h3 className="effect-picker__family" id={`${domId}-family-${group.family}`}>
              {group.label}
            </h3>
            {group.entries.map((entry) => (
              <Row
                key={entry.effect.id}
                entry={entry}
                domId={`${domId}-${entry.effect.id}`}
                on={highlighted === entry.effect.id}
                register={(element) => {
                  if (element === null) rows.current.delete(entry.effect.id);
                  else rows.current.set(entry.effect.id, element);
                }}
                onHover={() => setHighlighted(entry.effect.id)}
                onPick={() => commit(entry.effect.id)}
              />
            ))}
          </section>
        ))}
      </div>

      {/*
        Outside the listbox, not the last row of it. The suggestions are buttons
        and a listbox may only contain options; a chip inside it would be
        announced as an effect that can be added, which it is not.
      */}
      {model.groups.length > 0 || model.miss === null ? null : (
        <div className="effect-picker__miss">
          {/*
            The sentence is `describeMiss`, not one written here: the picker,
            the hover help and the guide have to give the same account of the
            same miss, and three copies of a sentence drift exactly the way
            three copies of a description do. The exception is a named gap,
            which the notice above has already explained in full.
          */}
          <p className="effect-picker__miss-head" role="status">
            {model.unbuilt === null
              ? describeMiss(model.miss, query)
              : `Nothing in the catalogue matches “${query}”.`}
          </p>
          {model.miss.kind === "filtered-out" && slot !== null ? (
            <button type="button" className="ui-button" onClick={() => setSlot(null)}>
              search every slot
            </button>
          ) : null}
          {missNearest.length === 0 ? null : (
            <p className="effect-picker__miss-body">
              {missNearest.map((effect, index) => (
                <React.Fragment key={effect.id}>
                  {index === 0 ? null : " "}
                  <button
                    type="button"
                    className="effect-picker__chip"
                    onClick={() => lookUp(effect.name)}
                  >
                    {effect.name}
                  </button>
                </React.Fragment>
              ))}
            </p>
          )}
        </div>
      )}

      {current === undefined ? null : (
        <div className="effect-picker__about">
          {current.available ? null : (
            <p className="effect-picker__refusal">
              Cannot go here: {current.reason}
            </p>
          )}
          <p className="effect-picker__prose">{current.effect.description}</p>
          {concept === undefined ? null : (
            <p className="effect-picker__prose effect-picker__prose--quiet">
              <b>{EFFECT_CONCEPTS[concept].title}.</b>{" "}
              {EFFECT_CONCEPTS[concept].summary}
            </p>
          )}
        </div>
      )}

      <footer className="effect-picker__foot">
        <span className="field__note">
          ↑↓ to move · enter to add · esc to close
        </span>
      </footer>
    </div>
  );
}

interface RowProps {
  readonly entry: PickerEntry;
  readonly domId: string;
  readonly on: boolean;
  readonly register: (element: HTMLElement | null) => void;
  readonly onHover: () => void;
  readonly onPick: () => void;
}

/**
 * One result.
 *
 * A `button` rather than a `div` so a pointer press behaves like a press, and
 * `aria-disabled` rather than `disabled` on a refused one: a disabled control
 * emits no pointer events at all, so hovering the very row whose refusal you
 * want to read would fail to bring the reason up.
 */
function Row({ entry, domId, on, register, onHover, onPick }: RowProps): React.ReactElement {
  const effect = entry.effect;
  return (
    <button
      type="button"
      id={domId}
      ref={register}
      role="option"
      aria-selected={on}
      aria-disabled={!entry.available}
      tabIndex={-1}
      className={`effect-picker__row${on ? " effect-picker__row--on" : ""}${
        entry.available ? "" : " effect-picker__row--blocked"
      }`}
      // The row is a help anchor too (F-UI-13). The panel below already prints
      // the highlighted effect's description, and this is the same text — but
      // reached with the pointer, on the row under it, without the highlight
      // having to move first. The article also carries the grammar facts a
      // refusal is made of, which is what a blocked row is most often asked
      // about.
      {...helpFor({ kind: "effect", effect: effect.id })}
      title={entry.reason ?? `Add ${effect.name}`}
      onPointerEnter={onHover}
      onClick={onPick}
    >
      <span className="effect-picker__line">
        <span className="effect-picker__name">
          <Marked segments={entry.match.name} />
        </span>
        {/*
          The same three chips a stack row wears, ranked the same way: the slot
          is the structural fact, execution is the cost model, the spec id is
          reference material. Anything else would make a row mean one thing in
          the picker and another once it is in the stack.
        */}
        <span className="badge" title={`Goes in the ${SLOT_LABEL[effect.slot]} slot`}>
          {SLOT_LABEL[effect.slot]}
        </span>
        <span
          className={`badge badge--exec-${effect.execution}`}
          title={
            effect.execution === "wasm"
              ? "Serial CPU kernel: a readback and an upload when it sits between GPU nodes"
              : "One GPU compute pass"
          }
        >
          {EXECUTION_LABEL[effect.execution]}
        </span>
        <span className="badge badge--req">{effect.requirement}</span>
      </span>
      <span className="effect-picker__summary">
        <Marked segments={entry.match.summary} />
      </span>
      {entry.match.reasons.map((reason) => (
        <Why key={reason.field} reason={reason} />
      ))}
      {entry.available ? null : (
        <span className="effect-picker__blocked">{entry.reason}</span>
      )}
    </button>
  );
}

/** Why this row is on screen when its name and summary do not say so. */
function Why({ reason }: { readonly reason: MatchReason }): React.ReactElement {
  return (
    <span className="effect-picker__why">
      <span className="effect-picker__why-label">{reason.label}</span>
      <Marked segments={reason.segments} />
    </span>
  );
}

/** Text with the query marked in it. `mark` because that is what it means. */
function Marked({ segments }: { readonly segments: readonly Segment[] }): React.ReactElement {
  return (
    <React.Fragment>
      {segments.map((segment, index) =>
        segment.match ? (
          // The index is part of the key because two runs of the same text are
          // two different places in one string, and nothing here reorders.
          <mark key={`${index}-${segment.text}`}>{segment.text}</mark>
        ) : (
          <React.Fragment key={`${index}-${segment.text}`}>{segment.text}</React.Fragment>
        ),
      )}
    </React.Fragment>
  );
}
