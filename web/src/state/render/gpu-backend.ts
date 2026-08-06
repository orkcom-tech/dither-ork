/**
 * `GpuBackend` — the graph's parallel half, against the real device.
 *
 * The graph decides what runs and where the boundary crossings fall; this
 * encodes the dispatches. `graph/backend.ts` is the line between them and this
 * file is on the far side of it.
 *
 * ## One submission per node, not one per batch — and why
 *
 * The plan hands over a *batch*: a maximal run of consecutive parallel nodes,
 * meant to become one command buffer. This encodes each node separately and
 * submits per node, and that is a deliberate, stated departure.
 *
 * `BatchExecutor.run` takes one `SurfaceChain` for colour and one for the index
 * map, and a chain recycles the texture it displaces as its next write target —
 * which is exactly right for a pipeline whose intermediates nobody keeps, and
 * exactly wrong here: the graph requires **one retained output buffer per
 * node** (`GpuBatchResult.outputs`, and a missing entry is an error rather than
 * an absence), because caching every node's output is what makes editing node 7
 * reuse node 6 (F-ST-01). Sharing one chain across a batch would hand node 5's
 * cached buffer to node 6 as scratch and the cache would then hold a texture
 * whose contents had been overwritten — a wrong picture with no error anywhere.
 *
 * What the departure costs is one `queue.submit` per node instead of one per
 * run: tens of microseconds each, on the same queue, in the same order. What it
 * does **not** cost is the thing the architecture actually cares about — no
 * readback happens between two parallel nodes, so the crossing count is
 * unchanged and the boundary instrumentation still reads true.
 *
 * Closing the gap properly means a batch-wide encode that can be told "keep
 * this one", which is a change to `BatchExecutor` and `SurfaceChain` — it is
 * described in this round's report rather than done here, because both files
 * belong to another part of the tree.
 *
 * ## What this refuses
 *
 * **A node carrying a composite** — per-node opacity or blend (F-ST-03). The
 * plan marks it, and nothing implements it: compositing needs a pass that reads
 * two colour textures, and the pass model has one input colour binding. It is
 * refused with a message naming the requirement rather than silently rendered
 * at full opacity, which would be an opacity slider that does nothing.
 */

import type { Palette } from "../../types/document";
import type { ParamDescriptor } from "../../types/registry";
import type {
  ContentHash,
  FrameBuffer,
  GpuColorSurface,
  GpuIndexSurface,
} from "../../types/graph";
import type {
  GpuBackend,
  GpuBatch,
  GpuBatchResult,
  GpuNodeTiming,
  TransferResult,
} from "../../graph";
import { GraphError, paletteDigest } from "../../graph";
import type { PlannedNode } from "../../graph";
import type { EffectRegistry } from "../../registry";
import type { GpuLayer } from "../../gpu";
import {
  SurfaceChain,
  planExecution,
  prepareNodePasses,
  readColorSurface,
  readIndexSurface,
  uploadPalette,
  writeColorSurface,
  writeIndexSurface,
  type GpuPalette,
} from "../../gpu";
import { logger } from "../../lib/log";
import type { GpuEffectCache } from "./effects";
import type { RenderSurfaces } from "./surfaces";

const log = logger("gpu");

export interface GpuBackendDeps {
  readonly layer: GpuLayer;
  readonly registry: EffectRegistry;
  readonly effects: GpuEffectCache;
  readonly surfaces: RenderSurfaces;
}

export class GpuRenderBackend implements GpuBackend {
  readonly #deps: GpuBackendDeps;
  /** Parameter descriptors by effect id, so the uniform packer is not re-derived. */
  readonly #paramTypes = new Map<string, ReadonlyMap<string, ParamDescriptor>>();

  constructor(deps: GpuBackendDeps) {
    this.#deps = deps;
  }

  // --- execution --------------------------------------------------------

  async submit(batch: GpuBatch): Promise<GpuBatchResult> {
    const outputs = new Map<string, FrameBuffer>();
    const timings: GpuNodeTiming[] = [];

    for (const planned of batch.nodes) {
      const input = this.#inputOf(planned, batch, outputs);
      const started = performance.now();
      const output = await this.#runNode(planned, batch, input);
      outputs.set(planned.node.id, output);
      timings.push({
        nodeId: planned.node.id,
        ms: Math.round((performance.now() - started) * 100) / 100,
        // Wall clock around encode and submit. Not a timestamp query, and said
        // so: reporting this as a measured GPU duration would be a number that
        // looks precise and is not.
        measured: "submission",
      });
    }

    return { outputs, timings };
  }

  /** The buffer this node reads, from the batch's inputs or from a sibling. */
  #inputOf(
    planned: PlannedNode,
    batch: GpuBatch,
    produced: ReadonlyMap<string, FrameBuffer>,
  ): FrameBuffer {
    for (const input of planned.inputs) {
      if (input.port !== "in") continue;
      const origin = input.origin;
      if (origin.kind === "source") {
        if (batch.source === null) {
          throw new GraphError(
            "invariant",
            `node ${planned.node.id} reads the source but the batch carries none`,
            { nodeId: planned.node.id, batch: batch.label },
          );
        }
        return batch.source;
      }
      const buffer =
        origin.kind === "batch"
          ? produced.get(origin.nodeId)
          : batch.buffers.get(origin.nodeId);
      if (buffer === undefined) {
        throw new GraphError(
          "invariant",
          `node ${planned.node.id} reads ${origin.nodeId}, which this batch does not have`,
          { nodeId: planned.node.id, from: origin.nodeId, batch: batch.label },
        );
      }
      return buffer;
    }
    throw new GraphError(
      "invariant",
      `node ${planned.node.id} has no "in" input; every stack node reads one`,
      { nodeId: planned.node.id },
    );
  }

  async #runNode(
    planned: PlannedNode,
    batch: GpuBatch,
    input: FrameBuffer,
  ): Promise<FrameBuffer> {
    const nodeId = planned.node.id;

    if (planned.composite !== null) {
      throw new GraphError(
        "invariant",
        `node ${nodeId} asks for opacity ${planned.composite.opacity} in blend ` +
          `"${planned.composite.blend}", and per-node compositing (F-ST-03) is not implemented ` +
          `in this build. Nothing here renders it at full opacity instead.`,
        { nodeId, effect: planned.node.effect, blend: planned.composite.blend },
      );
    }

    if (input.color.residency !== "gpu") {
      throw new GraphError(
        "invariant",
        `node ${nodeId} was handed a CPU-resident input; the renderer guarantees residency before the call`,
        { nodeId },
      );
    }

    const effect = await this.#deps.effects.effectFor(planned.node.effect);
    const palette = this.#palette(batch.palette);
    const state = {
      nodeId,
      params: planned.node.params,
      paramTypes: this.#paramTypesOf(planned.node.effect),
      seed: planned.node.seed,
      // `frame / frames`. Bound parameters are already resolved by the time a
      // graph reaches here, so this is the only thing an animated shader reads.
      normalizedTime: 0,
      paletteSize: palette.count,
    };

    const inputExtent = { width: input.width, height: input.height };
    const prepared = prepareNodePasses(effect, state, inputExtent);

    const inputColor = input.color.texture;
    const inputIndex =
      input.quantization.kind === "indexed" && input.quantization.indices.residency === "gpu"
        ? input.quantization.indices.texture
        : null;

    const color = new SurfaceChain(
      this.#deps.layer.textures,
      "rgba16float",
      inputColor,
      input.width,
      input.height,
      `${nodeId}/color`,
    );
    const index = new SurfaceChain(
      this.#deps.layer.textures,
      "r32uint",
      inputIndex,
      input.width,
      input.height,
      `${nodeId}/index`,
    );

    let encoded = false;
    try {
      const plan = planExecution([prepared.unit]);
      for (const passBatch of plan.batches) {
        this.#deps.layer.executor.run(passBatch, { color, index, palette });
      }
      encoded = true;

      // Own the result. A chain that never wrote colour still reports the
      // texture it was seeded with, which belongs to the node upstream — handing
      // that to the cache would have two entries owning one texture, and the
      // second release would throw inside the pool, far from here.
      const outColor =
        color.current === inputColor
          ? this.#copyTexture(color.current, "rgba16float", color.extent, `${nodeId}/color`)
          : color.current;

      const producedIndex = index.hasContent ? index.current : null;
      const outIndex =
        producedIndex === null
          ? null
          : producedIndex === inputIndex
            ? this.#copyTexture(producedIndex, "r32uint", index.extent, `${nodeId}/index`)
            : producedIndex;

      const buffer = this.#frameBuffer(
        planned.hash,
        color.extent.width,
        color.extent.height,
        outColor,
        outIndex,
        batch.palette,
        input,
      );

      log.debug("node encoded", {
        nodeId,
        effect: planned.node.effect,
        passes: prepared.unit.passes.length,
        width: buffer.width,
        height: buffer.height,
        indexed: buffer.quantization.kind === "indexed",
      });
      return buffer;
    } finally {
      // `release()` hands back every texture the chain allocated **except** the
      // one it is currently holding, which is either the seeded input — owned
      // upstream — or this node's output, now owned by the buffer above. So on
      // the success path there is nothing further to do, and that is the whole
      // ownership rule for this function.
      color.release();
      index.release();
      if (!encoded) {
        // Encoding threw. The live textures were never handed to a buffer, so
        // the two the chains are still holding would otherwise never come back.
        this.#releaseIfOwned(color.hasContent ? color.current : null, inputColor);
        this.#releaseIfOwned(index.hasContent ? index.current : null, inputIndex);
      }
    }
  }

  /** Release a chain's live texture, unless it is the one it was seeded with. */
  #releaseIfOwned(texture: GPUTexture | null, seeded: GPUTexture | null): void {
    if (texture === null || texture === seeded) return;
    this.#deps.layer.textures.release(texture);
  }

  #frameBuffer(
    hash: ContentHash,
    width: number,
    height: number,
    color: GPUTexture,
    indexTexture: GPUTexture | null,
    palette: Palette,
    input: FrameBuffer,
  ): FrameBuffer {
    const colorSurface: GpuColorSurface = {
      residency: "gpu",
      texture: color,
      format: "rgba16float",
    };
    if (indexTexture === null) {
      return {
        width,
        height,
        color: colorSurface,
        quantization: { kind: "continuous" },
        hash,
      };
    }
    const indices: GpuIndexSurface = {
      residency: "gpu",
      texture: indexTexture,
      format: "r32uint",
    };
    return {
      width,
      height,
      color: colorSurface,
      quantization: {
        kind: "indexed",
        indices,
        // The palette the indices name. Carried from the input when it was
        // already indexed, because a node that only *reads* the index map has
        // not re-quantized against anything.
        palette: input.quantization.kind === "indexed" ? input.quantization.palette : palette,
      },
      hash,
    };
  }

  /**
   * A private copy of a texture this node does not own.
   *
   * Only reached when a node writes one half of the buffer and passes the other
   * through — an effect that rewrites the index map and leaves the colour
   * alone, say. A full-surface copy, and it is the honest cost of every node's
   * output being a separately cacheable buffer.
   */
  #copyTexture(
    source: GPUTexture,
    format: "rgba16float" | "r32uint",
    extent: { width: number; height: number },
    label: string,
  ): GPUTexture {
    const target = this.#deps.layer.textures.acquire(
      format,
      extent.width,
      extent.height,
      `${label}/kept`,
    );
    const encoder = this.#deps.layer.context.device.createCommandEncoder({
      label: `copy ${label}`,
    });
    encoder.copyTextureToTexture(
      { texture: source },
      { texture: target },
      { width: extent.width, height: extent.height, depthOrArrayLayers: 1 },
    );
    this.#deps.layer.context.device.queue.submit([encoder.finish()]);
    log.debug("surface copied to keep a pass-through half", {
      label,
      format,
      width: extent.width,
      height: extent.height,
    });
    return target;
  }

  // --- boundary ---------------------------------------------------------

  async upload(buffer: FrameBuffer): Promise<TransferResult> {
    if (buffer.color.residency !== "cpu") {
      throw new GraphError("invariant", "upload was given a buffer that is already on the GPU");
    }
    const texture = this.#deps.layer.textures.acquire(
      "rgba16float",
      buffer.width,
      buffer.height,
      "upload/color",
    );
    const crossing = writeColorSurface(
      this.#deps.layer.context,
      texture,
      buffer.color,
      buffer.width,
      buffer.height,
      "upload",
    );
    let bytes = crossing.bytes;

    const color: GpuColorSurface = { residency: "gpu", texture, format: "rgba16float" };
    if (buffer.quantization.kind !== "indexed") {
      return {
        buffer: {
          width: buffer.width,
          height: buffer.height,
          color,
          quantization: { kind: "continuous" },
          hash: buffer.hash,
        },
        bytes,
      };
    }

    const indices = buffer.quantization.indices;
    if (indices.residency !== "cpu") {
      throw new GraphError(
        "invariant",
        "a buffer with CPU colour and a GPU index map reached upload; the two halves are meant to travel together",
      );
    }
    const indexTexture = this.#deps.layer.textures.acquire(
      "r32uint",
      buffer.width,
      buffer.height,
      "upload/index",
    );
    bytes += writeIndexSurface(
      this.#deps.layer.context,
      indexTexture,
      indices.data,
      buffer.width,
      buffer.height,
      "upload",
    ).bytes;

    return {
      buffer: {
        width: buffer.width,
        height: buffer.height,
        color,
        quantization: {
          kind: "indexed",
          indices: { residency: "gpu", texture: indexTexture, format: "r32uint" },
          palette: buffer.quantization.palette,
        },
        hash: buffer.hash,
      },
      bytes,
    };
  }

  async readback(buffer: FrameBuffer): Promise<TransferResult> {
    if (buffer.color.residency !== "gpu") {
      throw new GraphError("invariant", "readback was given a buffer that is already on the CPU");
    }
    const color = await readColorSurface(
      this.#deps.layer.context,
      this.#deps.layer.staging,
      buffer.color.texture,
      buffer.width,
      buffer.height,
      "readback",
    );
    let bytes = color.crossing.bytes;

    if (buffer.quantization.kind !== "indexed") {
      return {
        buffer: {
          width: buffer.width,
          height: buffer.height,
          color: color.surface,
          quantization: { kind: "continuous" },
          hash: buffer.hash,
        },
        bytes,
      };
    }

    const indices = buffer.quantization.indices;
    if (indices.residency !== "gpu") {
      throw new GraphError(
        "invariant",
        "a buffer with GPU colour and a CPU index map reached readback; the two halves are meant to travel together",
      );
    }
    const read = await readIndexSurface(
      this.#deps.layer.context,
      this.#deps.layer.staging,
      indices.texture,
      buffer.width,
      buffer.height,
      "readback",
    );
    bytes += read.crossing.bytes;

    return {
      buffer: {
        width: buffer.width,
        height: buffer.height,
        color: color.surface,
        quantization: {
          kind: "indexed",
          indices: { residency: "cpu", data: read.indices },
          palette: buffer.quantization.palette,
        },
        hash: buffer.hash,
      },
      bytes,
    };
  }

  // --- helpers ----------------------------------------------------------

  /**
   * The palette on the GPU, keyed by its digest.
   *
   * The digest rather than the id: two palettes named "extracted" with
   * different colours are different palettes, and `BufferCache` keys on the
   * string it is given — an id would hand the second one the first one's bytes.
   */
  #palette(palette: Palette): GpuPalette {
    return uploadPalette(
      this.#deps.layer.context,
      palette,
      this.#deps.layer.buffers,
      paletteDigest(palette),
    );
  }

  #paramTypesOf(effectId: string): ReadonlyMap<string, ParamDescriptor> {
    const cached = this.#paramTypes.get(effectId);
    if (cached !== undefined) return cached;
    const descriptor = this.#deps.registry.require(effectId);
    const types = new Map<string, ParamDescriptor>();
    for (const param of descriptor.params) types.set(param.key, param);
    this.#paramTypes.set(effectId, types);
    return types;
  }
}
