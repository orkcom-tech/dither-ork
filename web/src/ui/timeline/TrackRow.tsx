import React from "react";

import { MAX_CYCLES_PER_LOOP, MODULATOR_SHAPES } from "../../animation";
import type { ModulatorShape } from "../../types/document";
import type { FloatParam, IntParam } from "../../types/registry";
import { NumberField } from "../properties";
import { Lane } from "./Lane";
import { FloatEntry, IntEntry } from "./fields";
import type { TrackCurve } from "./evaluate";
import { EASINGS, EASING_LABEL, isEasing, type Easing, type Keyframe } from "./keyframes";
import { MAX_AMOUNT_SCALE, type Track } from "./model";

/**
 * One track — F-AN-07's row, F-AN-08's keys and F-AN-11's two controls.
 *
 * The head is the same shape for both kinds of track, because bypass, gain and
 * collapse mean the same thing on both; only the lane and the expanded controls
 * differ. That is deliberate: a sheet whose rows are two different shapes is a
 * sheet you have to read twice.
 */

const SHAPE_LABEL: Readonly<Record<ModulatorShape, string>> = {
  sine: "sine",
  triangle: "triangle",
  saw: "saw",
  square: "square",
  "smooth-noise": "smooth noise",
  "stepped-random": "stepped random",
};

export interface TrackRowProps {
  readonly track: Track;
  readonly param: FloatParam | IntParam;
  readonly effectName: string;
  readonly curve: TrackCurve | null;
  readonly frames: number;
  readonly playhead: number;
  readonly selected: boolean;
  readonly selectedKeyFrame: number | null;
  readonly onSelect: () => void;
  readonly onCollapse: (collapsed: boolean) => void;
  readonly onEnabled: (enabled: boolean) => void;
  readonly onGain: (scale: number) => void;
  readonly onRemove: () => void;
  readonly onModulator: (patch: {
    shape?: ModulatorShape;
    amount?: number;
    cyclesPerLoop?: number;
    phase?: number;
    bipolar?: boolean;
  }) => void;
  readonly onAddKey: (frame: number) => void;
  readonly onMoveKey: (from: number, to: number) => void;
  readonly onSelectKey: (frame: number | null) => void;
  readonly onKeyValue: (frame: number, value: number) => void;
  readonly onKeyEasing: (frame: number, easing: Easing) => void;
  readonly onRemoveKey: (frame: number) => void;
  readonly onInteractionStart: () => void;
  readonly onInteractionEnd: () => void;
}

export function TrackRow(props: TrackRowProps): React.ReactElement {
  const { track, param, curve, frames, selected } = props;
  const spec = track.spec;
  const keys = spec.kind === "keyframe" ? spec.keys : undefined;
  const [legalMin, legalMax] = param.legal;
  const span = legalMax - legalMin;

  return (
    <div className={"timeline__row" + (selected ? " timeline__row--selected" : "")}>
      <div className={"timeline__head" + (track.enabled ? "" : " timeline__head--off")}>
        <button
          type="button"
          className="timeline__chevron"
          aria-label={track.collapsed ? "Show track controls" : "Hide track controls"}
          aria-expanded={!track.collapsed}
          title={track.collapsed ? "Show track controls" : "Hide track controls"}
          onClick={() => props.onCollapse(!track.collapsed)}
        >
          {track.collapsed ? "▸" : "▾"}
        </button>
        <button
          type="button"
          className="timeline__name"
          title={`${props.effectName} · ${param.label} — ${spec.kind}`}
          onClick={props.onSelect}
        >
          {param.label} <small>{props.effectName}</small>
        </button>
        <button
          type="button"
          className="timeline__flag"
          aria-pressed={track.enabled}
          aria-label={track.enabled ? "Bypass this track" : "Enable this track"}
          title={
            track.enabled
              ? "Bypass — the parameter goes back to the value the properties panel shows"
              : "Enable this track"
          }
          onClick={() => props.onEnabled(!track.enabled)}
        >
          {track.enabled ? "●" : "○"}
        </button>
        <FloatEntry
          className="timeline__gain"
          label={`${param.label} track amount`}
          title={`Track amount — how much of this track reaches the picture (0 to ${MAX_AMOUNT_SCALE})`}
          value={track.amountScale}
          min={0}
          max={MAX_AMOUNT_SCALE}
          onCommit={props.onGain}
        />
        <button
          type="button"
          className="timeline__action"
          aria-label={`Remove the ${param.label} track`}
          title="Remove this track"
          onClick={props.onRemove}
        >
          ×
        </button>
      </div>

      <Lane
        curve={curve}
        frames={frames}
        enabled={track.enabled}
        keys={keys}
        selectedKeyFrame={props.selectedKeyFrame}
        onAddKey={keys === undefined ? undefined : props.onAddKey}
        onMoveKey={keys === undefined ? undefined : props.onMoveKey}
        onSelectKey={keys === undefined ? undefined : props.onSelectKey}
        onDragStart={props.onInteractionStart}
        onDragEnd={props.onInteractionEnd}
      />

      {track.collapsed ? null : (
        <div className="timeline__controls">
          {spec.kind === "modulator" ? (
            <>
              <label className="timeline__entry">
                shape
                <select
                  className="timeline__select"
                  value={spec.shape}
                  onChange={(event) =>
                    props.onModulator({ shape: event.target.value as ModulatorShape })
                  }
                >
                  {MODULATOR_SHAPES.map((shape) => (
                    <option key={shape} value={shape}>
                      {SHAPE_LABEL[shape]}
                    </option>
                  ))}
                </select>
              </label>
              <NumberField
                label="amount"
                dense
                value={spec.amount}
                // In parameter units, because that is how `animation/binding.ts`
                // reads it: `value = base + amount * unit`. A full swing of the
                // legal range either way is the widest a modulator can usefully
                // be, and the clamp handles anything past the edge.
                min={-span}
                max={span}
                {...(param.type === "int" ? { integer: true } : {})}
                interaction={`timeline:${track.id}.amount`}
                onChange={(amount) => props.onModulator({ amount })}
              />
              <IntEntry
                label="cycles"
                value={spec.cyclesPerLoop}
                min={1}
                max={MAX_CYCLES_PER_LOOP}
                title="Cycles per loop — a whole number, which is what makes frame N equal frame 0 (F-AN-03)"
                onCommit={(cyclesPerLoop) => props.onModulator({ cyclesPerLoop })}
              />
              <NumberField
                label="phase"
                dense
                value={spec.phase}
                min={0}
                max={1}
                step={0.01}
                hint="Phase in turns — where in the cycle the loop starts"
                interaction={`timeline:${track.id}.phase`}
                onChange={(phase) => props.onModulator({ phase })}
              />
              <button
                type="button"
                className="ui-button"
                aria-pressed={spec.bipolar}
                title={
                  spec.bipolar
                    ? "Bipolar — the modulator swings both ways around the authored value"
                    : "Unipolar — the modulator only adds"
                }
                onClick={() => props.onModulator({ bipolar: !spec.bipolar })}
              >
                {spec.bipolar ? "bipolar" : "unipolar"}
              </button>
            </>
          ) : (
            <KeyframeControls
              keys={spec.keys}
              param={param}
              trackId={track.id}
              frames={frames}
              playhead={props.playhead}
              selectedKeyFrame={props.selectedKeyFrame}
              onAddKey={props.onAddKey}
              onKeyValue={props.onKeyValue}
              onKeyEasing={props.onKeyEasing}
              onRemoveKey={props.onRemoveKey}
              onMoveKey={props.onMoveKey}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface KeyframeControlsProps {
  readonly keys: readonly Keyframe[];
  readonly param: FloatParam | IntParam;
  readonly trackId: string;
  readonly frames: number;
  readonly playhead: number;
  readonly selectedKeyFrame: number | null;
  readonly onAddKey: (frame: number) => void;
  readonly onMoveKey: (from: number, to: number) => void;
  readonly onKeyValue: (frame: number, value: number) => void;
  readonly onKeyEasing: (frame: number, easing: Easing) => void;
  readonly onRemoveKey: (frame: number) => void;
}

/**
 * The controls for one key.
 *
 * There is no "add key" that guesses a value: a key added from the lane takes
 * the value the track already has at that frame, so setting one and changing
 * nothing else leaves the animation exactly as it was. The value is then edited
 * here, which is the order the operation actually happens in.
 */
function KeyframeControls({
  keys,
  param,
  trackId,
  frames,
  playhead,
  selectedKeyFrame,
  onAddKey,
  onMoveKey,
  onKeyValue,
  onKeyEasing,
  onRemoveKey,
}: KeyframeControlsProps): React.ReactElement {
  const key = keys.find((entry) => entry.frame === selectedKeyFrame);
  const [legalMin, legalMax] = param.legal;

  if (key === undefined) {
    return (
      <>
        <span className="timeline__entry">
          {keys.length} key{keys.length === 1 ? "" : "s"} — pick one on the lane to edit it
        </span>
        <button type="button" className="ui-button" onClick={() => onAddKey(playhead)}>
          key at playhead
        </button>
      </>
    );
  }

  return (
    <>
      <IntEntry
        label="frame"
        value={key.frame}
        min={0}
        max={frames - 1}
        onCommit={(frame) => onMoveKey(key.frame, frame)}
      />
      <NumberField
        label="value"
        dense
        value={key.value}
        min={legalMin}
        max={legalMax}
        {...(param.type === "float" && param.step !== undefined ? { step: param.step } : {})}
        {...(param.type === "int" ? { integer: true } : {})}
        interaction={`timeline:${trackId}.key`}
        onChange={(value) => onKeyValue(key.frame, value)}
      />
      <label className="timeline__entry">
        easing
        <select
          className="timeline__select"
          value={key.easing}
          title="How this key reaches the next one. The last key's easing governs the segment that crosses the seam."
          onChange={(event) => {
            const value = event.target.value;
            if (isEasing(value)) onKeyEasing(key.frame, value);
          }}
        >
          {EASINGS.map((easing) => (
            <option key={easing} value={easing}>
              {EASING_LABEL[easing]}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="ui-button" onClick={() => onAddKey(playhead)}>
        key at playhead
      </button>
      <button
        type="button"
        className="ui-button"
        disabled={keys.length <= 1}
        title={
          keys.length <= 1
            ? "A keyframe track keeps at least one key — remove the track itself instead"
            : "Delete this key"
        }
        onClick={() => onRemoveKey(key.frame)}
      >
        delete key
      </button>
    </>
  );
}
