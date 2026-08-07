/**
 * Where the panel goes — the two placement clauses of F-UI-13.
 *
 * > never cover the control it describes, and stay inside the viewport near
 * > screen edges
 *
 * Both are guaranteed by construction rather than checked afterwards. The panel
 * is placed **outside** the anchor on one axis with a gap, and its extent on
 * that axis is clamped to the room that actually exists between the anchor and
 * the viewport edge. It therefore cannot reach back across the anchor no matter
 * how tall its content is: what does not fit scrolls inside the panel, which is
 * why {@link HelpPlacement} carries the size the panel is allowed to be as well
 * as the corner it starts at.
 *
 * The alternative — place it, measure, and nudge it if it overlaps — is one
 * frame of the panel in the wrong place and a class of bug that only appears at
 * particular window sizes. This is arithmetic, and it is tested at every edge
 * and corner without a browser.
 *
 * Side order is below, above, right, left. Below first because a panel under the
 * control is where the eye already is after reading a label, and because the
 * side columns of this application are narrow: a panel to the right of a slider
 * in the properties panel would be clamped to a strip.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type HelpSide = "below" | "above" | "right" | "left";

export interface HelpPlacement {
  /** Viewport coordinates of the panel's top-left corner. */
  readonly x: number;
  readonly y: number;
  readonly side: HelpSide;
  /** What the panel is allowed to occupy. Content beyond this scrolls. */
  readonly width: number;
  readonly height: number;
}

/** Clear space between the anchor and the panel. */
export const HELP_GAP = 10;

/** Clear space between the panel and the edge of the viewport. */
export const HELP_MARGIN = 8;

export const HELP_SIDE_ORDER: readonly HelpSide[] = ["below", "above", "right", "left"];

export interface PlaceHelpInput {
  /** The control being described, in viewport coordinates. */
  readonly anchor: Rect;
  /** The size the panel wants — its measured, unconstrained size. */
  readonly panel: Size;
  readonly viewport: Size;
  readonly gap?: number;
  readonly margin?: number;
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return value < low ? low : value > high ? high : value;
}

/** Room outside the anchor on `side`, less the gap and the viewport margin. */
function mainRoom(side: HelpSide, anchor: Rect, viewport: Size, gap: number, margin: number): number {
  const raw =
    side === "below"
      ? viewport.height - (anchor.y + anchor.height) - gap - margin
      : side === "above"
        ? anchor.y - gap - margin
        : side === "right"
          ? viewport.width - (anchor.x + anchor.width) - gap - margin
          : anchor.x - gap - margin;
  return raw > 0 ? raw : 0;
}

/** Room across `side` — the full viewport less both margins. */
function crossRoom(side: HelpSide, viewport: Size, margin: number): number {
  const raw =
    side === "below" || side === "above"
      ? viewport.width - margin * 2
      : viewport.height - margin * 2;
  return raw > 0 ? raw : 0;
}

function mainWanted(side: HelpSide, panel: Size): number {
  return side === "below" || side === "above" ? panel.height : panel.width;
}

function crossWanted(side: HelpSide, panel: Size): number {
  return side === "below" || side === "above" ? panel.width : panel.height;
}

/**
 * Place the panel against an anchor.
 *
 * Picks the first side the panel fits on whole; failing that, the side with the
 * most room, with the panel clamped to it. There is always an answer — a control
 * that fills the viewport leaves a small panel rather than no panel — and the
 * answer never intersects the anchor.
 */
export function placeHelp(input: PlaceHelpInput): HelpPlacement {
  const gap = input.gap ?? HELP_GAP;
  const margin = input.margin ?? HELP_MARGIN;
  const { anchor, panel, viewport } = input;

  let chosen: HelpSide = "below";
  let chosenRoom = -1;
  let found = false;

  for (const side of HELP_SIDE_ORDER) {
    const main = mainRoom(side, anchor, viewport, gap, margin);
    const cross = crossRoom(side, viewport, margin);
    if (main >= mainWanted(side, panel) && cross >= crossWanted(side, panel)) {
      chosen = side;
      chosenRoom = main;
      found = true;
      break;
    }
    if (main > chosenRoom) {
      chosen = side;
      chosenRoom = main;
    }
  }

  const available = found
    ? chosenRoom
    : mainRoom(chosen, anchor, viewport, gap, margin);
  const across = crossRoom(chosen, viewport, margin);

  const main = Math.min(mainWanted(chosen, panel), available);
  const cross = Math.min(crossWanted(chosen, panel), across);

  const width = chosen === "below" || chosen === "above" ? cross : main;
  const height = chosen === "below" || chosen === "above" ? main : cross;

  // The cross axis is aligned with the anchor's leading edge and then clamped
  // into the viewport — so a control at the right-hand edge gets a panel that
  // slides left rather than one that runs off the screen.
  const x =
    chosen === "right"
      ? anchor.x + anchor.width + gap
      : chosen === "left"
        ? anchor.x - gap - width
        : clamp(anchor.x, margin, viewport.width - width - margin);

  const y =
    chosen === "below"
      ? anchor.y + anchor.height + gap
      : chosen === "above"
        ? anchor.y - gap - height
        : clamp(anchor.y, margin, viewport.height - height - margin);

  return { x, y, side: chosen, width, height };
}

/** Whether two rectangles share any area. Used by the placement tests. */
export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}
