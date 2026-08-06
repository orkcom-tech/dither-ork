import React from "react";

import { useViewport } from "../../app";
import { logger } from "../../lib/log";
import {
  VALUE_DRAG_SPAN,
  beginDrag,
  commitText,
  continueDrag,
  formatValue,
  normalized,
  nudge,
  precisionFor,
  quantize,
  type DragState,
  type NumericSpec,
} from "./numeric";

const log = logger("app");

export interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** The descriptor's drag/entry quantum. Absent means continuous. */
  readonly step?: number | undefined;
  readonly integer?: boolean | undefined;
  readonly hint?: string | undefined;
  /**
   * The name this drag reports to the viewport's adaptive preview (F-UI-03).
   * Conventionally `param:<nodeId>.<key>`.
   */
  readonly interaction: string;
  readonly onChange: (value: number) => void;
  /** Sits after the entry field — a unit, or a reroll button. */
  readonly trailing?: React.ReactNode;
  /** One line instead of two. Used inside a stack row. */
  readonly dense?: boolean | undefined;
}

/**
 * The numeric control — F-UI-06 in full.
 *
 * Three ways in, one arithmetic behind them (`./numeric.ts`): a track that
 * jumps to the pointer, the label dragged sideways with shift for fine and alt
 * for coarse, and a typed entry. The track is a `div` rather than
 * `<input type="range">` for exactly one reason — a native range control has no
 * way to see the modifier keys, so fine and coarse drag are not expressible on
 * it, and half of F-UI-06 would have to live somewhere else.
 *
 * Every drag brackets itself with `beginInteraction`/`endInteraction` on the
 * viewport, which is what puts the preview into its reduced resolution while
 * the value is moving and back to full on release, with the badge saying so.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step,
  integer,
  hint,
  interaction,
  onChange,
  trailing,
  dense,
}: NumberFieldProps): React.ReactElement {
  const viewport = useViewport();
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const drag = React.useRef<{
    state: DragState;
    value: number;
    spec: NumericSpec;
    pointerId: number;
    element: HTMLElement;
  } | null>(null);

  /** Non-null only while the entry field is being typed into. */
  const [typed, setTyped] = React.useState<string | null>(null);

  const isInteger = integer === true;
  const specFor = React.useCallback(
    (span: number): NumericSpec => ({ min, max, step, integer: isInteger, span }),
    [min, max, step, isInteger],
  );
  const displaySpec = specFor(1);

  const emit = React.useCallback(
    (next: number) => {
      if (next === value) return;
      onChange(next);
    },
    [onChange, value],
  );

  const startDrag = (
    event: React.PointerEvent<HTMLElement>,
    absolute: boolean,
  ): void => {
    const element = event.currentTarget;
    const rect = absolute
      ? (trackRef.current?.getBoundingClientRect() ?? element.getBoundingClientRect())
      : null;
    const spec = specFor(rect === null ? VALUE_DRAG_SPAN : rect.width);
    const precision = precisionFor(event);
    const started = beginDrag({
      x: event.clientX,
      current: value,
      precision,
      absolute,
      origin: rect === null ? 0 : rect.left,
      spec,
    });

    element.setPointerCapture(event.pointerId);
    drag.current = {
      state: started.state,
      value: started.value,
      spec,
      pointerId: event.pointerId,
      element,
    };
    viewport?.beginInteraction(interaction);
    log.debug("parameter drag started", {
      param: interaction,
      absolute,
      precision,
      from: value,
    });
    emit(started.value);
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const active = drag.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    const moved = continueDrag({
      state: active.state,
      x: event.clientX,
      precision: precisionFor(event),
      current: active.value,
      spec: active.spec,
    });
    drag.current = { ...active, state: moved.state, value: moved.value };
    emit(moved.value);
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const active = drag.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    if (active.element.hasPointerCapture(event.pointerId)) {
      active.element.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    viewport?.endInteraction(interaction);
    log.debug("parameter drag ended", { param: interaction, to: active.value });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const precision = precisionFor(event);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = nudge(value, 1, specFor(1), precision);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = nudge(value, -1, specFor(1), precision);
        break;
      case "PageUp":
        next = nudge(value, 10, specFor(1), precision);
        break;
      case "PageDown":
        next = nudge(value, -10, specFor(1), precision);
        break;
      case "Home":
        next = quantize(min, specFor(1));
        break;
      case "End":
        next = quantize(max, specFor(1));
        break;
      default:
        return;
    }
    event.preventDefault();
    emit(next);
  };

  const commit = (text: string): void => {
    const next = commitText(text, specFor(1));
    setTyped(null);
    if (next === null) {
      // Reverted, not guessed at. The field snaps back to the value that is
      // actually in the document, and the reason is on the console.
      log.warn("numeric entry rejected", { param: interaction, text });
      return;
    }
    emit(next);
  };

  const shown = typed ?? formatValue(value, displaySpec);
  const fill = normalized(value, displaySpec);

  return (
    <div className={`nf${dense === true ? " nf--dense" : ""}`}>
      <div
        className="nf__label"
        title={hint ?? `${label} — drag to change, shift for fine, alt for coarse`}
        onPointerDown={(event) => {
          event.preventDefault();
          startDrag(event, false);
        }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {label}
      </div>

      <div className="nf__row">
        <div
          className="nf__track"
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={formatValue(value, displaySpec)}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.focus();
            startDrag(event, true);
          }}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        >
          <div className="nf__fill" style={{ width: `${fill * 100}%` }} />
          <div className="nf__thumb" style={{ left: `${fill * 100}%` }} />
        </div>

        <input
          className="nf__entry"
          type="text"
          inputMode="decimal"
          aria-label={`${label} value`}
          value={shown}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={(event) => {
            if (typed !== null) commit(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(event.currentTarget.value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setTyped(null);
            }
          }}
        />
        {trailing}
      </div>
    </div>
  );
}
