/**
 * The viewport — the canvas half of the application.
 *
 * Two things a caller needs from here:
 *
 * 1. {@link Viewport}, which owns a canvas inside an element you give it.
 * 2. {@link ViewportFrame}, the contract for handing it something to show.
 *
 * ```ts
 * const viewport = new Viewport(host);
 * viewport.on("request", (req) => renderer.render(req));   // the render seam
 * viewport.setFrame({ image, documentWidth, documentHeight, quality: "full" });
 * viewport.setReference({ image: source, ...size, quality: "full" });  // F-UI-04
 * ```
 *
 * The pure modules are exported too: they are the specification of what the
 * viewport does, they are unit-tested without a DOM, and a panel that needs to
 * reason about zoom or degradation should use them rather than re-deriving it.
 */

export {
  Viewport,
  type FramePaintedEvent,
  type QualityEvent,
  type RenderRequest,
  type ViewEvent,
  type ViewportEventName,
  type ViewportEvents,
  type ViewportOptions,
} from "./viewport";

export {
  frameImageSize,
  frameScale,
  releaseFrame,
  type FrameImage,
  type ViewportFrame,
} from "./frame";

export {
  DEFAULT_COMPARE,
  comparePlan,
  setHolding,
  setMode as setCompareMode,
  setSplit,
  toggleSplit,
  type CompareMode,
  type CompareState,
} from "./compare";

export {
  IDLE_INTERACTION,
  beginInteraction,
  degradedState,
  endInteraction,
  isInteracting,
  previewScaleFactor,
  requestedQuality,
  type DegradedState,
  type FrameQuality,
  type InteractionState,
} from "./quality";

export {
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_LADDER,
  centreView,
  clampScale,
  clampView,
  deviceExactScale,
  fitScale,
  fitView,
  formatZoom,
  imageRect,
  imageToView,
  isPixelExact,
  panBy,
  snapScale,
  stepZoom,
  viewToImage,
  zoomAt,
  type Point,
  type Size,
  type ViewState,
} from "./view";
