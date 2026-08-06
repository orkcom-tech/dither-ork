import React from "react";

import { useViewport } from "../../app";
import { logger } from "../../lib/log";
import type { CurvePoint } from "../../types/document";
import {
  copyCurve,
  insertCurvePoint,
  moveCurvePoint,
  nearestPoint,
  removeCurvePoint,
  sampleCurve,
} from "./curve";

const log = logger("app");

/**
 * The widget's internal coordinate system. Unit-square values are drawn into
 * this box, so a stroke width of 1 is one hundredth of the widget whatever size
 * CSS gives it.
 */
const BOX = 100;

/** How close a pointer has to be, in unit-square distance, to grab a point. */
const GRAB_RADIUS = 0.05;

/** Enough that the drawn line is the evaluated curve, not an approximation of it. */
const SAMPLES = 129;

export interface CurveEditorProps {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly value: readonly CurvePoint[];
  /** The descriptor's default, for the reset control. */
  readonly fallback: readonly CurvePoint[];
  readonly interaction: string;
  readonly onChange: (points: readonly CurvePoint[]) => void;
}

function toSvgX(x: number): number {
  return x * BOX;
}

function toSvgY(y: number): number {
  // SVG y grows downward and a transfer curve does not.
  return (1 - y) * BOX;
}

/**
 * The `curve` parameter kind (F-PP-05's control).
 *
 * Click the line to add a point, drag a point to move it, alt-click a point to
 * remove it. The two endpoints keep their x, because the schema requires the
 * curve to span the whole domain.
 *
 * The drawn line is `sampleCurve`, which is `evaluateCurve`, which is the
 * definition any node consuming a curve has to use — see `./curve.ts`. Drawing
 * a shape the renderer does not apply is the one failure a curve widget can
 * have that you cannot see by looking at the widget.
 */
export function CurveEditor({
  label,
  hint,
  value,
  fallback,
  interaction,
  onChange,
}: CurveEditorProps): React.ReactElement {
  const viewport = useViewport();
  const surface = React.useRef<SVGSVGElement | null>(null);
  const drag = React.useRef<{ index: number; pointerId: number } | null>(null);
  const [active, setActive] = React.useState<number>(-1);

  const path = React.useMemo(() => {
    const samples = sampleCurve(value, SAMPLES);
    return samples
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${toSvgX(point.x).toFixed(3)} ${toSvgY(point.y).toFixed(3)}`,
      )
      .join(" ");
  }, [value]);

  const unitAt = (clientX: number, clientY: number): CurvePoint | null => {
    const element = surface.current;
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: (clientX - rect.left) / rect.width,
      y: 1 - (clientY - rect.top) / rect.height,
    };
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    const at = unitAt(event.clientX, event.clientY);
    if (at === null) {
      log.error("curve editor has no measurable surface", { param: interaction });
      return;
    }
    event.preventDefault();

    const hit = nearestPoint(value, at.x, at.y, GRAB_RADIUS);

    if (hit !== -1 && event.altKey) {
      const next = removeCurvePoint(value, hit);
      if (next === value) {
        log.info("curve point not removable", {
          param: interaction,
          index: hit,
          points: value.length,
        });
        return;
      }
      log.info("curve point removed", { param: interaction, index: hit });
      onChange(next);
      setActive(-1);
      return;
    }

    let index = hit;
    let points = value;
    if (index === -1) {
      const inserted = insertCurvePoint(value, at.x, at.y);
      if (inserted.index === -1) {
        log.info("curve point not inserted", { param: interaction, x: at.x });
        return;
      }
      points = inserted.points;
      index = inserted.index;
      log.info("curve point added", { param: interaction, index, x: at.x });
      onChange(points);
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { index, pointerId: event.pointerId };
    setActive(index);
    viewport?.beginInteraction(interaction);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const held = drag.current;
    if (held === null || held.pointerId !== event.pointerId) return;
    const at = unitAt(event.clientX, event.clientY);
    if (at === null) return;
    const next = moveCurvePoint(value, held.index, at.x, at.y);
    if (next !== value) onChange(next);
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>): void => {
    const held = drag.current;
    if (held === null || held.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    viewport?.endInteraction(interaction);
    log.debug("curve edit ended", { param: interaction, points: value.length });
  };

  return (
    <div className="field">
      <div className="field__label" title={hint ?? label}>
        {label}
      </div>

      <svg
        className="curve"
        ref={surface}
        viewBox={`0 0 ${BOX} ${BOX}`}
        preserveAspectRatio="none"
        role="application"
        aria-label={`${label} — click to add a point, drag to move, alt-click to remove`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <rect className="curve__ground" x={0} y={0} width={BOX} height={BOX} />
        {[0.25, 0.5, 0.75].map((at) => (
          <React.Fragment key={at}>
            <line
              className="curve__grid"
              x1={toSvgX(at)}
              y1={0}
              x2={toSvgX(at)}
              y2={BOX}
              vectorEffect="non-scaling-stroke"
            />
            <line
              className="curve__grid"
              x1={0}
              y1={toSvgY(at)}
              x2={BOX}
              y2={toSvgY(at)}
              vectorEffect="non-scaling-stroke"
            />
          </React.Fragment>
        ))}
        <line
          className="curve__identity"
          x1={0}
          y1={BOX}
          x2={BOX}
          y2={0}
          vectorEffect="non-scaling-stroke"
        />
        <path className="curve__line" d={path} vectorEffect="non-scaling-stroke" />
        {value.map((point, index) => (
          <circle
            key={`${index}:${point.x}`}
            className={`curve__point${index === active ? " curve__point--active" : ""}`}
            cx={toSvgX(point.x)}
            cy={toSvgY(point.y)}
            r={3}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <div className="curve__footer">
        <span className="field__note">{value.length} points</span>
        <button
          type="button"
          className="ui-button"
          onClick={() => {
            log.info("curve reset to default", { param: interaction });
            onChange(copyCurve(fallback));
            setActive(-1);
          }}
        >
          reset
        </button>
      </div>
    </div>
  );
}
