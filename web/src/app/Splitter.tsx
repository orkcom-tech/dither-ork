import React from "react";

import { logger } from "../lib/log";

const log = logger("app");

export interface SplitterProps {
  readonly axis: "vertical" | "horizontal";
  /** Human name of what is being resized, for the accessible label and the log. */
  readonly label: string;
  /** Called on every pointer move with the pointer's client coordinate. */
  readonly onDrag: (clientPosition: number) => void;
  /** Keyboard adjustment, in CSS pixels, positive meaning "grow". */
  readonly onNudge: (delta: number) => void;
  /** Double-click, which collapses the thing being resized. */
  readonly onToggle: () => void;
}

const NUDGE = 16;
const NUDGE_COARSE = 64;

/**
 * A draggable divider.
 *
 * Pointer events with capture rather than global mouse listeners: the pointer
 * keeps sending to this element even when it leaves it, which is what makes a
 * fast drag not fall off the divider, and the capture ends by itself if the
 * pointer is cancelled by the OS.
 *
 * It is a `separator` with keyboard adjustment because a splitter that can only
 * be dragged is a panel a keyboard user cannot resize, and F-UI-08 is not
 * qualified with "by mouse".
 *
 * Nothing is logged per move — a drag is hundreds of events and a log nobody
 * can read is the same as no log. The commit is logged, once, on release.
 */
export function Splitter({
  axis,
  label,
  onDrag,
  onNudge,
  onToggle,
}: SplitterProps): React.ReactElement {
  const [dragging, setDragging] = React.useState(false);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    onDrag(axis === "vertical" ? event.clientX : event.clientY);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    log.debug("splitter released", { label, axis });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
    const grow = axis === "vertical" ? "ArrowRight" : "ArrowDown";
    const shrink = axis === "vertical" ? "ArrowLeft" : "ArrowUp";
    if (event.key === grow) onNudge(step);
    else if (event.key === shrink) onNudge(-step);
    else if (event.key === "Enter" || event.key === " ") onToggle();
    else return;
    event.preventDefault();
  };

  return (
    <div
      className={`splitter splitter--${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${label}`}
      aria-orientation={axis === "vertical" ? "vertical" : "horizontal"}
      data-dragging={dragging ? "true" : "false"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onToggle}
      onKeyDown={handleKeyDown}
    />
  );
}
