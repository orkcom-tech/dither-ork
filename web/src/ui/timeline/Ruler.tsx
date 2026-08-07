import React from "react";

/**
 * The loop range and the scrub surface — half of F-AN-07, and the scrub half of
 * F-AN-09.
 *
 * The ruler is the whole loop and nothing else: frame 0 at the left edge, frame
 * `N - 1` at the right. It does **not** draw frame `N`, because `t` never
 * reaches 1 (F-AN-01) — frame `N` is frame 0 of the next repeat, and giving it a
 * position here would draw the seam as a gap the loop does not have.
 */

/** Tick spacings the ruler is willing to use, in frames. */
const STEPS: readonly number[] = [1, 2, 5, 10, 15, 20, 30, 60, 120, 240, 480, 960, 1920];

/** Most labels a ruler shows before they run into each other. */
const MAX_TICKS = 12;

export function tickStep(frames: number): number {
  for (const step of STEPS) {
    if (frames / step <= MAX_TICKS) return step;
  }
  return Math.max(1, Math.ceil(frames / MAX_TICKS));
}

/** The frame a pointer at `x` within a `width`-wide ruler is over. */
export function frameAtOffset(x: number, width: number, frames: number): number {
  if (width <= 0 || frames < 1) return 0;
  const fraction = x / width;
  const frame = Math.floor(fraction * frames);
  return frame < 0 ? 0 : frame > frames - 1 ? frames - 1 : frame;
}

export interface RulerProps {
  readonly frames: number;
  readonly fps: number;
  readonly playhead: number;
  readonly onScrub: (frame: number) => void;
  /** Bracketed around a drag so the preview may degrade while it moves. */
  readonly onScrubStart: () => void;
  readonly onScrubEnd: () => void;
  readonly onStep: (delta: number) => void;
}

export function Ruler({
  frames,
  fps,
  playhead,
  onScrub,
  onScrubStart,
  onScrubEnd,
  onStep,
}: RulerProps): React.ReactElement {
  const element = React.useRef<HTMLDivElement | null>(null);
  const dragging = React.useRef<number | null>(null);

  const step = tickStep(frames);
  const ticks: number[] = [];
  for (let frame = 0; frame < frames; frame += step) ticks.push(frame);

  const scrubTo = (clientX: number): void => {
    const host = element.current;
    if (host === null) return;
    const rect = host.getBoundingClientRect();
    onScrub(frameAtOffset(clientX - rect.left, rect.width, frames));
  };

  return (
    <div
      className="timeline__ruler"
      ref={element}
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={frames - 1}
      aria-valuenow={playhead}
      aria-valuetext={`frame ${playhead} of ${frames}`}
      // Arrow keys step, shift steps ten, Home and End are the ends of the loop.
      // A ruler that only answers a pointer is a ruler half the users cannot
      // move — the same argument the stack editor makes for its step buttons.
      onKeyDown={(event) => {
        const coarse = event.shiftKey ? 10 : 1;
        switch (event.key) {
          case "ArrowLeft":
            onStep(-coarse);
            break;
          case "ArrowRight":
            onStep(coarse);
            break;
          case "Home":
            onScrub(0);
            break;
          case "End":
            onScrub(frames - 1);
            break;
          default:
            return;
        }
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = event.pointerId;
        onScrubStart();
        scrubTo(event.clientX);
      }}
      onPointerMove={(event) => {
        if (dragging.current !== event.pointerId) return;
        scrubTo(event.clientX);
      }}
      onPointerUp={(event) => {
        if (dragging.current !== event.pointerId) return;
        dragging.current = null;
        onScrubEnd();
      }}
      onPointerCancel={(event) => {
        if (dragging.current !== event.pointerId) return;
        dragging.current = null;
        onScrubEnd();
      }}
    >
      {ticks.map((frame) => (
        <React.Fragment key={frame}>
          <div className="timeline__tick" style={{ left: `${(frame / frames) * 100}%` }} />
          <div
            className="timeline__tick-label"
            style={{ left: `${(frame / frames) * 100}%` }}
            // Frames on the ruler, seconds in the transport readout: both at
            // every tick is more text than the gaps hold, and the frame index is
            // the number every other control in here speaks.
            title={`frame ${frame} — ${(frame / fps).toFixed(2)} s`}
          >
            {frame}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
