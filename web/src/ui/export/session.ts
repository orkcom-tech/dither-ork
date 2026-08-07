/**
 * The adapter: an `EditorSession` seen as an {@link ExportImageSource}.
 *
 * `web/src/export/` is not allowed to know that a document store, a renderer or
 * a session exist — it takes an interface (`export/source.ts`) written in its
 * own vocabulary. This is the one file that speaks both, and it is the whole of
 * the coupling between export and `state/`.
 *
 * ## What it assumes about `state/`, all of it public API
 *
 * - `store.getSnapshot()` is referentially stable and carries `document`,
 *   `source`, `soloNodeId` and a `revision` that increments on every change.
 * - `store.registry` resolves an effect id to its descriptor, so the solo point
 *   can be named rather than shown as a node id.
 * - `renderer.render(document, { solo })` returns a `RenderedFrame` whose
 *   `image` is the document-resolution, sRGB-encoded `ImageData` the viewport
 *   is given.
 *
 * ## Renders are serialised
 *
 * `DocumentRenderer` holds one node cache, one surface pool and one GPU
 * backend, and nothing in it is re-entrant. The session's own render pump keeps
 * one render in flight at a time; this adds a second caller, so export's
 * renders are chained behind each other here. That closes the case this file
 * can close — two export renders — and leaves the case it cannot: an export
 * render starting while the session's pump has one in flight. In practice the
 * export panel opens on a settled preview, and the chain below plus the panel's
 * own debounce keep them apart. The complete fix belongs in `state/`, as a
 * single render queue both callers go through, and is reported rather than
 * worked around here.
 */

import type {
  ExportFrame,
  ExportImageSource,
  ExportSubject,
  VectorTracer,
} from "../../export";
import { logger } from "../../lib/log";
import type { DocumentSnapshot, EditorSession } from "../../state";

const log = logger("export");

/**
 * The session's core, seen as export's {@link VectorTracer}.
 *
 * The whole of the coupling, again: `export/trace.ts` names what it needs and
 * `state/render/core.ts` is the only file that may hold the WASM handle the
 * answer arrives in. This is the line that joins them.
 */
export function vectorTracerFor(session: EditorSession): VectorTracer {
  return {
    trace(indices, width, height, paletteRgb, settings) {
      const started = performance.now();
      const traced = session.core.traceSvg(indices, width, height, paletteRgb, settings);
      log.info("index map traced", {
        width,
        height,
        entries: paletteRgb.length / 3,
        mode: settings.mode,
        layers: traced.report.layers,
        points: traced.report.points,
        chars: traced.svg.length,
        ms: Math.round(performance.now() - started),
      });
      return traced;
    },
  };
}

export function exportSourceFor(session: EditorSession): ExportImageSource {
  // Memoised against the store's own snapshot identity. `useSyncExternalStore`
  // compares with `Object.is`, so a subject rebuilt on every read renders
  // forever — the same contract the document store itself documents.
  let lastSnapshot: DocumentSnapshot | null = null;
  let lastSubject: ExportSubject | null = null;

  const build = (snapshot: DocumentSnapshot): ExportSubject | null => {
    const image = snapshot.source;
    if (image === null) return null;

    let soloNodeName: string | null = null;
    if (snapshot.soloNodeId !== null) {
      const node = snapshot.document.stack.find((entry) => entry.id === snapshot.soloNodeId);
      soloNodeName =
        node === undefined
          ? null
          : (session.store.registry.get(node.effect)?.name ?? node.effect);
    }

    return {
      name: image.name,
      width: image.width,
      height: image.height,
      soloNodeName,
      revision: snapshot.revision,
    };
  };

  let chain: Promise<unknown> = Promise.resolve();

  return {
    subject(): ExportSubject | null {
      const snapshot = session.store.getSnapshot();
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        lastSubject = build(snapshot);
      }
      return lastSubject;
    },

    renderFrame(signal?: AbortSignal): Promise<ExportFrame> {
      const run = async (): Promise<ExportFrame> => {
        const snapshot = session.store.getSnapshot();
        if (snapshot.source === null) {
          throw new Error("there is no image open to export");
        }
        if (signal?.aborted === true) {
          throw new DOMException("the export render was superseded", "AbortError");
        }

        const frame = await session.renderer.render(snapshot.document, {
          solo: snapshot.soloNodeId,
        });
        log.info("frame rendered for export", {
          width: frame.width,
          height: frame.height,
          cid: frame.correlationId,
          ms: frame.totalMs,
        });
        return {
          width: frame.width,
          height: frame.height,
          data: frame.image.data,
        };
      };

      // Chained, not raced: see the note at the top of the file. The `catch`
      // keeps one failed render from poisoning the chain for the next one, and
      // logs rather than discarding, because the caller already sees the
      // rejection it is about to be handed.
      const next = chain.then(run, run);
      chain = next.catch((error: unknown) => {
        log.debug("export render finished with an error", { error: String(error) });
      });
      return next;
    },

    subscribe(listener: () => void): () => void {
      return session.store.subscribe(listener);
    },
  };
}
