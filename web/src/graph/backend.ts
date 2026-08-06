/**
 * What the graph requires from the layers below it.
 *
 * The graph decides *what* runs, *in what order*, *what is cached* and *where
 * the GPU/CPU crossings fall*. It computes no pixels. These interfaces are the
 * line: `web/src/gpu` implements {@link GpuBackend}, the WASM bridge implements
 * {@link WasmBackend}, and neither is referenced from here by anything but its
 * type — so the scheduler can be reasoned about, and tested, without a device.
 *
 * Two things are deliberately on this side of the line rather than in the
 * graph.
 *
 * **Blending.** Per-node opacity and blend (F-ST-03) is pixel arithmetic, and
 * pixel arithmetic exists once per execution kind or the preview and the export
 * stop matching. The graph decides *whether* a composite happens and against
 * what; the backend does it, inside the same submission or the same kernel
 * call, so a composite costs no extra boundary crossing.
 *
 * **The crossings themselves.** `upload` and `readback` are WebGPU's
 * `writeTexture`/`copyTextureToBuffer` plus a map, which is the GPU layer's
 * business end to end. The graph times each call and logs it, because the cost
 * of those two functions is the performance ceiling of the whole application
 * and it has to be readable from the console.
 */

import type { Palette } from "../types/document";
import type { Extent } from "../types/gpu";
import type { FrameBuffer, RenderQuality } from "../types/graph";
import type { PlannedNode } from "./plan";

/** Fields every backend call needs about the render it belongs to. */
export interface RenderContext {
  /**
   * The extent this unit **reads** — the shape of the buffer arriving on its
   * `in` port.
   *
   * Not the render's working resolution, and the difference is not academic:
   * F-PP-01 runs the middle of the stack at a fraction of the ends, so from the
   * first resampling node onwards these two numbers diverge and a backend that
   * used the working resolution would allocate and dispatch at the wrong shape.
   * Where a unit's own passes resize further is the pass's business — see
   * `PassExtent` in `types/gpu.ts` — and the buffer it returns states the shape
   * it actually produced.
   */
  readonly width: number;
  readonly height: number;
  /**
   * The render's working resolution: the extent the decoded source enters at.
   *
   * Carried separately because it is still a real number a backend may need —
   * an adaptive-quality decision, a memory readout — and because leaving only
   * one pair of dimensions in this record is what made the confusion above
   * possible in the first place.
   */
  readonly working: Extent;
  readonly quality: RenderQuality;
  /** Frame index, already used to resolve bound parameters. */
  readonly frame: number;
  /**
   * The document palette. Passed alongside the graph because `RenderGraph`
   * carries none, and a quantizing node needs one before there is an index map
   * to read it from. A per-node override (F-CO-07) arrives as a parameter.
   */
  readonly palette: Palette;
}

/**
 * A maximal run of consecutive parallel nodes, to be encoded into one command
 * buffer and sent with one `queue.submit`.
 *
 * Coalescing is the point: the batch boundary, not the pass count, is what
 * costs. Passes inside a batch still run in order — WebGPU orders compute
 * passes within a command buffer — so a `neighbourhood` or `global` pass sees
 * everything written before it.
 */
export interface GpuBatch extends RenderContext {
  /** Stable enough to put in a `GPUCommandEncoder` label. */
  readonly label: string;
  /** In execution order. An input marked `batch` is produced by an earlier entry here. */
  readonly nodes: readonly PlannedNode[];
  /** Buffers produced outside this batch, by node id. Guaranteed GPU-resident. */
  readonly buffers: ReadonlyMap<string, FrameBuffer>;
  /** The decoded source, GPU-resident. `null` when no node in this batch reads it. */
  readonly source: FrameBuffer | null;
}

/**
 * How a node's duration was measured.
 *
 * Stated rather than assumed. Timestamp queries are an optional WebGPU feature;
 * where they are unavailable the honest number is the wall clock around the
 * whole submission, attributed to each node in it. Logging that as though it
 * were a per-pass measurement would turn a coalesced batch of eight nodes into
 * eight readings that each look like the total.
 */
export interface GpuNodeTiming {
  readonly nodeId: string;
  readonly ms: number;
  readonly measured: "timestamp" | "submission";
}

export interface GpuBatchResult {
  /** One output per node in the batch, GPU-resident. A missing entry is an error, not an absence. */
  readonly outputs: ReadonlyMap<string, FrameBuffer>;
  /** One timing per node in the batch. */
  readonly timings: readonly GpuNodeTiming[];
}

/** One GPU/CPU transfer and what it actually moved. */
export interface TransferResult {
  readonly buffer: FrameBuffer;
  /**
   * Bytes copied. Reported by the backend rather than inferred by the graph
   * because colour and index map can sit on different sides of the boundary,
   * so only the layer doing the copy knows how much of the buffer had to move.
   */
  readonly bytes: number;
}

export interface GpuBackend {
  /** Encode every pass of every node and submit once. */
  submit(batch: GpuBatch): Promise<GpuBatchResult>;
  /** Copy a CPU-resident buffer — colour and index map both — onto the GPU. */
  upload(buffer: FrameBuffer): Promise<TransferResult>;
  /** Copy a GPU-resident buffer back into WASM memory. */
  readback(buffer: FrameBuffer): Promise<TransferResult>;
}

/**
 * One serial kernel.
 *
 * Never batched with anything. Error diffusion is inherently serial — each
 * pixel depends on error propagated from pixels already processed — which is
 * the constraint the entire renderer is shaped around.
 */
export interface WasmNodeRequest extends RenderContext {
  readonly node: PlannedNode;
  /** Buffers the node reads, by node id. Guaranteed CPU-resident. */
  readonly buffers: ReadonlyMap<string, FrameBuffer>;
  /** The decoded source, CPU-resident. `null` when this node does not read it. */
  readonly source: FrameBuffer | null;
}

export interface WasmBackend {
  run(request: WasmNodeRequest): Promise<FrameBuffer>;
}
