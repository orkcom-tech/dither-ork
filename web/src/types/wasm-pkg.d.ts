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

  /** Newline-separated ids of every registered error-diffusion kernel. */
  export function kernel_ids(): string;

  export class DitherOutput {
    readonly width: number;
    readonly height: number;
    /** 8-bit sRGB RGBA. Getters copy out of WASM memory — read once, hold it. */
    readonly pixels: Uint8Array;
    /** One palette index per pixel. */
    readonly indices: Uint16Array;
    free(): void;
  }

  /**
   * Throws on buffer/dimension mismatch, an empty or misaligned palette, an
   * unknown kernel id, or an unknown metric.
   *
   * `metric` is a look control, not a correctness switch: "oklab" is
   * perceptually correct, "srgb" reproduces period-accurate tools.
   */
  export function dither_image(
    rgba: Uint8Array,
    width: number,
    height: number,
    palette_rgb: Uint8Array,
    kernel_id: string,
    strength: number,
    serpentine: boolean,
    metric: "oklab" | "srgb",
  ): DitherOutput;
}
