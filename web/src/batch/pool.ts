/**
 * The batch worker pool.
 *
 * docs/ARCHITECTURE.md asks for one, and this is it — built out of the worker
 * infrastructure that already exists rather than out of a second mechanism.
 * Each member of the pool is a whole {@link RenderService}: its own thread, its
 * own `GPUDevice`, its own WASM core, its own effect registry and its own node
 * cache. That is not extravagance, it is forced:
 *
 * - **`DocumentRenderer` holds exactly one source** (`set-source` in
 *   `worker/protocol.ts`) and is not re-entrant. Two images cannot be in flight
 *   on one worker, whatever the queue does.
 * - **The editor's worker is not borrowed.** Pointing it at a batch image would
 *   replace the source under the preview, the before/after reference and every
 *   cached node in the editor's own graph, and putting it back afterwards would
 *   be an invisible reload of the user's picture. A batch is long-running work
 *   that must not disturb the editor, so it runs somewhere else entirely.
 *
 * The pool is created when a run starts and disposed when it ends. Bringing a
 * device and a core up costs a few hundred milliseconds per member, which is
 * why the size is clamped to the number of images: a batch of one does not pay
 * for four.
 *
 * ## The lease
 *
 * `render` waits for a free member, points it at the image, runs the document
 * on the **export lane** — never superseded, never preempted, full resolution,
 * samples rather than a bitmap — and frees the member in a `finally`, including
 * on the failure and cancellation paths. A member that is never freed is a
 * batch that stops halfway with no error anywhere, which is the failure this
 * shape exists to make impossible.
 *
 * `trace` takes a lease too. The SVG trace does not touch the device or the
 * cache, but it is a synchronous call into `trace.rs` that occupies whichever
 * thread it lands on, and a trace running on a member that is also rendering
 * would stall that render for its whole duration.
 */

import type { VectorTracer, TracedDocument } from "../export";
import type { CapabilityReport } from "../lib/capabilities";
import { logger } from "../lib/log";
import { RenderService } from "../worker";
import type {
  BatchRenderPool,
  BatchRenderRequest,
  BatchRenderedFrame,
} from "./types";
import { MAX_BATCH_WORKERS, MIN_BATCH_WORKERS } from "./types";

const log = logger("batch");

export interface BatchPoolOptions {
  readonly report: CapabilityReport;
  /** How many members to bring up. Clamped to the legal range. */
  readonly size: number;
}

/** The size a pool will actually be, given a request and a queue length. */
export function poolSizeFor(requested: number, items: number): number {
  const wanted = Number.isFinite(requested) ? Math.trunc(requested) : MIN_BATCH_WORKERS;
  const bounded = Math.max(MIN_BATCH_WORKERS, Math.min(MAX_BATCH_WORKERS, wanted));
  // A fifth device for a queue of three is three hundred milliseconds of
  // startup spent on nothing.
  return Math.max(MIN_BATCH_WORKERS, Math.min(bounded, Math.max(1, items)));
}

interface Waiter {
  readonly resolve: (service: RenderService) => void;
  /**
   * Settled on dispose.
   *
   * Without it, a pool torn down while somebody is waiting for a member leaves
   * that promise pending forever — an item stuck on "rendering" with no error
   * anywhere, which is the exact failure mode the whole codebase refuses.
   */
  readonly reject: (error: unknown) => void;
}

class Pool implements BatchRenderPool {
  readonly #all: readonly RenderService[];
  readonly #free: RenderService[];
  readonly #waiting: Waiter[] = [];
  #disposed = false;

  constructor(services: readonly RenderService[]) {
    this.#all = services;
    this.#free = [...services];
  }

  get size(): number {
    return this.#all.length;
  }

  readonly tracer: VectorTracer = {
    trace: async (indices, width, height, paletteRgb, settings): Promise<TracedDocument> => {
      const service = await this.#acquire();
      try {
        const traced = await service.trace({ indices, width, height, paletteRgb, settings });
        return { svg: traced.svg, report: traced.report };
      } finally {
        this.#release(service);
      }
    },
  };

  async render(request: BatchRenderRequest): Promise<BatchRenderedFrame> {
    const service = await this.#acquire();
    try {
      // The source is replaced per item. The copy is the one large cost of a
      // batch item and it is logged by `RenderService.setSource` on both sides,
      // the same way an image open is.
      await service.setSource(request.image);

      const { id, frame } = service.renderCancellable({
        document: request.document,
        // A batch renders the whole stack. Solo is a property of what the editor
        // is showing, and a file produced from a half-run stack because a node
        // happened to be soloed is a surprise nobody asked for.
        solo: null,
        quality: "full",
        factor: 1,
        lane: "export",
        present: "bytes",
      });

      const stop = (): void => service.cancel(id);
      request.signal.addEventListener("abort", stop, { once: true });
      try {
        const result = await frame;
        const image = result.image;
        if (image.kind !== "bytes") {
          throw new Error("a batch render came back as a bitmap; batch encodes samples");
        }
        log.debug("batch frame rendered", {
          name: request.image.name,
          width: result.width,
          height: result.height,
          cid: result.correlationId,
          workerMs: result.totalMs,
        });
        return { width: result.width, height: result.height, data: image.data };
      } finally {
        request.signal.removeEventListener("abort", stop);
      }
    } finally {
      this.#release(service);
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    // Anything still waiting for a member will never get one, so it is failed
    // rather than left pending.
    while (this.#waiting.length > 0) {
      this.#waiting
        .shift()
        ?.reject(new Error("the batch pool was disposed while this render was waiting"));
    }
    this.#free.length = 0;
    await Promise.all(this.#all.map((service) => service.dispose()));
    log.info("batch pool disposed", { workers: this.#all.length });
  }

  #acquire(): Promise<RenderService> {
    if (this.#disposed) {
      return Promise.reject(new Error("the batch pool is disposed; no worker can be leased"));
    }
    const free = this.#free.pop();
    if (free !== undefined) return Promise.resolve(free);
    return new Promise<RenderService>((resolve, reject) => {
      this.#waiting.push({ resolve, reject });
    });
  }

  #release(service: RenderService): void {
    if (this.#disposed) return;
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) {
      waiter.resolve(service);
      return;
    }
    this.#free.push(service);
  }
}

/**
 * Bring a pool up.
 *
 * The members are created concurrently — each requests its own adapter, and
 * doing it one at a time would make a four-member pool four sequential device
 * acquisitions. If any member fails, the ones that succeeded are disposed
 * before the failure is rethrown; leaving three devices alive behind a rejected
 * promise is a leak with no owner.
 */
export async function createBatchRenderPool(
  options: BatchPoolOptions,
): Promise<BatchRenderPool> {
  const size = Math.max(MIN_BATCH_WORKERS, Math.min(MAX_BATCH_WORKERS, options.size));
  const started = performance.now();

  const settled = await Promise.allSettled(
    Array.from({ length: size }, () => RenderService.create({ report: options.report })),
  );

  const services: RenderService[] = [];
  let failure: unknown = null;
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") services.push(outcome.value);
    else failure ??= outcome.reason;
  }

  if (failure !== null) {
    log.error("a batch worker would not start", {
      wanted: size,
      started: services.length,
      error: String(failure),
    });
    await Promise.all(services.map((service) => service.dispose()));
    throw failure instanceof Error ? failure : new Error(String(failure));
  }

  log.info("batch pool ready", {
    workers: services.length,
    core: services[0]?.info.coreVersion ?? "",
    ms: Math.round((performance.now() - started) * 100) / 100,
  });
  return new Pool(services);
}
