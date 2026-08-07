/**
 * Document to picture.
 *
 * A `.dork` in, a frame the viewport can draw out, with the existing graph doing
 * the scheduling, the existing cache doing the reuse, and the existing GPU and
 * WASM layers doing the pixels. It adds no rendering of its own — every line
 * here is wiring, and that is the point.
 *
 * ## F-ST-01, and why it needs nothing here
 *
 * "Re-render begins at the earliest changed position" is not implemented in
 * this file, and it would be a mistake to implement it here. `prepareGraph`
 * hashes every node over its parameters, seed, resolution and its inputs'
 * hashes; `planRender` then walks *backwards* from the output and stops at
 * every node the cache already holds. Editing node 7 leaves nodes 1-6 with
 * unchanged hashes, so the walk stops immediately and only node 7 onwards runs.
 * All this file has to do is keep one cache alive across renders.
 *
 * ## This runs in a worker
 *
 * The whole of it — device, core, cache and this class — lives in
 * `web/src/worker/render.worker.ts`. Nothing on the main thread constructs a
 * `DocumentRenderer`, and the two former callers (the session pump and export)
 * now reach it through the worker's `RenderQueue`, which is where cancellation
 * and the preview/export priority live.
 *
 * **It is still not re-entrant, and it now says so.** One node cache, one
 * surface pool, one GPU backend: two overlapping renders would interleave pins
 * and evictions and produce a wrong picture rather than a slow one. The guard
 * below turns that from a convention documented in a comment into a throw, so a
 * future caller that bypasses the queue fails at the first frame instead of at
 * the hundredth.
 *
 * ## F-UI-03 is real here
 *
 * `factor` is honoured. Below 1 the **source is resampled to the reduced
 * extent** (`worker/resample.ts`) and the entire graph runs there, so the frame
 * that comes back is genuinely smaller and the viewport's badge describes
 * something that happened. The graph itself needed nothing: `graph.width` and
 * `graph.height` are already in every content hash, so a preview and a full
 * render key to different cache entries by construction and neither can be
 * served the other's pixels.
 */

import type { DitherDocument } from "../../types/document";
import type { ContentHash, FrameBuffer, RenderQuality } from "../../types/graph";
import type { EffectRegistry, GpuEffectResolver } from "../../registry";
import type { GpuLayer } from "../../gpu";
import { readColorSurface } from "../../gpu";
import {
  NodeCache,
  hashBytes,
  renderGraph,
  type RenderDiagnostics,
  type RenderStats,
} from "../../graph";
import { srgbBytesFromLinearSurface, sourceFrameBuffer, type SourceImage } from "../../io";
import { correlationId, logger } from "../../lib/log";
import type { PresentAs, RenderedImage } from "../../worker/protocol";
import {
  isFullExtent,
  previewExtent,
  resampleLinearSurface,
  type Extent,
} from "../../worker/resample";
import { buildRenderGraph } from "./graph";
import { GpuEffectCache } from "./effects";
import { GpuRenderBackend } from "./gpu-backend";
import { RenderSurfaces } from "./surfaces";
import { WasmRenderBackend } from "./wasm-backend";
import type { DitherCore } from "./core";

const log = logger("graph");

/** What a render produced. */
export interface RenderedFrame {
  readonly image: RenderedImage;
  /** The extent the graph ran at — below the document's when degraded. */
  readonly width: number;
  readonly height: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly quality: RenderQuality;
  readonly correlationId: string;
  /** Absent when the stack was empty and the source itself is on screen. */
  readonly stats: RenderStats | null;
  readonly diagnostics: RenderDiagnostics | null;
  /** Milliseconds from the call to the finished frame. */
  readonly totalMs: number;
  /** Of which, presenting: the readback, the sRGB encode and the bitmap. */
  readonly presentMs: number;
  /** Bytes of pixel data the frame carries out of the worker. */
  readonly transferBytes: number;
}

export interface RendererOptions {
  readonly registry: EffectRegistry;
  readonly resolver: GpuEffectResolver;
  readonly layer: GpuLayer;
  readonly core: DitherCore;
}

export interface RenderOptions {
  /** Render up to and including this node (F-ST-02). */
  readonly solo?: string | null;
  /** Declared by the viewport; carried into the graph and onto the frame. */
  readonly quality?: RenderQuality;
  /** Fraction of document resolution to render at, in (0, 1] — F-UI-03. */
  readonly factor?: number;
  /** How the frame comes back: a bitmap for the screen, bytes for a file. */
  readonly present?: PresentAs;
  /** Abandon the render. See `graph/render.ts`, `RenderDeps.signal`. */
  readonly signal?: AbortSignal;
}

/**
 * Cache budget for one source.
 *
 * Sized from the image rather than fixed, because the thing being bounded is a
 * multiple of one working surface: colour at `rgba16float` plus an index map at
 * `r32uint` is twelve bytes a pixel. Eight surfaces is a stack of a few nodes
 * with their intermediates kept for the next edit, which is what F-ST-01 is
 * asking for. The floor keeps a small image from getting a budget too tight to
 * hold its own pinned front; the ceiling keeps a large one from asking a laptop
 * GPU for more than it has.
 *
 * A preview render's intermediates share this budget, and they are small — at a
 * factor of 0.5 a whole preview stack costs a quarter of one full-resolution
 * surface — so the two coexist rather than evicting each other.
 */
export function cacheBudgetFor(width: number, height: number): number {
  const surface = width * height * 12;
  return Math.min(Math.max(surface * 8, 96 * 1024 * 1024), 768 * 1024 * 1024);
}

/** The label bytes a preview source's hash is derived from. */
const UTF8 = new TextEncoder();

/**
 * A preview source's identity.
 *
 * Derived from the full source's hash and the extent rather than digested from
 * the resampled pixels: the resample is a pure function of those two things
 * (`worker/resample.ts` reads no clock and no randomness), so hashing megabytes
 * of floats would buy nothing a label cannot state. It must be *distinct* from
 * the full source's hash, or the graph would serve a full-resolution cache
 * entry to a preview render and the frame would come back the wrong size.
 */
function previewSourceHash(base: ContentHash, extent: Extent): ContentHash {
  return hashBytes(`preview-source:${extent.width}x${extent.height}`, UTF8.encode(base));
}

export class DocumentRenderer {
  readonly #registry: EffectRegistry;
  readonly #layer: GpuLayer;
  readonly #surfaces: RenderSurfaces;
  readonly #gpu: GpuRenderBackend;
  readonly #wasm: WasmRenderBackend;

  #source: SourceImage | null = null;
  #cpuSource: FrameBuffer | null = null;
  /**
   * The source resampled for the preview extent currently in use, and nothing
   * else. One at a time: the viewport raises a factor once per interaction
   * rather than per pointer move, so a second entry would be a cache of one
   * extent nobody is asking for any more.
   */
  #previewSource: { readonly extent: Extent; readonly buffer: FrameBuffer } | null = null;
  /**
   * Sources already uploaded, keyed by the CPU buffer's hash, so an unchanged
   * image is not re-uploaded per frame. Two entries at most — the document
   * extent and the preview extent.
   */
  readonly #uploads = new Map<ContentHash, FrameBuffer>();
  #cache: NodeCache | null = null;
  /** Non-null while a render is running. See the re-entrancy note above. */
  #inFlight: string | null = null;
  /** Reused per output size; `transferToImageBitmap` leaves it usable. */
  readonly #presentCanvases = new Map<string, OffscreenCanvas>();

  constructor(options: RendererOptions) {
    this.#registry = options.registry;
    this.#layer = options.layer;
    this.#surfaces = new RenderSurfaces(options.layer.textures);
    this.#gpu = new GpuRenderBackend({
      layer: options.layer,
      registry: options.registry,
      effects: new GpuEffectCache({
        registry: options.registry,
        resolver: options.resolver,
        compiler: options.layer.compiler,
        ranks: options.core,
      }),
      surfaces: this.#surfaces,
    });
    this.#wasm = new WasmRenderBackend(options.core);
  }

  get source(): SourceImage | null {
    return this.#source;
  }

  /**
   * Point the renderer at an image.
   *
   * Everything cached is dropped: every entry was hashed against the previous
   * source and at the previous resolution, so none of it can be hit again, and
   * holding it would keep a full set of textures at the old size alive against
   * the budget.
   */
  setSource(image: SourceImage | null): void {
    this.#dropSource();
    this.#source = image;
    if (image === null) return;

    this.#cpuSource = sourceFrameBuffer(image);
    this.#cache = new NodeCache({
      budget: { maxBytes: cacheBudgetFor(image.width, image.height) },
      surfaces: this.#surfaces,
      log: logger("graph"),
    });
    log.info("renderer source set", {
      name: image.name,
      width: image.width,
      height: image.height,
      budgetMb: Math.round(cacheBudgetFor(image.width, image.height) / 1_048_576),
    });
  }

  /**
   * Render one frame.
   *
   * Throws on a document the renderer cannot honour — an unimplemented
   * composite, a modulator binding, an effect the catalogue does not have. The
   * caller states it; nothing here renders an approximation of the document it
   * was given. Throws the abort reason when the render is abandoned, which the
   * queue tells apart from a failure.
   */
  async render(
    document: DitherDocument,
    options: RenderOptions = {},
  ): Promise<RenderedFrame> {
    const source = this.#source;
    const cpuSource = this.#cpuSource;
    if (source === null || cpuSource === null) {
      throw new Error("render was called with no source image open");
    }

    const cid = correlationId();
    if (this.#inFlight !== null) {
      // Not a queue and not a wait: one node cache, one surface pool and one GPU
      // backend cannot serve two renders, and a second entrant would interleave
      // pins with the first one's evictions. The queue in `worker/queue.ts` is
      // the only correct caller, and this is what says so out loud.
      throw new Error(
        `DocumentRenderer is not re-entrant: render ${cid} was started while ${this.#inFlight} was still running. Renders go through the worker's RenderQueue.`,
      );
    }
    this.#inFlight = cid;
    try {
      return await this.#renderOnce(document, options, source, cid);
    } finally {
      this.#inFlight = null;
    }
  }

  /** Release the GPU-side source copies and the cache. Not the GPU layer. */
  dispose(): void {
    this.#dropSource();
    this.#presentCanvases.clear();
  }

  // --- internals --------------------------------------------------------

  async #renderOnce(
    document: DitherDocument,
    options: RenderOptions,
    source: SourceImage,
    cid: string,
  ): Promise<RenderedFrame> {
    const startedAt = performance.now();
    const quality: RenderQuality = options.quality ?? "full";
    const extent = previewExtent(source.width, source.height, options.factor ?? 1);

    // Two checks around the resample, which is the one piece of real work that
    // happens before the graph and therefore before `renderGraph`'s own checks.
    // A render superseded while it waited its turn must not pay for a source it
    // will never use.
    throwIfAbandoned(options.signal);
    const cpu = this.#sourceAt(extent, source);
    throwIfAbandoned(options.signal);

    const graph = buildRenderGraph(document, {
      width: extent.width,
      height: extent.height,
      quality,
      frame: 0,
      solo: options.solo ?? null,
    });

    if (graph === null) {
      // No nodes: the picture is the image. Not a special rendering path — it
      // is the absence of one.
      const presented = await this.#present(cpu, cid, options.present ?? "bytes");
      const totalMs = round(performance.now() - startedAt);
      log.info("render complete (no nodes)", {
        cid,
        ms: totalMs,
        width: extent.width,
        height: extent.height,
        quality,
      });
      return {
        image: presented.image,
        width: cpu.width,
        height: cpu.height,
        documentWidth: source.width,
        documentHeight: source.height,
        quality,
        correlationId: cid,
        stats: null,
        diagnostics: null,
        totalMs,
        presentMs: presented.ms,
        transferBytes: presented.bytes,
      };
    }

    const cache = this.#cache;
    if (cache === null) throw new Error("the renderer has a source but no cache");

    const outcome = await renderGraph(
      {
        graph,
        source: await this.#residentSource(document, cpu),
        palette: document.palette,
        // Every node's output is kept: that is precisely what makes editing
        // node 7 reuse node 6 on the next keystroke.
        retain: { kind: "all" },
      },
      {
        gpu: this.#gpu,
        wasm: this.#wasm,
        cache,
        surfaces: this.#surfaces,
        effects: this.#effectMap(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        correlationId: cid,
      },
    );

    const presented = await this.#present(outcome.buffer, cid, options.present ?? "bytes");
    const totalMs = round(performance.now() - startedAt);
    log.info("frame ready", {
      cid,
      ms: totalMs,
      renderMs: outcome.stats.ms,
      presentMs: presented.ms,
      nodes: outcome.stats.nodesExecuted,
      cacheHits: outcome.stats.cacheHits,
      boundaryBytes: outcome.stats.boundaryBytes,
      width: outcome.buffer.width,
      height: outcome.buffer.height,
      quality,
    });

    return {
      image: presented.image,
      width: outcome.buffer.width,
      height: outcome.buffer.height,
      documentWidth: source.width,
      documentHeight: source.height,
      quality,
      correlationId: cid,
      stats: outcome.stats,
      diagnostics: outcome.diagnostics,
      totalMs,
      presentMs: presented.ms,
      transferBytes: presented.bytes,
    };
  }

  #dropSource(): void {
    this.#cache?.clear();
    this.#cache = null;
    for (const buffer of this.#uploads.values()) this.#surfaces.release(buffer);
    this.#uploads.clear();
    this.#previewSource = null;
    this.#cpuSource = null;
    this.#source = null;
  }

  /**
   * The CPU-resident source at `extent`, resampled if that is below the
   * document's own size.
   *
   * Held across renders, because during a drag the factor is constant — the
   * viewport raises one at the start of an interaction and one when it ends —
   * so this resamples once per interaction and not once per frame. When the
   * extent does change, the previous preview's GPU upload goes with it, or it
   * would sit in the texture pool for an extent nothing will ask for again.
   */
  #sourceAt(extent: Extent, source: SourceImage): FrameBuffer {
    const full = this.#cpuSource;
    if (full === null) throw new Error("no source buffer");
    if (isFullExtent(extent, source.width, source.height)) return full;

    const held = this.#previewSource;
    if (held !== null && held.extent.width === extent.width && held.extent.height === extent.height) {
      return held.buffer;
    }
    if (held !== null) this.#releaseUpload(held.buffer.hash);

    const started = performance.now();
    const surface = resampleLinearSurface(
      source.surface,
      { width: source.width, height: source.height },
      extent,
    );
    const buffer: FrameBuffer = {
      width: extent.width,
      height: extent.height,
      color: surface,
      quantization: { kind: "continuous" },
      hash: previewSourceHash(source.hash, extent),
    };
    this.#previewSource = { extent, buffer };
    log.info("preview source resampled", {
      from: `${source.width}x${source.height}`,
      to: `${extent.width}x${extent.height}`,
      factor: Math.round((extent.width / source.width) * 1000) / 1000,
      ms: round(performance.now() - started),
    });
    return buffer;
  }

  /**
   * The source in the residency the first node will want.
   *
   * The graph will move it either way and log the crossing, but an upload of
   * the whole image on every keystroke is a cost worth not paying: a stack that
   * starts with a parallel node gets the copy that was uploaded once, and one
   * that starts with a diffusion kernel gets the planar `f32` the decode
   * already produced.
   */
  async #residentSource(document: DitherDocument, cpu: FrameBuffer): Promise<FrameBuffer> {
    const first = document.stack.find((node) => node.enabled);
    if (first === undefined) return cpu;
    if (this.#registry.get(first.effect)?.execution !== "gpu") return cpu;

    const existing = this.#uploads.get(cpu.hash);
    if (existing !== undefined) return existing;

    const uploaded = await this.#gpu.upload(cpu);
    this.#uploads.set(cpu.hash, uploaded.buffer);
    log.info("source uploaded", {
      bytes: uploaded.bytes,
      width: cpu.width,
      height: cpu.height,
    });
    return uploaded.buffer;
  }

  #releaseUpload(hash: ContentHash): void {
    const buffer = this.#uploads.get(hash);
    if (buffer === undefined) return;
    this.#uploads.delete(hash);
    this.#surfaces.release(buffer);
  }

  #effectMap(): ReadonlyMap<string, ReturnType<EffectRegistry["require"]>> {
    const map = new Map<string, ReturnType<EffectRegistry["require"]>>();
    for (const descriptor of this.#registry.all()) map.set(descriptor.id, descriptor);
    return map;
  }

  /**
   * The rendered buffer as something that can leave the worker.
   *
   * Two shapes, because the two consumers want different things and converting
   * between them on the far side would cost a copy on the thread this whole
   * change exists to keep free:
   *
   * - **`bitmap`** for the screen. The sRGB bytes are painted into an
   *   `OffscreenCanvas` here and `transferToImageBitmap` hands over a
   *   *transferable* — so the main thread's viewport draws it with one
   *   `drawImage` and never touches a pixel. Before this, the main thread paid a
   *   full-frame `putImageData` per frame; that pass is now on this side.
   * - **`bytes`** for export, which needs the actual samples to encode.
   *
   * The GPU readback is still paid when the frame is GPU-resident — a canvas 2D
   * context cannot draw a WebGPU texture — but it is paid here rather than on
   * the main thread, which is the point.
   */
  async #present(
    buffer: FrameBuffer,
    cid: string,
    present: PresentAs,
  ): Promise<{ readonly image: RenderedImage; readonly ms: number; readonly bytes: number }> {
    const started = performance.now();
    const data =
      buffer.color.residency === "cpu"
        ? srgbBytesFromLinearSurface(buffer.color, buffer.width, buffer.height)
        : srgbBytesFromLinearSurface(
            (
              await readColorSurface(
                this.#layer.context,
                this.#layer.staging,
                buffer.color.texture,
                buffer.width,
                buffer.height,
                `present:${cid}`,
              )
            ).surface,
            buffer.width,
            buffer.height,
          );

    if (present === "bytes") {
      return {
        image: { kind: "bytes", data },
        ms: round(performance.now() - started),
        bytes: data.byteLength,
      };
    }

    const bitmap = this.#toBitmap(data, buffer.width, buffer.height);
    return {
      image: { kind: "bitmap", bitmap },
      ms: round(performance.now() - started),
      // What the reply actually moves. An ImageBitmap is transferred rather than
      // copied, so this is the size of the handover, not of a duplicate.
      bytes: buffer.width * buffer.height * 4,
    };
  }

  #toBitmap(
    data: Uint8ClampedArray<ArrayBuffer>,
    width: number,
    height: number,
  ): ImageBitmap {
    const key = `${width}x${height}`;
    let canvas = this.#presentCanvases.get(key);
    if (canvas === undefined) {
      canvas = new OffscreenCanvas(width, height);
      // One per extent, and there are at most two live at a time (document and
      // preview). Kept rather than recreated because allocating a canvas per
      // frame during a drag is an allocation per frame nobody needs.
      this.#presentCanvases.set(key, canvas);
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      // Loud, not degraded: without this the worker has no way to hand a frame
      // over that does not cost the main thread a full-frame decode.
      throw new Error("the render worker could not acquire an OffscreenCanvas 2D context");
    }
    ctx.putImageData(new ImageData(data, width, height), 0, 0);
    return canvas.transferToImageBitmap();
  }
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/**
 * Stop if the render has been abandoned.
 *
 * Throws the abort *reason*, the same way `graph/render.ts` does, because the
 * reason is what tells a supersession from a cancellation and inventing a new
 * error here would throw that away.
 */
function throwIfAbandoned(signal: AbortSignal | undefined): void {
  if (signal === undefined || !signal.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error("the render was abandoned");
}
