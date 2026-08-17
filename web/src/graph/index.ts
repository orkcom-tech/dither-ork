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
  MASK_PARAM_KEY,
  PALETTE_PARAM_KEY,
  contentHash,
  hashBytes,
  paletteDigest,
} from "./hash";

export {
  BLEND_MODES,
  BLEND_ORDINAL,
  blendChannel,
  compositeChannel,
  compositeLinearSurface,
} from "./blend";

export { NodeAssetStore } from "./assets";
export type { NodeAsset, NodeAssetStoreOptions, NodeAssets } from "./assets";

export { analyseGraph, renderUpTo } from "./topology";
export type { GraphTopology } from "./topology";

export {
  MASK_PORT,
  derivedFeedbackPorts,
  isFeedbackRole,
  isPrimaryPort,
  portOf,
  portOrder,
  portsOf,
} from "./ports";

export {
  MASK_CHANNELS,
  MASK_CHANNEL_ORDINAL,
  MASK_KINDS,
  MASK_KIND_ORDINAL,
  linearLuminance,
  maskChannelValue,
  maskCoverage,
  maskDigest,
  maskNeedsImage,
  maskProblem,
  resolveColorTarget,
  smoothstep,
} from "./mask";
export type { MaskKind, ResolvedColorTarget } from "./mask";

export {
  addGraphNode,
  connect,
  connectionProblem,
  disconnect,
  draftOf,
  chainOf,
  isLinearChain,
  legalConnections,
  removeGraphNode,
  setNodeMask,
  setOutput,
} from "./edit";
export type {
  ConnectionRefusal,
  ConnectionRefusalCode,
  EffectLookup,
  GraphDraft,
  LegalConnection,
} from "./edit";

export {
  analyseFeedback,
  readsFeedback,
  stackReadsFeedback,
} from "./feedback";
export type { FeedbackAnalysis } from "./feedback";

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
