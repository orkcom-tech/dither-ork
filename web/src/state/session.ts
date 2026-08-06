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
 * 1. **GPU device and the Rust core**, because the renderer cannot exist
 *    without either and both are asynchronous. A failure here is fatal and is
 *    thrown — the capability screen has already passed, so a device that will
 *    not come up now is a real error and not a supported state.
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
 * ## The viewport arrives late, and can leave
 *
 * The session does not take a viewport. It is created before React renders, so
 * that the panels can be registered into the shell's slots exactly once — and
 * the viewport does not exist until the shell has mounted its host element.
 * `attachViewport` is therefore a setter, and `null` is a legal argument: React
 * mounts, unmounts and remounts the host in development to prove the effect is
 * clean, and a session that treated the first viewport as its only one would
 * draw into a canvas that had been thrown away.
 *
 * ## Renders are coalesced, not queued
 *
 * A drag emits a mutation per pointer move and each one invalidates the node it
 * touched. Rendering every one would queue frames the user will never see and
 * would hold the main thread through all of them. So: one render in flight, one
 * *latest* render pending, and anything that arrives while a render is running
 * replaces the pending one. The cache is what makes the skipped frames free —
 * the intermediate documents were never rendered, so nothing was computed for
 * them.
 */

import type { CapabilityReport } from "../lib/capabilities";
import { correlationId, logger } from "../lib/log";
import type { EffectRegistry } from "../registry";
import { loadGpuEffects } from "../registry";
import { GpuLayer } from "../gpu";
import type { Viewport } from "../viewport";
import {
  ImageLoadError,
  installClipboardPaste,
  installImageDrop,
  receiveImage,
  sourceLimits,
  srgbBytesFromLinearSurface,
  type ImageIntake,
  type SourceImage,
  type SourceLimits,
} from "../io";
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
import { DocumentStore, restoreNotice, type RestoreNotice } from "./store";
import { loadDitherCore, type DitherCore } from "./render/core";
import { DocumentRenderer } from "./render/renderer";

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
  readonly renderer: DocumentRenderer;
  readonly core: DitherCore;
  readonly layer: GpuLayer;
  readonly limits: SourceLimits;
  /** Point the session at the shell's viewport, or at nothing. */
  attachViewport(viewport: Viewport | null): void;
  /**
   * Open one file (F-IN-01) — from the toolbar's file input, which is a real
   * `<input type="file">` in the document rather than a synthesised one.
   */
  openFile(file: File): Promise<void>;
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
  const layer = await GpuLayer.create({
    report: options.report,
    label: "dither-ork",
    onDeviceLost: (info) => {
      // Not recoverable and not silent: every subsequent render throws from
      // `assertUsable`, and this is the line that says why.
      log.error("the GPU device was lost", { reason: info.reason, message: info.message });
    },
  });
  const core = await loadDitherCore();
  const resolver = loadGpuEffects();
  const limits = sourceLimits(layer.context.limits.maxTextureDimension2D);

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

  const renderer = new DocumentRenderer({
    registry: options.registry,
    resolver,
    layer,
    core,
  });

  let viewport: Viewport | null = null;

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

  // --- image intake (F-IN-01) -------------------------------------------

  const intake: ImageIntake = {
    onImage: (image: SourceImage) => {
      renderer.setSource(image);
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
    },
    onError: (error: ImageLoadError) => {
      report(error);
    },
    onNotice: (message: string) => {
      log.info("intake notice", { message });
    },
  };

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

  const uninstall = [
    installImageDrop(window, { intake, limits }),
    installClipboardPaste(window, { intake, limits }),
  ];

  // --- rendering ---------------------------------------------------------

  let inFlight: Promise<void> | null = null;
  let pendingRevision: number | null = null;
  let lastRendered = -1;

  const renderNow = async (): Promise<void> => {
    const snapshot = store.getSnapshot();
    if (snapshot.source === null) {
      viewport?.setFrame(null);
      viewport?.setReference(null);
      return;
    }
    lastRendered = snapshot.revision;
    const frame = await renderer.render(snapshot.document, {
      solo: snapshot.soloNodeId,
    });
    viewport?.setFrame({
      image: frame.image,
      documentWidth: frame.width,
      documentHeight: frame.height,
      quality: frame.quality,
      correlationId: frame.correlationId,
    });
    // A frame arrived, so whatever the last failure was, it is over.
    report(null);
  };

  const pump = (): void => {
    if (inFlight !== null) return;
    const revision = pendingRevision;
    if (revision === null) return;
    pendingRevision = null;

    inFlight = renderNow()
      .catch((error: unknown) => {
        // Every failure reaches the UI. A render that throws leaves the previous
        // frame on screen, which is the honest thing to show: the document is
        // one the renderer cannot honour, and the last one it could is what is
        // there.
        const wrapped = error instanceof Error ? error : new Error(String(error));
        log.error("render failed", { revision, error: wrapped.message });
        report(wrapped);
      })
      .finally(() => {
        inFlight = null;
        // Anything that arrived during the render is rendered now, once.
        if (pendingRevision !== null) pump();
      });
  };

  const request = (): void => {
    const snapshot = store.getSnapshot();
    if (snapshot.revision === lastRendered && inFlight === null) return;
    pendingRevision = snapshot.revision;
    pump();
  };

  const unsubscribe = store.subscribe(request);

  log.info("editor session ready", {
    cid,
    effects: options.registry.size,
    core: core.version,
    autosave: storage !== null,
    restored: restored !== null,
    maxSource: limits.maxDimension,
  });

  return {
    store,
    renderer,
    core,
    layer,
    limits,

    attachViewport(next: Viewport | null): void {
      viewport = next;
      log.info("viewport " + (next === null ? "detached" : "attached"));
      if (next === null) return;
      // A viewport that arrives after an image is already open has to be given
      // both surfaces; a fresh one has nothing to draw and this does nothing.
      const source = store.getSnapshot().source;
      if (source !== null) setReference(source);
      lastRendered = -1;
      request();
    },

    openFile: (file: File) => receiveImage(file, file.name, { intake, limits }),

    onError: (listener) => {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },

    async dispose(): Promise<void> {
      unsubscribe();
      paletteToDocument();
      documentToPalette();
      for (const off of uninstall) off();
      await store.flushAutosave();
      renderer.dispose();
      layer.destroy();
      log.info("editor session disposed");
    },
  };
}
