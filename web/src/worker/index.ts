/**
 * The render worker: the thread that owns the device, the core and the pixels.
 *
 * - `protocol.ts`       the wire format, imported by both sides.
 * - `queue.ts`          preview versus export, supersession and preemption.
 * - `resample.ts`       the fractional source resampler F-UI-03 needed.
 * - `render.worker.ts`  the worker itself. Not imported from here — `client.ts`
 *                       imports it as `./render.worker.ts?worker&url`, which is
 *                       what makes Vite bundle it as its own chunk rather than
 *                       folding it into the main bundle *or*, as happened once,
 *                       copying the raw TypeScript into `dist/assets/` and
 *                       leaving the browser to fail on it. See the note at that
 *                       import; it is not interchangeable with a `new URL`
 *                       expression held in a variable.
 * - `diagnose.ts`       what a `Worker` `error` event actually means. Reads the
 *                       two different event shapes a browser can hand over, so
 *                       a failure reports a cause instead of `undefined`.
 * - `client.ts`         `RenderService`, the main thread's handle on all of it.
 *
 * **`RenderService` is the interface anything that wants a picture uses** —
 * animation, Surprise Me, batch and animated export included. See its doc
 * comment for the two rules a caller has to know: an abandoned render is not an
 * error, and a transferred `ImageBitmap` has exactly one owner.
 */

export { RenderService, isAbandoned, type RenderServiceOptions } from "./client";

export {
  describeWorkerError,
  describeWorkerScriptResponse,
  describeWorkerScriptUnreachable,
  type WorkerErrorDescription,
  type WorkerErrorEvent,
} from "./diagnose";

export {
  RenderAbandoned,
  reviveError,
  serialiseError,
  sourceBytes,
  type GifAbandonParams,
  type GifBeginParams,
  type GifBeginResult,
  type GifFinishParams,
  type GifFinishResult,
  type GifFrameParams,
  type GifFrameResult,
  type InitResult,
  type PresentAs,
  type RenderLane,
  type RenderParams,
  type RenderResult,
  type RenderedImage,
  type SetSourceResult,
  type TraceParams,
  type TraceResult,
  type WorkerCapabilityReport,
  type WorkerErrorCode,
  type WorkerKernel,
} from "./protocol";

export {
  RenderQueue,
  type QueueJob,
  type QueueListener,
  type QueueOutcome,
  type QueueState,
} from "./queue";

export {
  isFullExtent,
  previewExtent,
  resampleLinearSurface,
  type Extent,
} from "./resample";
