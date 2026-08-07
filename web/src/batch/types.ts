/**
 * What a batch run is, as types — F-BA-01 through F-BA-06.
 *
 * Nothing in `web/src/batch/` knows that React, the document store, the palette
 * editor or the editor session exist. It takes the four interfaces declared at
 * the bottom of this file — a renderer, a palette extractor, a place to put
 * files, a decoder — and `web/src/ui/batch/session.ts` is the one adapter that
 * speaks both vocabularies. That is exactly the arrangement `web/src/export/`
 * already uses (`export/source.ts` names what it needs; `ui/export/session.ts`
 * supplies it), and it is here for the same reason: the batch pipeline is
 * testable in a Node process with no device, no DOM and no image.
 *
 * ## One document, many images (F-BA-01)
 *
 * A batch applies **one** `DitherDocument` — the stack, the clock, the bindings
 * and, unless F-BA-04's per-image mode is on, the palette — to every input. The
 * document's own `source` field is replaced per item, because the whole point is
 * that the recipe is constant and the picture is not.
 *
 * ## Every item is independent (F-BA-06)
 *
 * "One corrupt file in a folder of two hundred must not kill the run." So each
 * item carries its own state, its own stage and its own error string, and the
 * run's outcome is a count of each rather than a single success or failure.
 * There is no path in `run.ts` on which a per-item failure escapes the item.
 */

import { DEFAULT_EXPORT_SETTINGS, clampSettings } from "../export";
import type { Destination, ExportSettings, VectorTracer } from "../export";
import type { SourceImage } from "../io";
import type { DitherDocument, Palette } from "../types/document";
import { DEFAULT_TEMPLATE } from "./naming";

/**
 * Where each image's palette comes from — F-BA-04.
 *
 * `document` is the palette the open document carries, so every output is
 * quantized against one set of colours and a folder of frames stays coherent.
 * `per-image` re-runs extraction against each source, which is what a person
 * wants when the inputs are unrelated pictures rather than frames of one thing.
 */
export type BatchPaletteMode = "document" | "per-image";

export const BATCH_PALETTE_MODES: readonly BatchPaletteMode[] = ["document", "per-image"];

/**
 * How many images are rendered at once.
 *
 * Each worker in the pool is a whole `RenderService` — its own thread, its own
 * `GPUDevice`, its own WASM core and its own node cache — because
 * `DocumentRenderer` holds exactly one source and is not re-entrant. So the
 * ceiling is low on purpose: four devices is four copies of every texture the
 * graph allocates, and past two the GPU is the bottleneck anyway.
 */
export const MAX_BATCH_WORKERS = 4;
export const MIN_BATCH_WORKERS = 1;

export interface BatchSettings {
  /** Format, quality, scale and the tracer's controls — the export panel's own. */
  readonly export: ExportSettings;
  readonly palette: BatchPaletteMode;
  /** F-BA-05. See `naming.ts` for the tokens. */
  readonly template: string;
  readonly workers: number;
}

/**
 * What the panel opens on.
 *
 * Two workers rather than one: the second is what turns a batch from "one image
 * at a time" into something that uses the machine, and it is where the return
 * flattens — past two the GPU is the bottleneck and each further device is
 * another full copy of every texture the graph allocates.
 */
export const DEFAULT_BATCH_SETTINGS: BatchSettings = {
  export: DEFAULT_EXPORT_SETTINGS,
  palette: "document",
  template: DEFAULT_TEMPLATE,
  workers: 2,
};

/**
 * Put a settings object inside its own legal range.
 *
 * The extent handed to `clampSettings` is the *largest* one a batch may
 * contain, because the scale multiplier's ceiling is a function of the frame it
 * scales and a batch does not have one frame. Passing a per-image extent here
 * would make the control jump as the queue changed.
 */
export function clampBatchSettings(
  settings: BatchSettings,
  width: number,
  height: number,
): BatchSettings {
  const exported = clampSettings(settings.export, width, height);
  const workers = Math.max(
    MIN_BATCH_WORKERS,
    Math.min(MAX_BATCH_WORKERS, Math.trunc(settings.workers)),
  );
  if (exported === settings.export && workers === settings.workers) return settings;
  return { ...settings, export: exported, workers };
}

/** One file waiting to be processed. */
export interface BatchInputFile {
  /** Stable for the life of the queue. Minted by a counter — never random. */
  readonly id: string;
  /**
   * The name as it arrived. For a folder drop this carries the relative path,
   * so the queue can show where a file came from; the *output* name never does
   * (see `naming.ts`).
   */
  readonly path: string;
  readonly blob: Blob;
  readonly bytes: number;
}

/** How far one item got. Every one of these is shown in the queue. */
export type BatchItemStage =
  | "waiting"
  | "decoding"
  | "palette"
  | "rendering"
  | "encoding"
  | "writing"
  | "finished";

export type BatchItemState = "pending" | "running" | "done" | "failed" | "cancelled";

export interface BatchItem {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly state: BatchItemState;
  readonly stage: BatchItemStage;
  /**
   * The name it was written under, or `null` until it has one.
   *
   * Not known before the run: `{width}` and `{height}` are output dimensions,
   * and the output extent is only certain once the frame has been encoded — a
   * vector export ignores the scale multiplier, so the number in the name would
   * otherwise be a guess that disagrees with the file.
   */
  readonly outputName: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly outputBytes: number | null;
  /**
   * Why this item failed, written for a person — F-BA-06's per-item error
   * reporting. Non-null exactly when `state` is `failed`.
   */
  readonly error: string | null;
  readonly ms: number | null;
}

export type BatchPhase = "idle" | "running" | "finished" | "cancelled" | "failed";

export interface BatchRunState {
  readonly items: readonly BatchItem[];
  readonly phase: BatchPhase;
  readonly done: number;
  readonly failed: number;
  readonly cancelled: number;
  /** 0..1 across the queue. Items, not bytes: an item is the unit a person counts. */
  readonly completed: number;
  /** One short line naming what the run is doing. */
  readonly detail: string;
  /**
   * A failure of the run itself rather than of an item — the ZIP could not be
   * written, the output directory went away. Distinct from a per-item error
   * because it stops the run and an item error does not.
   */
  readonly failure: string | null;
  readonly summary: BatchSummary | null;
}

export interface BatchSummary {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly outputBytes: number;
  readonly ms: number;
  /** How the files were delivered, for the line the UI prints afterwards. */
  readonly delivery: string;
}

/** Where the finished files go — F-BA-03. */
export type BatchOutput =
  | {
      readonly kind: "zip";
      /** Chosen inside the click, like every other write. See `destination.ts`. */
      readonly destination: Destination;
      readonly name: string;
    }
  | {
      readonly kind: "directory";
      readonly handle: FileSystemDirectoryHandle;
      /** The directory's own name, for the summary line. */
      readonly name: string;
    };

// --- what the pipeline is given ------------------------------------------

/**
 * The render pool, as `run.ts` sees it.
 *
 * `render` leases a worker, points it at this image, runs the document's stack
 * at full resolution on the export lane, and frees the worker. The lease is the
 * pool's business; a caller may issue more calls than there are workers and
 * they queue.
 */
export interface BatchRenderPool {
  /** How many renders may be in flight. Drives the run's concurrency. */
  readonly size: number;
  render(request: BatchRenderRequest): Promise<BatchRenderedFrame>;
  /** The core's SVG tracer, routed through the pool rather than the editor's worker. */
  readonly tracer: VectorTracer;
  dispose(): Promise<void>;
}

export interface BatchRenderRequest {
  readonly image: SourceImage;
  readonly document: DitherDocument;
  readonly signal: AbortSignal;
}

export interface BatchRenderedFrame {
  readonly width: number;
  readonly height: number;
  /** Interleaved 8-bit sRGB RGBA — exactly `export/types.ts`'s `ExportFrame`. */
  readonly data: Uint8ClampedArray;
}

/**
 * Per-image palette extraction — the F-BA-04 half that needs the core.
 *
 * An interface rather than a call into `ui/palette`, because this directory may
 * not import the palette editor and because the settings an extraction runs
 * with (method, k, seed, iterations, and which swatches are locked) belong to
 * that editor. The adapter passes them; this only asks for the result.
 */
export interface BatchPaletteExtractor {
  /** One line the panel states before the run, so the mode is never a mystery. */
  readonly detail: string;
  extract(image: SourceImage): Promise<Palette>;
}

/**
 * Bytes to a decoded source.
 *
 * `io/decode.ts` is exactly this shape; it is named here so the pipeline can be
 * driven in a test by a function that returns a two-pixel image.
 */
export type BatchDecoder = (blob: Blob, name: string) => Promise<SourceImage>;

/** Everything one run needs. */
export interface BatchRunRequest {
  readonly items: readonly BatchInputFile[];
  /** The recipe. Its `source` is replaced per item; nothing else is touched. */
  readonly document: DitherDocument;
  /** What `{preset}` expands to — the open document's name. */
  readonly presetName: string;
  readonly settings: BatchSettings;
  readonly output: BatchOutput;
  readonly pool: BatchRenderPool;
  readonly decode: BatchDecoder;
  /** Required when {@link BatchSettings.palette} is `per-image`, refused otherwise. */
  readonly extractor: BatchPaletteExtractor | null;
  /**
   * The modification time written into every ZIP entry.
   *
   * Passed in rather than read here: a clock read inside the pipeline would make
   * the same inputs produce different bytes, and this file is the one place that
   * would happen. One read, at the click, is what the UI does.
   */
  readonly modifiedAt: Date;
}
