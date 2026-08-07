import React from "react";

import type { EffectRegistry } from "../../registry";
import type { DitherDocument } from "../../types/document";
import type { FloatParam, IntParam } from "../../types/registry";
import { isBindableParam, trackId, type TrackKind } from "./model";

/**
 * Choosing what to animate.
 *
 * The list is generated from the registry, like every other control in the
 * application: a parameter appears here exactly when its descriptor says
 * `animatable` and its type is `float` or `int`. Nothing is special-cased and
 * there is no second list of "animatable things" anywhere.
 *
 * A parameter that already has a track is shown **disabled with the reason**
 * rather than hidden. Hiding it makes "where did my parameter go" a question
 * with no answer on screen; one parameter carries one track, and the row that
 * has it is a few pixels below.
 */

export interface BindCandidate {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly param: FloatParam | IntParam;
  readonly base: number;
  /** Already tracked; the button says so and does nothing. */
  readonly taken: boolean;
}

/**
 * The default modulator amount for a parameter, in parameter units.
 *
 * Taken from the descriptor's **surprise range** rather than from its legal
 * range. That field is the catalogue's own statement of the interval this
 * parameter is interesting over — `surprise/animation.ts` leans on it for the
 * same reason — so a quarter of it is a swing you can see on a `[0, 1]` opacity
 * and on a `[-1024, 1024]` pattern offset alike. A quarter of the *legal* range
 * would send the second one round the picture on the first frame.
 */
export function defaultAmountFor(param: FloatParam | IntParam): number {
  const [low, high] = param.surprise.range;
  const quarter = Math.abs(high - low) / 4;
  if (quarter > 0) return param.type === "int" ? Math.max(1, Math.round(quarter)) : quarter;
  const [legalLow, legalHigh] = param.legal;
  const fallback = Math.abs(legalHigh - legalLow) / 8;
  return param.type === "int" ? Math.max(1, Math.round(fallback)) : fallback;
}

export function bindCandidates(
  document: DitherDocument,
  registry: EffectRegistry,
  taken: ReadonlySet<string>,
): readonly BindCandidate[] {
  const candidates: BindCandidate[] = [];
  for (const node of document.stack) {
    const descriptor = registry.get(node.effect);
    if (descriptor === undefined) continue;
    for (const param of descriptor.params) {
      if (!isBindableParam(param)) continue;
      if (param.type !== "float" && param.type !== "int") continue;
      const value = node.params[param.key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      candidates.push({
        nodeId: node.id,
        nodeLabel: descriptor.name,
        param,
        base: value,
        taken: taken.has(trackId(node.id, param.key)),
      });
    }
  }
  return candidates;
}

export interface BindPickerProps {
  readonly document: DitherDocument;
  readonly registry: EffectRegistry;
  readonly taken: ReadonlySet<string>;
  readonly onBind: (
    nodeId: string,
    param: string,
    kind: TrackKind,
    base: number,
    amount: number,
  ) => void;
  readonly onClose: () => void;
}

export function BindPicker({
  document,
  registry,
  taken,
  onBind,
  onClose,
}: BindPickerProps): React.ReactElement {
  const [kind, setKind] = React.useState<TrackKind>("modulator");
  const candidates = React.useMemo(
    () => bindCandidates(document, registry, taken),
    [document, registry, taken],
  );

  return (
    <div className="timeline__picker">
      <div className="timeline__picker-row">
        <span className="ui-label">new track</span>
        <button
          type="button"
          className="ui-button"
          aria-pressed={kind === "modulator"}
          title="A modulator: a shape that repeats a whole number of times per loop (F-AN-02)"
          onClick={() => setKind("modulator")}
        >
          modulator
        </button>
        <button
          type="button"
          className="ui-button"
          aria-pressed={kind === "keyframe"}
          title="Keyframes: values you place on frames, interpolated and wrapped at the seam (F-AN-08)"
          onClick={() => setKind("keyframe")}
        >
          keyframes
        </button>
        <span className="timeline__spacer" />
        <button type="button" className="ui-button" onClick={onClose}>
          close
        </button>
      </div>

      {candidates.length === 0 ? (
        <p className="timeline__empty">
          Nothing in the stack declares an animatable <b>float</b> or <b>int</b> parameter.
          Add an effect that does, and its parameters appear here.
        </p>
      ) : (
        <div className="timeline__picker-list">
          {candidates.map((candidate) => (
            <button
              key={`${candidate.nodeId}::${candidate.param.key}`}
              type="button"
              className="ui-button"
              disabled={candidate.taken}
              title={
                candidate.taken
                  ? `${candidate.param.label} already has a track — one parameter carries one`
                  : `${candidate.nodeLabel} · ${candidate.param.label} — currently ${candidate.base}`
              }
              onClick={() =>
                onBind(
                  candidate.nodeId,
                  candidate.param.key,
                  kind,
                  candidate.base,
                  defaultAmountFor(candidate.param),
                )
              }
            >
              {candidate.nodeLabel} · {candidate.param.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
