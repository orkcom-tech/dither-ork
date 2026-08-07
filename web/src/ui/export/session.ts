/**
 * The adapter: an `EditorSession` seen as an {@link ExportImageSource}.
 *
 * `web/src/export/` is not allowed to know that a document store, a render
 * service or a session exist — it takes an interface (`export/source.ts`)
 * written in its own vocabulary. This is the one file that speaks both, and it
 * is the whole of the coupling between export and `state/`.
 *
 * ## What it assumes about `state/`, all of it public API
 *
 * - `store.getSnapshot()` is referentially stable and carries `document`,
 *   `source`, `soloNodeId` and a `revision` that increments on every change.
 * - `store.registry` resolves an effect id to its descriptor, so the solo point
 *   can be named rather than shown as a node id.
 * - `session.render` is the render worker, and a render on its `export` lane
 *   comes back at document resolution with the frame's own samples.
 *
 * ## Renders are no longer chained here
 *
 * This file used to hold a promise chain, because `DocumentRenderer` is not
 * re-entrant and export was its second caller; the comment that chain carried
 * said the real fix was a single queue both callers went through, in `state/`.
 * That queue now exists, in the render worker (`worker/queue.ts`), and it does
 * two things the chain could not:
 *
 * - **An export preempts the preview.** The preview render in flight is
 *   aborted and re-queued, so an export never waits behind a frame that will be
 *   superseded 16 ms later, and the preview it displaced is re-run rather than
 *   dropped.
 * - **An export is never superseded.** Preview renders are thrown away when a
 *   newer one arrives; an export is a file somebody asked for and runs to
 *   completion or is cancelled explicitly.
 *
 * So there is nothing to serialise here, and the chain is gone rather than
 * kept as a second, weaker copy of the same policy.
 *
 * ## Cancel stops the worker
 *
 * F-EX-13 asks for a cancel that stops the worker rather than one that stops
 * reporting. The panel's `AbortSignal` is wired to the worker call's id, so
 * pressing cancel mid-render abandons the render itself.
 */

import type {
  ExportFrame,
  ExportImageSource,
  ExportSubject,
  TracedDocument,
  VectorTracer,
} from "../../export";
import { logger } from "../../lib/log";
import type { DocumentSnapshot, EditorSession } from "../../state";
import type { DitherDocument } from "../../types/document";
import { frameDocument, type TimelineStore } from "../timeline";
import { isAbandoned, type RenderResult } from "../../worker";

const log = logger("export");

/**
 * Whether the caller has cancelled.
 *
 * A function rather than `signal?.aborted === true` at each site: an abort flag
 * flips *during* the await between the two checks below, and TypeScript's
 * control-flow analysis would narrow the second one away on the strength of the
 * first — silently turning a cancellation into a reported failure.
 */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The render worker, seen as export's {@link VectorTracer}.
 *
 * The whole of the coupling, again: `export/trace.ts` names what it needs and
 * the worker is the only place a `wasm-bindgen` handle may be held. This is the
 * line that joins them — and it is the line that moved the trace off the main
 * thread, which on a large image was seconds of frozen window.
 */
export function vectorTracerFor(session: EditorSession): VectorTracer {
  return {
    async trace(indices, width, height, paletteRgb, settings): Promise<TracedDocument> {
      const traced = await session.render.trace({
        indices,
        width,
        height,
        paletteRgb,
        settings,
      });
      log.info("index map traced", {
        width,
        height,
        entries: paletteRgb.length / 3,
        mode: settings.mode,
        layers: traced.report.layers,
        points: traced.report.points,
        chars: traced.svg.length,
        workerMs: traced.ms,
      });
      return { svg: traced.svg, report: traced.report };
    },
  };
}

/**
 * The document a still export renders.
 *
 * **The frame at the playhead, when the document is animated.** An animated
 * document has no single picture: `buildRenderGraph` refuses it as written, and
 * the honest answer to "export this as a PNG" is the frame on screen, which is
 * the one the timeline is drawing. Anything else would either fail or export a
 * frame nobody was looking at.
 *
 * A document with no tracks has no plan and comes through untouched, which is
 * every still document and the overwhelming majority of exports.
 */
function documentToExport(session: EditorSession, timeline: TimelineStore): DitherDocument {
  return frameDocument(timeline, session.store.getSnapshot().document);
}

export function exportSourceFor(
  session: EditorSession,
  timeline: TimelineStore,
): ExportImageSource {
  // Memoised against the store's own snapshot identity. `useSyncExternalStore`
  // compares with `Object.is`, so a subject rebuilt on every read renders
  // forever — the same contract the document store itself documents.
  let lastSnapshot: DocumentSnapshot | null = null;
  let lastTimelineRevision = -1;
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
      // The playhead is part of what would be exported when the document is
      // animated, so the estimate has to be re-measured when it moves.
      revision: snapshot.revision * 1_000_003 + timeline.getSnapshot().revision,
    };
  };

  return {
    subject(): ExportSubject | null {
      const snapshot = session.store.getSnapshot();
      const timelineRevision = timeline.getSnapshot().revision;
      if (snapshot !== lastSnapshot || timelineRevision !== lastTimelineRevision) {
        lastSnapshot = snapshot;
        lastTimelineRevision = timelineRevision;
        lastSubject = build(snapshot);
      }
      return lastSubject;
    },

    async renderFrame(signal?: AbortSignal): Promise<ExportFrame> {
      const snapshot = session.store.getSnapshot();
      if (snapshot.source === null) {
        throw new Error("there is no image open to export");
      }
      if (aborted(signal)) {
        throw new DOMException("the export render was superseded", "AbortError");
      }

      const { id, frame } = session.render.renderCancellable({
        document: documentToExport(session, timeline),
        solo: snapshot.soloNodeId,
        // Always the document's own resolution. F-UI-03's reduction is a
        // property of the preview, and a file rendered at 40% would be a
        // different picture — a dither is a function of the pixel grid it ran
        // on.
        quality: "full",
        factor: 1,
        lane: "export",
        // Export needs the samples themselves; a bitmap would have to be
        // decoded back on this thread to encode it.
        present: "bytes",
      });

      const stop = (): void => session.render.cancel(id);
      signal?.addEventListener("abort", stop, { once: true });
      try {
        let result: RenderResult;
        try {
          result = await frame;
        } catch (error) {
          // The worker says "abandoned"; export's vocabulary for the same event
          // is an `AbortError`, which `isCancellation` recognises and the panel
          // therefore does not show as a failure. Translated rather than left
          // alone, because a cancel that surfaces as "the frame could not be
          // produced" tells the user something went wrong when they are the one
          // who stopped it. Anything that is not our own cancellation is
          // rethrown untouched.
          if (isAbandoned(error) && aborted(signal)) {
            throw new DOMException("the export render was cancelled", "AbortError");
          }
          throw error;
        }
        const image = result.image;
        if (image.kind !== "bytes") {
          throw new Error("an export render came back as a bitmap; export encodes samples");
        }
        log.info("frame rendered for export", {
          width: result.width,
          height: result.height,
          cid: result.correlationId,
          workerMs: result.totalMs,
          bytes: result.transferBytes,
        });
        return { width: result.width, height: result.height, data: image.data };
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    },

    subscribe(listener: () => void): () => void {
      // Both stores: when the document is animated, moving the playhead changes
      // which frame a still export would write.
      const offDocument = session.store.subscribe(listener);
      const offTimeline = timeline.subscribe(listener);
      return () => {
        offDocument();
        offTimeline();
      };
    },
  };
}
