/**
 * From one node to the passes the executor encodes.
 *
 * Three things have to happen between "this node runs this effect" and "this
 * dispatch reads these bindings", and until now each caller did all three by
 * hand: pack the uniforms, resolve the extent each pass reads and writes, and
 * build the node's bulk data. Doing them separately is how the three disagree —
 * a uniform block that says the shader is 1024 wide, a texture allocated at
 * 512, and a LUT built from the parameters of the frame before.
 *
 * This threads them in one place, in the order the passes run:
 *
 * - The **first** pass reads the node's input extent. Each subsequent pass
 *   reads what the one before it wrote, so a two-pass separable resampler
 *   composes without either pass knowing about the other.
 * - The uniform block gets `width`/`height` from the extent the pass reads and
 *   `output-width`/`output-height` from the extent it writes.
 * - Every `instance-data` binding is built and digested, so an unchanged curve
 *   costs no upload and a changed one invalidates exactly its own buffer.
 *
 * Pure: no device, no registry lookup, no clock. That is what lets the whole
 * resizing and bulk-data story be tested without a GPU, and it is the same
 * property `packUniforms` has and for the same reason — the determinism test
 * renders one frame in two workers and compares bytes.
 */

import type { ParameterValue } from "../types/document";
import type { ParamDescriptor } from "../types/registry";
import type { Extent, GpuEffect, ScheduledPass } from "../types/gpu";
import { logger } from "../lib/log";
import { assertExtent, describeExtent, resolvePassExtent } from "./extent";
import { resolvePassInstances } from "./instance";
import { ScheduleError, type ScheduleUnit } from "./scheduler";
import { packUniforms } from "./uniforms";

const log = logger("gpu");

/** One node's state, as everything below the graph needs it. */
export interface NodeRenderState {
  readonly nodeId: string;
  readonly params: Readonly<Record<string, ParameterValue>>;
  readonly paramTypes: ReadonlyMap<string, ParamDescriptor>;
  readonly seed: number;
  /** `frame / clock.frames`. Never reaches 1, so a shader animating on it loops. */
  readonly normalizedTime: number;
  readonly paletteSize: number;
  /**
   * Bulk bytes the document carries for this node, by instance slot (F-PP-07).
   * Absent for the overwhelming majority of nodes, which carry none.
   */
  readonly supplied?: ReadonlyMap<string, Uint8Array>;
}

export interface PreparedNode {
  readonly unit: ScheduleUnit;
  /** The extent this node's last pass wrote. What the next node reads. */
  readonly output: Extent;
}

/**
 * Schedule every pass of one parallel node.
 *
 * `input` is the extent of the buffer this node reads — not the render's
 * working resolution, which stops being the same number the moment anything
 * upstream resamples.
 */
export function prepareNodePasses(
  effect: GpuEffect,
  state: NodeRenderState,
  input: Extent,
): PreparedNode {
  assertExtent(`node ${state.nodeId} input`, input);
  if (effect.passes.length === 0) {
    // The compiler rejects this too, but a node scheduled with no passes would
    // reach `planExecution` as an empty run and be reported against the batch
    // rather than against the effect that declared nothing.
    throw new ScheduleError(
      `effect "${effect.effect}" at node ${state.nodeId} declares no passes`,
    );
  }

  const passes: ScheduledPass[] = [];
  let reads = input;

  for (const pass of effect.passes) {
    const writes = resolvePassExtent(pass, reads, state.params);

    const uniforms = packUniforms(`${state.nodeId}/${pass.id}`, pass.uniforms, {
      params: state.params,
      paramTypes: state.paramTypes,
      width: reads.width,
      height: reads.height,
      outputWidth: writes.width,
      outputHeight: writes.height,
      normalizedTime: state.normalizedTime,
      seed: state.seed,
      paletteSize: state.paletteSize,
    });

    const instances = resolvePassInstances(
      pass.id,
      pass.bindings,
      {
        nodeId: state.nodeId,
        params: state.params,
        paramTypes: state.paramTypes,
        seed: state.seed,
      },
      state.supplied,
    );

    passes.push({
      nodeId: state.nodeId,
      pass,
      uniforms,
      width: reads.width,
      height: reads.height,
      // Omitted rather than set equal to the input, so `exactOptionalPropertyTypes`
      // keeps "this pass resizes" a visible fact about the scheduled pass and
      // not something a reader has to compare two pairs of numbers to learn.
      ...(writes.width === reads.width && writes.height === reads.height
        ? {}
        : { output: writes }),
      ...(instances.length === 0 ? {} : { instances }),
    });

    reads = writes;
  }

  if (reads.width !== input.width || reads.height !== input.height) {
    log.info("node resamples", {
      node: state.nodeId,
      effect: effect.effect,
      from: describeExtent(input),
      to: describeExtent(reads),
    });
  }

  return {
    unit: { nodeId: state.nodeId, execution: "gpu", passes },
    output: reads,
  };
}
