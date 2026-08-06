/**
 * The WebGPU pass layer.
 *
 * Roughly 48 of the 63 effects are per-pixel independent and run as WebGPU
 * compute passes; the ~15 error-diffusion kernels are inherently serial and run
 * in WASM. This file is the contract between those parallel effects and the
 * pass compiler that schedules them.
 *
 * Compute rather than fragment shaders throughout: pixel sort, block shuffle,
 * histograms and every index-map operation need storage buffers, workgroup
 * control and atomics, none of which a fragment shader has.
 *
 * WebGPU is a hard requirement with no WebGL2 fallback (see
 * docs/ARCHITECTURE.md, "Platform support policy"), so nothing here has a
 * second code path.
 */

import type { ParameterValue } from "./document";
import type { ParamDescriptor } from "./registry";

/**
 * Where a pass reads from, which decides how it may be scheduled.
 *
 * - `pointwise` — reads only its own pixel. Input and output may alias, so the
 *   compiler can skip allocating a second texture.
 * - `neighbourhood` — reads a bounded window around its pixel (blur, edge
 *   detect, dilate). Must not alias its input, and must not start before the
 *   previous pass has finished writing.
 * - `global` — reads or writes arbitrary pixels, or uses atomics (pixel sort,
 *   block shuffle, histograms). Same constraints as `neighbourhood`, and it
 *   cannot be reordered against anything.
 */
export type PassAccess = "pointwise" | "neighbourhood" | "global";

// --- extent -------------------------------------------------------------
//
// Until this section existed, every buffer in a chain had the same size and the
// renderer could carry one working resolution for the whole stack. That is the
// assumption F-PP-01 breaks: the internal-resolution factor is both the main
// performance lever and the mechanism that crushes detail without changing the
// output resolution (docs/ARCHITECTURE.md), and it works by running the middle
// of the stack smaller than the ends. F-SP-14 and F-EX-12 break it the other
// way. So a pass has to be able to say that what it writes is not the shape of
// what it reads, and every layer that allocates, binds, dispatches or hashes
// has to read that declaration rather than assume.

/** A working extent in texels. Both dimensions are positive integers. */
export interface Extent {
  readonly width: number;
  readonly height: number;
}

/**
 * Which axes a resampling rule touches.
 *
 * `x` and `y` exist because separable resampling — the standard way to
 * implement Lanczos, which F-PP-01 names — is two passes, each scaling one
 * axis. A rule that could only scale both would force a 2D gather and make the
 * separable implementation inexpressible rather than merely unchosen.
 */
export type ExtentAxes = "both" | "x" | "y";

/**
 * How the extent a pass writes relates to the extent it reads.
 *
 * Expressed as a rule over one of the node's own parameters rather than as a
 * number, because the factor is a document value the user drags and the extent
 * has to follow it without anything re-declaring the pass. The rule is resolved
 * by `web/src/gpu/extent.ts`, which is the only place the arithmetic lives.
 *
 * Both resizing kinds read an **integer** factor of at least 1. A fractional
 * internal-resolution factor would make the output extent a rounding decision
 * taken in three places — texture allocation, dispatch, and the shader's own
 * coordinate mapping — and those three disagreeing is a one-texel seam nobody
 * can attribute.
 */
export type PassExtent =
  /** Output is the input, texel for texel. Every pass but the resamplers. */
  | { readonly kind: "same" }
  /**
   * Output is the input divided by the factor, rounded **up**, floored at 1
   * texel. Rounding up rather than down because a box or Lanczos filter's last
   * output texel legitimately covers a partial source window, and rounding down
   * would drop that column of the image entirely; the floor is what stops a
   * narrow image from resolving to a zero-width texture. F-PP-01.
   */
  | {
      readonly kind: "downscale";
      /** Key of an `int` parameter on this node holding the factor. */
      readonly factorParam: string;
      /** Defaults to `both`. */
      readonly axes?: ExtentAxes;
    }
  /** Output is the input multiplied by the factor. F-SP-14, F-EX-12. */
  | {
      readonly kind: "upscale";
      readonly factorParam: string;
      readonly axes?: ExtentAxes;
    };

/** What a pass means when it declares no extent rule. */
export const SAME_EXTENT: PassExtent = { kind: "same" };

/** Scalar and vector types a uniform field may take. */
export type UniformFieldType =
  | "f32"
  | "i32"
  | "u32"
  | "vec2f"
  | "vec3f"
  | "vec4f";

/**
 * Values the compiler supplies rather than reading from the node's parameters.
 *
 * `normalized-time` is `frame / clock.frames` and never reaches 1, so a shader
 * that animates on it loops by construction. `seed` is the node's resolved
 * document seed — a shader that needs randomness derives it from this and the
 * pixel coordinate, never from a clock (F-AN-05).
 *
 * `width`/`height` are the extent the pass **reads**, and `output-width`/
 * `output-height` the extent it **writes**. They are equal for every pass that
 * does not declare a {@link PassExtent}, which is why the two that existed
 * first kept their names: no shader in the catalogue changes, and a resampler
 * is the only kind of pass that has to name both.
 */
export type UniformBuiltin =
  | "width"
  | "height"
  | "output-width"
  | "output-height"
  | "normalized-time"
  | "seed"
  | "palette-size";

export type UniformSource =
  /** A parameter key from the effect's registry descriptor. */
  | { readonly kind: "param"; readonly key: string }
  | { readonly kind: "builtin"; readonly name: UniformBuiltin };

/**
 * One field in the uniform buffer, at an explicit byte offset.
 *
 * Offsets are declared rather than derived because WGSL's uniform address space
 * uses std140-style alignment — a `vec3f` is 12 bytes of data with 16-byte
 * alignment, and a struct rounds up to 16 — so a packer that lays fields out
 * sequentially writes to addresses the shader does not read from, and the
 * symptom is a wrong-looking image rather than an error. Stating the offset
 * makes the two sides agree by construction, and makes a mismatch a diff in one
 * file.
 */
export interface UniformField {
  readonly source: UniformSource;
  readonly type: UniformFieldType;
  /** Byte offset from the start of the buffer. Must satisfy WGSL alignment. */
  readonly offset: number;
}

export interface UniformLayout {
  /** Total buffer size. Must be a multiple of {@link UNIFORM_ALIGNMENT}. */
  readonly sizeBytes: number;
  readonly fields: readonly UniformField[];
}

/** WGSL rounds a uniform struct's size up to this. */
export const UNIFORM_ALIGNMENT = 16;

/**
 * How much scratch storage a pass needs.
 *
 * Declared as a rule rather than a number because the working resolution
 * changes between preview and export, and a histogram sized for the preview
 * silently truncates the export.
 */
export type ScratchSize =
  | { readonly kind: "fixed"; readonly bytes: number }
  | { readonly kind: "per-pixel"; readonly bytesPerPixel: number }
  | { readonly kind: "per-row"; readonly bytesPerRow: number };

// --- per-node bulk data --------------------------------------------------
//
// A `table` binding is read-only data the **effect** ships: the same bytes for
// every node that uses that effect, uploaded once when the pipeline is
// compiled. That covers the glyph sheet and the blue-noise tile and nothing
// else, and the two requirements it does not cover are the two that need a
// buffer belonging to **one node instance**:
//
// - F-PP-05 curves: a 256-entry transfer LUT sampled from this node's own
//   `curve` parameter, which changes on every drag of the spline editor.
// - F-PP-07 threshold map: a tile decoded from an image the user uploaded for
//   this node, which is not expressible as a `ParameterValue` at all.
//
// Both arrive through {@link InstanceDataBinding}. The second is the reason the
// digest exists: bytes that come from outside the parameter set are invisible
// to the content hash unless something puts them there, and a node whose bulk
// data changed while its hash did not shows a stale cached frame — precisely
// the failure the hash is for.

/**
 * Everything a node's bulk data may be built from.
 *
 * `supplied` is the channel for bytes the parameter vocabulary cannot express.
 * It is `null` when the document carries none for this slot, and a builder that
 * cannot work without it refuses rather than substituting something plausible.
 */
export interface InstanceDataInput {
  readonly nodeId: string;
  readonly params: Readonly<Record<string, ParameterValue>>;
  /**
   * The effect's own parameter descriptors, keyed by parameter key. Needed for
   * the same reason `packUniforms` needs them: an enum's document value is a
   * string and only the descriptor knows its ordinal.
   */
  readonly paramTypes: ReadonlyMap<string, ParamDescriptor>;
  readonly seed: number;
  /** Bytes the document carries for this node under this slot (F-PP-07). */
  readonly supplied: Uint8Array | null;
}

/** One node's resolved bulk data, ready to bind. */
export interface InstanceData {
  readonly slot: string;
  readonly bytes: Uint8Array;
  /**
   * Digest of `bytes`. The GPU buffer for this slot is rewritten only when it
   * changes, so a slider drag that leaves the LUT alone costs no upload.
   */
  readonly digest: string;
}

/**
 * Bulk data one node instance supplies to its own pass.
 *
 * `build` is a function because the bytes are a function of the node, and the
 * node does not exist when the pass is declared. It must be **pure** in its
 * argument: the same input produces the same bytes on every thread and every
 * build, or the determinism test that renders one frame in two workers stops
 * meaning anything.
 */
export interface InstanceDataBinding {
  readonly role: "instance-data";
  readonly binding: number;
  /**
   * Names the buffer within the node, so successive passes of one effect can
   * read the same LUT and two slots of one pass cannot collide.
   */
  readonly slot: string;
  /**
   * Whether {@link InstanceDataInput.supplied} must be present.
   *
   * `required` is F-PP-07's case and is declared rather than discovered: a node
   * with no uploaded image must fail naming the slot, not render whatever a
   * builder decided to return from nothing.
   */
  readonly supplied: "required" | "none";
  readonly build: (input: InstanceDataInput) => Uint8Array;
}

/**
 * One entry in the pass's single bind group.
 *
 * All bindings sit in group 0. One group per pass keeps the layout a pure
 * function of the descriptor, so it is built once at compile time and reused
 * for every dispatch instead of being rebuilt per frame.
 */
export type PassBinding =
  /** The linear-light RGBA input. */
  | { readonly role: "input-color"; readonly binding: number }
  /** The linear-light RGBA output. */
  | { readonly role: "output-color"; readonly binding: number }
  /**
   * The index map. Only legal on a pass whose effect declares
   * `requiresIndexMap`, and the compiler rejects it otherwise rather than
   * binding an empty texture.
   */
  | { readonly role: "input-index"; readonly binding: number }
  | { readonly role: "output-index"; readonly binding: number }
  /** Packed palette colours, linear light. */
  | { readonly role: "palette"; readonly binding: number }
  | { readonly role: "uniforms"; readonly binding: number }
  /**
   * Working storage. `slot` names it so successive passes of one effect can
   * share it — a histogram written by pass 0 and read by pass 1 is the same
   * buffer, not two.
   */
  | {
      readonly role: "scratch";
      readonly binding: number;
      readonly slot: string;
      readonly access: "read" | "read-write";
      readonly size: ScratchSize;
    }
  /**
   * Read-only data the effect ships — a blue-noise tile (F-OD-05), a glyph
   * sheet (F-PT-08). Uploaded once when the pipeline is compiled; it does not
   * change per frame or per parameter.
   *
   * For data that belongs to one *node* rather than to the effect, see
   * {@link InstanceDataBinding}.
   */
  | { readonly role: "table"; readonly binding: number; readonly data: Uint8Array }
  /** Read-only data one node builds from its own state. See {@link InstanceDataBinding}. */
  | InstanceDataBinding;

/**
 * How many workgroups to dispatch.
 *
 * `per-row` and `per-column` exist because pixel sort (F-GL-01) and row/column
 * displacement (F-GL-02, F-GL-03) are one independent problem per line, not one
 * per pixel; dispatching per pixel for those wastes most of the invocations on
 * a bounds check.
 */
export type DispatchShape =
  | { readonly kind: "per-pixel" }
  | { readonly kind: "per-row" }
  | { readonly kind: "per-column" }
  | { readonly kind: "fixed"; readonly workgroups: readonly [number, number, number] };

/**
 * Largest workgroup size guaranteed across WebGPU implementations
 * (`maxComputeInvocationsPerWorkgroup`). A pass whose declared workgroup
 * dimensions multiply above this is rejected at compile time rather than
 * failing on one vendor's driver.
 */
export const MAX_PORTABLE_WORKGROUP_INVOCATIONS = 256;

/**
 * One compute dispatch: the unit an effect provides and the compiler schedules.
 *
 * The WGSL is complete and constant — no includes, no strings assembled at
 * runtime — so a module can be compiled once and cached by `id`, and so a
 * shader compilation error names a line in a real file.
 */
export interface ComputePass {
  /** Unique across the whole GPU layer; the shader module cache keys on it. */
  readonly id: string;
  readonly label: string;
  readonly wgsl: string;
  readonly entryPoint: string;
  /** `@workgroup_size` in the WGSL, restated so the compiler can size dispatches. */
  readonly workgroupSize: readonly [x: number, y: number, z: number];
  readonly dispatch: DispatchShape;
  readonly access: PassAccess;
  readonly bindings: readonly PassBinding[];
  readonly uniforms: UniformLayout;
  /**
   * How the extent this pass writes relates to the extent it reads.
   *
   * Optional, and absent means {@link SAME_EXTENT}. Optional rather than
   * required because 63 effects declare a pass and exactly two of them resize;
   * making every one of them restate "same" would put the interesting
   * declaration where nobody looks. The compiler still validates it, and a pass
   * that resizes has to satisfy three further rules — see
   * `web/src/gpu/compiler.ts`.
   */
  readonly extent?: PassExtent;
}

/**
 * What a parallel effect provides.
 *
 * More than one pass because several effects genuinely need multiple
 * dispatches — a histogram pass before a mapping pass, a per-row sort before a
 * gather. The scheduler flattens all of them, so a multi-pass effect coalesces
 * with its neighbours exactly like a single-pass one.
 */
export interface GpuEffect {
  /** Effect id from the node registry. */
  readonly effect: string;
  readonly passes: readonly ComputePass[];
}

// --- scheduling ---------------------------------------------------------

/** A pass bound to one node at one resolution, ready to encode. */
export interface ScheduledPass {
  readonly nodeId: string;
  readonly pass: ComputePass;
  /** Uniform bytes packed exactly per {@link ComputePass.uniforms}. */
  readonly uniforms: ArrayBuffer;
  /** The extent this pass **reads**. */
  readonly width: number;
  readonly height: number;
  /**
   * The extent this pass **writes**, when it differs from the one it reads.
   *
   * Absent means "the same", which is what every pass in the catalogue but a
   * resampler means. It is resolved here rather than by the executor because
   * resolving it needs the node's parameters and the executor has only the
   * packed uniform bytes; the executor checks the two agree and refuses a pass
   * that declares a {@link PassExtent} without one.
   */
  readonly output?: Extent;
  /**
   * Bulk data this node built for itself, one entry per
   * {@link InstanceDataBinding} across this pass. Absent when the pass declares
   * none.
   */
  readonly instances?: readonly InstanceData[];
}

/**
 * A run of passes encoded into one command buffer and sent with one
 * `queue.submit`.
 *
 * A batch is a maximal run of consecutive `gpu` nodes. The first `wasm` node
 * after it ends the batch, because a serial kernel needs the finished pixels in
 * CPU memory: the batch is submitted, read back, run, and uploaded again. Each
 * of those crossings is a {@link BoundaryCrossing} and each is logged, because
 * the number of boundary crossings — not the pass count — is what sets the
 * ceiling on how live the preview feels.
 *
 * Passes inside a batch still run in order; WebGPU orders compute passes within
 * a command buffer, so a `neighbourhood` or `global` pass sees everything
 * written before it.
 */
export interface PassBatch {
  readonly label: string;
  readonly passes: readonly ScheduledPass[];
}

/**
 * One GPU/CPU transfer, as logged. The known performance trap has to be
 * readable from the console rather than found with a profiler.
 */
export interface BoundaryCrossing {
  readonly nodeId: string;
  readonly direction: "readback" | "upload";
  readonly bytes: number;
  readonly ms: number;
}
