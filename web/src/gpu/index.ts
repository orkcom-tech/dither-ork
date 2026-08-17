/**
 * The WebGPU path.
 *
 * WebGPU is a hard requirement with no WebGL2 fallback (docs/ARCHITECTURE.md,
 * "Platform support policy"), so there is exactly one implementation of
 * everything here and no branch that says "if this is unavailable".
 *
 * Layout:
 *
 * - `device.ts`     adapter and device acquisition, device-lost reporting, limits
 * - `uniforms.ts`   std140 layout validation and packing
 * - `compiler.ts`   WGSL to compute pipeline, with the pipeline cache
 * - `resources.ts`  rgba16float colour, r32uint index maps, pools, ping-pong
 * - `extent.ts`     a pass's output extent, when it differs from its input
 * - `instance.ts`   per-node bulk data: curve LUTs, uploaded threshold tiles
 * - `boundary.ts`   readback and upload, every crossing measured
 * - `scheduler.ts`  pass coalescing and batch execution
 * - `composite.ts`  per-node opacity and blend (F-ST-03); the one non-effect program
 * - `prepare.ts`    one node to its scheduled passes: extent, uniforms, bulk data
 * - `matrices.ts`   the threshold-matrix upload interface
 * - `effects/`      per-effect passes; the WGSL lives in `web/src/shaders/`
 */

export {
  acquireGpuContext,
  GpuContext,
  GpuDeviceLostError,
  GpuUnavailableError,
  type GpuContextOptions,
  type GpuLimits,
} from "./device";

export {
  packUniforms,
  uniformFieldAlignment,
  uniformFieldSize,
  UniformLayoutError,
  UniformPackError,
  validateUniformLayout,
  type UniformContext,
} from "./uniforms";

export {
  FeedbackStore,
  FeedbackStoreError,
  type FeedbackStoreStats,
} from "./feedback";

export {
  dispatchCounts,
  validateFeedbackDeclaration,
  validateResamplingDeclaration,
  validateSourceDeclaration,
  PassCompileError,
  PassCompiler,
  type BindingPlan,
  type CompiledEffect,
  type CompiledPass,
  type InstanceSlotBinding,
  type ScratchBinding,
  type TableBinding,
} from "./compiler";

export { CompositeError, CompositeProgram } from "./composite";
export type { CompositeRequest } from "./composite";

export {
  assertExtent,
  describeExtent,
  ExtentError,
  extentsEqual,
  passExtentRule,
  resizes,
  resolveExtent,
  resolvePassExtent,
} from "./extent";

export {
  InstanceDataError,
  instanceBindingsOf,
  resolveInstanceData,
  resolvePassInstances,
} from "./instance";

export { prepareNodePasses } from "./prepare";
export type { NodeRenderState, PreparedNode } from "./prepare";

export {
  bytesPerTexel,
  BufferCache,
  GpuResourceError,
  linearToOklab,
  linearToSrgb,
  PALETTE_METRIC_OKLAB,
  PALETTE_METRIC_SRGB,
  scratchBytes,
  srgbToLinear,
  SurfaceChain,
  TexturePool,
  uploadPalette,
  type GpuPalette,
  type SurfaceFormat,
  type TexturePoolStats,
} from "./resources";

export {
  BoundaryError,
  floatToHalf,
  halfToFloat,
  readColorSurface,
  readIndexSurface,
  StagingPool,
  writeColorSurface,
  writeIndexSurface,
  type ColorReadback,
  type IndexReadback,
} from "./boundary";

export {
  BatchExecutor,
  planExecution,
  resolveScheduledOutput,
  ScheduleError,
  type BatchBindings,
  type BatchStats,
  type ExecutionPlan,
  type ScheduleUnit,
} from "./scheduler";

export {
  thresholdMatrix,
  thresholdMatrixBytes,
  ThresholdMatrixError,
  type ThresholdMatrix,
  type ThresholdMatrixSource,
} from "./matrices";

export { GpuLayer } from "./layer";

export {
  createOrderedDither,
  ORDERED_BINDING,
  ORDERED_CONTROL_PARAMS,
  ORDERED_DITHER_UNIFORMS,
  ORDERED_DITHERS,
  ORDERED_PARAM,
  ORDERED_PARAM_TYPES,
  orderedDitherDefaults,
  orderedDitherDescriptor,
  orderedDitherEffect,
  orderedDitherSpec,
  type OrderedDitherSpec,
} from "./effects/ordered";
