/**
 * Per-node opacity and blend on the parallel half — F-ST-03.
 *
 * ## Why this is not a `ComputePass`
 *
 * The effect pass model has exactly one `input-color` binding, and a composite
 * needs two: the node's input and the node's output. Widening `PassBinding` to
 * allow a second colour input would put a role in the vocabulary that no effect
 * in the catalogue can use and that the compiler would then have to refuse for
 * all 52 of them. So the composite is its own program, owned by the GPU layer,
 * compiled once at layer creation, with a bind group layout of its own. It is
 * the only program in `web/src/gpu` that is not an effect, which is why its
 * shader file is `_composite.wgsl` rather than `<effect-id>.wgsl`.
 *
 * ## What it composites against
 *
 * A node's own input. A stack node is a filter, not a layer, so 50% of a blur
 * is half-blurred rather than blurred over whatever preceded it in the panel.
 * `CompositeOp` in `graph/plan.ts` decides *whether* a node has a composite;
 * this does it.
 *
 * ## The index map is not composited, and that is a decision
 *
 * A quantizing node at 60% opacity emits colours that are no longer palette
 * entries, so it is fair to ask what its index map then means. It means what it
 * always meant: **which palette entry this node chose for each pixel**. Opacity
 * changes how much of that decision is shown, not what the decision was.
 * Blending two indices is meaningless for exactly the reason resampling one is
 * — the average of index 3 and index 7 is not a colour — so there is no
 * arithmetic to do on the map, and there is no third option: dropping it would
 * mean a stack that `registry/stack.ts` accepted at full opacity fails to
 * render the moment a slider moves, which is worse than either.
 *
 * ## Extents
 *
 * Base and top must be the same shape. A node that resamples has no common grid
 * with its own input, so there is nothing to composite against; that is refused
 * in `graph/plan.ts` when the plan is built, naming the node, rather than
 * discovered here with two textures already allocated. This class still checks,
 * because it is the layer that would otherwise read out of bounds.
 */

import type { BlendMode } from "../types/document";
import type { Extent } from "../types/gpu";
import { logger } from "../lib/log";
import type { GpuContext } from "./device";
import { assertExtent, describeExtent, extentsEqual } from "./extent";
import type { BufferCache } from "./resources";

import wgsl from "../shaders/_composite.wgsl?raw";

const log = logger("gpu");

export class CompositeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositeError";
  }
}

// The ordinals come from `graph/blend.ts` rather than being declared a second
// time here. The GPU layer importing one leaf module from the graph layer is
// deliberate: the alternative is two numberings that agree until somebody adds
// a mode to one of them, and the numbering is what the shader and every saved
// document both depend on. `blend.ts` is arithmetic and constants — it pulls in
// no graph machinery.
import { BLEND_ORDINAL } from "../graph/blend";

/** Binding numbers, restated from the top of `_composite.wgsl`. */
const BINDING = {
  base: 0,
  output: 1,
  uniforms: 5,
  top: 6,
} as const;

/** `width: u32, height: u32, mode: u32, opacity: f32`. */
const UNIFORM_BYTES = 16;

const WORKGROUP = 8;

export interface CompositeRequest {
  /** The node's input — what was on screen before this node ran. */
  readonly base: GPUTexture;
  /** What the node produced. */
  readonly top: GPUTexture;
  /** Where the result goes. Must be distinct from both inputs. */
  readonly output: GPUTexture;
  readonly extent: Extent;
  readonly opacity: number;
  readonly blend: BlendMode;
  /** Node id, or anything that identifies the composite in a label and a log line. */
  readonly label: string;
}

/**
 * The composite program: one pipeline, created once per device.
 *
 * Compilation is asynchronous, so it happens when the layer is created rather
 * than in the middle of the first frame that needs it. A composite that had to
 * compile mid-render would stall the frame it was meant to serve, which is the
 * same reason `PassCompiler` refuses to compile during encoding.
 */
export class CompositeProgram {
  readonly #ctx: GpuContext;
  readonly #buffers: BufferCache;
  readonly #pipeline: GPUComputePipeline;
  readonly #layout: GPUBindGroupLayout;
  #composites = 0;

  private constructor(
    ctx: GpuContext,
    buffers: BufferCache,
    pipeline: GPUComputePipeline,
    layout: GPUBindGroupLayout,
  ) {
    this.#ctx = ctx;
    this.#buffers = buffers;
    this.#pipeline = pipeline;
    this.#layout = layout;
  }

  static async create(ctx: GpuContext, buffers: BufferCache): Promise<CompositeProgram> {
    ctx.assertUsable("CompositeProgram.create");
    const started = performance.now();

    const module = ctx.device.createShaderModule({ label: "composite", code: wgsl });
    const info = await module.getCompilationInfo();
    let errors = 0;
    for (const message of info.messages) {
      const fields = {
        pass: "composite",
        line: message.lineNum,
        column: message.linePos,
        message: message.message,
      };
      if (message.type === "error") {
        errors += 1;
        log.error("wgsl error", fields);
      } else if (message.type === "warning") {
        log.warn("wgsl warning", fields);
      } else {
        log.debug("wgsl info", fields);
      }
    }
    if (errors > 0) {
      throw new CompositeError(
        `the composite shader has ${errors} WGSL compilation error(s); see the gpu log for line numbers`,
      );
    }

    const visibility = GPUShaderStage.COMPUTE;
    const layout = ctx.device.createBindGroupLayout({
      label: "composite layout",
      entries: [
        {
          binding: BINDING.base,
          visibility,
          texture: { sampleType: "float", viewDimension: "2d" },
        },
        {
          binding: BINDING.output,
          visibility,
          storageTexture: {
            access: "write-only",
            format: "rgba16float",
            viewDimension: "2d",
          },
        },
        {
          binding: BINDING.uniforms,
          visibility,
          // minBindingSize makes a short uniform buffer a creation-time error
          // rather than an out-of-bounds read the shader cannot detect.
          buffer: { type: "uniform", minBindingSize: UNIFORM_BYTES },
        },
        {
          binding: BINDING.top,
          visibility,
          texture: { sampleType: "float", viewDimension: "2d" },
        },
      ],
    });

    ctx.device.pushErrorScope("validation");
    const created = await ctx.device
      .createComputePipelineAsync({
        label: "composite",
        layout: ctx.device.createPipelineLayout({
          label: "composite pipeline layout",
          bindGroupLayouts: [layout],
        }),
        compute: { module, entryPoint: "composite" },
      })
      .then(
        (pipeline) => ({ ok: true, pipeline }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
    const scoped = await ctx.device.popErrorScope();

    if (!created.ok) {
      log.error("composite pipeline creation failed", { error: String(created.error) });
      throw new CompositeError(
        `the composite pipeline could not be created: ${String(created.error)}`,
      );
    }
    if (scoped !== null) {
      log.error("composite pipeline validation error", { error: scoped.message });
      throw new CompositeError(`the composite pipeline is invalid: ${scoped.message}`);
    }

    log.info("composite program compiled", {
      ms: Math.round((performance.now() - started) * 100) / 100,
    });
    return new CompositeProgram(ctx, buffers, created.pipeline, layout);
  }

  /**
   * Encode the composite into an existing compute pass.
   *
   * Taking an encoder rather than owning one is what lets a caller put the
   * composite in the same submission as the node it belongs to, which is the
   * whole reason a composite costs no extra boundary crossing.
   */
  encode(compute: GPUComputePassEncoder, request: CompositeRequest): void {
    this.#ctx.assertUsable(`composite ${request.label}`);
    const extent = assertExtent(`composite ${request.label}`, request.extent);

    for (const [role, texture] of [
      ["base", request.base],
      ["top", request.top],
      ["output", request.output],
    ] as const) {
      const shape: Extent = { width: texture.width, height: texture.height };
      if (!extentsEqual(shape, extent)) {
        throw new CompositeError(
          `composite at ${request.label}: the ${role} texture is ${describeExtent(shape)} and the composite covers ${describeExtent(extent)}; a node's output and its own input have to name the same pixel grid`,
        );
      }
    }
    if (request.output === request.base || request.output === request.top) {
      // WebGPU forbids one texture bound as both sampled and writable storage
      // in one dispatch, and it would be a read of pixels this dispatch is
      // concurrently overwriting even if it did not.
      throw new CompositeError(
        `composite at ${request.label}: the output texture is also one of the inputs`,
      );
    }
    if (!Number.isFinite(request.opacity) || request.opacity < 0 || request.opacity > 1) {
      throw new CompositeError(
        `composite at ${request.label}: opacity ${request.opacity} is not in [0, 1]`,
      );
    }

    const ordinal = BLEND_ORDINAL[request.blend];
    if (ordinal === undefined) {
      throw new CompositeError(
        `composite at ${request.label}: blend mode "${request.blend}" has no ordinal; BLEND_MODES in graph/blend.ts and the const block in _composite.wgsl have to name the same set`,
      );
    }

    const uniforms = new ArrayBuffer(UNIFORM_BYTES);
    const view = new DataView(uniforms);
    view.setUint32(0, extent.width, true);
    view.setUint32(4, extent.height, true);
    view.setUint32(8, ordinal, true);
    view.setFloat32(12, request.opacity, true);

    // One uniform buffer per node, rewritten in place, for the same reason
    // every pass has one: a slider drag re-runs this dozens of times a second.
    const buffer = this.#buffers.uniform(`${request.label}/composite`, UNIFORM_BYTES);
    this.#ctx.device.queue.writeBuffer(buffer, 0, uniforms);

    const bindGroup = this.#ctx.device.createBindGroup({
      label: `composite @ ${request.label}`,
      layout: this.#layout,
      entries: [
        { binding: BINDING.base, resource: request.base.createView() },
        { binding: BINDING.output, resource: request.output.createView() },
        {
          binding: BINDING.uniforms,
          resource: { buffer, offset: 0, size: UNIFORM_BYTES },
        },
        { binding: BINDING.top, resource: request.top.createView() },
      ],
    });

    compute.setPipeline(this.#pipeline);
    compute.setBindGroup(0, bindGroup);
    compute.dispatchWorkgroups(
      Math.ceil(extent.width / WORKGROUP),
      Math.ceil(extent.height / WORKGROUP),
      1,
    );

    this.#composites += 1;
    log.debug("composite encoded", {
      node: request.label,
      blend: request.blend,
      opacity: request.opacity,
      extent: describeExtent(extent),
    });
  }

  /** Encode and submit on its own, for a caller with no encoder open. */
  run(request: CompositeRequest): void {
    const encoder = this.#ctx.device.createCommandEncoder({
      label: `composite ${request.label}`,
    });
    const compute = encoder.beginComputePass({ label: `composite ${request.label}` });
    try {
      this.encode(compute, request);
    } finally {
      // Ended on the error path too: an unended compute pass makes `finish()`
      // a validation error that names the encoder rather than the composite.
      compute.end();
    }
    this.#ctx.device.queue.submit([encoder.finish()]);
  }

  stats(): { readonly composites: number } {
    return { composites: this.#composites };
  }
}
