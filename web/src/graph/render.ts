/**
 * Executing a plan.
 *
 * The plan says what runs and in what shape. This runs it, and does the three
 * things the plan cannot do statically.
 *
 * **Reconciles residency.** A buffer restored from the cache can be on either
 * side of the GPU/CPU boundary, so where a crossing actually falls is not
 * knowable until the render is under way. Every crossing is timed and logged
 * with its transfer size and attributed to the node that forced it. The known
 * performance trap has to be readable from the console rather than found with a
 * profiler, and these are the lines that make it so.
 *
 * **Keeps live buffers alive.** Everything produced goes into the cache, and
 * the cache is under a byte budget with LRU eviction, so without a pin a long
 * stack at export resolution would evict a buffer that a later node in the same
 * render is about to read. Each buffer is pinned when produced and unpinned
 * after its last consumer, computed from the plan.
 *
 * **Logs every node.** Id, effect, execution kind, cache hit or miss,
 * dimensions, duration, and the bytes moved across the boundary on its account.
 */

import type { Palette } from "../types/document";
import type {
  ContentHash,
  FrameBuffer,
  NodeExecution,
  RenderGraph,
} from "../types/graph";
import type { EffectDescriptor } from "../types/registry";
import type { BoundaryCrossing, Extent } from "../types/gpu";
import type { Logger } from "../lib/log";
import { logger } from "../lib/log";
import type { GpuBackend, TransferResult, WasmBackend } from "./backend";
import type { InputOrigin, PlanStep, PlannedNode, PreparedGraph, RenderPlan } from "./plan";
import { planRender, prepareGraph, stepNodes } from "./plan";
import type { NodeAssets } from "./assets";
import type { NodeCache, SurfaceOwner } from "./cache";
import { GraphError, expect } from "./errors";

/**
 * Which produced buffers earn a non-transient place in the cache.
 *
 * `all` is the preview policy: caching every node's output is precisely what
 * makes editing node 7 reuse node 6 (F-ST-01), and an interactive session asks
 * for those buffers again within the second.
 *
 * `only` is the export policy. An animated export produces a full set of
 * intermediates per frame and asks for none of them a second time; what it does
 * ask for again is the frame-invariant prefix, on every one of the remaining
 * N-1 frames. Naming those keeps the per-frame churn from pushing them out of
 * the budget.
 */
export type RetainPolicy =
  | { readonly kind: "all" }
  | { readonly kind: "only"; readonly hashes: ReadonlySet<ContentHash> };

export interface RenderDeps {
  readonly gpu: GpuBackend;
  readonly wasm: WasmBackend;
  readonly cache: NodeCache;
  readonly surfaces: SurfaceOwner;
  readonly effects: ReadonlyMap<string, EffectDescriptor>;
  /**
   * Bulk data the document carries per node — F-PP-07's uploaded threshold
   * image. Absent when nothing in the stack takes one, which is every document
   * the catalogue can express today.
   */
  readonly assets?: NodeAssets;
  /** Ties this render's log lines together; carried on every error too. */
  readonly correlationId: string;
}

export interface PreparedRenderRequest {
  readonly prepared: PreparedGraph;
  /** Must be the buffer the graph was prepared against; checked, not assumed. */
  readonly source: FrameBuffer;
  readonly retain: RetainPolicy;
}

export interface RenderRequest {
  readonly graph: RenderGraph;
  readonly source: FrameBuffer;
  readonly palette: Palette;
  readonly retain: RetainPolicy;
}

/** Matches the `RenderStats` contract in docs/API.md section 4. */
export interface RenderStats {
  readonly frame: number;
  readonly ms: number;
  readonly nodesExecuted: number;
  readonly cacheHits: number;
  /** Bytes moved across the GPU/CPU boundary — the known perf ceiling. */
  readonly boundaryBytes: number;
}

export interface RenderDiagnostics {
  readonly gpuBatches: number;
  readonly boundaryCrossings: number;
  readonly projectedCrossings: number;
  readonly passthroughNodes: number;
  readonly cacheBytes: number;
  readonly cacheEntries: number;
}

export interface RenderOutcome {
  /**
   * The rendered frame.
   *
   * Owned by the cache, not by the caller: present it or copy it before the
   * next render, which may evict it under budget pressure. Releasing it is a
   * double free.
   */
  readonly buffer: FrameBuffer;
  readonly stats: RenderStats;
  readonly diagnostics: RenderDiagnostics;
  readonly plan: RenderPlan;
}

type Residency = "gpu" | "cpu";

/** The key the source buffer is filed under; no node id can collide with it. */
const SOURCE_KEY = "@source";

function isResident(buffer: FrameBuffer, side: Residency): boolean {
  if (buffer.color.residency !== side) return false;
  // The index map can lag the colour across the boundary; a node reading one
  // needs both on its own side. See the note on `FrameBuffer`.
  if (buffer.quantization.kind === "indexed" && buffer.quantization.indices.residency !== side) {
    return false;
  }
  return true;
}

/**
 * Render a graph that has already been prepared.
 *
 * Used directly by the animated path, which prepares every frame up front to
 * find which nodes never move and would only throw that away by preparing
 * again inside each frame.
 */
export async function renderPrepared(
  request: PreparedRenderRequest,
  deps: RenderDeps,
): Promise<RenderOutcome> {
  const log = logger("graph", deps.correlationId);
  const { prepared, source, retain } = request;
  const graph = prepared.graph;

  if (source.hash !== prepared.sourceHash) {
    throw new GraphError(
      "source-mismatch",
      "the source buffer is not the one this graph was prepared against; its hash roots every node hash, so rendering it would cache the wrong pixels",
      { expected: prepared.sourceHash, got: source.hash },
    );
  }

  const startedAt = performance.now();
  const plan = planRender(prepared, (hash) => deps.cache.has(hash));

  log.info("plan", {
    frame: graph.frame,
    quality: graph.quality,
    width: graph.width,
    height: graph.height,
    nodes: graph.nodes.length,
    execute: plan.executedNodes,
    reuse: plan.seeded.length,
    disabled: plan.passthrough.length,
    gpuBatches: plan.gpuBatches,
    projectedCrossings: plan.projectedCrossings,
    retain: retain.kind,
  });
  for (const nodeId of plan.passthrough) {
    log.debug("node disabled, input passes through", { nodeId });
  }

  /** nodeId -> the buffer it produced. Every entry is cache-owned and pinned. */
  const produced = new Map<string, FrameBuffer>();
  /** nodeId -> hash, for the pins this render still holds. */
  const livePins = new Map<string, ContentHash>();
  /** `${key}:${side}` -> a copy this render made and therefore owns. */
  const converted = new Map<string, FrameBuffer>();

  let boundaryBytes = 0;
  let crossings = 0;
  let nodesExecuted = 0;

  const lastUse = computeLastUse(plan);

  const releaseConverted = (key: string): void => {
    for (const side of ["gpu", "cpu"] as const) {
      const cacheKey = `${key}:${side}`;
      const copy = converted.get(cacheKey);
      if (copy === undefined) continue;
      converted.delete(cacheKey);
      deps.surfaces.release(copy);
    }
  };

  /**
   * The buffer for `key`, on `side`, crossing the boundary if it is not there
   * already and charging the transfer to the node that needed it.
   */
  const resident = async (
    key: string,
    buffer: FrameBuffer,
    side: Residency,
    consumerId: string,
    charge: Map<string, number>,
  ): Promise<FrameBuffer> => {
    if (isResident(buffer, side)) return buffer;

    const cacheKey = `${key}:${side}`;
    const existing = converted.get(cacheKey);
    // A second consumer on the same side reuses the copy. Paying for the same
    // readback twice in one render is exactly the sort of cost that never shows
    // up in a profile as a single legible line.
    if (existing !== undefined) return existing;

    const direction = side === "gpu" ? "upload" : "readback";
    const startedTransfer = performance.now();
    let result: TransferResult;
    try {
      result = side === "gpu" ? await deps.gpu.upload(buffer) : await deps.gpu.readback(buffer);
    } catch (error) {
      log.error("boundary crossing failed", {
        nodeId: consumerId,
        from: key,
        direction,
        ms: round(performance.now() - startedTransfer),
        error: String(error),
      });
      throw error;
    }
    const ms = round(performance.now() - startedTransfer);

    const crossing: BoundaryCrossing = {
      nodeId: consumerId,
      direction,
      bytes: result.bytes,
      ms,
    };
    // The line the architecture asks for by name: every GPU/CPU crossing, with
    // transfer size and duration.
    log.info("boundary crossing", { ...crossing, from: key });

    boundaryBytes += result.bytes;
    crossings += 1;
    charge.set(consumerId, (charge.get(consumerId) ?? 0) + result.bytes);
    converted.set(cacheKey, result.buffer);
    return result.buffer;
  };

  const working: Extent = { width: graph.width, height: graph.height };

  const bufferFor = (origin: InputOrigin): { key: string; buffer: FrameBuffer } => {
    if (origin.kind === "source") return { key: SOURCE_KEY, buffer: source };
    return {
      key: origin.nodeId,
      buffer: expect(
        produced.get(origin.nodeId),
        "invariant",
        `node ${origin.nodeId} was read before it was produced; the plan order is wrong`,
        { nodeId: origin.nodeId },
      ),
    };
  };

  /** Take ownership of a produced buffer: cache it, pin it, file it. */
  const adopt = (planned: PlannedNode, buffer: FrameBuffer): FrameBuffer => {
    const transient = retain.kind === "only" && !retain.hashes.has(planned.hash);
    const stored = deps.cache.offer(planned.hash, buffer, transient);
    deps.cache.pin(planned.hash);
    livePins.set(planned.node.id, planned.hash);
    produced.set(planned.node.id, stored);
    return stored;
  };

  /** Drop the pins and copies for everything whose last consumer has now run. */
  const retire = (stepIndex: number): void => {
    for (const [nodeId, hash] of [...livePins]) {
      const last = lastUse.get(nodeId);
      if (last !== undefined && last > stepIndex) continue;
      livePins.delete(nodeId);
      produced.delete(nodeId);
      deps.cache.unpin(hash);
      releaseConverted(nodeId);
    }
  };

  /**
   * The extent a unit reads: the shape of the buffer on its first node's `in`
   * port.
   *
   * Not `graph.width`/`graph.height`, which is the extent the *source* enters
   * at. The two are the same number for a stack with no resampling node in it,
   * and they stop being the same the moment F-PP-01 appears — after which
   * passing the working resolution to a backend would have it allocate and
   * dispatch at a shape nothing in the stack is carrying.
   */
  const entryExtent = (
    nodes: readonly PlannedNode[],
    source: FrameBuffer | null,
    buffers: ReadonlyMap<string, FrameBuffer>,
  ): Extent => {
    const first = nodes[0];
    if (first === undefined) return working;
    for (const input of first.inputs) {
      if (input.port !== "in") continue;
      // A `batch` origin is produced by an earlier node of this same batch,
      // which the first node of a batch has none of by construction.
      if (input.origin.kind === "batch") break;
      const buffer =
        input.origin.kind === "source" ? source : buffers.get(input.origin.nodeId);
      if (buffer === undefined || buffer === null) break;
      return { width: buffer.width, height: buffer.height };
    }
    return working;
  };

  const runGpuBatch = async (
    step: Extract<PlanStep, { kind: "gpu-batch" }>,
    charge: Map<string, number>,
  ): Promise<void> => {
    const buffers = new Map<string, FrameBuffer>();
    let batchSource: FrameBuffer | null = null;

    for (const planned of step.nodes) {
      for (const input of planned.inputs) {
        // A `batch` origin is produced inside this very submission; the GPU
        // layer chains it without anything crossing the boundary.
        if (input.origin.kind === "batch") continue;
        const { key, buffer } = bufferFor(input.origin);
        const onGpu = await resident(key, buffer, "gpu", planned.node.id, charge);
        if (key === SOURCE_KEY) batchSource = onGpu;
        else buffers.set(key, onGpu);
      }
    }

    const entry = entryExtent(step.nodes, batchSource, buffers);
    const startedBatch = performance.now();
    const result = await deps.gpu.submit({
      label: step.label,
      nodes: step.nodes,
      buffers,
      source: batchSource,
      width: entry.width,
      height: entry.height,
      working,
      quality: graph.quality,
      frame: graph.frame,
      palette: prepared.palette,
    });
    const batchMs = round(performance.now() - startedBatch);

    const timings = new Map(result.timings.map((timing) => [timing.nodeId, timing]));
    log.debug("gpu submission", { label: step.label, nodes: step.nodes.length, ms: batchMs });

    for (const planned of step.nodes) {
      const buffer = adopt(
        planned,
        expect(
          result.outputs.get(planned.node.id),
          "missing-output",
          `the GPU backend returned no buffer for ${planned.node.id}`,
          { nodeId: planned.node.id, label: step.label },
        ),
      );
      const timing = expect(
        timings.get(planned.node.id),
        "missing-timing",
        `the GPU backend returned no timing for ${planned.node.id}; the boundary cost has to stay measurable`,
        { nodeId: planned.node.id, label: step.label },
      );
      logNode(
        log,
        {
          nodeId: planned.node.id,
          effect: planned.node.effect,
          execution: "gpu",
          cache: "miss",
          width: buffer.width,
          height: buffer.height,
          ms: timing.ms,
          boundaryBytes: charge.get(planned.node.id) ?? 0,
        },
        { measured: timing.measured, batch: step.label, composited: planned.composite !== null },
      );
    }
  };

  const runWasmNode = async (
    planned: PlannedNode,
    charge: Map<string, number>,
  ): Promise<void> => {
    const buffers = new Map<string, FrameBuffer>();
    let nodeSource: FrameBuffer | null = null;

    for (const input of planned.inputs) {
      const { key, buffer } = bufferFor(input.origin);
      const onCpu = await resident(key, buffer, "cpu", planned.node.id, charge);
      if (key === SOURCE_KEY) nodeSource = onCpu;
      else buffers.set(key, onCpu);
    }

    const entry = entryExtent([planned], nodeSource, buffers);
    const startedNode = performance.now();
    const output = await deps.wasm.run({
      node: planned,
      buffers,
      source: nodeSource,
      width: entry.width,
      height: entry.height,
      working,
      quality: graph.quality,
      frame: graph.frame,
      palette: prepared.palette,
    });
    // Timed here rather than inside the backend so the number includes the
    // worker hop, which is part of what a serial node costs the preview.
    const ms = round(performance.now() - startedNode);

    const buffer = adopt(planned, output);
    logNode(
      log,
      {
        nodeId: planned.node.id,
        effect: planned.node.effect,
        execution: "wasm",
        cache: "miss",
        width: buffer.width,
        height: buffer.height,
        ms,
        boundaryBytes: charge.get(planned.node.id) ?? 0,
      },
      { composited: planned.composite !== null },
    );
  };

  try {
    // Pinned before anything runs. A cache hit the plan counted on could
    // otherwise be evicted by the very buffers this render is about to produce,
    // and the failure would surface as a missing entry deep in the walk rather
    // than as the budget problem it is.
    for (const seed of plan.seeded) {
      const buffer = expect(
        deps.cache.get(seed.hash),
        "cache-miss",
        `node ${seed.nodeId} was planned as a cache hit but its entry is gone`,
        { nodeId: seed.nodeId, hash: seed.hash },
      );
      deps.cache.pin(seed.hash);
      livePins.set(seed.nodeId, seed.hash);
      produced.set(seed.nodeId, buffer);
      logNode(log, {
        nodeId: seed.nodeId,
        effect: seed.effect,
        execution: seed.execution,
        cache: "hit",
        width: buffer.width,
        height: buffer.height,
        ms: 0,
        boundaryBytes: 0,
      });
    }

    for (const [index, step] of plan.steps.entries()) {
      const charge = new Map<string, number>();
      if (step.kind === "gpu-batch") await runGpuBatch(step, charge);
      else await runWasmNode(step.node, charge);
      nodesExecuted += stepNodes(step).length;
      retire(index);
    }

    const output =
      plan.outputOrigin.kind === "source"
        ? source
        : expect(
            produced.get(plan.outputOrigin.nodeId),
            "invariant",
            "the graph output has no buffer after the plan ran",
            { nodeId: plan.outputOrigin.nodeId, hash: plan.outputHash },
          );

    const stats: RenderStats = {
      frame: graph.frame,
      ms: round(performance.now() - startedAt),
      nodesExecuted,
      cacheHits: plan.seeded.length,
      boundaryBytes,
    };
    const cacheStats = deps.cache.stats();
    const diagnostics: RenderDiagnostics = {
      gpuBatches: plan.gpuBatches,
      boundaryCrossings: crossings,
      projectedCrossings: plan.projectedCrossings,
      passthroughNodes: plan.passthrough.length,
      cacheBytes: cacheStats.bytes,
      cacheEntries: cacheStats.entries,
    };

    log.info("render complete", { ...stats, ...diagnostics });
    return { buffer: output, stats, diagnostics, plan };
  } finally {
    // Runs on the error path too, so a backend failure mid-stack leaves neither
    // a pinned cache nor a leaked transfer copy behind.
    for (const hash of livePins.values()) deps.cache.unpin(hash);
    livePins.clear();
    for (const copy of converted.values()) deps.surfaces.release(copy);
    converted.clear();
  }
}

/** Prepare and render in one call: the still-image path. */
export async function renderGraph(
  request: RenderRequest,
  deps: RenderDeps,
): Promise<RenderOutcome> {
  const prepared = prepareGraph(
    request.graph,
    request.source.hash,
    request.palette,
    deps.effects,
    deps.assets,
  );
  return renderPrepared({ prepared, source: request.source, retain: request.retain }, deps);
}

/**
 * The index of the last step that reads each node's output.
 *
 * A node whose output nothing reads again is unpinned as soon as its step ends,
 * which keeps the pinned set to the live working front rather than to every
 * buffer the render has ever produced. Steps are indexed from zero; the graph
 * output is read after the last step, so it gets `steps.length`.
 */
function computeLastUse(plan: RenderPlan): ReadonlyMap<string, number> {
  const lastUse = new Map<string, number>();
  for (const [index, step] of plan.steps.entries()) {
    for (const planned of stepNodes(step)) {
      for (const input of planned.inputs) {
        if (input.origin.kind === "source") continue;
        lastUse.set(input.origin.nodeId, index);
      }
    }
  }
  if (plan.outputOrigin.kind !== "source") {
    lastUse.set(plan.outputOrigin.nodeId, plan.steps.length);
  }
  return lastUse;
}

/**
 * One node execution line.
 *
 * Id, kind, cache hit/miss, dimensions and duration, as docs/ARCHITECTURE.md
 * requires, plus the bytes this node moved across the boundary — the field that
 * makes a badly ordered stack obvious at a glance.
 */
function logNode(
  log: Logger,
  execution: NodeExecution,
  extra: Readonly<Record<string, string | number | boolean>> = {},
): void {
  log.info("node", { ...execution, ...extra });
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
