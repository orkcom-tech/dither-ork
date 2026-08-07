/**
 * Batch processing — F-BA-01 through F-BA-06.
 *
 * One document's stack applied to many images, with a visible queue, per-item
 * errors and a cancel that stops work.
 *
 * ```ts
 * const pool = await createBatchRenderPool({ report, size: poolSizeFor(2, items.length) });
 * const run = createBatchRun({
 *   items, document, presetName, settings, output, pool,
 *   decode: (blob, name) => decodeImage(blob, name, { limits }),
 *   extractor, modifiedAt: new Date(),
 * });
 * const unsubscribe = run.subscribe(() => draw(run.getSnapshot()));
 * await run.start();
 * await pool.dispose();
 * ```
 *
 * ## Where each requirement lives
 *
 * | | |
 * | --- | --- |
 * | F-BA-01 apply one stack to many images | `run.ts`, `pool.ts` |
 * | F-BA-02 multi-select, folder drop, directory handle | `input.ts` |
 * | F-BA-03 ZIP, or written back to a directory | `destination.ts`, `zip.ts` |
 * | F-BA-04 shared or per-image palette | `run.ts`, via `BatchPaletteExtractor` |
 * | F-BA-05 filename templating | `naming.ts` |
 * | F-BA-06 visible queue, per-item errors, cancel | `queue.ts`, `run.ts` |
 *
 * ## What this directory is not allowed to know
 *
 * That React, the document store, the editor session or the palette editor
 * exist. It takes interfaces written in its own vocabulary — a render pool, a
 * decoder, a palette extractor — and `web/src/ui/batch/session.ts` is the one
 * file that speaks both. That is the same arrangement `web/src/export/` uses,
 * and it is what lets `naming.ts`, `queue.ts`, `plan.ts` and `zip.ts` be tested
 * in a Node process with no device, no DOM and no image.
 *
 * ## The degradation is stated, never silent
 *
 * Where the File System Access API is missing, batch is multi-select in and ZIP
 * out. {@link batchInputCapability} and {@link batchDeliveryCapability} are the
 * two sentences that say so, they name the consequence rather than the API, and
 * the panel renders both unconditionally.
 */

export type {
  BatchDecoder,
  BatchInputFile,
  BatchItem,
  BatchItemStage,
  BatchItemState,
  BatchOutput,
  BatchPaletteExtractor,
  BatchPaletteMode,
  BatchPhase,
  BatchRenderPool,
  BatchRenderRequest,
  BatchRenderedFrame,
  BatchRunRequest,
  BatchRunState,
  BatchSettings,
  BatchSummary,
} from "./types";

export {
  BATCH_PALETTE_MODES,
  DEFAULT_BATCH_SETTINGS,
  MAX_BATCH_WORKERS,
  MIN_BATCH_WORKERS,
  clampBatchSettings,
} from "./types";

export {
  DEFAULT_TEMPLATE,
  NAME_TOKENS,
  UNTITLED_OUTPUT,
  applyTemplate,
  collisionsIn,
  indexWidth,
  outputFileName,
  sanitiseName,
  templateRefusal,
  templateUsesExtent,
  unknownTokensIn,
  type NameContext,
  type NameToken,
} from "./naming";

export {
  MAX_ZIP_ENTRIES,
  METHOD_DEFLATE,
  METHOD_STORE,
  ZipBuilder,
  ZipCancelledError,
  ZipLimitError,
  deflateRaw,
  dosDateTime,
  zipMethodFor,
  type ZipBuilderOptions,
  type ZipMethod,
} from "./zip";

export {
  batchInputCapability,
  batchInputFile,
  canReadDroppedFolders,
  collectDroppedInputs,
  directoryPicker,
  looksLikeImage,
  orderInputs,
  pickBatchDirectoryFiles,
  pickBatchFiles,
  pickInputDirectory,
  readDirectoryHandle,
  type BatchInputCapability,
  type DroppedInputs,
} from "./input";

export {
  archiveFileName,
  batchDeliveryCapability,
  chooseArchiveDestination,
  chooseOutputDirectory,
  describeOutput,
  writeIntoDirectory,
  type BatchDeliveryCapability,
  type BatchDeliveryKind,
} from "./destination";

export {
  cancelUnfinished,
  completionOf,
  detailFor,
  duplicatesIn,
  initialItems,
  outputBytesOf,
  patchItem,
  runStateOf,
  summarise,
  type ItemPatch,
  type QueueCounts,
} from "./queue";

export { planBatch, tokenHint, type BatchPlan, type BatchPlanContext } from "./plan";

export {
  createBatchRenderPool,
  poolSizeFor,
  type BatchPoolOptions,
} from "./pool";

export { createBatchRun, failuresOf, type BatchRun } from "./run";
