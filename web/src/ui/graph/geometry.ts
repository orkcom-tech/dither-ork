/**
 * Pan, zoom, and where a wire is.
 *
 * Pure arithmetic over two coordinate spaces, kept out of the component for the
 * same reason `app/layout.ts` is: a transform bug that can only be reproduced by
 * dragging with a mouse is a bug nobody fixes, and every number below is a place
 * an off-by-one puts a wire beside its port instead of on it.
 *
 * - **World** units are CSS pixels at zoom 1. Everything `layout.ts` produces is
 *   in world units and nothing in it knows the view exists.
 * - **Screen** units are CSS pixels relative to the editor's own canvas element.
 *   A pointer event arrives here as `clientX - rect.left`.
 *
 * The transform is `screen = world * scale + offset`, which the DOM applies as
 * one `translate(...) scale(...)` on a single wrapper — so panning and zooming
 * move one element rather than re-laying out every card, and the browser can
 * composite it.
 */

import { NODE_WIDTH, PORT_ROW_HEIGHT, portOffsetY } from "./metrics";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ViewTransform {
  /** Screen position of world origin. */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Zoom limits.
 *
 * The floor is where an effect name stops being readable and the editor becomes
 * a diagram of coloured boxes; the ceiling is a little over life size, which is
 * as much as a port needs to be aimed at. Neither is a preference — beyond
 * either one the editor stops being able to do its job, so it does not go there.
 */
export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2;

/**
 * One notch of the zoom buttons and of the `+`/`-` keys.
 *
 * A ratio rather than an addition, so stepping in and then out returns exactly
 * where it started — an additive step does not, and a zoom that drifts every
 * time it is used is a zoom nobody trusts to be at 100%.
 */
export const ZOOM_STEP = 1.25;

export const IDENTITY_VIEW: ViewTransform = { x: 0, y: 0, scale: 1 };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function toScreen(view: ViewTransform, world: Point): Point {
  return { x: world.x * view.scale + view.x, y: world.y * view.scale + view.y };
}

export function toWorld(view: ViewTransform, screen: Point): Point {
  return { x: (screen.x - view.x) / view.scale, y: (screen.y - view.y) / view.scale };
}

export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/**
 * Zoom about a fixed screen point.
 *
 * The world point under the cursor stays under the cursor, which is the whole
 * of what makes wheel-zoom feel like zooming rather than like the graph running
 * away. Clamping the scale is done first so the offset is solved against the
 * scale that will actually be used — solving it against an unclamped scale and
 * then clamping is what makes a view drift every time it is zoomed at the limit.
 */
export function zoomAt(
  view: ViewTransform,
  anchor: Point,
  factor: number,
): ViewTransform {
  const scale = clampScale(view.scale * factor);
  if (scale === view.scale) return view;
  const world = toWorld(view, anchor);
  return { scale, x: anchor.x - world.x * scale, y: anchor.y - world.y * scale };
}

/** Zoom by a step about the centre of the canvas — what the buttons and keys do. */
export function zoomByStep(
  view: ViewTransform,
  steps: number,
  canvas: { readonly width: number; readonly height: number },
): ViewTransform {
  const factor = Math.pow(ZOOM_STEP, steps);
  return zoomAt(view, { x: canvas.width / 2, y: canvas.height / 2 }, factor);
}

/**
 * The view that shows all of `content` inside `canvas`.
 *
 * Never zooms past 1: a two-node document blown up to fill a wide panel reads as
 * a mistake, and the point of "fit" is to find the graph rather than to magnify
 * it. A canvas with no measured size yet returns the view unchanged rather than
 * dividing by zero — that happens on the first frame after mount.
 */
export function fitView(
  content: Bounds,
  canvas: { readonly width: number; readonly height: number },
  padding: number,
  fallback: ViewTransform = IDENTITY_VIEW,
): ViewTransform {
  if (canvas.width <= 0 || canvas.height <= 0) return fallback;
  if (content.width <= 0 || content.height <= 0) {
    return { scale: 1, x: canvas.width / 2, y: canvas.height / 2 };
  }
  const usableWidth = Math.max(1, canvas.width - padding * 2);
  const usableHeight = Math.max(1, canvas.height - padding * 2);
  const scale = clampScale(
    Math.min(1, Math.min(usableWidth / content.width, usableHeight / content.height)),
  );
  return {
    scale,
    x: (canvas.width - content.width * scale) / 2 - content.x * scale,
    y: (canvas.height - content.height * scale) / 2 - content.y * scale,
  };
}

// --- ports and wires ----------------------------------------------------

/** Where a node's output port sits, in world units. */
export function outputPoint(node: { readonly x: number; readonly y: number }): Point {
  return { x: node.x + NODE_WIDTH, y: node.y + portOffsetY(0) };
}

/** Where a node's `index`-th input port sits, in world units. */
export function inputPoint(
  node: { readonly x: number; readonly y: number },
  index: number,
): Point {
  return { x: node.x, y: node.y + portOffsetY(index) };
}

/**
 * The wire between two points, as an SVG path.
 *
 * A cubic with horizontal handles, so every wire leaves an output going right
 * and enters an input going right — which is what makes a wire that doubles back
 * (a node reading something to its right, which only a skip edge produces) read
 * as a detour rather than as a straight line through three other cards.
 *
 * The handle length grows with the horizontal gap and is floored, so two ports
 * one above the other still get a visible S rather than a vertical spike.
 */
export function wirePath(from: Point, to: Point): string {
  const span = Math.abs(to.x - from.x);
  const handle = Math.max(28, Math.min(120, span * 0.5));
  return `M ${round(from.x)} ${round(from.y)} C ${round(from.x + handle)} ${round(from.y)}, ${round(to.x - handle)} ${round(to.y)}, ${round(to.x)} ${round(to.y)}`;
}

/**
 * The loop a feedback port draws: out of the node's output, round the top, back
 * into the port.
 *
 * Drawn rather than left implicit because a feedback edge is the one edge no
 * document stores — it comes from the descriptor — and a loop nobody can see is
 * a node that appears to read nothing while behaving as though it reads itself.
 */
export function feedbackPath(
  node: { readonly x: number; readonly y: number; readonly height: number },
  portIndex: number,
): string {
  const out = outputPoint(node);
  const back = inputPoint(node, portIndex);
  const top = node.y - PORT_ROW_HEIGHT;
  return (
    `M ${round(out.x)} ${round(out.y)} ` +
    `C ${round(out.x + 34)} ${round(out.y)}, ${round(out.x + 34)} ${round(top)}, ${round(node.x + NODE_WIDTH / 2)} ${round(top)} ` +
    `C ${round(back.x - 34)} ${round(top)}, ${round(back.x - 34)} ${round(back.y)}, ${round(back.x)} ${round(back.y)}`
  );
}

/** Two decimals. Path strings end up in the DOM on every pointer move. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The nearest candidate within `radius`, or `null`.
 *
 * Ties are impossible in practice and broken by list order when they happen, so
 * the answer is a function of its arguments and not of iteration luck. This is
 * the forgiving part of "connecting must be forgiving": the caller passes every
 * port on screen and a drop lands on whichever is closest, rather than on
 * whichever the pointer happens to be inside.
 */
export function nearest<T>(
  candidates: readonly T[],
  pointOf: (candidate: T) => Point,
  target: Point,
  radius: number,
): { readonly candidate: T; readonly distance: number } | null {
  let best: { candidate: T; distance: number } | null = null;
  for (const candidate of candidates) {
    const away = distance(pointOf(candidate), target);
    if (away > radius) continue;
    if (best === null || away < best.distance) best = { candidate, distance: away };
  }
  return best;
}

/** The rectangle every card together occupies, padded. Empty graph gives zeroes. */
export function boundsOf(
  nodes: readonly { readonly x: number; readonly y: number; readonly width: number; readonly height: number }[],
): Bounds {
  if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
