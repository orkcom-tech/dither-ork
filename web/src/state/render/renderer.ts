/**
 * Document to picture.
 *
 * This is the seam the whole round was for: a `.dork` in, an `ImageData` the
 * viewport can draw out, with the existing graph doing the scheduling, the
 * existing cache doing the reuse, and the existing GPU and WASM layers doing
 * the pixels. It adds no rendering of its own — every line here is wiring, and
 * that is the point.
 *
 * ## F-ST-01, and why it needs nothing here
 *
 * "Re-render begins at the earliest changed position" is not implemented in
 * this file, and it would be a mistake to implement it here. `prepareGraph`
 * hashes every node over its parameters, seed, resolution and its inputs'
 * hashes; `planRender` then walks *backwards* from the output and stops at
 * every node the cache already holds. Editing node 7 leaves nodes 1-6 with
 * unchanged hashes, so the walk stops immediately and only node 7 onwards runs.
 * All this file has to do is keep one cache alive across renders — which is
 * exactly what the alternative implementation of the requirement would have got
 * wrong, by rebuilding the cache each time and then re-deriving what changed.
 *
 * ## The main thread
 *
 * **The render loop runs on the main thread, and that is a departure from
 * docs/ARCHITECTURE.md**, which puts it in a worker behind `OffscreenCanvas`
 * and Comlink. What that would take is written out in this round's report; the
 * short version is that Comlink is not a dependency of this project, the
 * viewport owns a main-thread 2D canvas rather than a transferred
 * `OffscreenCanvas`, and the WASM and WebGPU acquisition both happen in the
 * boot path on this side. Doing half of it — a worker that still renders here —
 * would be a worker in name only, so it is not pretended at.
 *
 * The consequence is real and should be stated in the UI rather than
 * discovered: a long stack at a large resolution blocks the main thread for the
 * duration of the render, and a diffusion node blocks it for its whole serial
 * pass.
 */

import type { DitherDocument } from "../../types/document";
import type { FrameBuffer, RenderQuality } from "../../types/graph";
import type { EffectRegistry, GpuEffectResolver } from "../../registry";
import type { GpuLayer } from "../../gpu";
import { readColorSurface } from "../../gpu";
import {
  NodeCache,
  renderGraph,
  type RenderDiagnostics,
  type RenderStats,
} from "../../graph";
import { srgbBytesFromLinearSurface, sourceFrameBuffer, type SourceImage } from "../../io";
import { correlationId, logger } from "../../lib/log";
import { buildRenderGraph } from "./graph";
import { GpuEffectCache } from "./effects";
import { GpuRenderBackend } from "./gpu-backend";
import { RenderSurfaces } from "./surfaces";
import { WasmRenderBackend } from "./wasm-backend";
import type { DitherCore } from "./core";

const log = logger("graph");

/** What a render produced, ready for `Viewport.setFrame`. */
export interface RenderedFrame {
  readonly image: ImageData;
  readonly width: number;
  readonly height: number;
  readonly quality: RenderQuality;
  readonly correlationId: string;
  /** Absent when the stack was empty and the source itself is on screen. */
  readonly stats: RenderStats | null;
  readonly diagnostics: RenderDiagnostics | null;
  /** Milliseconds from the call to the finished `ImageData`. */
  readonly totalMs: number;
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
 */
export function cacheBudgetFor(width: number, height: number): number {
  const surface = width * height * 12;
  return Math.min(Math.max(surface * 8, 96 * 1024 * 1024), 768 * 1024 * 1024);
}

export class DocumentRenderer {
  readonly #registry: EffectRegistry;
  readonly #layer: GpuLayer;
  readonly #surfaces: RenderSurfaces;
  readonly #gpu: GpuRenderBackend;
  readonly #wasm: WasmRenderBackend;

  #source: SourceImage | null = null;
  #cpuSource: FrameBuffer | null = null;
  /** The source uploaded once, so an unchanged image is not re-uploaded per frame. */
  #gpuSource: FrameBuffer | null = null;
  #cache: NodeCache | null = null;

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
   * was given.
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
    const startedAt = performance.now();

    const graph = buildRenderGraph(document, {
      width: source.width,
      height: source.height,
      // One quality, always the document's own resolution. Adaptive preview
      // resolution (F-UI-03) is not wired: the graph would need a resampled
      // source buffer per factor, and a half-resolution frame labelled `full`
      // is worse than a slow one. The viewport's badge reports what it is given.
      quality: "full",
      frame: 0,
      solo: options.solo ?? null,
    });

    if (graph === null) {
      // No nodes: the picture is the image. Not a special rendering path — it
      // is the absence of one.
      const image = this.#imageFrom(cpuSource, source.width, source.height);
      const totalMs = round(performance.now() - startedAt);
      log.info("render complete (no nodes)", { cid, ms: totalMs });
      return {
        image,
        width: source.width,
        height: source.height,
        quality: "full",
        correlationId: cid,
        stats: null,
        diagnostics: null,
        totalMs,
      };
    }

    const cache = this.#cache;
    if (cache === null) throw new Error("the renderer has a source but no cache");

    const outcome = await renderGraph(
      {
        graph,
        source: await this.#sourceFor(document),
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
        correlationId: cid,
      },
    );

    const image = await this.#present(outcome.buffer, cid);
    const totalMs = round(performance.now() - startedAt);
    log.info("frame ready", {
      cid,
      ms: totalMs,
      renderMs: outcome.stats.ms,
      nodes: outcome.stats.nodesExecuted,
      cacheHits: outcome.stats.cacheHits,
      boundaryBytes: outcome.stats.boundaryBytes,
    });

    return {
      image,
      width: outcome.buffer.width,
      height: outcome.buffer.height,
      quality: "full",
      correlationId: cid,
      stats: outcome.stats,
      diagnostics: outcome.diagnostics,
      totalMs,
    };
  }

  /** Release the GPU-side source copy and the cache. Not the GPU layer. */
  dispose(): void {
    this.#dropSource();
  }

  // --- internals --------------------------------------------------------

  #dropSource(): void {
    this.#cache?.clear();
    this.#cache = null;
    if (this.#gpuSource !== null) {
      this.#surfaces.release(this.#gpuSource);
      this.#gpuSource = null;
    }
    this.#cpuSource = null;
    this.#source = null;
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
  async #sourceFor(document: DitherDocument): Promise<FrameBuffer> {
    const cpu = this.#cpuSource;
    if (cpu === null) throw new Error("no source buffer");

    const first = document.stack.find((node) => node.enabled);
    if (first === undefined) return cpu;
    if (this.#registry.get(first.effect)?.execution !== "gpu") return cpu;

    if (this.#gpuSource === null) {
      const uploaded = await this.#gpu.upload(cpu);
      this.#gpuSource = uploaded.buffer;
      log.info("source uploaded", { bytes: uploaded.bytes });
    }
    return this.#gpuSource;
  }

  #effectMap(): ReadonlyMap<string, ReturnType<EffectRegistry["require"]>> {
    const map = new Map<string, ReturnType<EffectRegistry["require"]>>();
    for (const descriptor of this.#registry.all()) map.set(descriptor.id, descriptor);
    return map;
  }

  /** The rendered buffer as 8-bit sRGB for the screen. */
  async #present(buffer: FrameBuffer, cid: string): Promise<ImageData> {
    if (buffer.color.residency === "cpu") {
      return this.#imageFrom(buffer, buffer.width, buffer.height);
    }
    // The one readback the preview always pays: a 2D canvas cannot draw a
    // WebGPU texture, and the viewport owns a 2D canvas. Presenting through a
    // WebGPU canvas context would remove it, and is the other half of the
    // worker note at the top of this file.
    const read = await readColorSurface(
      this.#layer.context,
      this.#layer.staging,
      buffer.color.texture,
      buffer.width,
      buffer.height,
      `present:${cid}`,
    );
    return new ImageData(
      srgbBytesFromLinearSurface(read.surface, buffer.width, buffer.height),
      buffer.width,
      buffer.height,
    );
  }

  #imageFrom(buffer: FrameBuffer, width: number, height: number): ImageData {
    if (buffer.color.residency !== "cpu") {
      throw new Error("imageFrom was given a GPU buffer");
    }
    return new ImageData(
      srgbBytesFromLinearSurface(buffer.color, width, height),
      width,
      height,
    );
  }
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
