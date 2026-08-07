/**
 * The render path: document -> graph -> frame.
 *
 * **Everything here runs in the render worker.** `web/src/worker/render.worker.ts`
 * is the only importer of this barrel; nothing on the main thread constructs a
 * device, a core or a renderer, which is why `state/index.ts` does not re-export
 * any of it.
 *
 * - `graph.ts`        a document compiled to a `RenderGraph`. Pure.
 * - `effects.ts`      an effect id to compiled compute passes, cached per session.
 * - `gpu-backend.ts`  `GpuBackend` against the real device.
 * - `wasm-backend.ts` `WasmBackend` against the Rust core.
 * - `core.ts`         the one place `wasm-bindgen` handles are freed.
 * - `surfaces.ts`     who frees a buffer.
 * - `renderer.ts`     the whole of it, plus the presentation readback.
 */

export { buildRenderGraph, type BuildGraphOptions } from "./graph";
export { BLUE_NOISE_SEED, GpuEffectCache, type ThresholdRankSource } from "./effects";
export { GpuRenderBackend, type GpuBackendDeps } from "./gpu-backend";
export {
  WasmRenderBackend,
  packPalette,
  type DiffusionChannelMode,
  type DiffusionPort,
  type DiffusionRequest,
  type DiffusionResult,
} from "./wasm-backend";
export {
  loadDitherCore,
  type CoreGifAnimation,
  type CoreGifResult,
  type CoreKernel,
  type DitherCore,
} from "./core";
export { RenderSurfaces } from "./surfaces";
export {
  DocumentRenderer,
  cacheBudgetFor,
  type RenderOptions,
  type RenderedFrame,
  type RendererOptions,
} from "./renderer";
