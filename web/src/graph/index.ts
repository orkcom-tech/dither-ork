/**
 * The render graph.
 *
 * A document compiles to a DAG; this schedules it, hashes it, caches its node
 * outputs and executes it against the GPU and WASM backends. It computes no
 * pixels itself — see `backend.ts` for the line.
 *
 * The still path:
 *
 * ```ts
 * const cache = new NodeCache({ budget: { maxBytes }, surfaces, log: logger("graph") });
 * const outcome = await renderGraph({ graph, source, palette, retain: { kind: "all" } }, deps);
 * ```
 *
 * The animated path, which reuses every node that does not move:
 *
 * ```ts
 * await renderAnimation({ frames, graphForFrame, source, palette, onFrame }, deps);
 * ```
 */

export { GraphError, expect } from "./errors";
export type { GraphErrorCode } from "./errors";

export { sha256Hex } from "./sha256";
export {
  ASSET_PARAM_KEY,
  PALETTE_PARAM_KEY,
  contentHash,
  hashBytes,
  paletteDigest,
} from "./hash";

export { NodeAssetStore } from "./assets";
export type { NodeAsset, NodeAssetStoreOptions, NodeAssets } from "./assets";

export { PORT_ORDER, analyseGraph, renderUpTo } from "./topology";
export type { GraphTopology } from "./topology";

export { NodeCache, frameBufferBytes } from "./cache";
export type { NodeCacheOptions, NodeCacheStats, SurfaceOwner } from "./cache";

export { planRender, prepareGraph, stepNodes } from "./plan";
export type {
  CompositeOp,
  InputOrigin,
  PlanStep,
  PlannedNode,
  PreparedGraph,
  RenderPlan,
  ResolvedInput,
  SeededNode,
} from "./plan";

export type {
  GpuBackend,
  GpuBatch,
  GpuBatchResult,
  GpuNodeTiming,
  RenderContext,
  TransferResult,
  WasmBackend,
  WasmNodeRequest,
} from "./backend";

export { renderGraph, renderPrepared } from "./render";
export type {
  PreparedRenderRequest,
  RenderDeps,
  RenderDiagnostics,
  RenderOutcome,
  RenderRequest,
  RenderStats,
  RetainPolicy,
} from "./render";

export { renderAnimation } from "./animate";
export type { AnimatedRequest, AnimationOutcome } from "./animate";
