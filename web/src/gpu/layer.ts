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
import { acquireGpuContext, type GpuContext, type GpuContextOptions } from "./device";
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

  private constructor(context: GpuContext) {
    this.context = context;
    this.textures = new TexturePool(context);
    this.buffers = new BufferCache(context);
    this.staging = new StagingPool(context);
    this.compiler = new PassCompiler(context, this.buffers);
    this.executor = new BatchExecutor(context, this.compiler, this.buffers);
  }

  static async create(options: GpuContextOptions): Promise<GpuLayer> {
    const context = await acquireGpuContext(options);
    log.info("gpu layer ready");
    return new GpuLayer(context);
  }

  /** Resident bytes and cache occupancy, for the UI's memory readout. */
  stats(): {
    readonly textures: ReturnType<TexturePool["stats"]>;
    readonly pipelines: ReturnType<PassCompiler["stats"]>;
  } {
    return { textures: this.textures.stats(), pipelines: this.compiler.stats() };
  }

  destroy(): void {
    // Order matters: pipelines reference the layouts, everything references the
    // device, and destroying the device first would make the rest log errors on
    // the way down.
    this.compiler.clear();
    this.staging.destroy();
    this.buffers.destroy();
    this.textures.destroy();
    this.context.destroy();
    log.info("gpu layer destroyed");
  }
}
