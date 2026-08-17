/**
 * The render graph.
 *
 * A document compiles to a DAG. It is linear today; it is typed as a DAG so
 * node groups (F-ST-05) and node masking (F-PP-08) do not need a second engine
 * later. Preview and export share this one graph and differ only in resolution
 * and whether degradation is allowed — two rendering paths would mean two
 * different-looking outputs.
 *
 * See docs/ARCHITECTURE.md, "Render graph" and "Data layout".
 */

import type { BlendMode, NodeMask, Palette, ParameterValue } from "./document";
import type { ExecutionKind } from "./registry";

// --- buffers ------------------------------------------------------------

/**
 * Linear-light RGBA living on the GPU.
 *
 * `rgba16float` throughout: 8 bits cannot survive a stack of a dozen nodes in
 * linear light without banding in the shadows, and 32 bits doubles the
 * bandwidth for precision nothing in the pipeline can see.
 */
export interface GpuColorSurface {
  readonly residency: "gpu";
  readonly texture: GPUTexture;
  readonly format: "rgba16float";
}

/**
 * Linear-light RGBA living in WASM memory, planar `f32` — one contiguous array
 * per channel, each `width * height` long.
 *
 * Planar because the serial kernels walk one channel at a time and because
 * per-channel diffusion (F-ED-CTL) is then a choice of which planes to touch
 * rather than a strided access pattern.
 *
 * Alpha is unassociated. It is carried through the whole stack and never
 * silently composited onto white (F-IN-03).
 */
export interface CpuColorSurface {
  readonly residency: "cpu";
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Float32Array;
}

export type ColorSurface = GpuColorSurface | CpuColorSurface;

/**
 * The index map on the GPU.
 *
 * `r32uint` rather than a 16-bit format because WebGPU's storage-texture
 * formats do not include `r16uint`; the width is wasted memory bought to keep
 * the map addressable from a compute pass, which is what makes dilate/erode,
 * outline and hue-targeted recolour parallel at all.
 */
export interface GpuIndexSurface {
  readonly residency: "gpu";
  readonly texture: GPUTexture;
  readonly format: "r32uint";
}

/** The index map in WASM memory: one `u16` palette index per pixel. */
export interface CpuIndexSurface {
  readonly residency: "cpu";
  readonly data: Uint16Array;
}

export type IndexSurface = GpuIndexSurface | CpuIndexSurface;

/**
 * Whether the buffer has been quantized yet.
 *
 * After a quantizing node the pipeline carries **both** an RGBA buffer and an
 * index map — one palette index per pixel — and that pairing is what makes
 * hue-targeted recolour, index remap, outline, dilate/erode and the SVG tracer
 * lossless and cheap. Carrying it is a deliberate memory cost.
 *
 * Modelled as a union so an index map can never exist without the palette it
 * indexes into, and so a node that requires one (see
 * `EffectDescriptor.requiresIndexMap`) has a single thing to check.
 */
export type Quantization =
  | { readonly kind: "continuous" }
  | {
      readonly kind: "indexed";
      readonly indices: IndexSurface;
      /**
       * The palette the indices refer to. Carried rather than read from the
       * document because a node may override it (F-CO-07), so the document
       * palette is not always the right answer.
       */
      readonly palette: Palette;
    };

/**
 * What flows between nodes.
 *
 * Colour and index map may sit on different sides of the GPU/CPU boundary
 * mid-stack; the scheduler is what reconciles that, and every crossing it
 * forces is logged with its transfer size.
 */
export interface FrameBuffer {
  readonly width: number;
  readonly height: number;
  readonly color: ColorSurface;
  readonly quantization: Quantization;
  /**
   * Content hash of the node that produced this buffer. Carried on the buffer
   * because the next node's own hash is computed from it.
   */
  readonly hash: ContentHash;
}

// --- nodes --------------------------------------------------------------

/**
 * An input port key.
 *
 * A `string` rather than a closed union, and that widening is the whole of what
 * multi-input changed in this file. The set of ports is a property of the
 * *effect*, declared as `EffectDescriptor.inputs` — a node that displaces one
 * picture by another names its second port `displace`, a node that blends two
 * chains names its second port `layer`, and neither can be enumerated here
 * without this file knowing the catalogue.
 *
 * Nothing accepts an arbitrary string in practice: `graph/ports.ts` resolves a
 * node's legal ports from its descriptor and `graph/topology.ts` refuses an
 * edge naming one the node does not declare. Two keys are fixed for every node
 * — `in`, the picture, and `mask`, spatially-varying opacity (F-PP-08) — and
 * both are constants in `types/registry.ts`.
 */
export type InputPort = string;

/** Output ports. One today; named so a node can grow a second without a schema change. */
export type OutputPort = "out";

export interface NodeOutputRef {
  readonly nodeId: string;
  readonly port: OutputPort;
}

export interface NodeInput {
  readonly port: InputPort;
  readonly from: NodeOutputRef;
}

/**
 * One node in the compiled graph.
 *
 * This is the document's `StackNode` after edge resolution: same identity, same
 * parameters, plus where its inputs come from. Parameter values here are
 * already resolved for the frame being rendered — a bound parameter arrives as
 * the concrete number the modulator produced, not as the binding.
 */
export interface GraphNode {
  readonly id: string;
  /** Effect id from the node registry. */
  readonly effect: string;
  readonly enabled: boolean;
  readonly opacity: number;
  /** Blended against this node's own input, not against the layer below. */
  readonly blend: BlendMode;
  readonly params: Readonly<Record<string, ParameterValue>>;
  readonly seed: number;
  readonly inputs: readonly NodeInput[];
  /**
   * Spatially-varying opacity (F-PP-08), carried through from the document.
   *
   * Absent on an unmasked node, which is every node in every document written
   * before schema 2. When present and its source is `image`, the node has an
   * edge on its `mask` port and the composite reads that buffer; the other two
   * sources read the node's own input and need no edge.
   */
  readonly mask?: NodeMask;
}

/** Whether the render may degrade resolution to keep up (F-UI-03). */
export type RenderQuality = "preview" | "full";

export interface RenderGraph {
  readonly nodes: readonly GraphNode[];
  /** The output presented to the viewport. Solo (F-ST-02) moves it upstream. */
  readonly output: NodeOutputRef;
  /** Working resolution. The only thing that differs between preview and export. */
  readonly width: number;
  readonly height: number;
  readonly quality: RenderQuality;
  /** Frame index, already used to resolve bound parameters. */
  readonly frame: number;
}

// --- content hashing ----------------------------------------------------

/**
 * A node's content hash.
 *
 * Branded so a hash cannot be confused with a node id or any other string.
 * The only place that mints one is the hashing function itself, which casts
 * once; everything downstream passes the value along.
 */
export type ContentHash = string & { readonly __brand: "ContentHash" };

/**
 * Everything a node's output depends on.
 *
 * Node outputs are cached against the hash of this. Editing a parameter
 * invalidates that node and everything downstream, because every downstream
 * hash folds in its inputs' hashes; nothing upstream re-runs.
 *
 * What is deliberately *not* here:
 *
 * - **The frame index.** Bound parameters are resolved to concrete values
 *   before hashing, so a node whose parameters do not move produces the same
 *   hash on every frame and is computed once for the whole animation. That is
 *   the entire reason an N-frame export is far cheaper than N renders.
 * - **`enabled`.** A disabled node is not executed at all; its input passes
 *   through unchanged, carrying the input's own hash.
 *
 * What is here and is easy to forget: `opacity` and `blend`. They change the
 * pixels the node emits, so leaving them out would let an opacity drag show a
 * stale cached frame.
 */
export interface ContentHashInput {
  readonly effect: string;
  readonly params: Readonly<Record<string, ParameterValue>>;
  readonly seed: number;
  readonly opacity: number;
  readonly blend: BlendMode;
  /** Hashes of this node's inputs, in port order. */
  readonly inputs: readonly ContentHash[];
  /** Working resolution: the same stack at two sizes is two different results. */
  readonly width: number;
  readonly height: number;
}

/**
 * Must be a pure function of its argument, stable across builds and workers —
 * the determinism test renders one frame in two workers and compares bytes, and
 * a cache keyed on an unstable hash would defeat it silently rather than fail.
 */
export type ContentHashFn = (input: ContentHashInput) => ContentHash;

// --- cache --------------------------------------------------------------

export interface NodeCacheEntry {
  readonly hash: ContentHash;
  readonly buffer: FrameBuffer;
  /** Resident bytes, counted against the budget. */
  readonly bytes: number;
  /**
   * Monotonic tick of last use, for LRU. A counter rather than a clock reading:
   * nothing inside the graph reads a wall clock.
   */
  readonly lastUsed: number;
}

/**
 * Float buffers plus index maps plus a cache at export resolution will exhaust
 * memory if left alone, so the budget is explicit and eviction is a logged
 * event rather than a crash.
 */
export interface NodeCacheBudget {
  readonly maxBytes: number;
}

export interface CacheEviction {
  readonly hash: ContentHash;
  readonly bytes: number;
  /** `budget` is LRU pressure; `invalidated` is an upstream edit. */
  readonly reason: "budget" | "invalidated";
}

// --- instrumentation ----------------------------------------------------

/**
 * One node execution, as logged.
 *
 * `boundaryBytes` is the field the architecture cares about: each serial node
 * between GPU nodes costs a readback plus an upload, and that ceiling has to be
 * readable from the console rather than found by profiling.
 */
export interface NodeExecution {
  readonly nodeId: string;
  readonly effect: string;
  readonly execution: ExecutionKind;
  readonly cache: "hit" | "miss";
  readonly width: number;
  readonly height: number;
  readonly ms: number;
  /** Bytes moved across the GPU/CPU boundary for this node. Zero when none. */
  readonly boundaryBytes: number;
}
