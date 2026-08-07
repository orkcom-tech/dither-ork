import React from "react";

import type { TrackCurve } from "./evaluate";
import type { Keyframe } from "./keyframes";
import { frameAtOffset } from "./Ruler";

/**
 * One track's lane — the curve the render will actually follow, and the keys
 * that shape it.
 *
 * The curve is sampled from the plan, which reads it back through the animation
 * core's own evaluator (`evaluate.ts`, {@link TrackCurve}). It is therefore the
 * value the picture uses, clamp and rounding included, rather than a second
 * drawing of the same intention that could disagree with it.
 *
 * The lane is drawn in a fixed 1000 × 100 space and stretched by the browser
 * (`preserveAspectRatio="none"`), so a resize costs no re-render. That stretch
 * would also stretch the stroke, which is what `vector-effect` is for.
 */

const VIEW_W = 1000;
const VIEW_H = 100;
/** Kept clear at the top and bottom so a flat curve is not drawn on the edge. */
const PAD = 8;

function scaleY(value: number, lo: number, hi: number): number {
  if (!(hi > lo)) return VIEW_H / 2;
  const unit = (value - lo) / (hi - lo);
  return VIEW_H - PAD - unit * (VIEW_H - 2 * PAD);
}

/** The vertical extent a lane draws over: the curve's own range, never zero-high. */
export function laneRange(curve: TrackCurve): { readonly lo: number; readonly hi: number } {
  if (curve.max > curve.min) return { lo: curve.min, hi: curve.max };
  // A flat curve — a track at amount 0, or one key. Half a unit either side of
  // it so the line lands in the middle instead of on an edge.
  const span = Math.max(Math.abs(curve.base) * 0.1, 0.5);
  return { lo: curve.base - span, hi: curve.base + span };
}

export function curvePath(curve: TrackCurve, frames: number): string {
  const { lo, hi } = laneRange(curve);
  let path = "";
  for (let i = 0; i < curve.values.length; i += 1) {
    const value = curve.values[i];
    const frame = curve.frames[i];
    if (value === undefined || frame === undefined) continue;
    const x = (frame / frames) * VIEW_W;
    const y = scaleY(value, lo, hi);
    path += `${path === "" ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return path;
}

export interface LaneProps {
  readonly curve: TrackCurve | null;
  readonly frames: number;
  readonly enabled: boolean;
  /** Keys, when the track carries them. Absent on a modulator track. */
  readonly keys?: readonly Keyframe[] | undefined;
  readonly selectedKeyFrame?: number | null | undefined;
  /** Clicking empty lane on a keyframe track sets a key there. */
  readonly onAddKey?: ((frame: number) => void) | undefined;
  readonly onMoveKey?: ((from: number, to: number) => void) | undefined;
  readonly onSelectKey?: ((frame: number) => void) | undefined;
  readonly onDragStart?: (() => void) | undefined;
  readonly onDragEnd?: (() => void) | undefined;
}

export function Lane({
  curve,
  frames,
  enabled,
  keys,
  selectedKeyFrame,
  onAddKey,
  onMoveKey,
  onSelectKey,
  onDragStart,
  onDragEnd,
}: LaneProps): React.ReactElement {
  const host = React.useRef<HTMLDivElement | null>(null);
  const drag = React.useRef<{ pointerId: number; from: number } | null>(null);

  const frameAt = (clientX: number): number => {
    const element = host.current;
    if (element === null) return 0;
    const rect = element.getBoundingClientRect();
    return frameAtOffset(clientX - rect.left, rect.width, frames);
  };

  const range = curve === null ? null : laneRange(curve);

  return (
    <div
      className={
        "timeline__lane" +
        (keys === undefined ? "" : " timeline__lane--keyframe") +
        (enabled ? "" : " timeline__lane--off")
      }
      ref={host}
      onPointerDown={(event) => {
        // Only the empty lane adds a key; a key handles its own pointer.
        if (keys === undefined || onAddKey === undefined) return;
        if (event.target !== event.currentTarget && !(event.target instanceof SVGElement)) return;
        event.preventDefault();
        onAddKey(frameAt(event.clientX));
      }}
    >
      {curve === null ? null : (
        <svg
          className="timeline__curve"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {range === null ? null : (
            <line
              x1={0}
              x2={VIEW_W}
              y1={scaleY(curve.base, range.lo, range.hi)}
              y2={scaleY(curve.base, range.lo, range.hi)}
              vectorEffect="non-scaling-stroke"
            />
          )}
          <path d={curvePath(curve, frames)} vectorEffect="non-scaling-stroke" />
        </svg>
      )}

      {keys?.map((key) => (
        <button
          key={key.frame}
          type="button"
          className={
            "timeline__key" +
            (key.easing === "hold" ? " timeline__key--hold" : "") +
            (key.frame === selectedKeyFrame ? " timeline__key--selected" : "")
          }
          style={{ left: `${(key.frame / frames) * 100}%` }}
          title={`frame ${key.frame} — ${key.value} — ${key.easing} to the next key`}
          aria-label={`Keyframe at frame ${key.frame}`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { pointerId: event.pointerId, from: key.frame };
            onSelectKey?.(key.frame);
            onDragStart?.();
          }}
          onPointerMove={(event) => {
            const active = drag.current;
            if (active === null || active.pointerId !== event.pointerId) return;
            const to = frameAt(event.clientX);
            if (to === active.from) return;
            onMoveKey?.(active.from, to);
            drag.current = { pointerId: event.pointerId, from: to };
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            drag.current = null;
            onDragEnd?.();
          }}
          onPointerCancel={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            drag.current = null;
            onDragEnd?.();
          }}
        />
      ))}

      {curve === null || range === null ? null : (
        <span className="timeline__range">
          {format(range.lo)} … {format(range.hi)}
        </span>
      )}
    </div>
  );
}

function format(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 1 ? 3 : 2);
}
