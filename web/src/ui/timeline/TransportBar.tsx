import React from "react";

import { MAX_FPS, MAX_FRAMES, MAX_GLOBAL_SPEED } from "../../animation";
import { FloatEntry, IntEntry } from "./fields";
import { describePlayback, type PlaybackReport } from "./playback";

/**
 * The transport — F-AN-09's play/pause and frame step, F-AN-01's loop range and
 * F-AN-10's two global controls, on one line.
 *
 * The state chip on the right is the only thing here that is not a control, and
 * it is the reason this file exists rather than the buttons being scattered: it
 * states what playback is *actually* doing — the resolution the frames came back
 * at, and how many were dropped — beside the button that started it. A reading
 * that is somewhere else is a reading nobody sees.
 */

export interface TransportBarProps {
  readonly frames: number;
  readonly fps: number;
  readonly playhead: number;
  readonly playing: boolean;
  readonly canPlay: boolean;
  readonly speed: number;
  readonly phaseOffset: number;
  readonly playback: PlaybackReport;
  readonly previewScale: number;
  readonly engaged: boolean;
  readonly onPlaying: (playing: boolean) => void;
  readonly onStep: (delta: number) => void;
  readonly onFrames: (frames: number) => void;
  readonly onFps: (fps: number) => void;
  readonly onSpeed: (speed: number) => void;
  readonly onPhaseOffset: (turns: number) => void;
  readonly onBind: () => void;
  readonly binding: boolean;
}

export function TransportBar(props: TransportBarProps): React.ReactElement {
  const seconds = props.playhead / props.fps;
  const duration = props.frames / props.fps;
  const state = describePlayback(props.playback, props.fps, props.previewScale);

  return (
    <div className="timeline__bar">
      <div className="timeline__transport">
        <button
          type="button"
          className="ui-button"
          aria-pressed={props.playing}
          disabled={!props.canPlay}
          title={
            props.canPlay
              ? props.playing
                ? "Pause"
                : "Play the loop at the document's fps"
              : "Nothing to play — bind a parameter first, and open an image"
          }
          onClick={() => props.onPlaying(!props.playing)}
        >
          {props.playing ? "❚❚ pause" : "▶ play"}
        </button>
        <button
          type="button"
          className="ui-button"
          title="Back one frame"
          onClick={() => props.onStep(-1)}
        >
          ◀
        </button>
        <button
          type="button"
          className="ui-button"
          title="Forward one frame"
          onClick={() => props.onStep(1)}
        >
          ▶
        </button>
      </div>

      <div className="timeline__readout">
        frame
        <b>{props.playhead}</b>
        <span>
          / {props.frames} · {seconds.toFixed(2)}s of {duration.toFixed(2)}s
        </span>
      </div>

      <div className="timeline__group">
        <IntEntry
          label="frames"
          value={props.frames}
          min={1}
          max={MAX_FRAMES}
          title="Frames in the loop. Normalized time is frame / frames, so frame N is frame 0."
          onCommit={props.onFrames}
        />
        <IntEntry
          label="fps"
          value={props.fps}
          min={1}
          max={MAX_FPS}
          title="Playback rate, and the rate an animated export would use"
          onCommit={props.onFps}
        />
      </div>

      <div className="timeline__group">
        <IntEntry
          label="speed"
          value={props.speed}
          min={1}
          max={MAX_GLOBAL_SPEED}
          title="Global speed (F-AN-10) — multiplies every modulator's cycles per loop. A whole number, so the loop still closes; to run a loop slower, raise the frame count."
          onCommit={props.onSpeed}
        />
        <label className="timeline__entry">
          phase
          <FloatEntry
            label="global phase offset"
            title="Global phase offset in turns (F-AN-10) — moves where every modulator starts"
            value={props.phaseOffset}
            min={0}
            max={1}
            onCommit={props.onPhaseOffset}
          />
        </label>
      </div>

      <span className="timeline__spacer" />

      {state === "" ? null : (
        <span
          className={
            "timeline__state" +
            (props.playback.behind || props.previewScale < 0.999
              ? " timeline__state--degraded"
              : "")
          }
          title="What playback is actually managing. The viewport's badge says the same thing about the frame on screen."
        >
          {state}
        </span>
      )}

      {props.engaged ? (
        <span
          className="timeline__state"
          title="The timeline is drawing the preview, because the picture depends on the playhead. It hands the viewport back when the last track goes."
        >
          timeline preview
        </span>
      ) : null}

      <button
        type="button"
        className="ui-button"
        aria-pressed={props.binding}
        onClick={props.onBind}
      >
        bind parameter
      </button>
    </div>
  );
}
