/**
 * The adapter: an `EditorSession` and a `PaletteStore` seen as the four
 * interfaces `web/src/batch/` declares.
 *
 * `web/src/batch/` is not allowed to know that a document store, a render
 * service, a session or the palette editor exist — it takes a decoder, a render
 * pool and a palette extractor written in its own vocabulary. This is the one
 * file that speaks both, and it is the whole of the coupling. Exactly the
 * arrangement `ui/export/session.ts` is, for exactly the same reason.
 *
 * ## The batch does not borrow the editor's worker
 *
 * `RenderService.setSource` replaces the source the renderer holds, and the
 * editor's worker holds the picture on screen. Pointing it at a batch image
 * would invalidate the preview, the before/after reference and every cached
 * node in the editor's graph, and putting it back afterwards would be an
 * invisible reload of the user's document. So `poolFor` builds *new* workers —
 * see `batch/pool.ts` — and the editor carries on rendering while a batch runs.
 *
 * ## Where per-image extraction actually runs, stated
 *
 * `extractFromSource` is a synchronous call into the WASM core on **this**
 * thread; the palette editor has always reached it that way and there is no
 * `extract` call on the render worker's protocol to route it through. So a
 * per-image batch holds the main thread for the duration of each extraction —
 * tens to a few hundred milliseconds per image on the sizes this application
 * takes. `run.ts` hands the thread back between items, so the queue and the
 * cancel button stay live between extractions but not during one. That is a
 * real property of the current worker protocol and it is written down rather
 * than left to be discovered.
 *
 * ## Locked swatches survive a batch, too
 *
 * F-CO-05 says a locked swatch survives re-extraction, and a batch is two
 * hundred re-extractions. The same `entriesToExtract` / `mergeLocked` pair the
 * palette panel uses is applied here, so a person who pinned their two brand
 * colours gets them in every one of the two hundred outputs.
 */

import type {
  BatchDecoder,
  BatchPaletteExtractor,
  BatchRenderPool,
} from "../../batch";
import { createBatchRenderPool, poolSizeFor } from "../../batch";
import { decodeImage, type SourceImage } from "../../io";
import type { CapabilityReport } from "../../lib/capabilities";
import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import type { EditorSession } from "../../state";
import type { Palette } from "../../types/document";
import {
  entriesToExtract,
  extractFromSource,
  lockedCount,
  mergeLocked,
  methodLabel,
  type PaletteStore,
} from "../palette";
import { suggestPresetName } from "../documents";

const log = logger("batch");

/** Bytes to a decoded source, with the device's own extent ceiling applied. */
export function batchDecoderFor(session: EditorSession): BatchDecoder {
  return (blob, name) => decodeImage(blob, name, { limits: session.limits });
}

/**
 * What `{preset}` expands to.
 *
 * The document has no name of its own — a `.dork` is named after the image and
 * a preset is named when it is saved — so the same proposal the preset save box
 * opens with is used here: the look, named after the dither in the stack. It
 * falls back to the palette's name and then to a constant, so the token always
 * expands to something.
 */
export function presetNameFor(session: EditorSession, registry: EffectRegistry): string {
  const document = session.store.getSnapshot().document;
  const suggested = suggestPresetName(document, registry).trim();
  if (suggested.length > 0) return suggested;
  const palette = document.palette.name.trim();
  return palette.length > 0 ? palette : "dither-ork";
}

/**
 * Per-image palette extraction (F-BA-04), driven by the palette panel's own
 * settings.
 *
 * Returns `null` when extraction cannot run at all — which today means the
 * editor has locked at least as many swatches as `k` allows, the one refusal
 * that does not depend on having an image. `plan.ts` turns a `null` into a
 * refusal on the button rather than into a silent fall back to the document
 * palette, which is the behaviour that would be indistinguishable from the
 * feature not working.
 */
export function batchPaletteExtractorFor(store: PaletteStore): BatchPaletteExtractor | null {
  const editor = store.getSnapshot().editor;
  const settings = editor.extract;
  const locked = lockedCount(editor.swatches);
  if (locked >= settings.k) return null;

  const asked = entriesToExtract(editor.swatches, settings);

  return {
    detail:
      `Each image gets its own palette: ${methodLabel(settings.method)}, k = ${settings.k}` +
      (locked > 0 ? `, with ${locked} locked swatch${locked === 1 ? "" : "es"} kept` : "") +
      `, seed ${settings.seed}. Extraction runs on this thread, so the window is ` +
      `busy for a moment per image.`,

    async extract(image: SourceImage): Promise<Palette> {
      const extraction = await extractFromSource(
        { name: image.name, width: image.width, height: image.height, surface: image.surface },
        settings,
        asked,
      );
      const merged = mergeLocked(editor.swatches, extraction.colors, extraction.populations);
      const colors: number[] = [];
      for (const swatch of merged) {
        colors.push(swatch.rgb[0], swatch.rgb[1], swatch.rgb[2]);
      }
      log.debug("per-image palette extracted", {
        image: image.name,
        asked,
        entries: merged.length,
        method: settings.method,
      });
      return {
        // The id and the metric follow the editor: the metric decides how the
        // quantizer measures distance and is a property of the document, not of
        // one picture. Only the colours are per image.
        id: editor.id,
        name: editor.name,
        colors,
        metric: editor.metric,
      };
    },
  };
}

/**
 * Bring a pool of batch workers up.
 *
 * Called when a run starts and disposed when it ends, because each member holds
 * a `GPUDevice` and a WASM core for as long as it exists.
 */
export function poolFor(
  report: CapabilityReport,
  workers: number,
  images: number,
): Promise<BatchRenderPool> {
  return createBatchRenderPool({ report, size: poolSizeFor(workers, images) });
}
