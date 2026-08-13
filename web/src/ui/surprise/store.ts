/**
 * The surprise panel's store.
 *
 * One immutable snapshot, read through `useSyncExternalStore`, in the same shape
 * as `ui/palette/store.ts` — a getter that rebuilt its object would re-render
 * forever, and a subscription per field would be four things to keep in step.
 *
 * It owns the things that are ways of *asking* for a surprise rather than part
 * of a document: the chaos setting, the per-aspect modes (the locks and the
 * excludes), the history and whichever history entry is currently on screen.
 * None of them belongs in the `.dork` — the seed does, and the document carries
 * it.
 *
 * That is the answer to "should an exclude be in the seed or the share link"
 * (F-SM-02, F-DO-06), and it is the same answer the locks already have. A seed
 * reproduces a document *given the same base document and the same request*;
 * that has been true since the first lock, because a locked palette comes from
 * the base rather than from the seed. What actually travels is the document
 * itself — `io/document/share.ts` encodes the whole thing into the URL fragment
 * — and an excluded aspect is visible there as the state it produced:
 * `bindings: []`. So the picture at the far end is exact without the exclude
 * being carried, and carrying it would put a control setting into a file format
 * that describes pictures.
 */

import { logger } from "../../lib/log";
import type { DitherDocument } from "../../types/document";
import type { DocumentStore } from "../../state";
import {
  NO_EXCLUDES,
  NO_LOCKS,
  describeEntry,
  pushSurprise,
  withThumbnail,
  type SurpriseExcludes,
  type SurpriseHistoryEntry,
  type SurpriseLocks,
} from "../../surprise";
import type { PaletteStore } from "../palette/store";
import type { SurpriseEngine, StackEntry } from "./engine";
import {
  DEFAULT_CHAOS,
  clampChaos,
  withAspectMode,
  type AspectKey,
  type AspectMode,
  type Readiness,
} from "./model";

const log = logger("app");

export interface SurpriseSnapshot {
  /** Tame to wild (F-SM-07). */
  readonly chaos: number;
  /** What the next press leaves alone (F-SM-06). */
  readonly locks: SurpriseLocks;
  /** What the next press does not produce at all. Never true where a lock is. */
  readonly excludes: SurpriseExcludes;
  /** Newest first (F-SM-10). */
  readonly history: readonly SurpriseHistoryEntry[];
  /**
   * The history entry the document currently *is*, or `null` once it has been
   * edited since. Derived from the document store's revision rather than by
   * comparing documents: an edit is exactly a revision this store did not cause.
   */
  readonly current: string | null;
  readonly busy: boolean;
  /** The last refusal or failure, shown until the next attempt. */
  readonly problem: string | null;
  readonly ready: Readiness;
  /** The stack, for the per-node dice (F-SM-08). */
  readonly stack: readonly StackEntry[];
}

export interface SurpriseStore {
  getSnapshot(): SurpriseSnapshot;
  subscribe(listener: () => void): () => void;
  setChaos(value: number): void;
  /**
   * Put one aspect into one mode: reroll, keep, or off.
   *
   * One call rather than a lock toggle and an exclude toggle, so "kept and
   * excluded" has no sequence of calls that produces it.
   */
  setMode(key: AspectKey, mode: AspectMode): void;
  /** F-SM-01. Safe to call while one is running — the engine coalesces. */
  surprise(): void;
  /** F-SM-08. */
  reroll(nodeId: string): void;
  /** F-SM-10. */
  restore(entryId: string): void;
  dismissProblem(): void;
  dispose(): void;
}

export interface SurpriseStoreOptions {
  readonly engine: SurpriseEngine;
  /**
   * The live document.
   *
   * The store itself rather than the whole `EditorSession`, deliberately: this
   * needs the revision counter and nothing else from it, and taking the session
   * would drag the render worker into a file that never asks for a picture. The
   * engine is what holds the session, because the engine is what renders.
   */
  readonly documents: DocumentStore;
  readonly palette: PaletteStore;
}

export function createSurpriseStore(options: SurpriseStoreOptions): SurpriseStore {
  const { engine, documents, palette } = options;

  let chaos = DEFAULT_CHAOS;
  let locks: SurpriseLocks = NO_LOCKS;
  let excludes: SurpriseExcludes = NO_EXCLUDES;
  let history: readonly SurpriseHistoryEntry[] = [];
  let current: string | null = null;
  let busy = false;
  let problem: string | null = null;
  /** The document revision this store last produced. See {@link SurpriseSnapshot.current}. */
  let ownRevision = -1;
  let nextEntryId = 1;
  let disposed = false;

  const listeners = new Set<() => void>();
  let snapshot: SurpriseSnapshot = build();

  function build(): SurpriseSnapshot {
    return {
      chaos,
      locks,
      excludes,
      history,
      current,
      busy,
      problem,
      ready: engine.ready(),
      stack: engine.stack(),
    };
  }

  function publish(): void {
    snapshot = build();
    for (const listener of listeners) listener();
  }

  /**
   * A document revision this store did not cause means the surprise on screen
   * has been edited, so it is no longer the history entry it came from.
   */
  const onDocument = (): void => {
    const revision = documents.getSnapshot().revision;
    if (current !== null && revision !== ownRevision) {
      log.debug("the document moved off the surprise it came from", { entry: current });
      current = null;
    }
    publish();
  };

  const offDocument = documents.subscribe(onDocument);
  // The palette store is what knows whether the hardware library has been read,
  // which is half of `ready()`. Without this the button would stay disabled
  // until something else happened to notify.
  const offPalette = palette.subscribe(() => publish());

  function fail(message: string): void {
    problem = message;
    busy = false;
    log.warn("surprise refused", { reason: message });
    publish();
  }

  function attachThumbnail(entryId: string, document: DitherDocument): void {
    // Fired after the document is applied, so the picture is already on its way
    // and the thumbnail is the only thing still outstanding. `thumbnail` never
    // rejects; it reports.
    void engine.thumbnail(document).then((outcome) => {
      if (disposed) return;
      history = withThumbnail(history, entryId, outcome.url, outcome.problem);
      publish();
    });
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setChaos(value: number): void {
      const next = clampChaos(value);
      if (next === chaos) return;
      chaos = next;
      log.debug("chaos set", { chaos });
      publish();
    },

    setMode(key: AspectKey, mode: AspectMode): void {
      const next = withAspectMode({ locks, excludes }, key, mode);
      locks = next.locks;
      excludes = next.excludes;
      log.info("surprise aspect set", { aspect: key, mode });
      publish();
    },

    surprise(): void {
      const verdict = engine.ready();
      if (!verdict.ready) {
        fail(verdict.reason);
        return;
      }
      busy = true;
      problem = null;
      publish();

      void engine
        .surprise({
          chaos,
          locks,
          excludes,
          // Once per surprise that reached the screen, which is not always once
          // per press: the engine coalesces a hammered shortcut into fewer runs.
          // Recording each as it lands is what keeps the history a record of
          // what was actually shown.
          onApplied: (run) => {
            if (disposed) return;
            const entry: SurpriseHistoryEntry = {
              id: `s${nextEntryId}`,
              seed: run.result.summary.seed,
              summary: run.result.summary,
              document: run.result.document,
              thumbnail: null,
              thumbnailProblem: null,
            };
            nextEntryId += 1;
            history = pushSurprise(history, entry);
            current = entry.id;
            ownRevision = documents.getSnapshot().revision;
            publish();
            log.info("surprise recorded", { entry: describeEntry(entry) });
            attachThumbnail(entry.id, entry.document);
          },
        })
        .then(() => {
          if (disposed) return;
          busy = false;
          publish();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          fail(error instanceof Error ? error.message : String(error));
        });
    },

    reroll(nodeId: string): void {
      try {
        engine.reroll(nodeId, chaos);
        // The document is no longer the surprise it came from; the seed it
        // advertises has been dropped by `rerollNodeParams` for the same reason.
        current = null;
        ownRevision = documents.getSnapshot().revision;
        problem = null;
        publish();
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    },

    restore(entryId: string): void {
      const entry = history.find((candidate) => candidate.id === entryId);
      if (entry === undefined) {
        fail(`that surprise is no longer in the history`);
        return;
      }
      try {
        engine.restore(entry.document, `Surprise ${entry.seed}`);
        current = entry.id;
        ownRevision = documents.getSnapshot().revision;
        problem = null;
        // Moved to the front rather than duplicated, so looking at an old
        // surprise again does not push a second copy of it.
        history = pushSurprise(history, entry);
        publish();
        log.info("surprise restored", { entry: describeEntry(entry) });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    },

    dismissProblem(): void {
      if (problem === null) return;
      problem = null;
      publish();
    },

    dispose(): void {
      disposed = true;
      offDocument();
      offPalette();
      listeners.clear();
    },
  };
}
