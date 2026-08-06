/**
 * Pass coalescing and batch execution.
 *
 * A batch is a maximal run of consecutive `gpu` nodes, encoded into one command
 * buffer and sent with one `queue.submit`. The first `wasm` node after it ends
 * the batch, because a serial kernel needs finished pixels in CPU memory: the
 * batch is submitted, read back, run, and uploaded again.
 *
 * Coalescing is not an optimisation bolted on afterwards — it is one of the two
 * mitigations the architecture names for the boundary cost, and it is also
 * correct for the look, because consecutive parallel effects compose the same
 * way whether or not there is a submit between them.
 *
 * Passes inside a batch still run in order. WebGPU orders dispatches within a
 * queue and makes their writes visible to what follows, so a `neighbourhood` or
 * `global` pass sees everything written before it without an explicit barrier.
 */

import type { ExecutionKind } from "../types/registry";
import type { PassBatch, ScheduledPass } from "../types/gpu";
import { logger } from "../lib/log";
import type { GpuContext } from "./device";
import type { CompiledPass, PassCompiler } from "./compiler";
import { dispatchCounts } from "./compiler";
import {
  scratchBytes,
  type BufferCache,
  type GpuPalette,
  type SurfaceChain,
} from "./resources";

const log = logger("gpu");

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

/** One node's contribution to the schedule, in stack order. */
export interface ScheduleUnit {
  readonly nodeId: string;
  readonly execution: ExecutionKind;
  /** Empty for `wasm` nodes; they are what ends a batch. */
  readonly passes: readonly ScheduledPass[];
}

export interface ExecutionPlan {
  readonly batches: readonly PassBatch[];
  /**
   * Readbacks plus uploads the plan implies — one per `gpu`↔`wasm` transition.
   * This is the number that sets the preview's ceiling, so it is planned and
   * logged rather than discovered.
   */
  readonly crossings: number;
}

/**
 * Group a stack into batches.
 *
 * The rule is deliberately the simplest one that is correct: adjacency in stack
 * order. Reordering nodes to make longer runs would change the image, and a
 * `global` pass cannot be reordered against anything at all.
 */
export function planExecution(units: readonly ScheduleUnit[]): ExecutionPlan {
  const batches: PassBatch[] = [];
  let run: ScheduleUnit[] = [];
  let crossings = 0;
  let previous: ExecutionKind | null = null;

  const flush = (): void => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) return;
    const label =
      run.length === 1 ? first.nodeId : `${first.nodeId}..${last.nodeId}`;
    batches.push({
      label,
      passes: run.flatMap((unit) => unit.passes),
    });
    run = [];
  };

  for (const unit of units) {
    if (unit.execution === "gpu") {
      if (unit.passes.length === 0) {
        throw new ScheduleError(`node ${unit.nodeId} declares gpu execution but has no passes`);
      }
      if (previous === "wasm") crossings += 1; // upload
      run.push(unit);
    } else {
      if (unit.passes.length > 0) {
        throw new ScheduleError(
          `node ${unit.nodeId} declares wasm execution but carries ${unit.passes.length} compute pass(es)`,
        );
      }
      if (previous === "gpu") crossings += 1; // readback
      flush();
    }
    previous = unit.execution;
  }
  flush();

  const passCount = batches.reduce((total, batch) => total + batch.passes.length, 0);
  log.info("execution planned", {
    nodes: units.length,
    batches: batches.length,
    passes: passCount,
    crossings,
  });
  return { batches, crossings };
}

/** The surfaces a batch reads and writes. */
export interface BatchBindings {
  readonly color: SurfaceChain;
  /** Present once anything in the stack has quantized. */
  readonly index: SurfaceChain | null;
  readonly palette: GpuPalette | null;
}

export interface BatchStats {
  readonly label: string;
  readonly passes: number;
  readonly encodeMs: number;
  readonly uniformBytes: number;
}

/**
 * Encodes and submits batches.
 *
 * Pipelines must already be compiled — compilation is asynchronous and encoding
 * is not, so a batch that had to compile mid-encode would stall the frame it
 * was meant to serve. A missing pipeline is an error naming the pass rather
 * than a silent compile.
 */
export class BatchExecutor {
  readonly #ctx: GpuContext;
  readonly #compiler: PassCompiler;
  readonly #buffers: BufferCache;

  constructor(ctx: GpuContext, compiler: PassCompiler, buffers: BufferCache) {
    this.#ctx = ctx;
    this.#compiler = compiler;
    this.#buffers = buffers;
  }

  run(batch: PassBatch, bindings: BatchBindings): BatchStats {
    this.#ctx.assertUsable(`batch ${batch.label}`);
    if (batch.passes.length === 0) {
      throw new ScheduleError(`batch ${batch.label} has no passes`);
    }
    const started = performance.now();

    const encoder = this.#ctx.device.createCommandEncoder({ label: `batch ${batch.label}` });
    // One compute pass encoder for the whole batch. Splitting per dispatch would
    // add nothing — WebGPU already synchronises between dispatches — and would
    // cost a pass begin/end per effect.
    const compute = encoder.beginComputePass({ label: `batch ${batch.label}` });

    let uniformBytes = 0;
    for (const scheduled of batch.passes) {
      uniformBytes += this.#encode(compute, scheduled, bindings);
    }

    compute.end();
    const commands = encoder.finish();
    const encodeMs = Math.round((performance.now() - started) * 100) / 100;
    this.#ctx.device.queue.submit([commands]);

    const submittedAt = performance.now();
    this.#ctx.device.queue
      .onSubmittedWorkDone()
      .then(() => {
        log.info("batch complete", {
          batch: batch.label,
          passes: batch.passes.length,
          gpuMs: Math.round((performance.now() - submittedAt) * 100) / 100,
        });
      })
      .catch((error: unknown) => {
        log.error("batch fence rejected", { batch: batch.label, error: String(error) });
      });

    log.debug("batch submitted", {
      batch: batch.label,
      passes: batch.passes.length,
      encodeMs,
      uniformBytes,
    });

    return { label: batch.label, passes: batch.passes.length, encodeMs, uniformBytes };
  }

  #encode(
    compute: GPUComputePassEncoder,
    scheduled: ScheduledPass,
    bindings: BatchBindings,
  ): number {
    const compiled = this.#compiler.get(scheduled.pass.id);
    if (compiled === undefined) {
      throw new ScheduleError(
        `pass ${scheduled.pass.id} has not been compiled; call PassCompiler.compile() before scheduling it`,
      );
    }

    const { entries, uniformBytes, commit } = this.#bind(compiled, scheduled, bindings);

    const bindGroup = this.#ctx.device.createBindGroup({
      label: `${scheduled.pass.label} @ ${scheduled.nodeId}`,
      layout: compiled.bindGroupLayout,
      entries,
    });

    const [x, y, z] = dispatchCounts(
      scheduled.pass,
      scheduled.width,
      scheduled.height,
      this.#ctx.limits,
    );

    compute.setPipeline(compiled.pipeline);
    compute.setBindGroup(0, bindGroup);
    compute.dispatchWorkgroups(x, y, z);

    // The written textures only become the live ones once the dispatch that
    // fills them has been encoded; doing it earlier would make the next pass
    // read a texture nothing has written yet.
    commit();

    log.debug("pass encoded", {
      node: scheduled.nodeId,
      pass: scheduled.pass.id,
      width: scheduled.width,
      height: scheduled.height,
      workgroups: `${x}x${y}x${z}`,
    });

    return uniformBytes;
  }

  #bind(
    compiled: CompiledPass,
    scheduled: ScheduledPass,
    bindings: BatchBindings,
  ): {
    entries: GPUBindGroupEntry[];
    uniformBytes: number;
    commit: () => void;
  } {
    const { plan } = compiled;
    const entries: GPUBindGroupEntry[] = [];
    const commits: (() => void)[] = [];
    let uniformBytes = 0;

    if (plan.inputColor !== null) {
      entries.push({
        binding: plan.inputColor,
        resource: bindings.color.current.createView(),
      });
    }
    if (plan.outputColor !== null) {
      const target = bindings.color.target();
      entries.push({ binding: plan.outputColor, resource: target.createView() });
      commits.push(() => bindings.color.commit(target));
    }

    if (plan.inputIndex !== null || plan.outputIndex !== null) {
      const chain = bindings.index;
      if (chain === null) {
        throw new ScheduleError(
          `pass ${scheduled.pass.id} binds the index map, but no index surface was supplied — nothing upstream has quantized`,
        );
      }
      if (plan.inputIndex !== null) {
        entries.push({ binding: plan.inputIndex, resource: chain.current.createView() });
      }
      if (plan.outputIndex !== null) {
        const target = chain.target();
        entries.push({ binding: plan.outputIndex, resource: target.createView() });
        commits.push(() => chain.commit(target));
      }
    }

    if (plan.palette !== null) {
      if (bindings.palette === null) {
        throw new ScheduleError(
          `pass ${scheduled.pass.id} binds a palette, but none was supplied`,
        );
      }
      entries.push({
        binding: plan.palette,
        resource: { buffer: bindings.palette.buffer, offset: 0, size: bindings.palette.bytes },
      });
    }

    if (plan.uniforms !== null) {
      const size = scheduled.pass.uniforms.sizeBytes;
      if (scheduled.uniforms.byteLength !== size) {
        throw new ScheduleError(
          `pass ${scheduled.pass.id} at node ${scheduled.nodeId}: packed ${scheduled.uniforms.byteLength} uniform bytes, layout declares ${size}`,
        );
      }
      const buffer = this.#buffers.uniform(`${scheduled.nodeId}/${scheduled.pass.id}`, size);
      this.#ctx.device.queue.writeBuffer(buffer, 0, scheduled.uniforms);
      entries.push({ binding: plan.uniforms, resource: { buffer, offset: 0, size } });
      uniformBytes = size;
    }

    for (const slot of plan.scratch) {
      const bytes = scratchBytes(slot.size, scheduled.width, scheduled.height);
      const buffer = this.#buffers.scratch(`${scheduled.nodeId}/${slot.slot}`, bytes);
      entries.push({ binding: slot.binding, resource: { buffer, offset: 0, size: bytes } });
    }

    for (const table of plan.tables) {
      entries.push({
        binding: table.binding,
        resource: { buffer: table.buffer, offset: 0, size: table.buffer.size },
      });
    }

    return {
      entries,
      uniformBytes,
      commit: () => {
        for (const fn of commits) fn();
      },
    };
  }
}
