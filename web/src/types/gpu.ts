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
 */
export type UniformBuiltin =
  | "width"
  | "height"
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
   */
  | { readonly role: "table"; readonly binding: number; readonly data: Uint8Array };

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
  readonly width: number;
  readonly height: number;
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
