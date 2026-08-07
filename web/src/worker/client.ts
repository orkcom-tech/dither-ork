/**
 * The render worker, seen from the main thread.
 *
 * **This is the interface everything that wants a picture uses.** Animation,
 * Surprise Me, batch and animated export all build on it, so it is written as a
 * service rather than as a private detail of the session: `render()` for a
 * frame, `trace()` for an SVG, and both go through the worker's queue, which is
 * where cancellation and the preview-versus-export priority live.
 *
 * ```ts
 * const service = await RenderService.create({ report });
 * await service.setSource(image);
 *
 * // The screen. Superseded by the next preview; cheap to call per pointer move.
 * const frame = await service.render({
 *   document, solo: null, quality: "preview", factor: 0.5,
 *   lane: "preview", present: "bitmap",
 * });
 *
 * // A file. Preempts a running preview, never superseded, full resolution.
 * const exported = await service.render({
 *   document, solo: null, quality: "full", factor: 1,
 *   lane: "export", present: "bytes",
 * });
 * ```
 *
 * ## What a caller has to handle
 *
 * `render()` rejects with {@link RenderAbandoned} when a newer preview replaced
 * this one or somebody cancelled it. That is an ordinary outcome of an
 * interactive editor and is **not** an error to show anybody — `isAbandoned`
 * below is the test. Everything else that rejects is a real failure: a document
 * the renderer refuses, a lost device, a stack the catalogue cannot honour.
 *
 * A preview preempted by an export does *not* reject. The queue re-runs it, so
 * the promise still settles with a frame.
 *
 * ## Ownership of what comes back
 *
 * A `bitmap` frame is an `ImageBitmap` that was **transferred** out of the
 * worker. Whoever receives it owns it: hand it to the viewport, which closes it
 * when it is replaced (`viewport/frame.ts`, "Ownership"), or close it. Dropping
 * one on the floor leaks GPU memory that nothing in the JS heap accounts for.
 */

import type { CapabilityReport } from "../lib/capabilities";
import { correlationId, logger } from "../lib/log";
import type { SourceImage } from "../io";
import {
  RenderAbandoned,
  reviveError,
  sourceBytes,
  type CallParams,
  type CallResult,
  type GifBeginParams,
  type GifFinishParams,
  type GifFinishResult,
  type GifFrameParams,
  type GifFrameResult,
  type InitResult,
  type RenderParams,
  type RenderResult,
  type TraceParams,
  type TraceResult,
  type WorkerCallKind,
  type WorkerCapabilityReport,
  type WorkerOutbound,
} from "./protocol";

const log = logger("graph");

/** Whether a rejection means "a newer render replaced this one", not a failure. */
export function isAbandoned(error: unknown): error is RenderAbandoned {
  return error instanceof RenderAbandoned;
}

export interface RenderServiceOptions {
  readonly report: CapabilityReport;
}

interface Pending {
  readonly kind: WorkerCallKind;
  readonly resolve: (value: never) => void;
  readonly reject: (error: unknown) => void;
  readonly startedAt: number;
}

export class RenderService {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #info: InitResult | null = null;
  #disposed = false;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.addEventListener("message", (event: MessageEvent<WorkerOutbound>) => {
      this.#settle(event.data);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      // A worker that fails to load leaves every call unanswered, so this both
      // reports and fails them — a spinner that never stops is the worst
      // possible symptom for the one thread that draws the picture.
      const message = event.message === "" ? "the render worker failed to start" : event.message;
      log.error("render worker error", { message, file: event.filename, line: event.lineno });
      this.#failAll(new Error(`render worker error: ${message}`));
    });
    worker.addEventListener("messageerror", (event: MessageEvent) => {
      log.error("a message to the render worker could not be deserialised", {
        data: String(event.data),
      });
    });
  }

  /**
   * Start the worker and bring its device and core up.
   *
   * Rejects if either fails, and the caller treats that exactly as it treated a
   * failed device before: the startup failure screen. The capability gate has
   * already passed, so a device that will not come up now is a real error and
   * not a supported state.
   */
  static async create(options: RenderServiceOptions): Promise<RenderService> {
    const cid = correlationId();
    const started = performance.now();
    const worker = new Worker(new URL("./render.worker.ts", import.meta.url), {
      type: "module",
      name: "dither-ork-render",
    });
    const service = new RenderService(worker);

    // Only the verdict crosses: `GPUAdapterInfo` is a platform object and
    // posting one throws `DataCloneError`.
    const report: WorkerCapabilityReport = {
      capabilities: options.report.capabilities,
      fatalFailures: options.report.fatalFailures,
      usable: options.report.usable,
    };

    try {
      service.#info = await service.#call("init", report);
    } catch (error) {
      worker.terminate();
      throw error;
    }
    log.info("render service ready", {
      cid,
      core: service.#info.coreVersion,
      adapter: service.#info.adapter.vendor,
      workerMs: service.#info.ms,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });
    return service;
  }

  /** What the worker's device and core turned out to be. */
  get info(): InitResult {
    if (this.#info === null) throw new Error("the render service is not initialised");
    return this.#info;
  }

  /**
   * Point the worker at an image, or at nothing.
   *
   * The pixel planes are **copied**, not transferred: the main thread keeps its
   * own decoded surface because the before/after reference (F-UI-04) and palette
   * extraction (F-CO-02) both read it. This is the one large copy in the design
   * and it happens once per image open rather than once per frame; the byte
   * count and the duration are logged on both sides so it is measurable rather
   * than assumed.
   */
  async setSource(image: SourceImage | null): Promise<void> {
    const bytes = image === null ? 0 : sourceBytes(image);
    const started = performance.now();
    const result = await this.#call("set-source", { source: image });
    log.info("source handed to the render worker", {
      bytes,
      mb: Math.round((bytes / 1_048_576) * 10) / 10,
      workerMs: result.ms,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });
  }

  /**
   * Render one frame.
   *
   * Returns the call id alongside the frame so a caller that wants to cancel one
   * explicitly can — the ordinary preview path does not need to, because a newer
   * preview supersedes the one in flight on its own.
   */
  render(params: RenderParams): Promise<RenderResult> {
    return this.#call("render", params);
  }

  /**
   * Same, but hands back the id first so it can be cancelled while it runs.
   *
   * Used by export, whose cancel button has to stop the render as well as the
   * encode — F-EX-13 asks for a cancel that stops the worker rather than one
   * that stops reporting.
   */
  renderCancellable(params: RenderParams): {
    readonly id: number;
    readonly frame: Promise<RenderResult>;
  } {
    const id = this.#claimId();
    return { id, frame: this.#dispatch(id, "render", params) };
  }

  /** Abandon a call by id. A cancel for something already finished is harmless. */
  cancel(id: number): void {
    if (this.#disposed) return;
    this.#worker.postMessage({ channel: "cancel", target: id });
  }

  /** Trace an index map to SVG (F-EX-08) — off this thread. */
  async trace(params: TraceParams): Promise<TraceResult> {
    const started = performance.now();
    const result = await this.#call("trace", params);
    log.info("trace returned from the render worker", {
      chars: result.svg.length,
      layers: result.report.layers,
      workerMs: result.ms,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });
    return result;
  }

  /**
   * Start an animated GIF (F-EX-04). The handle is fed by {@link gifFrame} and
   * consumed by exactly one of {@link gifFinish} or {@link gifAbandon}.
   */
  async gifBegin(params: GifBeginParams): Promise<number> {
    const result = await this.#call("gif-begin", params);
    return result.handle;
  }

  /**
   * Add one frame's index map.
   *
   * The array is **copied** rather than transferred. `replicateIndices` returns
   * its input unchanged at scale 1, so the buffer handed here can be one the
   * palette builder still owns, and detaching it would leave the encoder reading
   * a zero-length array on the next frame. One clone of `width * height` bytes
   * per frame is the price of not having to reason about that at every caller.
   */
  gifFrame(params: GifFrameParams): Promise<GifFrameResult> {
    return this.#call("gif-frame", params);
  }

  /** Write the file and release the worker-side handle. */
  async gifFinish(params: GifFinishParams): Promise<GifFinishResult> {
    const started = performance.now();
    const result = await this.#call("gif-finish", params);
    log.info("gif returned from the render worker", {
      frames: result.frames,
      bytes: result.byteLength,
      tableEntries: result.tableEntries,
      workerMs: result.ms,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });
    return result;
  }

  /**
   * Throw away a GIF that will not be finished.
   *
   * Never rejects for a handle the worker no longer has, because the only
   * correct place to call it is a `finally` that also runs after a successful
   * finish — and a cleanup path that can throw is a cleanup path that hides the
   * error it was cleaning up after.
   */
  async gifAbandon(handle: number): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.#call("gif-abandon", { handle });
    } catch (error) {
      log.warn("a GIF animation could not be abandoned", { handle, error: String(error) });
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      await this.#call("dispose", null);
    } catch (error) {
      // Reported, never swallowed: the device is going away either way, and the
      // terminate below is unconditional.
      log.warn("the render worker did not shut down cleanly", { error: String(error) });
    }
    this.#worker.terminate();
    this.#failAll(new Error("the render service was disposed"));
    log.info("render service disposed");
  }

  // --- plumbing ---------------------------------------------------------

  #claimId(): number {
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }

  #call<K extends WorkerCallKind>(kind: K, params: CallParams<K>): Promise<CallResult<K>> {
    return this.#dispatch(this.#claimId(), kind, params);
  }

  #dispatch<K extends WorkerCallKind>(
    id: number,
    kind: K,
    params: CallParams<K>,
  ): Promise<CallResult<K>> {
    if (this.#disposed && kind !== "dispose") {
      return Promise.reject(new Error(`the render service is disposed; ${kind} was refused`));
    }
    return new Promise<CallResult<K>>((resolve, reject) => {
      this.#pending.set(id, {
        kind,
        resolve: resolve as (value: never) => void,
        reject,
        startedAt: performance.now(),
      });
      this.#worker.postMessage({ channel: "call", id, kind, params });
    });
  }

  #settle(message: WorkerOutbound): void {
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      // Cannot happen through this class — ids are minted here and deleted
      // exactly once — so if it does, something else is posting to this worker.
      log.error("a reply arrived for a call nobody is waiting on", { id: message.id });
      return;
    }
    this.#pending.delete(message.id);

    if (message.channel === "error") {
      pending.reject(reviveError(message.error));
      return;
    }
    if (pending.kind === "render") {
      const result = message.value as RenderResult;
      log.debug("frame received", {
        id: message.id,
        width: result.width,
        height: result.height,
        quality: result.quality,
        cid: result.correlationId,
        // The worker-boundary cost, in the same shape the GPU/CPU boundary
        // already logs: what moved, and how long it took to get here.
        transferBytes: result.transferBytes,
        workerMs: result.totalMs,
        presentMs: result.presentMs,
        ms: Math.round((performance.now() - pending.startedAt) * 100) / 100,
      });
    }
    (pending.resolve as (value: unknown) => void)(message.value);
  }

  #failAll(error: Error): void {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}
