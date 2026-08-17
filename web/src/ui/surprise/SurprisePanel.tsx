import React from "react";

import { helpFor } from "../help";
import {
  ASPECT_KEYS,
  aspectLabel,
  aspectMode,
  chaosLabel,
  describeStack,
  modeConcept,
  modeHint,
  modeLabel,
  modesFor,
  type AspectKey,
} from "./model";
import type { SurpriseStore } from "./store";
import type { ModulatorSupport } from "./capability";

/**
 * The surprise panel — the seed, the chaos slider, the per-aspect modes, the
 * per-node dice and the history.
 *
 * Everything on it is wired to something that happens.
 *
 * ## The aspect rows say what they do
 *
 * Five aspects, one control each, three named states: reroll, keep, off. The
 * words are on the buttons rather than behind a padlock icon, the sentence for
 * whichever one you are pointing at is on the control itself, and the general
 * ideas — what keeping is, what leaving out is — are contextual help (F-UI-13)
 * read from `ui/help/concepts.ts`, which is the same mechanism every other panel
 * in the application uses. Nothing here writes its own prose about them.
 *
 * Not every aspect offers all three, and `modesFor` is the only thing that
 * decides which — `SurpriseExcludes` in `surprise/generate.ts` is where the
 * reason is written. Animation and graph shape have an `off`, because for both
 * of them the absence is a state a document can hold. Graph shape has no
 * `keep`, because setting the stack to keep already keeps the wiring.
 *
 * ## The document says whether it loops
 *
 * Beside the seed, and only when it does not. A feedback node reads the previous
 * frame, so the document never returns to where it started and an animated
 * export reports it rather than failing a seam check it was never going to pass
 * (F-AN-03, narrowed by `docs/dither-ork-node-graph.md`). Somebody who is about
 * to export a loop should learn that from the thing that made the document, not
 * from the encoder, and the line points at the control that turns it off.
 *
 * ## The animation row disappears when the build cannot animate
 *
 * Not greyed out — absent, with the renderer's own words for why in its place.
 * A build whose modulator path does not resolve produces no bindings whatever
 * the panel says, so a keep/off control over it would be a control wired to
 * nothing. The probe in `capability.ts` is what decides, and in this build it
 * passes.
 */
export interface SurprisePanelProps {
  readonly store: SurpriseStore;
  readonly modulators: ModulatorSupport;
}

export function SurprisePanel({ store, modulators }: SurprisePanelProps): React.ReactElement {
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [copied, setCopied] = React.useState<string | null>(null);

  const currentEntry =
    snapshot.current === null
      ? null
      : (snapshot.history.find((entry) => entry.id === snapshot.current) ?? null);

  const copySeed = (seed: string): void => {
    void navigator.clipboard.writeText(seed).then(
      () => setCopied(seed),
      // A clipboard write can be refused by permissions policy. Stated rather
      // than silently doing nothing — the seed is still on screen to be selected.
      () => setCopied(null),
    );
  };

  const aspects: readonly AspectKey[] = ASPECT_KEYS.filter(
    (key) => key !== "animation" || modulators.renderable,
  );
  const state = { locks: snapshot.locks, excludes: snapshot.excludes };

  return (
    <div className="sm">
      {snapshot.problem === null ? null : (
        <button
          type="button"
          className="sm__problem"
          title="Click to dismiss"
          onClick={() => store.dismissProblem()}
        >
          {snapshot.problem}
        </button>
      )}

      <section className="sm__section">
        <div className="sm__head">
          <span className="ui-label">seed</span>
          {currentEntry === null ? null : (
            <button
              type="button"
              className="ui-button sm__copy"
              title="Copy this seed. The same seed and the same build reproduce this document exactly."
              onClick={() => copySeed(currentEntry.seed)}
            >
              {copied === currentEntry.seed ? "copied" : "copy"}
            </button>
          )}
        </div>
        <p className="sm__seed" data-testid="surprise-seed">
          {currentEntry === null
            ? "— press surprise, or edit the document and this stops being a seed's"
            : currentEntry.seed}
        </p>
        {currentEntry === null ? null : (
          <p className="sm__note">{describeStack(currentEntry.summary.effectNames)}</p>
        )}
        {currentEntry === null ? null : (
          <p className="sm__note">{currentEntry.summary.shape}</p>
        )}
        {currentEntry === null || currentEntry.summary.loops ? null : (
          <p className="sm__note" data-testid="surprise-nonlooping">
            This document does not loop: a feedback node reads the previous
            frame, so the last frame is not the first one. An animated export
            says so rather than failing a seam check. Set graph shape to off for
            a document that closes.
          </p>
        )}
      </section>

      <section className="sm__section">
        <div className="sm__head">
          <span className="ui-label">chaos</span>
          <span className="sm__value">
            {snapshot.chaos.toFixed(2)} · {chaosLabel(snapshot.chaos)}
          </span>
        </div>
        <input
          type="range"
          className="sm__slider"
          min={0}
          max={1}
          step={0.05}
          value={snapshot.chaos}
          aria-label="Chaos"
          data-testid="surprise-chaos"
          onChange={(event) => store.setChaos(Number.parseFloat(event.target.value))}
        />
        <p className="sm__note">
          How many effects the stack gets, how far parameters move off their
          defaults, how likely a glitch is — and how likely the document is to be
          more than a chain. At the tame end it is nearly always a chain, and it
          always loops.
        </p>
      </section>

      <section className="sm__section">
        <span className="ui-label">what a surprise makes</span>
        <ul className="sm__aspects">
          {aspects.map((key) => {
            const current = aspectMode(state, key);
            return (
              <li key={key} className="sm__aspect">
                <span className="sm__aspect-name">{aspectLabel(key)}</span>
                <div
                  className="sm__modes"
                  role="radiogroup"
                  aria-label={aspectLabel(key)}
                  data-testid={`surprise-aspect-${key}`}
                >
                  {modesFor(key).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      className="ui-button sm__mode"
                      aria-checked={current === mode}
                      // The sentence for this exact button. The general idea —
                      // what keeping is, what leaving out is — is the hover help
                      // below, so neither says the other's half twice.
                      title={modeHint(key, mode)}
                      data-testid={`surprise-aspect-${key}-${mode}`}
                      {...helpFor({ kind: "concept", concept: modeConcept(mode) })}
                      onClick={() => store.setMode(key, mode)}
                    >
                      {modeLabel(mode)}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="sm__note">
          Reroll makes a new one every press. Keep leaves that one exactly as it
          is. Off leaves it out of the document altogether — animation off means
          nothing moves, graph shape off means a plain chain over your image.
        </p>
        {modulators.renderable ? null : (
          <React.Fragment>
            <p className="sm__note">
              Animation is not listed — a surprise makes no modulator bindings,
              because this build cannot render one:
            </p>
            {/* The renderer's own words rather than a paraphrase, so the reason
                shown here cannot drift from the reason it is true. */}
            <p className="sm__quote">{modulators.reason}</p>
          </React.Fragment>
        )}
      </section>

      <section className="sm__section">
        <span className="ui-label">reroll one node</span>
        {snapshot.stack.length === 0 ? (
          <p className="sm__note">The stack is empty. A surprise fills it.</p>
        ) : (
          <ul className="sm__nodes">
            {snapshot.stack.map((node) => (
              <li key={node.id} className="sm__node">
                <span className="sm__node-name">{node.name}</span>
                <button
                  type="button"
                  className="ui-button sm__dice"
                  title={`Re-roll ${node.name}'s parameters and seed, and nothing else`}
                  data-testid={`surprise-reroll-${node.id}`}
                  onClick={() => store.reroll(node.id)}
                >
                  reroll
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sm__section">
        <span className="ui-label">history</span>
        {snapshot.history.length === 0 ? (
          <p className="sm__note">The last twelve surprises appear here.</p>
        ) : (
          <ul className="sm__history">
            {snapshot.history.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="sm__entry"
                  aria-pressed={entry.id === snapshot.current}
                  title={`${entry.seed} — ${describeStack(entry.summary.effectNames)} — ${entry.summary.paletteName} (${entry.summary.paletteEntries}). Click to restore.`}
                  data-testid={`surprise-history-${entry.id}`}
                  onClick={() => store.restore(entry.id)}
                >
                  {entry.thumbnail === null ? (
                    <span className="sm__entry-blank">
                      {entry.thumbnailProblem === null ? "rendering" : "no preview"}
                    </span>
                  ) : (
                    <img className="sm__entry-image" src={entry.thumbnail} alt="" />
                  )}
                  <span className="sm__entry-seed">{entry.seed.slice(0, 8)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
