/**
 * The frame contract — the interface by which the application hands the
 * viewport something to show.
 *
 * This is the seam between the render graph and the screen, and it is
 * deliberately narrow: the viewport knows nothing about documents, stacks,
 * palettes or WebGPU. It is given a picture and told how big the document it
 * came from is, and everything else it does — zoom, pan, compare, the degraded
 * badge — follows from those two facts.
 *
 * ## sRGB, at the edge
 *
 * A frame is **display-referred sRGB**, 8-bit, because that is what a 2D canvas
 * draws. The pipeline is linear light from end to end (docs/ARCHITECTURE.md,
 * "Colour") and the transfer is reapplied exactly once, by whoever produces the
 * frame. The viewport applies no colour transform of its own; if it did, there
 * would be two answers to what the image looks like.
 *
 * ## Alpha
 *
 * Unassociated, and preserved (F-IN-03). The checkerboard the viewport draws
 * behind the image (F-UI-05) is the only thing that ever appears underneath it.
 *
 * ## Ownership
 *
 * **The viewport owns every frame handed to it.** When a frame is replaced or
 * the viewport is disposed, an `ImageBitmap` it was holding is `close()`d.
 * Producers must not reuse a bitmap after passing it in. The rule exists
 * because the alternative — everyone frees their own — leaks a bitmap per
 * render at 60 frames a second during a slider drag, and an `ImageBitmap` holds
 * GPU memory that nothing in the JS heap accounts for.
 */

import type { FrameQuality } from "./quality";
import type { Size } from "./view";

/** Anything a 2D context can `drawImage`. */
export type FrameImage =
  | ImageBitmap
  | ImageData
  | HTMLCanvasElement
  | OffscreenCanvas;

export interface ViewportFrame {
  /** The rendered picture, sRGB, 8-bit, unassociated alpha. */
  readonly image: FrameImage;
  /** Width of the document this was rendered from, in document pixels. */
  readonly documentWidth: number;
  /** Height of the document this was rendered from, in document pixels. */
  readonly documentHeight: number;
  /**
   * Whether this is a full-quality render or a reduced one (F-UI-03). A
   * `preview` frame keeps the degraded badge up for as long as it is on screen.
   */
  readonly quality: FrameQuality;
  /** The render's correlation id, so a frame on screen ties back to its log. */
  readonly correlationId?: string;
}

/** Pixel dimensions of the image itself, which may be below the document's. */
export function frameImageSize(frame: ViewportFrame): Size {
  const image = frame.image;
  return { width: image.width, height: image.height };
}

/**
 * The frame's resolution as a fraction of the document's.
 *
 * 1 means the frame is the document's own size. Below 1 the frame is being
 * magnified to stand in for the document, which is the degraded state the badge
 * reports whatever the frame's declared quality says — a half-resolution frame
 * labelled `full` is still half resolution on screen, and the badge follows the
 * picture rather than the label.
 */
export function frameScale(frame: ViewportFrame): number {
  if (frame.documentWidth <= 0) return 1;
  return frame.image.width / frame.documentWidth;
}

/**
 * Release a frame's underlying resources.
 *
 * Only `ImageBitmap` holds anything that needs releasing; the other three are
 * ordinary garbage. Called by the viewport when a frame is replaced or dropped.
 *
 * The check is `close` being callable rather than `instanceof ImageBitmap` so
 * that this module names no browser global and stays inside the node test
 * suite, which is where the repository keeps every layer that does not need a
 * DOM (docs/DEVELOPMENT.md, "Tests"). Of the four members of {@link FrameImage}
 * only `ImageBitmap` has a `close`, so the test is exact rather than
 * approximate.
 */
export function releaseFrame(frame: ViewportFrame | null): void {
  if (frame === null) return;
  const image: FrameImage = frame.image;
  if ("close" in image && typeof image.close === "function") image.close();
}
