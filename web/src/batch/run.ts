/**
 * One batch, end to end — F-BA-01, and the place F-BA-04 and F-BA-06 become
 * behaviour rather than types.
 *
 * ```ts
 * const run = createBatchRun({ items, document, presetName, settings, output,
 *                              pool, decode, extractor, modifiedAt });
 * const unsubscribe = run.subscribe(() => render(run.getSnapshot()));
 * const final = await run.start();
 * ```
 *
 * ## The shape of one item
 *
 * decode → (extract) → render → encode → write. Each stage is named on the item
 * while it runs, because "processing…" on two hundred rows tells a person
 * nothing and "rendering" versus "encoding" tells them where the time is going.
 *
 * The encode happens **before** the name is computed, and that is deliberate:
 * `{width}` and `{height}` are the *output* extent, a vector export ignores the
 * scale multiplier, and a number in a file name that disagrees with the file is
 * worse than no number at all.
 *
 * ## Nothing an item does can end the run
 *
 * Every per-item failure is caught, converted to a sentence, and recorded on
 * that item. F-BA-06's "one corrupt file in a folder of two hundred" is not
 * handled by a special case for corrupt files — it is handled by there being no
 * path out of {@link processItem} that is not a state of the item.
 *
 * The two things that *do* stop a run are the two that make continuing
 * pointless: the person cancelled, and the archive or the output directory
 * could not be written. Both are recorded as a run-level failure, which is a
 * different field from a per-item error precisely so the UI can tell them apart.
 *
 * ## Concurrency
 *
 * `pool.size` lanes pull from one cursor. A lane owns its item from decode to
 * write, so the expensive parts overlap — one image is being encoded on this
 * thread while two more are being rendered on other threads — and the pool's
 * own lease is what keeps two images off one renderer.
 *
 * The ZIP is assembled **after** every lane has finished, in queue order, so
 * the archive is byte-identical whatever order the lanes happened to complete
 * in. A directory run writes as it goes, which is the whole reason to prefer
 * one: a cancel halfway leaves the files that already finished.
 */

import {
  encodeExport,
  formatInfo,
  isCancellation,
  maxScaleFor,
  throwIfCancelled,
  writeToDestination,
  yieldToHost,
  type ExportResult,
} from "../export";
import { sourceRefOf, type SourceImage } from "../io";
import { correlationId, logger } from "../lib/log";
import type { DitherDocument, Palette } from "../types/document";
import { isAbandoned } from "../worker";
import { describeOutput, writeIntoDirectory } from "./destination";
import { outputFileName } from "./naming";
import {
  cancelUnfinished,
  initialItems,
  outputBytesOf,
  patchItem,
  runStateOf,
  summarise,
  type ItemPatch,
} from "./queue";
import { ZipBuilder, ZipCancelledError } from "./zip";
import type {
  BatchItem,
  BatchPhase,
  BatchRunRequest,
  BatchRunState,
  BatchSummary,
} from "./types";

const log = logger("batch");

export interface BatchRun {
  /** Stable by identity until something changes — safe for `useSyncExternalStore`. */
  getSnapshot(): BatchRunState;
  subscribe(listener: () => void): () => void;
  /** Runs to completion. Never rejects; the outcome is in the returned state. */
  start(): Promise<BatchRunState>;
  /** F-BA-06's cancel. Stops the workers, not just the reporting. */
  cancel(): void;
}

/** Whether a rejection means "somebody stopped this", not "this went wrong". */
function isStopped(error: unknown): boolean {
  return isCancellation(error) || isAbandoned(error) || error instanceof ZipCancelledError;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One finished file waiting to go into the archive. */
interface Pending {
  readonly name: string;
  readonly blob: Blob;
  readonly mime: string;
}

export function createBatchRun(request: BatchRunRequest): BatchRun {
  const cid = correlationId();
  const total = request.items.length;

  let items = initialItems(request.items);
  let phase: BatchPhase = "idle";
  let failure: string | null = null;
  let summary: BatchSummary | null = null;
  let snapshot: BatchRunState = runStateOf(items, phase, failure, summary);

  const listeners = new Set<() => void>();
  const controller = new AbortController();
  const signal = controller.signal;
  let started = false;

  const publish = (): void => {
    snapshot = runStateOf(items, phase, failure, summary);
    for (const listener of listeners) listener();
  };

  const patch = (index: number, next: ItemPatch): void => {
    items = patchItem(items, index, next);
    publish();
  };

  /**
   * Output names already claimed.
   *
   * The backstop for a template whose names depend on the picture's own extent
   * — `plan.ts` refuses the knowable collisions before the run and this catches
   * the rest. First writer wins and the later item is *refused with a message*,
   * never silently overwritten. Which of two colliding items is "later" is
   * settled by completion order when more than one worker is running, which is
   * why `plan.ts` warns about it rather than leaving it to be discovered.
   */
  const claimed = new Set<string>();

  /** For the ZIP path only: results held until every lane has finished. */
  const pending: (Pending | null)[] = Array.from({ length: total }, () => null);

  const documentFor = (image: SourceImage, palette: Palette): DitherDocument => ({
    ...request.document,
    // The recipe is constant and the picture is not — F-BA-01 in one line.
    source: sourceRefOf(image),
    palette,
  });

  async function processItem(index: number): Promise<void> {
    const input = request.items[index];
    if (input === undefined) return;
    const at = performance.now();

    patch(index, { state: "running", stage: "decoding" });

    try {
      const image = await request.decode(input.blob, input.path);
      throwIfCancelled(signal);

      let palette = request.document.palette;
      if (request.settings.palette === "per-image") {
        const extractor = request.extractor;
        if (extractor === null) {
          // Unreachable through the panel — `plan.ts` refuses this combination
          // before the run — and it is still checked, because falling back to
          // the document palette here would be the application quietly doing
          // something other than what was asked.
          throw new Error(
            "per-image palettes were chosen but no extractor was supplied to the run",
          );
        }
        patch(index, { stage: "palette" });
        palette = await extractor.extract(image);
        throwIfCancelled(signal);
      }

      patch(index, { stage: "rendering" });
      const frame = await request.pool.render({
        image,
        document: documentFor(image, palette),
        signal,
      });

      // F-EX-12's multiplier has a ceiling that is a function of the frame it
      // scales, and a batch has one setting and many frames. Refused per item,
      // with the number that would have worked, rather than reaching the
      // allocator and failing as an opaque RangeError — and never clamped,
      // because a file written at 4x when 8x was asked for is a file that lies.
      const ceiling = maxScaleFor(frame.width, frame.height);
      const info = formatInfo(request.settings.export.format);
      if (!info.vector && request.settings.export.scale > ceiling) {
        throw new Error(
          `this picture renders at ${frame.width} x ${frame.height}, and ${request.settings.export.scale}x ` +
            `of it is more than a browser tab can allocate. ${ceiling}x is the most for an ` +
            `image this size.`,
        );
      }

      patch(index, { stage: "encoding" });
      const encoded: ExportResult = await encodeExport({
        frame,
        settings: request.settings.export,
        tracer: request.pool.tracer,
        signal,
      });

      const name = outputFileName(request.settings.template, {
        sourceName: input.path,
        index,
        total,
        presetName: request.presetName,
        // The encoder's own numbers, so the name cannot disagree with the file.
        width: encoded.width,
        height: encoded.height,
        format: request.settings.export.format,
      });

      const key = name.toLowerCase();
      if (claimed.has(key)) {
        throw new Error(
          `another image in this batch already produced "${name}". Nothing was ` +
            `overwritten — add {index} to the name template and run again.`,
        );
      }
      claimed.add(key);

      patch(index, {
        stage: "writing",
        outputName: name,
        width: encoded.width,
        height: encoded.height,
        outputBytes: encoded.bytes,
      });

      if (request.output.kind === "directory") {
        await writeIntoDirectory(request.output.handle, name, encoded.blob);
      } else {
        pending[index] = {
          name,
          blob: encoded.blob,
          mime: formatInfo(request.settings.export.format).mime,
        };
      }

      patch(index, {
        state: "done",
        stage: "finished",
        ms: Math.round(performance.now() - at),
      });
      log.info("batch item finished", {
        cid,
        index,
        path: input.path,
        name,
        width: encoded.width,
        height: encoded.height,
        bytes: encoded.bytes,
        indexed: encoded.indexed,
        ms: Math.round(performance.now() - at),
      });
    } catch (error) {
      if (isStopped(error) || signal.aborted) {
        patch(index, {
          state: "cancelled",
          stage: "finished",
          ms: Math.round(performance.now() - at),
        });
        log.debug("batch item cancelled", { cid, index, path: input.path });
        return;
      }
      const message = messageOf(error);
      patch(index, {
        state: "failed",
        stage: "finished",
        error: message,
        ms: Math.round(performance.now() - at),
      });
      // Reported here rather than only shown, because the message a person sees
      // is one line and the stack that produced it is worth having in the
      // console when two hundred files were processed and one was not.
      log.error("batch item failed", { cid, index, path: input.path, error: message });
    }
  }

  async function drain(): Promise<void> {
    let cursor = 0;
    const lanes = Math.max(1, Math.min(request.pool.size, Math.max(1, total)));
    const workers = Array.from({ length: lanes }, async () => {
      for (;;) {
        if (signal.aborted) return;
        const index = cursor;
        cursor += 1;
        if (index >= total) return;
        await processItem(index);
        // The encode and the palette extraction both hold this thread for real
        // stretches. Handing it back between items is what keeps the queue's
        // rows and the cancel button live during a long run.
        await yieldToHost();
      }
    });
    await Promise.all(workers);
  }

  /** Assemble and write the archive. A failure here stops the run. */
  async function writeArchive(): Promise<void> {
    if (request.output.kind !== "zip") return;
    const builder = new ZipBuilder({ modifiedAt: request.modifiedAt, signal });
    for (const entry of pending) {
      if (entry === null) continue;
      await builder.add(entry.name, entry.blob, entry.mime);
    }
    if (builder.count === 0) {
      // Nothing to write, and writing an empty archive would look like success.
      log.warn("no files were produced, so no archive was written", { cid });
      return;
    }
    await writeToDestination(request.output.destination, builder.finish());
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    cancel(): void {
      if (controller.signal.aborted) return;
      log.info("batch cancelled", { cid, ...summarise(items) });
      controller.abort();
      // The list is corrected now rather than when the workers unwind, so the
      // button appears to do what it says.
      items = cancelUnfinished(items);
      phase = "cancelled";
      publish();
    },

    async start(): Promise<BatchRunState> {
      if (started) {
        throw new Error("this batch run has already been started; create another");
      }
      started = true;
      const at = performance.now();
      phase = "running";
      publish();

      log.info("batch started", {
        cid,
        images: total,
        workers: request.pool.size,
        format: request.settings.export.format,
        scale: request.settings.export.scale,
        palette: request.settings.palette,
        template: request.settings.template,
        output: request.output.kind,
      });

      try {
        await drain();
        if (!signal.aborted) await writeArchive();
      } catch (error) {
        if (isStopped(error) || signal.aborted) {
          phase = "cancelled";
        } else {
          failure = messageOf(error);
          phase = "failed";
          log.error("the batch run stopped", { cid, error: failure });
        }
      }

      if (phase === "running") phase = "finished";
      // Anything still pending after a cancel — a lane that never picked it up.
      if (phase !== "finished") items = cancelUnfinished(items);

      const counts = summarise(items);
      summary = {
        total,
        done: counts.done,
        failed: counts.failed,
        cancelled: counts.cancelled,
        outputBytes: outputBytesOf(items),
        ms: Math.round(performance.now() - at),
        delivery: describeOutput(request.output),
      };
      publish();

      log.info("batch finished", {
        cid,
        phase,
        done: summary.done,
        failed: summary.failed,
        cancelled: summary.cancelled,
        bytes: summary.outputBytes,
        ms: summary.ms,
      });
      return snapshot;
    },
  };
}

/** The items that failed, for the panel's "copy the errors" affordance. */
export function failuresOf(items: readonly BatchItem[]): readonly BatchItem[] {
  return items.filter((item) => item.state === "failed");
}
