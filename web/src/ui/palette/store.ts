/**
 * The palette store — the palette system's single owner, and the whole of its
 * interface to the rest of the application.
 *
 * # What another agent's document store needs from this file
 *
 * The palette is one of the five things a `.dork` document is made of, and this
 * module owns it. It is not a copy of the document's palette that has to be
 * kept in step; it is where that palette lives while the app is running. The
 * contract is four calls:
 *
 * ```ts
 * import { paletteStore, remapIndices } from "./ui/palette";
 *
 * // 1. Saving, or building a render: the document palette, right now.
 * const palette = paletteStore.palette;          // types/document.ts `Palette`
 *
 * // 2. Opening a document, undo, redo, Surprise Me: put one in.
 * paletteStore.dispatch({ kind: "load", palette });
 *
 * // 3. Whoever decodes an image hands it over, so extraction has a source.
 * paletteStore.setSource({ name, width, height, rgba });   // or null
 *
 * // 4. Re-render, and keep index maps addressing the right entries.
 * paletteStore.subscribe((change) => {
 *   if (change === null || !change.rerender) return;
 *   if (change.permutation !== null) remapIndices(indices, change.permutation);
 *   else invalidateQuantizedNodes();
 *   rerender();
 * });
 * ```
 *
 * `change.permutation` is the one part that is not obvious and is not optional.
 * It is non-null exactly when the palette's colours are unchanged and only
 * their order moved — a drag or a sort. An index map, a population column, or
 * anything else keyed by palette position is *still valid data in the wrong
 * order* after such a change, and putting it through `remapIndices` is what
 * makes a reorder free. When it is null the colours themselves changed, every
 * index map is stale, and the nodes that produced them have to run again.
 * Reordering without remapping is silent corruption — it does not throw, it
 * renders a plausible picture with the wrong colours — which is why the core
 * exposes ordering as a permutation and why this store passes it on.
 *
 * # Undo
 *
 * F-ST-04 wants undo across palette edits. This store does not implement it,
 * and deliberately: undo is one stack across every document mutation, not one
 * per panel. Every state here is an immutable value and every change is
 * announced, so the document store can push `change.palette` onto its own stack
 * and restore with `dispatch({ kind: "load", ... })`.
 */

import type { Palette } from "../../types/document";
import { logger } from "../../lib/log";
import { extractFromSource, fetchBuiltinPalettes } from "./core";
import type { ExtractionReport, PaletteSource } from "./extract";
import { canExtract, entriesToExtract, lockedCount } from "./extract";
import type { BuiltinPalette } from "./library";
import type { PaletteChange, PaletteEdit, PaletteState } from "./model";
import { documentPalette, initialPaletteState, reduce } from "./model";

const log = logger("app");

export type LibraryStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Everything the panel renders from, as one immutable value.
 *
 * One snapshot rather than a field per concern because `useSyncExternalStore`
 * compares snapshots with `Object.is`: a getter that rebuilds an object would
 * re-render forever, and a component per field would be four subscriptions to
 * keep in step.
 */
export interface PaletteSnapshot {
  readonly editor: PaletteState;
  readonly source: PaletteSource | null;
  readonly library: readonly BuiltinPalette[];
  readonly libraryStatus: LibraryStatus;
  readonly extracting: boolean;
  /** The last extraction failure, shown in the panel until the next attempt. */
  readonly extractionError: string | null;
  /**
   * Why the last edit did nothing.
   *
   * A refused edit is a real outcome and it is stated. The controls that can be
   * refused are disabled with the same reason in their tooltip, so this is the
   * second line of defence rather than the first — but a control that silently
   * does nothing is the failure this field exists to prevent.
   */
  readonly refusal: string | null;
}

export type PaletteListener = (change: PaletteChange | null) => void;

export interface PaletteStore {
  /** The current snapshot. Stable by identity until something changes. */
  getSnapshot(): PaletteSnapshot;
  /** The document palette right now — what `.dork` writes and the graph renders. */
  readonly palette: Palette;
  /**
   * Called with the change for a palette edit, and with `null` for a store
   * event that changed no colours (a source arriving, an extraction starting).
   * Returns the unsubscribe function.
   */
  subscribe(listener: PaletteListener): () => void;
  /** Apply one edit. Returns the change, or `null` when it was refused. */
  dispatch(edit: PaletteEdit): PaletteChange | null;
  /** Hand over the decoded source image, or `null` when none is open. */
  setSource(source: PaletteSource | null): void;
  /** Read the built-in hardware library from the core. Idempotent. */
  loadLibrary(): Promise<void>;
  /** Run an extraction against the current source (F-CO-02). */
  extract(): Promise<void>;
}

export function createPaletteStore(): PaletteStore {
  let snapshot: PaletteSnapshot = {
    editor: initialPaletteState(),
    source: null,
    library: [],
    libraryStatus: { kind: "idle" },
    extracting: false,
    extractionError: null,
    refusal: null,
  };
  const listeners = new Set<PaletteListener>();
  let libraryLoad: Promise<void> | null = null;

  const publish = (next: PaletteSnapshot, change: PaletteChange | null): void => {
    snapshot = next;
    for (const listener of listeners) listener(change);
  };

  const store: PaletteStore = {
    getSnapshot(): PaletteSnapshot {
      return snapshot;
    },

    get palette(): Palette {
      return documentPalette(snapshot.editor);
    },

    subscribe(listener: PaletteListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispatch(edit: PaletteEdit): PaletteChange | null {
      const outcome = reduce(snapshot.editor, edit);

      if (outcome.kind === "refused") {
        log.warn("palette edit refused", { edit: edit.kind, reason: outcome.reason });
        publish({ ...snapshot, refusal: outcome.reason }, null);
        return null;
      }

      const before = snapshot.editor;
      if (before.mode.kind !== "indexed" && outcome.state.mode.kind === "indexed") {
        log.info("output mode became indexed", {
          from: before.mode.kind,
          because: edit.kind,
        });
      }

      log.info("palette edit", {
        edit: edit.kind,
        entries: outcome.state.swatches.length,
        locked: lockedCount(outcome.state.swatches),
        reordered: outcome.change.permutation !== null,
        rerender: outcome.change.rerender,
        palette: outcome.state.id,
        metric: outcome.state.metric,
      });

      publish({ ...snapshot, editor: outcome.state, refusal: null }, outcome.change);
      return outcome.change;
    },

    setSource(source: PaletteSource | null): void {
      if (source !== null) {
        const pixels = source.width * source.height;
        const planes = [
          source.surface.r,
          source.surface.g,
          source.surface.b,
          source.surface.a,
        ];
        if (pixels === 0 || planes.some((plane) => plane.length < pixels)) {
          // Refused rather than stored: an extraction against a short plane
          // would either read zeros off the end or throw from inside the
          // encoder, and both name the buffer rather than whoever handed it over.
          const reason = `source "${source.name}" is ${source.width}x${source.height} but its planes hold ${planes.map((p) => p.length).join("/")}`;
          log.error("palette source refused", { source: source.name, reason });
          publish({ ...snapshot, refusal: reason }, null);
          return;
        }
      }
      log.info("palette source set", {
        source: source?.name ?? null,
        width: source?.width ?? 0,
        height: source?.height ?? 0,
      });
      publish({ ...snapshot, source, refusal: null }, null);
    },

    async loadLibrary(): Promise<void> {
      if (libraryLoad !== null) return libraryLoad;
      publish({ ...snapshot, libraryStatus: { kind: "loading" } }, null);

      libraryLoad = (async (): Promise<void> => {
        try {
          const library = await fetchBuiltinPalettes();
          publish({ ...snapshot, library, libraryStatus: { kind: "ready" } }, null);
        } catch (error) {
          // The library is the whole of F-CO-04; a failure to read it is shown
          // in the panel, not swallowed into an empty list that looks like a
          // build with no palettes in it.
          const message = error instanceof Error ? error.message : String(error);
          log.error("the built-in palette library could not be read", { error: message });
          publish({ ...snapshot, libraryStatus: { kind: "failed", message } }, null);
          // Cleared so the panel's retry can try again rather than resolving
          // instantly against the failed attempt.
          libraryLoad = null;
        }
      })();
      return libraryLoad;
    },

    async extract(): Promise<void> {
      const { editor, source } = snapshot;
      const allowed = canExtract(editor.swatches, editor.extract, source);
      if (!allowed.ok || source === null) {
        const reason = allowed.ok ? "open an image first" : allowed.reason;
        log.warn("extraction refused", { reason });
        publish({ ...snapshot, refusal: reason }, null);
        return;
      }

      const asked = entriesToExtract(editor.swatches, editor.extract);
      const locked = lockedCount(editor.swatches);
      publish({ ...snapshot, extracting: true, extractionError: null, refusal: null }, null);

      try {
        const result = await extractFromSource(source, editor.extract, asked);
        const report: ExtractionReport = {
          method: editor.extract.method,
          requestedK: editor.extract.k,
          askedOfCore: asked,
          lockedKept: locked,
          paletteLen: result.paletteLen,
          occupiedBins: result.occupiedBins,
          iterations: result.iterations,
          emptyClusterRepairs: result.emptyClusterRepairs,
          emptyClustersDropped: result.emptyClustersDropped,
          ms: result.ms,
          sourceName: source.name,
        };
        publish({ ...snapshot, extracting: false }, null);
        store.dispatch({
          kind: "extracted",
          colors: result.colors,
          populations: result.populations,
          report,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("extraction failed", { error: message, method: editor.extract.method });
        publish({ ...snapshot, extracting: false, extractionError: message }, null);
      }
    },
  };

  return store;
}

/**
 * The application's palette store.
 *
 * A module singleton, matching how the shell's own panel and toolbar registries
 * work: the palette panel registers itself and reads this, and the document
 * store imports it rather than a provider being threaded through a tree that
 * the shell deliberately does not know the shape of.
 */
export const paletteStore: PaletteStore = createPaletteStore();
