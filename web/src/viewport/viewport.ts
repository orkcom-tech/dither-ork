/**
 * The viewport.
 *
 * It owns its canvas and it is **not React** (docs/ARCHITECTURE.md, "Stack").
 * React reconciles a tree; this thing reconciles nothing — it is handed a
 * picture and a view transform and it paints, at most once per animation frame,
 * with no virtual DOM between the pointer and the pixels. Every panel around it
 * is React because those panels are DOM-heavy and change shape; the viewport's
 * DOM is eleven fixed elements and never changes shape at all.
 *
 * What lives here: the canvas, the overlay, the event plumbing, and the paint.
 * What deliberately does not: the view maths (`view.ts`), the degradation
 * policy (`quality.ts`) and the comparison policy (`compare.ts`), each pure and
 * each unit-tested without a DOM.
 *
 * Requirements implemented here: F-UI-01 (zoom and pan, pixel-exact
 * nearest-neighbour above 100%), F-UI-02 (fit / 100% / integer-zoom snapping),
 * F-UI-03 (adaptive preview resolution with a visible degraded indicator),
 * F-UI-04 (before/after split slider and hold-to-compare), F-UI-05
 * (checkerboard behind transparency).
 */

import { logger, type Logger } from "../lib/log";
import {
  DEFAULT_COMPARE,
  comparePlan,
  setHolding,
  setMode,
  setSplit,
  toggleSplit,
  type CompareMode,
  type CompareState,
} from "./compare";
import { frameScale, releaseFrame, type ViewportFrame } from "./frame";
import {
  IDLE_INTERACTION,
  beginInteraction,
  degradedState,
  endInteraction,
  isInteracting,
  previewScaleFactor,
  requestedQuality,
  type FrameQuality,
  type InteractionState,
} from "./quality";
import {
  clampView,
  centreView,
  deviceExactScale,
  fitScale,
  formatZoom,
  imageRect,
  isPixelExact,
  panBy,
  snapScale,
  stepZoom,
  zoomAt,
  type Point,
  type Size,
  type ViewState,
} from "./view";
import "./viewport.css";

/** What the application must render next, and at what resolution. */
export interface RenderRequest {
  readonly quality: FrameQuality;
  /**
   * Fraction of document resolution to render at. 1 means full. Anything below
   * 1 must arrive back as a frame whose `quality` is `preview`, or the badge
   * will report the reduction and the label will disagree with it.
   */
  readonly factor: number;
  /** Why the request was raised — `"interaction-start"`, `"idle"`, `"resize"`. */
  readonly reason: string;
  /** Viewport size in CSS pixels, for anything that wants to size to the screen. */
  readonly viewport: Size;
  /** Current zoom, image pixels per CSS pixel. */
  readonly zoom: number;
}

export interface ViewEvent {
  readonly scale: number;
  /** The scale actually drawn at, after device-pixel quantization. */
  readonly effectiveScale: number;
  readonly x: number;
  readonly y: number;
  readonly pixelExact: boolean;
}

export interface QualityEvent {
  readonly requested: FrameQuality;
  /** What is on screen right now — a property of the frame, not the intent. */
  readonly displayed: FrameQuality;
  /** The frame's resolution as a fraction of the document's. */
  readonly displayedScale: number;
  readonly degraded: boolean;
  /** Interaction sources currently holding the preview down. */
  readonly sources: readonly string[];
}

export interface FramePaintedEvent {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly quality: FrameQuality;
  readonly ms: number;
}

export interface ViewportEvents {
  readonly view: ViewEvent;
  readonly quality: QualityEvent;
  readonly request: RenderRequest;
  readonly compare: CompareState;
  readonly painted: FramePaintedEvent;
}

export type ViewportEventName = keyof ViewportEvents;

export interface ViewportOptions {
  /** Gap kept around the image when fitting, CSS pixels. */
  readonly padding?: number;
  /** Quiet time after an interaction before full quality is requested, ms. */
  readonly idleMs?: number;
  /** Ceiling on the pixels a preview render may cost. */
  readonly budgetPixels?: number;
}

const DEFAULT_PADDING = 24;
const DEFAULT_IDLE_MS = 140;
/** Wheel events have no end; this is how long after the last one zoom ends. */
const WHEEL_IDLE_MS = 180;
const KEYBOARD_PAN_STEP = 32;
const KEYBOARD_PAN_STEP_COARSE = 160;
/** Hold-to-compare key (F-UI-04). `\` is the shortcut this class of tool uses. */
const HOLD_TO_COMPARE_KEY = "\\";

interface ThemeColors {
  readonly checkerA: string;
  readonly checkerB: string;
  readonly border: string;
  readonly background: string;
}

type Unsubscribe = () => void;

export class Viewport {
  readonly element: HTMLDivElement;

  private readonly log: Logger;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly padding: number;
  private readonly idleMs: number;
  private readonly budgetPixels: number;

  // Overlay elements. Fixed set, created once, never re-created.
  private readonly badge: HTMLDivElement;
  private readonly compareTag: HTMLDivElement;
  private readonly readout: HTMLDivElement;
  private readonly emptyState: HTMLDivElement;
  private readonly splitHandle: HTMLDivElement;
  private readonly zoomLabel: HTMLElement;
  private readonly sizeLabel: HTMLElement;
  private readonly splitButton: HTMLButtonElement;

  private view: ViewState = { scale: 1, x: 0, y: 0 };
  private frame: ViewportFrame | null = null;
  private reference: ViewportFrame | null = null;
  private interaction: InteractionState = IDLE_INTERACTION;
  private compare: CompareState = DEFAULT_COMPARE;
  private lastDegraded = false;

  /**
   * Scratch canvases for `ImageData` frames, keyed by size. `putImageData`
   * cannot scale and ignores the transform, so such a frame is painted into one
   * of these once and drawn from there.
   */
  private readonly scratch = new Map<string, HTMLCanvasElement>();

  /**
   * Whether a resize should re-fit. Set by {@link zoomToFit}, cleared by any
   * manual zoom or pan — so the window growing keeps a fitted image fitted, and
   * never fights a user who has zoomed in on a corner.
   */
  private autoFit = true;
  private viewportSize: Size = { width: 0, height: 0 };
  private devicePixelRatio = 1;

  private paintHandle = 0;
  private idleTimer = 0;
  private wheelTimer = 0;
  private disposed = false;

  private theme: ThemeColors | null = null;
  private checkerPattern: CanvasPattern | null = null;

  private readonly listeners = new Map<
    ViewportEventName,
    Set<(payload: never) => void>
  >();
  private readonly teardown: Unsubscribe[] = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly themeObserver: MutationObserver;
  private dprQuery: MediaQueryList | null = null;

  constructor(host: HTMLElement, options: ViewportOptions = {}) {
    this.log = logger("app");
    this.padding = options.padding ?? DEFAULT_PADDING;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.budgetPixels = options.budgetPixels ?? 2_000_000;

    this.element = document.createElement("div");
    this.element.className = "viewport";
    this.element.tabIndex = 0;
    this.element.setAttribute("role", "img");
    this.element.setAttribute("aria-label", "Preview");

    this.canvas = document.createElement("canvas");
    this.canvas.className = "viewport__canvas";
    this.element.append(this.canvas);

    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (ctx === null) {
      // Loud, not degraded: without a 2D context there is no viewport, and a
      // viewport that silently shows nothing is the worst possible failure for
      // an image tool.
      this.log.error("viewport could not acquire a 2D canvas context");
      throw new Error("viewport: canvas 2D context unavailable");
    }
    this.ctx = ctx;

    const built = this.buildOverlay();
    this.badge = built.badge;
    this.compareTag = built.compareTag;
    this.readout = built.readout;
    this.emptyState = built.emptyState;
    this.splitHandle = built.splitHandle;
    this.zoomLabel = built.zoomLabel;
    this.sizeLabel = built.sizeLabel;
    this.splitButton = built.splitButton;

    host.append(this.element);

    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(this.element);

    this.themeObserver = new MutationObserver(() => {
      this.theme = null;
      this.checkerPattern = null;
      this.requestPaint();
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    this.bindPointer();
    this.bindWheel();
    this.bindKeyboard();
    this.watchDevicePixelRatio();

    this.measure();
    this.log.info("viewport created", {
      padding: this.padding,
      idleMs: this.idleMs,
      budgetPixels: this.budgetPixels,
    });
  }

  // --- public API -------------------------------------------------------

  /**
   * Show a rendered frame. Passing `null` returns the viewport to its empty
   * state. The viewport takes ownership; see `frame.ts`, "Ownership".
   */
  setFrame(frame: ViewportFrame | null): void {
    const previous = this.frame;
    const firstFrame = previous === null && frame !== null;
    const resized =
      frame !== null &&
      (previous === null ||
        previous.documentWidth !== frame.documentWidth ||
        previous.documentHeight !== frame.documentHeight);

    if (previous !== frame) releaseFrame(previous);
    this.frame = frame;

    if (frame !== null) {
      this.log.debug("frame received", {
        width: frame.image.width,
        height: frame.image.height,
        documentWidth: frame.documentWidth,
        documentHeight: frame.documentHeight,
        quality: frame.quality,
        scale: Math.round(frameScale(frame) * 1000) / 1000,
        ...(frame.correlationId === undefined ? {} : { cid: frame.correlationId }),
      });
    } else {
      this.log.info("frame cleared");
    }

    // A new document, or the first one, is fitted. A new frame of the same
    // document never moves the view — re-centring under someone's cursor
    // while they work is the single most annoying thing a viewport can do.
    if (firstFrame || (resized && this.autoFit)) this.zoomToFit();

    this.syncEmptyState();
    this.emitQuality();
    this.requestPaint();
  }

  /**
   * Set the reference frame for before/after comparison (F-UI-04). Usually the
   * source image. `null` disables both compare gestures, and the control says
   * so rather than going quiet.
   */
  setReference(frame: ViewportFrame | null): void {
    if (this.reference !== frame) releaseFrame(this.reference);
    this.reference = frame;
    this.splitButton.disabled = frame === null;
    this.splitButton.title =
      frame === null
        ? "Before/after needs a reference frame; none has been set"
        : "Before/after split (hold \\ to compare)";
    this.log.info("reference frame " + (frame === null ? "cleared" : "set"));
    this.requestPaint();
  }

  get viewState(): ViewState {
    return this.view;
  }

  get documentSize(): Size | null {
    if (this.frame === null) return null;
    return { width: this.frame.documentWidth, height: this.frame.documentHeight };
  }

  /** F-UI-02 — fit the whole document in the viewport and centre it. */
  zoomToFit(): void {
    const content = this.documentSize;
    if (content === null) return;
    this.autoFit = true;
    this.setView(this.fittedView(content, this.viewportSize), "fit");
  }

  /**
   * The scale this display can actually draw (F-UI-01), applied where a view is
   * *built* rather than where it is painted.
   *
   * Quantizing at paint time instead would leave the model believing in a scale
   * the canvas never used: the pan clamp, the wheel anchor and the split
   * divider would all be computed against an image edge a few per cent away
   * from the one on screen. Measured on a 160-pixel document at a fit scale of
   * 5.133 against a drawn 5, that is twenty-one pixels of disagreement at the
   * right-hand edge.
   */
  private exactScale(scale: number): number {
    return deviceExactScale(scale, this.devicePixelRatio);
  }

  private fittedView(content: Size, viewport: Size): ViewState {
    return centreView(
      content,
      viewport,
      this.exactScale(fitScale(content, viewport, this.padding)),
    );
  }

  /** F-UI-02 — 100%, centred. */
  zoomTo100(): void {
    const content = this.documentSize;
    if (content === null) return;
    this.autoFit = false;
    this.setView(centreView(content, this.viewportSize, 1), "100%");
  }

  /** F-UI-02 — one rung up or down the integer zoom ladder, anchored centre. */
  stepZoomBy(direction: 1 | -1): void {
    this.zoomTo(stepZoom(this.view.scale, direction), this.viewportCentre(), "step");
  }

  /** Set an arbitrary scale, holding `anchor` (view space) still. */
  zoomTo(scale: number, anchor: Point = this.viewportCentre(), reason = "zoom"): void {
    this.autoFit = false;
    const content = this.documentSize;
    const next = zoomAt(this.view, this.exactScale(snapScale(scale)), anchor);
    this.setView(
      content === null ? next : clampView(next, content, this.viewportSize),
      reason,
    );
  }

  panByPixels(dx: number, dy: number): void {
    this.autoFit = false;
    const content = this.documentSize;
    const next = panBy(this.view, dx, dy);
    this.setView(
      content === null ? next : clampView(next, content, this.viewportSize),
      "pan",
    );
  }

  /**
   * Declare that something is being dragged, so the preview may degrade
   * (F-UI-03). Anything may call this — the properties panel names its
   * parameter, playback names itself — and every source that begins one must
   * end it.
   */
  beginInteraction(source: string): void {
    const before = isInteracting(this.interaction);
    this.interaction = beginInteraction(this.interaction, source);
    if (this.idleTimer !== 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = 0;
    }
    if (!before) this.emitRequest("interaction-start");
    this.emitQuality();
  }

  endInteraction(source: string): void {
    const next = endInteraction(this.interaction, source);
    if (next === this.interaction) return;
    this.interaction = next;
    this.emitQuality();
    if (!isInteracting(this.interaction)) {
      if (this.idleTimer !== 0) clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => {
        this.idleTimer = 0;
        this.emitRequest("idle");
      }, this.idleMs);
    }
  }

  setCompareMode(mode: CompareMode): void {
    this.applyCompare(setMode(this.compare, mode));
  }

  setSplitPosition(fraction: number): void {
    this.applyCompare(setSplit(this.compare, fraction));
  }

  /** Ask the application for a render. Exposed so a document change can force one. */
  requestRender(reason: string): void {
    this.emitRequest(reason);
  }

  on<K extends ViewportEventName>(
    event: K,
    listener: (payload: ViewportEvents[K]) => void,
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const entry = listener as (payload: never) => void;
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.paintHandle !== 0) cancelAnimationFrame(this.paintHandle);
    if (this.idleTimer !== 0) clearTimeout(this.idleTimer);
    if (this.wheelTimer !== 0) clearTimeout(this.wheelTimer);
    this.resizeObserver.disconnect();
    this.themeObserver.disconnect();
    for (const off of this.teardown) off();
    this.teardown.length = 0;
    this.listeners.clear();
    releaseFrame(this.frame);
    releaseFrame(this.reference);
    this.frame = null;
    this.reference = null;
    this.element.remove();
    this.log.info("viewport disposed");
  }

  // --- overlay ----------------------------------------------------------

  private buildOverlay(): {
    badge: HTMLDivElement;
    compareTag: HTMLDivElement;
    readout: HTMLDivElement;
    emptyState: HTMLDivElement;
    splitHandle: HTMLDivElement;
    zoomLabel: HTMLElement;
    sizeLabel: HTMLElement;
    splitButton: HTMLButtonElement;
  } {
    const overlay = document.createElement("div");
    overlay.className = "viewport__overlay";

    const top = document.createElement("div");
    top.className = "viewport__top";

    const controls = document.createElement("div");
    controls.className = "viewport__controls";

    const button = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ui-button";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", onClick);
      controls.append(b);
      return b;
    };

    button("Fit", "Fit the image in the viewport (0)", () => this.zoomToFit());
    button("100%", "Zoom to 100% (1)", () => this.zoomTo100());
    button("−", "Zoom out one integer step (-)", () => this.stepZoomBy(-1));
    button("+", "Zoom in one integer step (+)", () => this.stepZoomBy(1));
    const splitButton = button("Split", "Before/after split (hold \\ to compare)", () =>
      this.applyCompare(toggleSplit(this.compare)),
    );
    splitButton.disabled = true;
    splitButton.setAttribute("aria-pressed", "false");

    const badge = document.createElement("div");
    badge.className = "viewport__badge";
    badge.hidden = true;
    badge.setAttribute("role", "status");

    const compareTag = document.createElement("div");
    compareTag.className = "viewport__compare-tag";
    compareTag.hidden = true;
    compareTag.textContent = "Before";

    top.append(controls, badge, compareTag);

    const bottom = document.createElement("div");
    bottom.className = "viewport__bottom";

    const readout = document.createElement("div");
    readout.className = "viewport__readout";
    const zoomLabel = document.createElement("b");
    zoomLabel.textContent = "100%";
    const sizeLabel = document.createElement("span");
    sizeLabel.textContent = "no frame";
    readout.append(zoomLabel, sizeLabel);
    bottom.append(readout);

    const emptyState = document.createElement("div");
    emptyState.className = "viewport__empty";
    const emptyTitle = document.createElement("div");
    emptyTitle.className = "viewport__empty-title";
    emptyTitle.textContent = "No frame";
    const emptyDetail = document.createElement("div");
    emptyDetail.className = "viewport__empty-detail";
    emptyDetail.textContent =
      "Nothing has been rendered yet. The viewport shows a frame as soon as one is handed to it.";
    emptyState.append(emptyTitle, emptyDetail);

    const splitHandle = document.createElement("div");
    splitHandle.className = "viewport__split";
    splitHandle.hidden = true;
    splitHandle.setAttribute("role", "separator");
    splitHandle.setAttribute("aria-label", "Before/after divider");
    const grip = document.createElement("div");
    grip.className = "viewport__split-grip";
    splitHandle.append(grip);

    overlay.append(top, bottom, emptyState, splitHandle);
    this.element.append(overlay);

    return {
      badge,
      compareTag,
      readout,
      emptyState,
      splitHandle,
      zoomLabel,
      sizeLabel,
      splitButton,
    };
  }

  private syncEmptyState(): void {
    this.emptyState.hidden = this.frame !== null;
    if (this.frame === null) {
      this.sizeLabel.textContent = "no frame";
      return;
    }
    this.sizeLabel.textContent = `${this.frame.documentWidth} × ${this.frame.documentHeight}`;
  }

  // --- events -----------------------------------------------------------

  private emit<K extends ViewportEventName>(event: K, payload: ViewportEvents[K]): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;
    for (const listener of set) (listener as (p: ViewportEvents[K]) => void)(payload);
  }

  private emitView(): void {
    const effectiveScale = deviceExactScale(this.view.scale, this.devicePixelRatio);
    this.zoomLabel.textContent = formatZoom(effectiveScale);
    this.emit("view", {
      scale: this.view.scale,
      effectiveScale,
      x: this.view.x,
      y: this.view.y,
      pixelExact: isPixelExact(effectiveScale, this.devicePixelRatio),
    });
  }

  private emitQuality(): void {
    const requested = requestedQuality(this.interaction);
    const displayed: FrameQuality = this.frame?.quality ?? "full";
    const displayedScale = this.frame === null ? 1 : frameScale(this.frame);
    const state =
      this.frame === null ? null : degradedState(displayed, displayedScale);
    const degraded = state !== null;

    this.badge.hidden = state === null;
    if (state !== null) {
      this.badge.textContent = state.label;
      this.badge.title = state.detail;
    }

    // Transitions are logged, never just shown — docs/ARCHITECTURE.md,
    // "Logging": preview degradation transitions are logged and shown in the UI.
    if (degraded !== this.lastDegraded) {
      this.lastDegraded = degraded;
      this.log.info(degraded ? "preview degraded" : "preview restored to full", {
        displayed,
        displayedScale: Math.round(displayedScale * 1000) / 1000,
        sources: this.interaction.sources.join(",") || "none",
      });
    }

    this.emit("quality", {
      requested,
      displayed,
      displayedScale,
      degraded,
      sources: this.interaction.sources,
    });
  }

  private emitRequest(reason: string): void {
    const quality = requestedQuality(this.interaction);
    const content = this.documentSize;
    const factor =
      quality === "full" || content === null
        ? 1
        : previewScaleFactor(content, this.view.scale, this.budgetPixels);
    const request: RenderRequest = {
      quality,
      factor,
      reason,
      viewport: this.viewportSize,
      zoom: this.view.scale,
    };
    this.log.debug("render requested", {
      quality,
      factor: Math.round(factor * 1000) / 1000,
      reason,
    });
    this.emit("request", request);
  }

  private setView(next: ViewState, reason: string): void {
    this.view = next;
    this.log.debug("view changed", {
      reason,
      scale: Math.round(next.scale * 1000) / 1000,
      x: Math.round(next.x),
      y: Math.round(next.y),
    });
    this.emitView();
    this.requestPaint();
  }

  private applyCompare(next: CompareState): void {
    if (next === this.compare) return;
    const wasHolding = this.compare.holding;
    this.compare = next;
    this.splitButton.setAttribute(
      "aria-pressed",
      next.mode === "split" ? "true" : "false",
    );
    this.splitHandle.hidden = next.mode !== "split" || this.reference === null;
    this.compareTag.hidden = !(next.holding && this.reference !== null);
    if (next.holding !== wasHolding) {
      this.log.info(next.holding ? "hold-to-compare down" : "hold-to-compare up");
    }
    this.emit("compare", next);
    this.requestPaint();
  }

  private viewportCentre(): Point {
    return { x: this.viewportSize.width / 2, y: this.viewportSize.height / 2 };
  }

  // --- input ------------------------------------------------------------

  private bindPointer(): void {
    let panning = false;
    let lastX = 0;
    let lastY = 0;
    let pointerId = -1;

    const onCanvasDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      if (this.frame === null) return;
      panning = true;
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      this.canvas.setPointerCapture(event.pointerId);
      this.element.classList.add("viewport--panning");
      this.element.focus({ preventScroll: true });
      this.beginInteraction("pan");
      event.preventDefault();
    };

    const onCanvasMove = (event: PointerEvent) => {
      if (!panning || event.pointerId !== pointerId) return;
      this.panByPixels(event.clientX - lastX, event.clientY - lastY);
      lastX = event.clientX;
      lastY = event.clientY;
    };

    const endPan = (event: PointerEvent) => {
      if (!panning || event.pointerId !== pointerId) return;
      panning = false;
      pointerId = -1;
      this.element.classList.remove("viewport--panning");
      this.endInteraction("pan");
    };

    this.listen(this.canvas, "pointerdown", onCanvasDown);
    this.listen(this.canvas, "pointermove", onCanvasMove);
    this.listen(this.canvas, "pointerup", endPan);
    this.listen(this.canvas, "pointercancel", endPan);

    // Double-click toggles fit and 100%, which is the gesture everyone tries.
    this.listen(this.canvas, "dblclick", () => {
      if (this.frame === null) return;
      if (Math.abs(this.view.scale - 1) < 1e-6) this.zoomToFit();
      else this.zoomTo100();
    });

    // The split divider.
    let draggingSplit = false;
    this.listen(this.splitHandle, "pointerdown", (event: PointerEvent) => {
      draggingSplit = true;
      this.splitHandle.setPointerCapture(event.pointerId);
      this.beginInteraction("compare-split");
      event.preventDefault();
    });
    this.listen(this.splitHandle, "pointermove", (event: PointerEvent) => {
      if (!draggingSplit) return;
      const rect = this.element.getBoundingClientRect();
      if (rect.width > 0) {
        this.setSplitPosition((event.clientX - rect.left) / rect.width);
      }
    });
    const endSplit = () => {
      if (!draggingSplit) return;
      draggingSplit = false;
      this.endInteraction("compare-split");
    };
    this.listen(this.splitHandle, "pointerup", endSplit);
    this.listen(this.splitHandle, "pointercancel", endSplit);
  }

  private bindWheel(): void {
    const onWheel = (event: WheelEvent) => {
      if (this.frame === null) return;
      // Not passive: the page must not scroll under a zoom gesture.
      event.preventDefault();
      const rect = this.element.getBoundingClientRect();
      const anchor: Point = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const delta = event.deltaY * unit;
      this.beginInteraction("zoom");
      this.zoomTo(this.view.scale * Math.exp(-delta * 0.0015), anchor, "wheel");
      if (this.wheelTimer !== 0) clearTimeout(this.wheelTimer);
      this.wheelTimer = window.setTimeout(() => {
        this.wheelTimer = 0;
        this.endInteraction("zoom");
      }, WHEEL_IDLE_MS);
    };
    this.canvas.addEventListener("wheel", onWheel, { passive: false });
    this.teardown.push(() => this.canvas.removeEventListener("wheel", onWheel));
  }

  private bindKeyboard(): void {
    this.listen(this.element, "keydown", (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const step = event.shiftKey ? KEYBOARD_PAN_STEP_COARSE : KEYBOARD_PAN_STEP;
      switch (event.key) {
        case "0":
          this.zoomToFit();
          break;
        case "1":
          this.zoomTo100();
          break;
        case "+":
        case "=":
          this.stepZoomBy(1);
          break;
        case "-":
        case "_":
          this.stepZoomBy(-1);
          break;
        case "ArrowLeft":
          this.panByPixels(step, 0);
          break;
        case "ArrowRight":
          this.panByPixels(-step, 0);
          break;
        case "ArrowUp":
          this.panByPixels(0, step);
          break;
        case "ArrowDown":
          this.panByPixels(0, -step);
          break;
        case HOLD_TO_COMPARE_KEY:
          if (this.reference !== null && !this.compare.holding) {
            this.applyCompare(setHolding(this.compare, true));
          }
          break;
        default:
          return;
      }
      event.preventDefault();
    });

    this.listen(this.element, "keyup", (event: KeyboardEvent) => {
      if (event.key !== HOLD_TO_COMPARE_KEY) return;
      this.applyCompare(setHolding(this.compare, false));
      event.preventDefault();
    });

    // Losing focus with the key down would strand the reference on screen.
    this.listen(this.element, "blur", () => {
      if (this.compare.holding) this.applyCompare(setHolding(this.compare, false));
    });
  }

  private listen<E extends Event>(
    target: EventTarget,
    type: string,
    handler: (event: E) => void,
  ): void {
    const wrapped = handler as EventListener;
    target.addEventListener(type, wrapped);
    this.teardown.push(() => target.removeEventListener(type, wrapped));
  }

  /**
   * Track `devicePixelRatio`.
   *
   * There is no event for it, so the idiom is a media query that matches only
   * the current ratio: when the window moves to a display with a different one
   * the query stops matching and fires, and a fresh query is installed for the
   * new value. Without this, dragging the window to a second monitor leaves the
   * backing store at the old density and the nearest-neighbour draw stops being
   * pixel-exact — silently, which is the part that matters.
   */
  private watchDevicePixelRatio(): void {
    const install = () => {
      if (this.disposed) return;
      this.dprQuery?.removeEventListener("change", onChange);
      const dpr = window.devicePixelRatio || 1;
      this.devicePixelRatio = dpr;
      this.dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);
      this.dprQuery.addEventListener("change", onChange);
    };
    const onChange = () => {
      const previous = this.devicePixelRatio;
      install();
      this.log.info("device pixel ratio changed", {
        from: previous,
        to: this.devicePixelRatio,
      });
      // The stored scale was exact for the old ratio and is not for the new
      // one, so it is re-quantized rather than left to drift.
      this.setView({ ...this.view, scale: this.exactScale(this.view.scale) }, "dpr");
    };
    install();
    this.teardown.push(() => this.dprQuery?.removeEventListener("change", onChange));
  }

  private measure(): void {
    const rect = this.element.getBoundingClientRect();
    const next: Size = { width: rect.width, height: rect.height };
    const changed =
      next.width !== this.viewportSize.width || next.height !== this.viewportSize.height;
    this.viewportSize = next;
    if (!changed) return;
    const content = this.autoFit ? this.documentSize : null;
    if (content !== null) {
      this.setView(this.fittedView(content, next), "resize-fit");
      return;
    }
    this.emitView();
    this.requestPaint();
  }

  // --- paint ------------------------------------------------------------

  private requestPaint(): void {
    if (this.disposed || this.paintHandle !== 0) return;
    this.paintHandle = requestAnimationFrame(() => {
      this.paintHandle = 0;
      this.paint();
    });
  }

  private readTheme(): ThemeColors {
    if (this.theme !== null) return this.theme;
    const style = getComputedStyle(this.element);
    const read = (name: string, fallbackName: string): string => {
      const value = style.getPropertyValue(name).trim();
      // A missing custom property means the stylesheet did not load, which is a
      // real failure and is reported rather than papered over with a literal.
      if (value === "") this.log.error("theme token missing", { token: fallbackName });
      return value;
    };
    this.theme = {
      checkerA: read("--checker-a", "--checker-a"),
      checkerB: read("--checker-b", "--checker-b"),
      border: read("--rule-strong", "--rule-strong"),
      background: read("--bg-sunken", "--bg-sunken"),
    };
    return this.theme;
  }

  /**
   * The checkerboard behind transparency (F-UI-05).
   *
   * Built in device pixels and drawn in the untransformed space, so the squares
   * are a constant size on screen at every zoom. A checkerboard that scaled with
   * the image would read as content — which is exactly the confusion it exists
   * to prevent.
   */
  private checkerboard(theme: ThemeColors): CanvasPattern | null {
    if (this.checkerPattern !== null) return this.checkerPattern;
    const square = 8;
    const tile = document.createElement("canvas");
    tile.width = square * 2;
    tile.height = square * 2;
    const tileCtx = tile.getContext("2d");
    if (tileCtx === null) {
      this.log.error("checkerboard tile context unavailable");
      return null;
    }
    tileCtx.fillStyle = theme.checkerA;
    tileCtx.fillRect(0, 0, square * 2, square * 2);
    tileCtx.fillStyle = theme.checkerB;
    tileCtx.fillRect(0, 0, square, square);
    tileCtx.fillRect(square, square, square, square);
    this.checkerPattern = this.ctx.createPattern(tile, "repeat");
    return this.checkerPattern;
  }

  private paint(): void {
    const start = performance.now();
    const dpr = this.devicePixelRatio;
    const width = Math.max(1, Math.round(this.viewportSize.width * dpr));
    const height = Math.max(1, Math.round(this.viewportSize.height * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    const theme = this.readTheme();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);

    const frame = this.frame;
    if (frame === null) {
      this.splitHandle.hidden = true;
      return;
    }

    const content: Size = {
      width: frame.documentWidth,
      height: frame.documentHeight,
    };

    // Everything below is in device pixels, with the image origin snapped to a
    // whole device pixel whenever the zoom is pixel-exact. Rounding the origin
    // is half of F-UI-01: an exact integer scale drawn at a fractional offset
    // still resamples.
    const scale = deviceExactScale(this.view.scale, dpr) * dpr;
    const exact = scale >= dpr;
    const originX = exact ? Math.round(this.view.x * dpr) : this.view.x * dpr;
    const originY = exact ? Math.round(this.view.y * dpr) : this.view.y * dpr;
    const rect = imageRect({ scale, x: originX, y: originY }, content);

    ctx.imageSmoothingEnabled = false;
    const pattern = this.checkerboard(theme);
    if (pattern !== null) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      ctx.fillStyle = pattern;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.restore();
    }

    const plan = comparePlan(this.compare, this.reference !== null);
    const splitX = Math.round(plan.split * width);

    // Below 100% the image is minified, and point-sampling a dither pattern at
    // 40% produces moiré that is not in the picture. Smoothing is therefore on
    // when minifying and off when magnifying — F-UI-01 constrains the
    // magnifying case, which is the one where a resample would destroy the
    // thing being previewed.
    ctx.imageSmoothingEnabled = scale < dpr;
    ctx.imageSmoothingQuality = "high";

    if (plan.reference === "all" && this.reference !== null) {
      this.drawFrame(this.reference, rect);
    } else if (plan.reference === "left" && this.reference !== null) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, height);
      ctx.clip();
      this.drawFrame(this.reference, rect);
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, width - splitX, height);
      ctx.clip();
      this.drawFrame(frame, rect);
      ctx.restore();
    } else {
      this.drawFrame(frame, rect);
    }

    ctx.imageSmoothingEnabled = false;
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x - 0.5, rect.y - 0.5, rect.width + 1, rect.height + 1);

    this.splitHandle.hidden = !(this.compare.mode === "split" && this.reference !== null);
    if (!this.splitHandle.hidden) {
      this.splitHandle.style.left = `${plan.split * 100}%`;
      this.splitHandle.setAttribute(
        "aria-valuenow",
        String(Math.round(plan.split * 100)),
      );
    }

    this.emit("painted", {
      imageWidth: frame.image.width,
      imageHeight: frame.image.height,
      documentWidth: frame.documentWidth,
      documentHeight: frame.documentHeight,
      quality: frame.quality,
      ms: Math.round((performance.now() - start) * 100) / 100,
    });
  }

  private drawFrame(
    frame: ViewportFrame,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    const image = frame.image;
    const drawable: CanvasImageSource | null =
      image instanceof ImageData ? this.rasterize(image) : image;
    if (drawable === null) return;
    this.ctx.drawImage(drawable, rect.x, rect.y, rect.width, rect.height);
  }

  /**
   * Producers that can hand over an `ImageBitmap` should — it is the only form
   * of frame that costs nothing here.
   */
  private rasterize(data: ImageData): HTMLCanvasElement | null {
    const key = `${data.width}x${data.height}`;
    let canvas = this.scratch.get(key);
    if (canvas === undefined) {
      canvas = document.createElement("canvas");
      canvas.width = data.width;
      canvas.height = data.height;
      this.scratch.set(key, canvas);
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      this.log.error("scratch canvas context unavailable", { size: key });
      return null;
    }
    ctx.putImageData(data, 0, 0);
    return canvas;
  }
}
