import React from "react";

import { LOCK_KEYS, chaosLabel, describeStack, lockHint, lockLabel } from "./model";
import type { SurpriseStore } from "./store";
import type { ModulatorSupport } from "./capability";

/**
 * The surprise panel — the seed, the chaos slider, the locks, the per-node dice
 * and the history.
 *
 * Everything on it is wired to something that happens. The one thing it does
 * *not* show is the animation lock, and that omission is the point: this build's
 * renderer refuses a document carrying modulator bindings, so an animation lock
 * would be a control that produced an unrenderable document. The panel states
 * the fact in one line instead, with the renderer's own words for why. When the
 * modulator core lands, the probe in `capability.ts` flips and the lock appears
 * with no edit here.
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

  const locks = LOCK_KEYS.filter((key) => key !== "animation" || modulators.renderable);

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
          defaults, and how likely a glitch is.
        </p>
      </section>

      <section className="sm__section">
        <span className="ui-label">locks</span>
        <div className="sm__locks">
          {locks.map((key) => (
            <button
              key={key}
              type="button"
              className="ui-button"
              aria-pressed={snapshot.locks[key]}
              title={lockHint(key)}
              onClick={() => store.toggle(key)}
            >
              {lockLabel(key)}
            </button>
          ))}
        </div>
        {modulators.renderable ? null : (
          <React.Fragment>
            <p className="sm__note">
              No animation lock — a surprise makes no modulator bindings, because
              this build cannot render one:
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
