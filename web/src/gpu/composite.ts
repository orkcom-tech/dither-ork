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

import type { BlendMode, NodeMask } from "../types/document";
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
// Same argument for the mask arithmetic: `mask.ts` is the definition and
// `_composite.wgsl` is its transcription, so the ordinals come from there
// rather than being written down a second time here.
import {
  MASK_CHANNEL_ORDINAL,
  MASK_KIND_ORDINAL,
  maskNeedsImage,
  resolveColorTarget,
} from "../graph/mask";

/** Binding numbers, restated from the top of `_composite.wgsl`. */
const BINDING = {
  base: 0,
  output: 1,
  uniforms: 5,
  top: 6,
  mask: 7,
} as const;

/**
 * `width, height, mode: u32; opacity: f32; mask_kind, mask_invert: u32;
 * mask_a..mask_e: f32; mask_channel: u32` — twelve 4-byte fields, 48 bytes.
 *
 * It has to equal the WGSL struct's size exactly: `minBindingSize` below makes
 * a short buffer a pipeline-creation error, and a long one is a silent waste
 * that hides a field somebody forgot to pack.
 *
 * One layout for masked and unmasked alike. A second, shorter layout for the
 * unmasked case would be a second `minBindingSize` and a second uniform buffer
 * per node for 32 bytes, on a buffer that is rewritten on every drag anyway.
 */
const UNIFORM_BYTES = 48;

/**
 * The `mask_kind` value that means "no mask".
 *
 * Not a member of `MASK_KINDS`: those are append-only ordinals starting at 0
 * and any sentinel inside that range would collide with the next kind added.
 * Restated in `_composite.wgsl` as `MASK_NONE`.
 */
const MASK_NONE = 0xffffffff;

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
  /**
   * Spatially-varying opacity (F-PP-08), or absent on an unmasked node.
   *
   * `mask.source.kind === "image"` is the only case that needs {@link mask
   * CompositeRequest.maskTexture}; the other two read the base texture, which
   * is already bound.
   */
  readonly mask?: NodeMask | null;
  /**
   * The picture wired to the node's `mask` port.
   *
   * Required when — and legal only when — the mask's source is `image`. Missing
   * it is refused rather than treated as full coverage, which would be a mask
   * that silently is not one.
   */
  readonly maskTexture?: GPUTexture | null;
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
/** A pipeline and the bind group layout it was built against. */
interface CompiledComposite {
  readonly pipeline: GPUComputePipeline;
  readonly layout: GPUBindGroupLayout;
}

export class CompositeProgram {
  readonly #ctx: GpuContext;
  readonly #buffers: BufferCache;
  readonly #plain: CompiledComposite;
  /**
   * The variant with a mask texture bound at 7.
   *
   * A separate pipeline rather than a flag, because WebGPU requires every
   * declared binding to be provided: one pipeline would have to be handed some
   * texture for the mask slot on every unmasked composite, and binding a
   * texture to a slot the shader is told to ignore is a correctness bug waiting
   * for the day the flag is wrong.
   */
  readonly #masked: CompiledComposite;
  #composites = 0;
  #maskedComposites = 0;

  private constructor(
    ctx: GpuContext,
    buffers: BufferCache,
    plain: CompiledComposite,
    masked: CompiledComposite,
  ) {
    this.#ctx = ctx;
    this.#buffers = buffers;
    this.#plain = plain;
    this.#masked = masked;
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
    const layoutFor = (masked: boolean): GPUBindGroupLayout =>
      ctx.device.createBindGroupLayout({
        label: masked ? "composite layout (masked)" : "composite layout",
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
          ...(masked
            ? [
                {
                  binding: BINDING.mask,
                  visibility,
                  texture: { sampleType: "float" as const, viewDimension: "2d" as const },
                },
              ]
            : []),
        ],
      });

    const compile = async (
      entryPoint: "composite" | "composite_masked",
      masked: boolean,
    ): Promise<CompiledComposite> => {
      const layout = layoutFor(masked);
      ctx.device.pushErrorScope("validation");
      const created = await ctx.device
        .createComputePipelineAsync({
          label: entryPoint,
          layout: ctx.device.createPipelineLayout({
            label: `${entryPoint} pipeline layout`,
            bindGroupLayouts: [layout],
          }),
          compute: { module, entryPoint },
        })
        .then(
          (pipeline) => ({ ok: true, pipeline }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        );
      const scoped = await ctx.device.popErrorScope();

      if (!created.ok) {
        log.error("composite pipeline creation failed", {
          entryPoint,
          error: String(created.error),
        });
        throw new CompositeError(
          `the ${entryPoint} pipeline could not be created: ${String(created.error)}`,
        );
      }
      if (scoped !== null) {
        log.error("composite pipeline validation error", {
          entryPoint,
          error: scoped.message,
        });
        throw new CompositeError(`the ${entryPoint} pipeline is invalid: ${scoped.message}`);
      }
      return { pipeline: created.pipeline, layout };
    };

    // Both compiled up front, for the reason the class comment gives: a
    // pipeline that had to compile mid-render would stall the frame it was
    // meant to serve, and the frame a mask is first switched on is exactly the
    // frame somebody is watching.
    const plain = await compile("composite", false);
    const masked = await compile("composite_masked", true);

    log.info("composite program compiled", {
      pipelines: 2,
      ms: Math.round((performance.now() - started) * 100) / 100,
    });
    return new CompositeProgram(ctx, buffers, plain, masked);
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

    const mask = request.mask ?? null;
    const maskTexture = request.maskTexture ?? null;
    const needsImage = mask !== null && maskNeedsImage(mask);

    // Both directions, and both refuse rather than default. A mask picture with
    // no image mask would be a texture bound for nobody; an image mask with no
    // picture would have to fall back to full coverage, which is a mask that
    // silently is not one — exactly the class of failure the opacity sliders
    // were removed over.
    if (needsImage && maskTexture === null) {
      throw new CompositeError(
        `composite at ${request.label}: the mask reads a picture and none was supplied`,
      );
    }
    if (!needsImage && maskTexture !== null) {
      throw new CompositeError(
        `composite at ${request.label}: a mask picture was supplied and this node's mask does not read one`,
      );
    }
    if (maskTexture !== null) {
      const shape: Extent = { width: maskTexture.width, height: maskTexture.height };
      if (!extentsEqual(shape, extent)) {
        throw new CompositeError(
          `composite at ${request.label}: the mask texture is ${describeExtent(shape)} and the composite covers ${describeExtent(extent)}; coverage is per pixel, so the two have to name the same grid`,
        );
      }
      if (maskTexture === request.output) {
        throw new CompositeError(
          `composite at ${request.label}: the mask texture is also the output texture`,
        );
      }
    }

    const uniforms = new ArrayBuffer(UNIFORM_BYTES);
    const view = new DataView(uniforms);
    view.setUint32(0, extent.width, true);
    view.setUint32(4, extent.height, true);
    view.setUint32(8, ordinal, true);
    view.setFloat32(12, request.opacity, true);
    packMask(view, mask);

    // One uniform buffer per node, rewritten in place, for the same reason
    // every pass has one: a slider drag re-runs this dozens of times a second.
    const buffer = this.#buffers.uniform(`${request.label}/composite`, UNIFORM_BYTES);
    this.#ctx.device.queue.writeBuffer(buffer, 0, uniforms);

    const compiled = needsImage ? this.#masked : this.#plain;
    const bindGroup = this.#ctx.device.createBindGroup({
      label: `composite @ ${request.label}`,
      layout: compiled.layout,
      entries: [
        { binding: BINDING.base, resource: request.base.createView() },
        { binding: BINDING.output, resource: request.output.createView() },
        {
          binding: BINDING.uniforms,
          resource: { buffer, offset: 0, size: UNIFORM_BYTES },
        },
        { binding: BINDING.top, resource: request.top.createView() },
        ...(maskTexture === null
          ? []
          : [{ binding: BINDING.mask, resource: maskTexture.createView() }]),
      ],
    });

    compute.setPipeline(compiled.pipeline);
    compute.setBindGroup(0, bindGroup);
    compute.dispatchWorkgroups(
      Math.ceil(extent.width / WORKGROUP),
      Math.ceil(extent.height / WORKGROUP),
      1,
    );

    this.#composites += 1;
    if (mask !== null) this.#maskedComposites += 1;
    log.debug("composite encoded", {
      node: request.label,
      blend: request.blend,
      opacity: request.opacity,
      mask: mask?.source.kind ?? "none",
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

  stats(): { readonly composites: number; readonly masked: number } {
    return { composites: this.#composites, masked: this.#maskedComposites };
  }
}

/**
 * The mask half of the uniform block, at byte 16.
 *
 * Five generic `f32` slots rather than three named layouts, because a uniform
 * buffer's layout is fixed when the pipeline is created and three layouts would
 * be three pipelines for one program. What each slot means per kind is stated
 * in `_composite.wgsl` beside the code that reads them, and the two are one
 * edit apart on purpose.
 */
function packMask(view: DataView, mask: NodeMask | null): void {
  if (mask === null) {
    view.setUint32(16, MASK_NONE, true);
    return;
  }
  view.setUint32(16, MASK_KIND_ORDINAL[mask.source.kind], true);
  view.setUint32(20, mask.invert ? 1 : 0, true);

  const source = mask.source;
  switch (source.kind) {
    case "luminance":
      view.setFloat32(24, source.low, true);
      view.setFloat32(28, source.high, true);
      view.setFloat32(32, source.feather, true);
      break;
    case "color": {
      // Converted here, once per node, rather than per invocation: the target
      // does not vary across the frame and OKLab costs three cube roots.
      const target = resolveColorTarget(source.color);
      view.setFloat32(24, target.l, true);
      view.setFloat32(28, target.a, true);
      view.setFloat32(32, target.b, true);
      view.setFloat32(36, source.tolerance, true);
      view.setFloat32(40, source.feather, true);
      break;
    }
    case "image":
      view.setUint32(44, MASK_CHANNEL_ORDINAL[source.channel], true);
      break;
  }
}
