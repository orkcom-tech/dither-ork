/**
 * The render worker.
 *
 * This is the thread docs/ARCHITECTURE.md has always described and the
 * application did not have: **the render loop does not run on the main thread.**
 * The GPU device, the WASM core, the effect registry, the node cache and the
 * `DocumentRenderer` all live here. The main thread keeps the UI, the input, the
 * panel state and the undo stack, and talks to this through
 * `worker/protocol.ts`.
 *
 * What actually moved, and why each mattered:
 *
 * - **The graph execution.** A long stack at a large resolution used to block
 *   the main thread for its whole duration, and a diffusion node blocked it for
 *   its entire serial pass. A frozen interface is what makes a person conclude
 *   the application is broken.
 * - **The presentation pass.** The frame is encoded to sRGB and painted into an
 *   `OffscreenCanvas` here; what crosses back is an `ImageBitmap`, transferred
 *   rather than copied, which the viewport draws with one `drawImage`. The
 *   main thread used to pay a full-frame `putImageData` per frame.
 * - **The SVG trace.** One synchronous WASM call with no cancellation point
 *   inside it, seconds long on a large image. It cannot be made interruptible —
 *   that is a fact about `trace.rs` and is stated rather than papered over — but
 *   it no longer freezes the window while it runs.
 *
 * ## Two things stay on the main thread, deliberately
 *
 * The **viewport's canvas** is not transferred. It is not a render target: it is
 * a compositor for a frame, a checkerboard, a reference image and a split
 * divider, driven directly by pointer events, and moving it here would put every
 * pan and zoom through a message queue to remove a `drawImage` that costs
 * nothing. `OffscreenCanvas` earns its place at the frame boundary, above, where
 * it removes real per-frame main-thread work.
 *
 * The **image decode** also stays there, because the palette editor's extraction
 * and the before/after reference both read the decoded surface. The source is
 * therefore copied in once per image open — `set-source` measures and logs that
 * copy — rather than transferred, which would leave the main thread without the
 * pixels two of its own features need.
 */

import { GpuLayer } from "../gpu";
import { correlationId, logger } from "../lib/log";
import { loadEffectRegistry, loadGpuEffects } from "../registry";
import {
  DocumentRenderer,
  loadDitherCore,
  type CoreGifAnimation,
  type DitherCore,
} from "../state/render";
import type { CapabilityReport } from "../lib/capabilities";
import {
  RenderAbandoned,
  serialiseError,
  sourceBytes,
  type CallMessage,
  type CallResult,
  type GifAbandonParams,
  type GifBeginParams,
  type GifBeginResult,
  type GifFinishParams,
  type GifFinishResult,
  type GifFrameParams,
  type GifFrameResult,
  type InitResult,
  type RenderParams,
  type RenderResult,
  type SetSourceParams,
  type SetSourceResult,
  type TraceParams,
  type TraceResult,
  type WorkerCallKind,
  type WorkerCapabilityReport,
  type WorkerInbound,
} from "./protocol";
import { RenderQueue } from "./queue";

const log = logger("graph", correlationId());

/**
 * The three things this file needs of its global scope.
 *
 * Written out rather than reached for via `DedicatedWorkerGlobalScope`, which
 * lives in TypeScript's `WebWorker` lib: adding that lib to `tsconfig.json`
 * would put it in scope for the whole package alongside `DOM`, and the two
 * declare overlapping globals with different types. A four-line interface at
 * the one file that is a worker is cheaper than a compiler configuration every
 * other file has to live with.
 */
interface RenderWorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerInbound>) => void,
  ): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: "unhandledrejection",
    listener: (event: PromiseRejectionEvent) => void,
  ): void;
}

const scope = self as unknown as RenderWorkerScope;

interface Live {
  readonly layer: GpuLayer;
  readonly core: DitherCore;
  readonly renderer: DocumentRenderer;
}

let live: Live | null = null;
let disposed = false;

const queue = new RenderQueue((lane, outcome, state) => {
  log.debug("queue", {
    lane,
    outcome,
    running: state.running ?? -1,
    pendingPreview: state.pendingPreview ?? -1,
    pendingExports: state.pendingExports.length,
  });
});

function requireLive(what: string): Live {
  if (live === null) {
    throw new Error(`the render worker was asked to ${what} before init() completed`);
  }
  return live;
}

// --- the calls ----------------------------------------------------------

async function init(report: WorkerCapabilityReport): Promise<InitResult> {
  if (live !== null) throw new Error("the render worker is already initialised");
  const started = performance.now();

  const layer = await GpuLayer.create({
    // The report crosses without its `GPUAdapterInfo`, which is not
    // structured-cloneable. `acquireGpuContext` reads only the verdict and
    // requests its own adapter, so nothing is lost.
    report: report as CapabilityReport,
    label: "dither-ork/render-worker",
    onDeviceLost: (info) => {
      // Not recoverable and not silent: every subsequent render throws from
      // `assertUsable`, and this is the line that says why.
      log.error("the GPU device was lost", { reason: info.reason, message: info.message });
    },
  });
  const core = await loadDitherCore();
  // Discovered here rather than sent across: an `EffectDescriptor` carries pass
  // builders and validators, which are functions and cannot be cloned. The glob
  // is the same one the main thread runs, over the same modules, and the
  // catalogue is validated on both sides — a build whose catalogue is wrong
  // fails in both places rather than in the one nobody is watching.
  const registry = loadEffectRegistry();
  const resolver = loadGpuEffects();

  live = {
    layer,
    core,
    renderer: new DocumentRenderer({ registry, resolver, layer, core }),
  };

  const info = layer.context.adapterInfo;
  const result: InitResult = {
    coreVersion: core.version,
    kernels: core.kernels.map((kernel) => ({ id: kernel.id, name: kernel.name })),
    maxTextureDimension2D: layer.context.limits.maxTextureDimension2D,
    adapter: {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    },
    ms: Math.round((performance.now() - started) * 100) / 100,
  };
  log.info("render worker ready", {
    core: result.coreVersion,
    effects: registry.size,
    maxTexture: result.maxTextureDimension2D,
    ms: result.ms,
  });
  return result;
}

function setSource(params: SetSourceParams): SetSourceResult {
  const started = performance.now();
  const { renderer } = requireLive("set a source");
  renderer.setSource(params.source);
  const bytes = params.source === null ? 0 : sourceBytes(params.source);
  const ms = Math.round((performance.now() - started) * 100) / 100;
  // The one large copy on the main thread's account, so it is measured like
  // every GPU/CPU crossing already is. It is per image open, not per frame.
  log.info("source received", {
    bytes,
    mb: Math.round((bytes / 1_048_576) * 10) / 10,
    ...(params.source === null
      ? {}
      : { width: params.source.width, height: params.source.height }),
    ms,
  });
  return { bytes, ms };
}

function render(id: number, params: RenderParams): Promise<RenderResult> {
  const { renderer } = requireLive("render");
  return queue.submit<RenderResult>({
    id,
    lane: params.lane,
    run: async (signal) => {
      const frame = await renderer.render(params.document, {
        solo: params.solo,
        quality: params.quality,
        factor: params.factor,
        present: params.present,
        signal,
      });
      return {
        image: frame.image,
        width: frame.width,
        height: frame.height,
        documentWidth: frame.documentWidth,
        documentHeight: frame.documentHeight,
        quality: frame.quality,
        correlationId: frame.correlationId,
        stats: frame.stats,
        diagnostics: frame.diagnostics,
        totalMs: frame.totalMs,
        presentMs: frame.presentMs,
        transferBytes: frame.transferBytes,
      };
    },
  });
}

/**
 * One SVG trace (F-EX-08) — task 2.
 *
 * Outside the render queue on purpose. It touches neither the device nor the
 * node cache, so it has nothing to serialise against; putting it in the queue
 * would only make an export's trace wait behind a preview it cannot conflict
 * with. What it does do is occupy this thread for its whole duration, because
 * the call into `trace.rs` is synchronous with no cancellation point inside it.
 * That is a fact about the tracer and is stated rather than hidden — the
 * difference this change makes is that the thread it occupies is no longer the
 * one drawing the interface.
 */
function trace(params: TraceParams): TraceResult {
  const { core } = requireLive("trace");
  const started = performance.now();
  const traced = core.traceSvg(
    params.indices,
    params.width,
    params.height,
    params.paletteRgb,
    params.settings,
  );
  const ms = Math.round((performance.now() - started) * 100) / 100;
  log.info("index map traced", {
    width: params.width,
    height: params.height,
    entries: params.paletteRgb.length / 3,
    mode: params.settings.mode,
    layers: traced.report.layers,
    points: traced.report.points,
    chars: traced.svg.length,
    ms,
  });
  return { svg: traced.svg, report: traced.report, ms };
}

// --- animated GIF (F-EX-04) ---------------------------------------------

/**
 * The GIF encoders in flight, by handle.
 *
 * Outside the render queue, like `trace`, and for the same reason: LZW touches
 * neither the device nor the node cache, so it has nothing to serialise against.
 * Unlike `trace` it is not one long call — the work is spread across one message
 * per frame, and each one is short, so an export's GIF encode interleaves with
 * preview renders instead of blocking them.
 *
 * A map rather than a single slot because nothing here may assume there is only
 * one: two dialogs, or an estimate running beside an export, are ordinary.
 */
const gifs = new Map<number, CoreGifAnimation>();
let nextGifHandle = 1;

function gifBegin(params: GifBeginParams): GifBeginResult {
  const { core } = requireLive("start a GIF");
  const handle = nextGifHandle;
  nextGifHandle += 1;
  gifs.set(handle, core.gifAnimation(params.width, params.height));
  log.info("gif animation started", {
    handle,
    width: params.width,
    height: params.height,
  });
  return { handle };
}

function requireGif(handle: number, what: string): CoreGifAnimation {
  const animation = gifs.get(handle);
  if (animation === undefined) {
    // Named rather than ignored: a handle the worker does not have means the
    // caller finished or abandoned it already, and silently accepting the frame
    // would produce a file missing frames nobody could account for.
    throw new Error(
      `the render worker has no GIF animation ${handle}, so it cannot ${what}; it was ` +
        `finished, abandoned, or never started`,
    );
  }
  return animation;
}

function gifFrame(params: GifFrameParams): GifFrameResult {
  const animation = requireGif(params.handle, "take a frame");
  animation.push(params.indices);
  return animation.state();
}

function gifFinish(params: GifFinishParams): GifFinishResult {
  const animation = requireGif(params.handle, "be finished");
  const started = performance.now();
  try {
    const encoded = animation.finish(
      params.paletteRgb,
      params.delayCentiseconds,
      params.loopForever,
      params.transparentIndex,
    );
    const ms = Math.round((performance.now() - started) * 100) / 100;
    log.info("gif encoded", {
      handle: params.handle,
      frames: encoded.frames,
      bytes: encoded.byteLength,
      paletteEntries: encoded.paletteEntries,
      tableEntries: encoded.tableEntries,
      minCodeSize: encoded.minCodeSize,
      croppedFrames: encoded.croppedFrames,
      ms,
    });
    return { ...encoded, ms };
  } finally {
    // `finish` frees the handle whether it succeeded or threw, so the entry goes
    // either way; leaving it would let a retry reach a freed handle.
    gifs.delete(params.handle);
  }
}

function gifAbandon(params: GifAbandonParams): null {
  const animation = gifs.get(params.handle);
  if (animation === undefined) return null;
  animation.abandon();
  gifs.delete(params.handle);
  log.info("gif animation abandoned", { handle: params.handle });
  return null;
}

function dispose(): null {
  if (disposed) return null;
  disposed = true;
  queue.clear("the render worker is shutting down");
  // Any GIF still being built holds WASM linear memory for its whole index
  // buffer. A dialog closed mid-encode is the ordinary way to get here.
  for (const animation of gifs.values()) animation.abandon();
  gifs.clear();
  live?.renderer.dispose();
  live?.layer.destroy();
  live = null;
  log.info("render worker disposed");
  return null;
}

// --- dispatch -----------------------------------------------------------

/** What of a reply is transferred rather than copied. */
function transferables(kind: WorkerCallKind, value: unknown): Transferable[] {
  if (kind === "render") {
    const result = value as RenderResult;
    if (result.image.kind === "bitmap") return [result.image.bitmap];
    // The frame's samples leave this thread rather than being duplicated on it.
    return [result.image.data.buffer as ArrayBuffer];
  }
  if (kind === "gif-finish") {
    // A finished GIF is the whole file. `bytes` is already a copy out of WASM
    // memory, so transferring it costs nothing here and saves a structured
    // clone of several megabytes on the way over.
    return [(value as GifFinishResult).bytes.buffer as ArrayBuffer];
  }
  return [];
}

async function run(message: CallMessage): Promise<CallResult<WorkerCallKind>> {
  switch (message.kind) {
    case "init":
      return init(message.params as WorkerCapabilityReport);
    case "set-source":
      return setSource(message.params as SetSourceParams);
    case "render":
      return render(message.id, message.params as RenderParams);
    case "trace":
      return trace(message.params as TraceParams);
    case "gif-begin":
      return gifBegin(message.params as GifBeginParams);
    case "gif-frame":
      return gifFrame(message.params as GifFrameParams);
    case "gif-finish":
      return gifFinish(message.params as GifFinishParams);
    case "gif-abandon":
      return gifAbandon(message.params as GifAbandonParams);
    case "dispose":
      return dispose();
  }
}

scope.addEventListener("message", (event: MessageEvent<WorkerInbound>) => {
  const message = event.data;
  if (message.channel === "cancel") {
    const found = queue.cancel(message.target);
    // A cancel for something that already finished is ordinary — the main
    // thread does not know when a render lands — but it is worth seeing.
    log.debug("cancel", { target: message.target, found });
    return;
  }

  void run(message).then(
    (value) => {
      scope.postMessage(
        { channel: "result", id: message.id, value },
        transferables(message.kind, value),
      );
    },
    (error: unknown) => {
      // Abandonment is an ordinary outcome and is not logged as a failure; a
      // real failure is, with everything the far side cannot see.
      if (error instanceof RenderAbandoned) {
        log.debug("call abandoned", { id: message.id, kind: message.kind, why: error.message });
      } else {
        log.error("call failed", {
          id: message.id,
          kind: message.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      scope.postMessage({ channel: "error", id: message.id, error: serialiseError(error) }, []);
    },
  );
});

// Nothing in here may die quietly: a worker that throws at the top level
// otherwise disappears and the main thread waits for a reply that will never
// come. These two are the last resort behind every `try` in the file.
scope.addEventListener("error", (event: ErrorEvent) => {
  log.error("uncaught error in the render worker", {
    message: event.message,
    file: event.filename,
    line: event.lineno,
  });
});
scope.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  log.error("unhandled rejection in the render worker", { reason: String(event.reason) });
});

log.info("render worker loaded");
