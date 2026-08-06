/**
 * Ambient declaration for the generated WASM package.
 *
 * `web/src/wasm/pkg` is produced by the `wasm` compose service and is not
 * committed, so a clean checkout has no types for it and `tsc --noEmit` would
 * fail before the first build. This declaration keeps the typecheck honest in
 * that state.
 *
 * TypeScript only falls back to a wildcard module declaration when real module
 * resolution fails, so once the package is built, its own generated `.d.ts`
 * takes precedence and this file goes unused. Keep the two in sync: it mirrors
 * the surface documented in docs/API.md, section 1.
 */
declare module "*/dither_wasm.js" {
  /** Instantiates the module. Must be awaited before any other call. */
  export default function init(
    module_or_path?: string | URL | Request | Response | BufferSource | WebAssembly.Module,
  ): Promise<unknown>;

  /** Version of the compiled core, for detecting a stale WASM build. */
  export function version(): string;

  /**
   * Colour distance metric. A look control, not a correctness switch: `Oklab`
   * is perceptually correct, `Srgb` reproduces what period-accurate tools did
   * by doing the maths in gamma space.
   */
  export enum ColorMetric {
    Oklab = 0,
    Srgb = 1,
  }

  /** Whether error is diffused per channel or as one luminance term (F-ED-CTL). */
  export enum DiffusionChannels {
    PerChannel = 0,
    Luma = 1,
  }

  /** Which extraction algorithm to run (F-CO-02). */
  export enum ExtractMethod {
    MedianCut = 0,
    Wu = 1,
    KMeans = 2,
  }

  /**
   * A `wasm-bindgen` handle. Every getter copies out of WASM memory, and the
   * object holds linear memory until `free()` is called — read each getter once
   * and release the handle.
   */
  interface WasmHandle {
    free(): void;
  }

  /** One registered diffusion kernel. */
  export class KernelInfo implements WasmHandle {
    /** Stable id; `.dork` documents and share URLs carry it. */
    readonly id: string;
    /** Display name. Free to change; nothing is keyed on it. */
    readonly name: string;
    free(): void;
  }

  /** Every registered error-diffusion kernel, in catalogue order. */
  export function kernels(): KernelInfo[];

  /** One shipped hardware palette (F-CO-04). */
  export class PaletteInfo implements WasmHandle {
    readonly id: string;
    readonly name: string;
    /** Packed 8-bit sRGB triplets. */
    readonly srgb: Uint8Array;
    free(): void;
  }

  /** Every built-in hardware palette, in catalogue order. */
  export function builtinPalettes(): PaletteInfo[];

  /**
   * Every control of F-ED-CTL, as one object. Throws from the constructor on an
   * unrecognised kernel id; range violations are reported by `ditherImage`.
   */
  export class DitherOptions implements WasmHandle {
    constructor(kernel_id: string);
    /** Id of the kernel these options were built for. */
    readonly kernelId: string;
    /** 0..=1. 0 is plain nearest-colour quantization. */
    strength: number;
    /** Alternate scan direction per row. Ignored by Riemersma. */
    serpentine: boolean;
    /** Seeded threshold jitter, 0..=1. */
    jitter: number;
    /** Seed for the jitter draws. 64 bits, so a `BigInt`. */
    seed: bigint;
    /** How far outside `[0, 1]` an accumulated working value may travel. */
    overshootLimit: number;
    channels: DiffusionChannels;
    metric: ColorMetric;
    free(): void;
  }

  export class DitherOutput implements WasmHandle {
    readonly width: number;
    readonly height: number;
    /** 8-bit sRGB RGBA. */
    readonly pixels: Uint8Array;
    /** One palette index per pixel. */
    readonly indices: Uint16Array;
    free(): void;
  }

  /**
   * Throws on a buffer/dimension mismatch, an empty or misaligned palette, a
   * palette a `u16` index map cannot address, or an out-of-range control.
   */
  export function ditherImage(
    rgba: Uint8Array,
    width: number,
    height: number,
    palette_rgb: Uint8Array,
    options: DitherOptions,
  ): DitherOutput;

  /** Extraction settings (F-CO-02). */
  export class ExtractOptions implements WasmHandle {
    constructor();
    method: ExtractMethod;
    /** Requested palette size; the result may be smaller. */
    k: number;
    /** Explicit 64-bit seed. Only k-means draws from it today. */
    seed: bigint;
    /** Ceiling on Lloyd iterations. Ignored by the single-pass methods. */
    maxIterations: number;
    free(): void;
  }

  export class ExtractedPalette implements WasmHandle {
    /** Packed 8-bit sRGB triplets, ready to hand back to `ditherImage`. */
    readonly srgb: Uint8Array;
    /** One palette index per source pixel. */
    readonly indices: Uint16Array;
    /** Pixels matched to each entry; the input to a population sort. */
    readonly populations: Uint32Array;
    readonly paletteLen: number;
    readonly occupiedBins: number;
    readonly iterations: number;
    readonly emptyClusterRepairs: number;
    readonly emptyClustersDropped: number;
    free(): void;
  }

  /**
   * Throws on a buffer/dimension mismatch, a `k` outside `1..=65536`, or
   * `maxIterations` of zero.
   */
  export function extractPalette(
    rgba: Uint8Array,
    width: number,
    height: number,
    options: ExtractOptions,
  ): ExtractedPalette;

  /**
   * Bayer ranks, row-major, a permutation of `0 .. size*size - 1`
   * (F-OD-01..04). Throws unless `size` is a power of two of at least 2.
   */
  export function bayerRanks(size: number): Uint32Array;

  /**
   * Void-and-cluster blue-noise ranks (F-OD-05). Throws unless `size` is a
   * power of two of at least 4. `O(size^4)` — build once and cache.
   */
  export function blueNoiseRanks(size: number, seed: bigint): Uint32Array;
}
