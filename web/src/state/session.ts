/**
 * The editor session — the one call that turns the shell into an application.
 *
 * Everything the parallel rounds built is a piece: the document store, the
 * image intake, the palette system, the render path, the autosave. This
 * assembles them, in the order their dependencies force, and hands back one
 * object with a `dispose`.
 *
 * ```ts
 * // in app/main.tsx, before React renders anything:
 * const session = await createEditorSession({ registry, report });
 * // and again from the shell, once the viewport element has mounted:
 * session.attachViewport(viewport);
 * ```
 *
 * The order is not arbitrary and each step is a reason:
 *
 * 1. **The render worker**, because nothing can draw without it and it is
 *    asynchronous. It brings up the GPU device and the Rust core on its own
 *    thread; a failure here is fatal and is thrown — the capability screen has
 *    already passed, so a device that will not come up now is a real error and
 *    not a supported state.
 * 2. **Autosave restore** (F-DO-07), *before* the store exists, because a
 *    restored document is the store's initial state rather than something
 *    pushed into it afterwards — pushing it in would put "restored the
 *    document" on the undo stack as an edit.
 * 3. **The store**, which is the only mutable state in the application.
 * 4. **The palette bridge**, which makes the palette editor's state and the
 *    document's palette one fact rather than two.
 * 5. **The intake**, which turns a dropped, pasted or chosen file into
 *    `store.openSource`.
 * 6. **The render subscription**, which is the only thing that reacts to the
 *    store by drawing.
 *
 * ## Nothing here renders
 *
 * The device, the core, the node cache and the `DocumentRenderer` are all in
 * `web/src/worker/`. This file holds a `RenderService` and posts to it. That is
 * the change docs/ARCHITECTURE.md always described and the application did not
 * have; the consequence a user can see is that a long stack at a large
 * resolution no longer freezes the window while it runs.
 *
 * ## Renders are superseded, not queued
 *
 * A drag emits a mutation per pointer move and each one invalidates the node it
 * touched. Every one is sent to the worker immediately — *not* held back behind
 * the render in flight, which is what used to put the user one frame behind
 * their own input. The worker's queue keeps at most one preview waiting, aborts
 * the running one when a newer arrives, and rejects the loser with
 * `RenderAbandoned`. Reaching the abort is what makes the skipped frames free:
 * the abandoned render stops at its next node instead of finishing a picture
 * nobody will see.
 *
 * ## Adaptive preview resolution (F-UI-03) is wired here
 *
 * The viewport declares what it wants on its `request` event — a quality and a
 * fraction of document resolution — and this subscribes to it and carries both
 * into every render. The worker resamples the source to that extent and runs the
 * whole graph there, so the frame that comes back really is smaller and the
 * viewport's degraded badge describes something that happened. Before this the
 * event had no subscriber and the renderer hard-coded full quality, so the badge
 * was a control that could never be true.
 */

import type { CapabilityReport } from "../lib/capabilities";
import { correlationId, logger } from "../lib/log";
import type { EffectRegistry } from "../registry";
import type { FrameQuality, Viewport } from "../viewport";
import {
  ImageLoadError,
  blankSource,
  installClipboardPaste,
  installImageDrop,
  receiveImage,
  sourceLimits,
  srgbBytesFromLinearSurface,
  type ImageIntake,
  type SourceImage,
  type SourceLimits,
} from "../io";
import { RenderService, isAbandoned } from "../worker";
import { documentAtFrame, planAnimation, stillFrameFor } from "../animation";
// Type-only, and deliberately: `state/` must not import `ui/`. The palette
// store is a value the application hands in, so the layer that owns the
// document depends on the palette editor's *shape* and not on its module.
import type { PaletteStore } from "../ui/palette/store";
import type { Palette } from "../types/document";
import {
  AutosaveWriter,
  hasOpfs,
  loadAutosave,
  opfsAutosaveStorage,
  type AutosaveStorage,
} from "./autosave";
import { DocumentStore, restoreNotice, type DocumentSnapshot, type RestoreNotice } from "./store";

const log = logger("app");

export interface EditorSessionOptions {
  readonly registry: EffectRegistry;
  readonly report: CapabilityReport;
  /** Overridden only by a test harness; the session builds the real one. */
  readonly autosaveStorage?: AutosaveStorage | null;
  /** The palette editor's store — `paletteStore` from `ui/palette`. */
  readonly palette: PaletteStore;
}

export interface EditorSession {
  readonly store: DocumentStore;
  /**
   * The render worker.
   *
   * The one way to ask for a picture. Export goes through it, and so will
   * animation, Surprise Me, batch and animated export — see
   * `worker/client.ts`.
   */
  readonly render: RenderService;
  readonly limits: SourceLimits;
  /** Point the session at the shell's viewport, or at nothing. */
  attachViewport(viewport: Viewport | null): void;
  /**
   * Open one file (F-IN-01) — from the toolbar's file input, which is a real
   * `<input type="file">` in the document rather than a synthesised one.
   */
  openFile(file: File): Promise<void>;
  /**
   * Start from a blank canvas of this size, for a document that makes its own
   * image (the `source` slot — see `types/document.ts`).
   *
   * It goes through the same intake as a dropped file, deliberately: a blank
   * canvas is a real `SourceImage` and every layer downstream — the worker, the
   * store, the palette, the compare reference — is given exactly what a
   * photograph gives it. A second path here would be a second set of things to
   * keep in step, and the first one to fall out of step would be export.
   */
  newCanvas(width: number, height: number): void;
  /**
   * The last thing that went wrong, for a banner — and `null` the moment a
   * render succeeds again.
   *
   * The clear matters as much as the error. A failure notice that only a click
   * removes outlives the state it describes: the stack that could not render is
   * two edits ago, the picture on screen is current, and the banner is still
   * saying something is wrong.
   */
  onError(listener: (error: Error | null) => void): () => void;
  dispose(): Promise<void>;
}

export async function createEditorSession(
  options: EditorSessionOptions,
): Promise<EditorSession> {
  const cid = correlationId();
  const palette = options.palette;

  // --- the render worker -------------------------------------------------

  const render = await RenderService.create({ report: options.report });
  const limits = sourceLimits(render.info.maxTextureDimension2D);

  // --- autosave, before the store ---------------------------------------

  const storage =
    options.autosaveStorage === undefined
      ? hasOpfs()
        ? opfsAutosaveStorage()
        : null
      : options.autosaveStorage;
  if (storage === null) {
    // The capability report already states OPFS is missing in the status bar;
    // this is the same fact in the log, at the moment it has a consequence.
    log.warn("autosave is off: OPFS is unavailable in this browser");
  }

  let restored: RestoreNotice | null = null;
  let restoredDocument = undefined;
  if (storage !== null) {
    try {
      const found = await loadAutosave(storage, options.registry);
      if (found !== null) {
        restoredDocument = found.document;
        restored = restoreNotice(found.savedAt, found.sourceName);
      }
    } catch (error) {
      // A corrupt autosave must not stop the application from starting. It is
      // reported and the session opens empty; the file is left alone so it can
      // be looked at rather than silently overwritten on the first edit.
      log.error("the autosave could not be restored", { error: String(error) });
    }
  }

  const store = new DocumentStore({
    registry: options.registry,
    autosave: storage === null ? null : new AutosaveWriter(storage),
    restored,
    ...(restoredDocument === undefined ? {} : { document: restoredDocument }),
  });

  let viewport: Viewport | null = null;
  const viewportOff: (() => void)[] = [];
  let disposed = false;

  // --- error reporting ---------------------------------------------------

  const errorListeners = new Set<(error: Error | null) => void>();
  let failing = false;
  const report = (error: Error | null): void => {
    if (error === null && !failing) return;
    failing = error !== null;
    for (const listener of errorListeners) listener(error);
  };

  // --- the palette bridge ------------------------------------------------

  /**
   * The palette lives in two places and must be one fact.
   *
   * `ui/palette` owns the editor's state — swatches, locks, output mode,
   * extraction settings — and the document owns the `Palette` a render reads
   * and a `.dork` writes. Neither can be dropped: the editor's state is more
   * than a colour list, and the document's palette has to be undoable with
   * everything else. So they are bridged in both directions, and the bridge is
   * re-entrant, because each direction's write is the other's notification.
   *
   * The guard is a flag rather than an equality check, because two palettes can
   * be equal by value and still be a real edit — a rename, or a metric change
   * that leaves every colour where it was.
   */
  let bridging = false;

  const samePalette = (a: Palette, b: Palette): boolean =>
    a.id === b.id &&
    a.name === b.name &&
    a.metric === b.metric &&
    a.colors.length === b.colors.length &&
    a.colors.every((component, index) => component === b.colors[index]);

  // The document is the truth at startup — it is what autosave restored — so
  // its palette is pushed into the editor rather than the other way round.
  bridging = true;
  palette.dispatch({ kind: "load", palette: store.document.palette });
  bridging = false;

  const paletteToDocument = palette.subscribe((change) => {
    if (bridging || change === null) return;
    bridging = true;
    try {
      // Every palette change is committed, including one the renderer does not
      // have to act on (a rename, a reorder that only moved positions): the
      // document has to record it or a save would lose it. `rerender` is the
      // renderer's business, and the node cache decides that by hashing.
      store.setPalette(change.palette);
    } finally {
      bridging = false;
    }
  });

  const documentToPalette = store.subscribe(() => {
    if (bridging) return;
    const wanted = store.document.palette;
    if (samePalette(wanted, palette.palette)) return;
    // Undo, redo, or a document arriving from anywhere else. The editor is put
    // back to what the document says; its locks and extraction settings survive
    // because `load` replaces the colours and not the settings.
    log.info("palette editor reloaded from the document", { palette: wanted.id });
    bridging = true;
    try {
      palette.dispatch({ kind: "load", palette: wanted });
    } finally {
      bridging = false;
    }
  });

  // F-CO-04: the hardware library is read from the core once, at startup. A
  // failure is shown in the panel rather than thrown here — fifteen palettes
  // being unreadable is not a reason the application cannot run.
  void palette.loadLibrary();

  // --- rendering ---------------------------------------------------------

  /**
   * What the viewport last asked for (F-UI-03).
   *
   * Full quality until something says otherwise, which is what an idle editor
   * is. Both fields move together and both go into {@link renderKey}, so
   * releasing a slider re-renders at full resolution rather than leaving a
   * reduced frame on screen with the badge still up.
   */
  let quality: FrameQuality = "full";
  let factor = 1;

  /**
   * What is on screen, or being rendered for it.
   *
   * A render is skipped when its key matches the last one *sent*, which is what
   * stops a store notification that changed nothing — a palette bridge write, a
   * selection change — from re-rendering. It is cleared on failure so the same
   * document can be retried, and on attach so a new viewport is given a frame.
   */
  let sentKey: string | null = null;

  /** Increments per render started, so a late reply cannot overwrite a newer frame. */
  let generation = 0;

  const renderKey = (snapshot: DocumentSnapshot): string =>
    `${snapshot.revision}|${quality}|${factor.toFixed(4)}`;

  const renderNow = async (snapshot: DocumentSnapshot, reason: string): Promise<void> => {
    const mine = generation + 1;
    generation = mine;

    // Which frame a *still* of this document is. Zero for everything that loops,
    // which is every document without a feedback node in it — and a frame inside
    // the loop for one that has, because a feedback node blends the previous
    // frame at its own position and at frame 0 there is no previous frame. The
    // viewport was therefore showing the picture *without* the trail: the one
    // thing a feedback node adds, absent from every first view of it.
    //
    // `planAnimation` and not the raw document, for the same reason the thumbnail
    // does it: the plan is what knows which nodes read their own history, and
    // `documentAtFrame` is the only shape `buildRenderGraph` accepts. This pump
    // only ever sees a document with no bindings — the block in `request` leaves
    // animated ones to the timeline — so the plan resolves nothing and the
    // document it returns is the document.
    const plan = planAnimation(snapshot.document, options.registry);
    const at = stillFrameFor(plan);

    // Frame N of a feedback document is the product of frames 0..N: the worker's
    // frame store serves the frame it holds and refuses any other rather than
    // inventing a history, so the frames before `at` are rendered and discarded.
    // `ui/timeline/preview.ts` does the same for a scrub and reports it the same
    // way. For every looping document this loop does not run.
    if (at > 0) {
      viewport?.beginInteraction("feedback-still");
      log.info("still replays a feedback document", {
        reason,
        frame: at,
        frames: plan.clock.frames,
        why: "a feedback node is the identity at frame 0",
      });
    }
    try {
      for (let index = 0; index < at; index += 1) {
        if (mine !== generation || disposed) return;
        const discarded = await render.render({
          document: documentAtFrame(plan, index),
          solo: snapshot.soloNodeId,
          quality,
          factor,
          frame: index,
          lane: "preview",
          present: "bitmap",
        });
        // Never shown, and an `ImageBitmap` holds GPU memory the JS heap does not
        // account for, so it is closed rather than dropped.
        if (discarded.image.kind === "bitmap") discarded.image.bitmap.close();
      }
    } finally {
      if (at > 0) viewport?.endInteraction("feedback-still");
    }

    const result = await render.render({
      document: documentAtFrame(plan, at),
      solo: snapshot.soloNodeId,
      quality,
      factor,
      frame: at,
      lane: "preview",
      // The frame is composited in the worker and transferred; the viewport
      // draws it with one `drawImage` and never touches a pixel.
      present: "bitmap",
    });

    const image = result.image;
    if (image.kind !== "bitmap") {
      throw new Error("a preview render came back as raw bytes; the viewport is given bitmaps");
    }

    // The three ways a finished frame can have nowhere to go: something newer
    // is already on screen, the session is being torn down, or React unmounted
    // the viewport host while this was in flight (which it does on every
    // development mount). In all three the bitmap was transferred here and
    // nobody took ownership of it, so it is closed rather than leaked — an
    // `ImageBitmap` holds GPU memory the JS heap does not account for.
    const target = viewport;
    if (mine !== generation || disposed || target === null) {
      image.bitmap.close();
      log.debug("frame discarded", {
        cid: result.correlationId,
        why: target === null ? "no viewport" : disposed ? "disposed" : "superseded on arrival",
      });
      return;
    }

    target.setFrame({
      image: image.bitmap,
      documentWidth: result.documentWidth,
      documentHeight: result.documentHeight,
      quality: result.quality,
      correlationId: result.correlationId,
    });
    log.debug("frame presented", {
      reason,
      cid: result.correlationId,
      width: result.width,
      height: result.height,
      quality: result.quality,
    });
    // A frame arrived, so whatever the last failure was, it is over.
    report(null);
  };

  const request = (reason: string): void => {
    if (disposed) return;
    const snapshot = store.getSnapshot();
    if (snapshot.source === null) {
      viewport?.setFrame(null);
      viewport?.setReference(null);
      sentKey = null;
      return;
    }

    // F-AN-09. An animated document's picture is a function of a playhead this
    // pump does not have, and `buildRenderGraph` refuses a document that still
    // carries bindings — so asking for one here produces a `DocumentError` and
    // an error banner for a document that is perfectly renderable. The timeline
    // resolves the bindings to concrete values and is the pump while any exist;
    // it takes the viewport through `attachViewport(null)`, but it does so on
    // its own subscription, which runs after this one. Skipping is what stops
    // that ordering from putting a spurious failure on screen.
    //
    // `sentKey` is cleared rather than set, so the frame is asked for again the
    // moment the last binding goes and the pump is this one once more.
    if (snapshot.document.bindings.length > 0) {
      sentKey = null;
      log.debug("preview left to the timeline: the document is animated", {
        reason,
        bindings: snapshot.document.bindings.length,
      });
      return;
    }

    const key = renderKey(snapshot);
    if (key === sentKey) return;
    sentKey = key;

    void renderNow(snapshot, reason).catch((error: unknown) => {
      // Teardown rejects everything in flight. That is not a failure the user
      // needs told about; the session is going away.
      if (disposed) return;
      if (isAbandoned(error)) {
        // Ordinary: a newer render replaced this one, or an export took the
        // device and this was re-queued and then replaced. Nothing to show.
        log.debug("render abandoned", { reason, why: error.message });
        return;
      }
      // Every failure reaches the UI. A render that throws leaves the previous
      // frame on screen, which is the honest thing to show: the document is one
      // the renderer cannot honour, and the last one it could is what is there.
      const wrapped = error instanceof Error ? error : new Error(String(error));
      log.error("render failed", { reason, error: wrapped.message });
      // Cleared so the same document can be asked for again — otherwise a
      // transient failure would wedge the preview until the next edit.
      sentKey = null;
      report(wrapped);
    });
  };

  const unsubscribe = store.subscribe(() => request("document"));

  // --- image intake (F-IN-01) -------------------------------------------

  /**
   * The reference for the before/after compare (F-UI-04) is the source itself,
   * produced by the same encoder the renderer presents with, so "before" and
   * "after" differ by the stack and by nothing else.
   */
  const setReference = (image: SourceImage): void => {
    viewport?.setReference({
      image: new ImageData(
        srgbBytesFromLinearSurface(image.surface, image.width, image.height),
        image.width,
        image.height,
      ),
      documentWidth: image.width,
      documentHeight: image.height,
      quality: "full",
    });
  };

  const intake: ImageIntake = {
    onImage: (image: SourceImage) => {
      // The worker is given the pixels *before* the store is told, because the
      // store's notification is what triggers a render and a render before the
      // worker has a source is a render that throws.
      void render
        .setSource(image)
        .then(() => {
          store.openSource(image);
          // Extraction (F-CO-02) needs the decoded image, and this is the only
          // place one arrives.
          palette.setSource({
            name: image.name,
            width: image.width,
            height: image.height,
            surface: image.surface,
          });
          setReference(image);
        })
        .catch((error: unknown) => {
          const wrapped = error instanceof Error ? error : new Error(String(error));
          log.error("the render worker would not take the image", { error: wrapped.message });
          report(wrapped);
        });
    },
    onError: (error: ImageLoadError) => {
      report(error);
    },
    onNotice: (message: string) => {
      log.info("intake notice", { message });
    },
  };

  const uninstall = [
    installImageDrop(window, { intake, limits }),
    installClipboardPaste(window, { intake, limits }),
  ];

  log.info("editor session ready", {
    cid,
    effects: options.registry.size,
    core: render.info.coreVersion,
    autosave: storage !== null,
    restored: restored !== null,
    maxSource: limits.maxDimension,
  });

  return {
    store,
    render,
    limits,

    attachViewport(next: Viewport | null): void {
      for (const off of viewportOff) off();
      viewportOff.length = 0;
      viewport = next;
      log.info("viewport " + (next === null ? "detached" : "attached"));
      if (next === null) return;

      // F-UI-03. The viewport raises this at the start of an interaction and
      // again when it goes idle, so the factor is constant for the duration of
      // a drag and the worker resamples the source once rather than per frame.
      viewportOff.push(
        next.on("request", (wanted) => {
          const moved =
            wanted.quality !== quality || Math.abs(wanted.factor - factor) > 1e-6;
          quality = wanted.quality;
          factor = wanted.factor;
          if (!moved) return;
          log.info("preview resolution changed", {
            quality,
            factor: Math.round(factor * 1000) / 1000,
            reason: wanted.reason,
            zoom: Math.round(wanted.zoom * 1000) / 1000,
          });
          // The key it would produce is different now, so this is a real
          // request rather than a repeat.
          request(`quality:${wanted.reason}`);
        }),
      );

      // A viewport that arrives after an image is already open has to be given
      // both surfaces; a fresh one has nothing to draw and this does nothing.
      const source = store.getSnapshot().source;
      if (source !== null) setReference(source);
      sentKey = null;
      request("attach");
    },

    openFile: (file: File) => receiveImage(file, file.name, { intake, limits }),

    newCanvas(width: number, height: number): void {
      // The same ceiling a decoded file is held to: the working surface is a
      // GPU texture either way, and a canvas the device cannot allocate is a
      // failure at the first render rather than here.
      if (width > limits.maxDimension || height > limits.maxDimension) {
        report(
          new Error(
            `a ${width}x${height} canvas is larger than this device allows (${limits.maxDimension}px on a side)`,
          ),
        );
        return;
      }
      const canvas = blankSource(width, height);
      log.info("blank canvas opened", { width, height, name: canvas.name });
      intake.onImage(canvas);
    },

    onError: (listener) => {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },

    async dispose(): Promise<void> {
      disposed = true;
      unsubscribe();
      paletteToDocument();
      documentToPalette();
      for (const off of viewportOff) off();
      viewportOff.length = 0;
      for (const off of uninstall) off();
      await store.flushAutosave();
      await render.dispose();
      log.info("editor session disposed");
    },
  };
}
