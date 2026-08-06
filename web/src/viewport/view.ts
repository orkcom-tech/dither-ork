/**
 * The view transform — F-UI-01 and F-UI-02.
 *
 * Pure arithmetic over an immutable {@link ViewState}: no canvas, no DOM, no
 * events. That is deliberate. Everything that decides *where a pixel lands* is
 * in this file and is unit-tested, so the canvas code in `viewport.ts` is left
 * with drawing and event plumbing and nothing that can be subtly wrong without
 * being visibly wrong.
 *
 * Coordinates:
 *
 * - **image space** — source pixels, origin at the image's top-left.
 * - **view space** — CSS pixels inside the viewport element, origin top-left.
 *
 * `x`/`y` are the position of the image's origin in view space, so
 * `view = image * scale + offset`. Device pixels never appear here; the canvas
 * multiplies by `devicePixelRatio` at draw time, and {@link deviceExactScale}
 * is the one place that ratio matters to the maths.
 */

export interface ViewState {
  /** Image pixels per CSS pixel. 1 is 100%. */
  readonly scale: number;
  /** View-space x of the image origin, CSS pixels. */
  readonly x: number;
  /** View-space y of the image origin, CSS pixels. */
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The zoom ladder (F-UI-02).
 *
 * Above 100% every rung is an integer, so stepping up from 100% always lands on
 * a scale where one source pixel is a whole number of screen pixels and the
 * nearest-neighbour draw is exact. Below 100% the rungs are the reciprocals of
 * the same integers, which is the other half of the same property: at 1/3 every
 * output pixel is fed by an exact 3x3 block.
 */
export const ZOOM_LADDER: readonly number[] = [
  1 / 32,
  1 / 24,
  1 / 16,
  1 / 12,
  1 / 8,
  1 / 6,
  1 / 4,
  1 / 3,
  1 / 2,
  1,
  2,
  3,
  4,
  6,
  8,
  12,
  16,
  24,
  32,
];

export const MIN_SCALE = 1 / 32;
export const MAX_SCALE = 32;

/** Distance from a rung, as a ratio, within which {@link snapScale} snaps. */
const SNAP_TOLERANCE = 0.06;

export function clampScale(scale: number): number {
  // NaN is the one input the clamp cannot express an answer to — it compares
  // false against everything, so `Math.min`/`Math.max` would propagate it into
  // the view transform and the canvas would silently draw nothing. Infinities
  // need no special case; they clamp.
  if (Number.isNaN(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Snap to a ladder rung when close enough to one (F-UI-02).
 *
 * Continuous zoom is the useful gesture and exact integer zoom is the useful
 * *destination*, so free zoom that passes near a rung is pulled onto it. The
 * tolerance is a ratio rather than an absolute difference because the ladder is
 * geometric: 6% either side of 1/8 and 6% either side of 16 have to feel the
 * same on the wheel.
 */
export function snapScale(scale: number, tolerance = SNAP_TOLERANCE): number {
  const clamped = clampScale(scale);
  let best = clamped;
  let bestError = Number.POSITIVE_INFINITY;
  for (const rung of ZOOM_LADDER) {
    const error = Math.abs(Math.log(clamped / rung));
    if (error < bestError) {
      bestError = error;
      best = rung;
    }
  }
  return bestError <= tolerance ? best : clamped;
}

/** The next rung up (`direction` 1) or down (-1) from an arbitrary scale. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  const clamped = clampScale(scale);
  if (direction === 1) {
    for (const rung of ZOOM_LADDER) {
      if (rung > clamped * (1 + 1e-6)) return rung;
    }
    return MAX_SCALE;
  }
  for (let i = ZOOM_LADDER.length - 1; i >= 0; i -= 1) {
    const rung = ZOOM_LADDER[i];
    if (rung !== undefined && rung < clamped * (1 - 1e-6)) return rung;
  }
  return MIN_SCALE;
}

/**
 * The scale actually used to draw, given the display's pixel ratio.
 *
 * F-UI-01 requires pixel-exact nearest-neighbour rendering above 100%, and
 * "pixel-exact" is a statement about *device* pixels: a source pixel has to
 * cover a whole number of them or the nearest-neighbour sampler drops or
 * doubles a row somewhere in the middle of the image, which on a dither pattern
 * reads as a seam. `scale * dpr` is therefore rounded to an integer whenever the
 * zoom is at or above 100%.
 *
 * Below 100% nothing is quantized: there is no exactness to preserve when many
 * source pixels share one device pixel, and quantizing would make the fit scale
 * jump.
 */
export function deviceExactScale(scale: number, devicePixelRatio: number): number {
  if (scale < 1) return scale;
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(1, Math.round(scale * dpr)) / dpr;
}

/** True when one source pixel covers a whole number of device pixels. */
export function isPixelExact(scale: number, devicePixelRatio: number): boolean {
  if (scale < 1) return false;
  const product = scale * (devicePixelRatio > 0 ? devicePixelRatio : 1);
  return Math.abs(product - Math.round(product)) < 1e-6;
}

/** Largest scale at which `content` fits inside `viewport`, minus padding. */
export function fitScale(content: Size, viewport: Size, padding = 0): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  return clampScale(
    Math.min(availableWidth / content.width, availableHeight / content.height),
  );
}

/** Centre `content` at `scale` inside `viewport`. */
export function centreView(content: Size, viewport: Size, scale: number): ViewState {
  const s = clampScale(scale);
  return {
    scale: s,
    x: Math.round((viewport.width - content.width * s) / 2),
    y: Math.round((viewport.height - content.height * s) / 2),
  };
}

/** Fit and centre (F-UI-02, the "fit" action). */
export function fitView(content: Size, viewport: Size, padding = 0): ViewState {
  return centreView(content, viewport, fitScale(content, viewport, padding));
}

/**
 * Change scale while holding one view-space point still.
 *
 * This is what makes wheel zoom feel attached to the cursor rather than to the
 * centre of the window; the same call implements pinch zoom and the keyboard
 * zoom (anchored at the viewport centre).
 */
export function zoomAt(view: ViewState, nextScale: number, anchor: Point): ViewState {
  const scale = clampScale(nextScale);
  const image = viewToImage(view, anchor);
  return {
    scale,
    x: anchor.x - image.x * scale,
    y: anchor.y - image.y * scale,
  };
}

export function panBy(view: ViewState, dx: number, dy: number): ViewState {
  return { scale: view.scale, x: view.x + dx, y: view.y + dy };
}

export function viewToImage(view: ViewState, point: Point): Point {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

export function imageToView(view: ViewState, point: Point): Point {
  return { x: point.x * view.scale + view.x, y: point.y * view.scale + view.y };
}

/** The image's rectangle in view space, CSS pixels. */
export function imageRect(
  view: ViewState,
  content: Size,
): { x: number; y: number; width: number; height: number } {
  return {
    x: view.x,
    y: view.y,
    width: content.width * view.scale,
    height: content.height * view.scale,
  };
}

/**
 * Keep at least `keepVisible` CSS pixels of the image inside the viewport.
 *
 * Panning is unbounded in every direction until the image would leave the
 * window entirely; the alternative — clamping the image's edges to the
 * viewport's — makes it impossible to work on a corner at high zoom, and losing
 * the image off-screen with no way back is the failure this prevents.
 */
export function clampView(
  view: ViewState,
  content: Size,
  viewport: Size,
  keepVisible = 48,
): ViewState {
  const rect = imageRect(view, content);
  const margin = Math.min(
    keepVisible,
    Math.max(1, rect.width),
    Math.max(1, rect.height),
  );
  const minX = margin - rect.width;
  const maxX = viewport.width - margin;
  const minY = margin - rect.height;
  const maxY = viewport.height - margin;
  return {
    scale: view.scale,
    x: Math.min(maxX, Math.max(minX, view.x)),
    y: Math.min(maxY, Math.max(minY, view.y)),
  };
}

/** Human-readable zoom, e.g. `100%`, `800%`, `33.3%`. */
export function formatZoom(scale: number): string {
  const percent = scale * 100;
  const rounded = percent >= 100 ? Math.round(percent) : Math.round(percent * 10) / 10;
  return `${rounded}%`;
}
