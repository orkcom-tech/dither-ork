import React from "react";

import type { HelpArticle } from "./article";
import { placeHelp, type Rect, type Size } from "./placement";
import type { HelpTargetKind } from "./target";
import "./help.css";

/**
 * The panel itself — everything F-UI-13 asks to be *shown*, and nothing about
 * when to show it (`dwell.ts`) or where it sits (`placement.ts`).
 *
 * ## Measure, then place
 *
 * The placement needs the panel's size and the panel's size depends on its text,
 * so the first render of any article is deliberately unplaced: the panel is laid
 * out at its natural height, hidden, measured, and only then positioned. That is
 * one hidden frame rather than a visible jump, and it is why the measurement is
 * keyed on the article's token — a new article means a new natural height, and
 * measuring the *previous* one while `max-height` is still applied would place
 * the new one against a stale number.
 *
 * Once measured, moving the anchor (a scroll, a window resize) re-places from
 * the stored measurement without touching the DOM again.
 *
 * `position: fixed` and viewport coordinates, so the panel is not clipped by the
 * `overflow: hidden` of whichever panel the control lives in.
 */

export interface HelpPanelProps {
  readonly article: HelpArticle;
  /** The control being described, in viewport coordinates. */
  readonly anchor: Rect;
  readonly viewport: Size;
  /** Referenced by the anchor's `aria-describedby` while this is open. */
  readonly id: string;
}

const KIND_LABEL: Record<HelpTargetKind, string> = {
  effect: "effect",
  param: "parameter",
  concept: "concept",
  "effect-concept": "concept",
};

export function HelpPanel({
  article,
  anchor,
  viewport,
  id,
}: HelpPanelProps): React.ReactElement {
  const panel = React.useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = React.useState<{
    readonly token: string;
    readonly size: Size;
  } | null>(null);

  // Derived rather than stored, so a change of article invalidates the
  // measurement in the same render that shows the new text.
  const wanted = measured !== null && measured.token === article.token ? measured.size : null;

  React.useLayoutEffect(() => {
    if (wanted !== null) return;
    const element = panel.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    setMeasured({
      token: article.token,
      size: { width: rect.width, height: rect.height },
    });
  }, [wanted, article.token]);

  const placement =
    wanted === null ? null : placeHelp({ anchor, panel: wanted, viewport });

  const style: React.CSSProperties =
    placement === null
      ? // The measuring pass. Off in the corner, hidden, and transparent to the
        // pointer so it cannot swallow the move that is still in flight.
        { left: 0, top: 0, visibility: "hidden", pointerEvents: "none" }
      : {
          left: `${placement.x}px`,
          top: `${placement.y}px`,
          maxWidth: `${placement.width}px`,
          maxHeight: `${placement.height}px`,
        };

  return (
    <div
      ref={panel}
      id={id}
      role="tooltip"
      className={`help-panel ui-scroll${
        placement === null ? "" : ` help-panel--placed help-panel--${placement.side}`
      }`}
      style={style}
    >
      <div className="help-panel__head">
        <h2 className="help-panel__title">{article.title}</h2>
        <span className="help-panel__kind">{KIND_LABEL[article.kind]}</span>
      </div>

      {article.summary === null ? null : (
        <p className="help-panel__summary">{article.summary}</p>
      )}

      <p className="help-panel__body">{article.description}</p>

      {article.family === null ? null : (
        <p className="help-panel__family">
          <b>{article.family.title}</b> — {article.family.summary}
        </p>
      )}

      {article.facts.length === 0 ? null : (
        <dl className="help-panel__facts">
          {article.facts.map((fact, index) => (
            <React.Fragment key={`${fact.label}-${index}`}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}
