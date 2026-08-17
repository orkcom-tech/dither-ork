/**
 * The GPU layer as one object.
 *
 * Device, pools, caches and executor have to be created together and destroyed
 * together — a pipeline cache outliving its device is a set of dangling
 * handles, and a texture pool that is not destroyed is a leak the size of the
 * working resolution times the stack depth. Bundling them means one `create`,
 * one `destroy`, and nowhere for half of it to survive the other half.
 */

import { logger } from "../lib/log";
import { StagingPool } from "./boundary";
import { PassCompiler } from "./compiler";
import { CompositeProgram } from "./composite";
import { acquireGpuContext, type GpuContext, type GpuContextOptions } from "./device";
import { FeedbackStore } from "./feedback";
import { BufferCache, TexturePool } from "./resources";
import { BatchExecutor } from "./scheduler";

const log = logger("gpu");

export class GpuLayer {
  readonly context: GpuContext;
  readonly textures: TexturePool;
  readonly buffers: BufferCache;
  readonly staging: StagingPool;
  readonly compiler: PassCompiler;
  readonly executor: BatchExecutor;
  /**
   * Per-node opacity and blend (F-ST-03).
   *
   * Compiled here, once, rather than on first use: its WGSL is constant and
   * pipeline creation is asynchronous, so a composite that had to compile
   * mid-render would stall the first frame a user dragged an opacity slider on
   * — the one frame where the delay is most visible.
   */
  readonly composite: CompositeProgram;
  /**
   * The previous frame at each feedback node's position.
   *
   * On the layer rather than inside the GPU backend because two callers need
   * it and neither owns the other: the backend reads and writes it while a node
   * runs, and `DocumentRenderer` resets it when the source or the stack
   * changes. Its textures come from this layer's pool, so it is destroyed with
   * the layer for the same reason everything else here is.
   */
  readonly feedback: FeedbackStore;

  private constructor(
    context: GpuContext,
    buffers: BufferCache,
    composite: CompositeProgram,
  ) {
    this.context = context;
    this.textures = new TexturePool(context);
    this.buffers = buffers;
    this.staging = new StagingPool(context);
    this.compiler = new PassCompiler(context, this.buffers);
    this.executor = new BatchExecutor(context, this.compiler, this.buffers);
    this.composite = composite;
    this.feedback = new FeedbackStore(context, this.textures);
  }

  static async create(options: GpuContextOptions): Promise<GpuLayer> {
    const context = await acquireGpuContext(options);
    // The buffer cache is built here rather than in the constructor because the
    // composite program needs one to exist before the layer does, and one cache
    // destroyed with the layer is the whole point of bundling these together —
    // a second cache for the composite's uniform buffers would be a leak the
    // size of one buffer per composited node.
    const buffers = new BufferCache(context);
    const composite = await CompositeProgram.create(context, buffers);
    log.info("gpu layer ready");
    return new GpuLayer(context, buffers, composite);
  }

  /** Resident bytes and cache occupancy, for the UI's memory readout. */
  stats(): {
    readonly textures: ReturnType<TexturePool["stats"]>;
    readonly pipelines: ReturnType<PassCompiler["stats"]>;
    readonly composites: ReturnType<CompositeProgram["stats"]>;
    readonly feedback: ReturnType<FeedbackStore["stats"]>;
  } {
    return {
      textures: this.textures.stats(),
      pipelines: this.compiler.stats(),
      composites: this.composite.stats(),
      feedback: this.feedback.stats(),
    };
  }

  destroy(): void {
    // Order matters: pipelines reference the layouts, everything references the
    // device, and destroying the device first would make the rest log errors on
    // the way down. The frame store goes back to the texture pool before the
    // pool is destroyed, so its surfaces are counted rather than orphaned.
    this.feedback.destroy();
    this.compiler.clear();
    this.staging.destroy();
    this.buffers.destroy();
    this.textures.destroy();
    this.context.destroy();
    log.info("gpu layer destroyed");
  }
}
