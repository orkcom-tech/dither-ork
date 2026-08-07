/**
 * F-EX-12 — the integer scale multiplier, nearest-neighbour, independent of
 * preview zoom.
 *
 * Two words in that requirement do all the work.
 *
 * **Integer.** A non-integer multiplier cannot replicate pixels evenly, so some
 * output pixels would come from one source pixel and their neighbours from two.
 * On a photograph nobody would see it; on a 4-colour Bayer dither it is a
 * visible beat pattern through the whole image, because the pattern's period
 * and the resampling period interfere. The control is a stepper, not a slider,
 * for that reason.
 *
 * **Independent.** The viewport's zoom is a way of looking at the picture and
 * lives in `viewport/view.ts`; this is a property of the file. Nothing in this
 * module can reach the viewport and nothing in the viewport can reach this. A
 * person exporting pixel art at 4x must not have to zoom the preview to 400%,
 * and — the case that would actually bite — a person who *has* zoomed to 400%
 * to look closely must not get a 4x file they did not ask for.
 *
 * The operation is pixel replication and nothing else: every output pixel is a
 * byte-for-byte copy of a pixel that was on screen. No filtering, no averaging,
 * no gamma-aware resampling — all three would invent colours the palette does
 * not contain, which for an indexed output would also mean the export could no
 * longer be indexed.
 */

import type { Bytes, ExportFrame } from "./types";
import { shouldYield, throwIfCancelled, yieldToHost } from "./progress";

export interface ScaleOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
}

export interface ScaledImage {
  readonly width: number;
  readonly height: number;
  readonly data: Bytes;
}

/**
 * Replicate each pixel into a `scale` by `scale` block.
 *
 * A scale of 1 still copies. Returning the frame's own buffer would hand a
 * caller a view onto memory the viewport is also holding, and the next stage
 * (the matte flatten) writes in place — which would mean an export with a
 * flatten silently editing the picture on screen.
 */
export async function scaleNearest(
  frame: ExportFrame,
  scale: number,
  options: ScaleOptions = {},
): Promise<ScaledImage> {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new RangeError(`the export scale must be a positive integer, got ${scale}`);
  }
  const { width, height, data } = frame;
  if (data.length !== width * height * 4) {
    throw new RangeError(
      `expected ${width * height * 4} bytes for ${width}x${height} RGBA, got ${data.length}`,
    );
  }

  const outWidth = width * scale;
  const outHeight = height * scale;
  const outRowBytes = outWidth * 4;
  const out = new Uint8Array(outRowBytes * outHeight);
  const row = new Uint8Array(outRowBytes);
  let mark = performance.now();

  for (let y = 0; y < height; y += 1) {
    const sourceAt = y * width * 4;
    // One scaled row is built once and then blitted `scale` times. The vertical
    // repeat is a `set` of a contiguous run, which is memcpy; doing it per pixel
    // instead is the same bytes at a tenth of the speed.
    for (let x = 0; x < width; x += 1) {
      const from = sourceAt + x * 4;
      const r = data[from] ?? 0;
      const g = data[from + 1] ?? 0;
      const b = data[from + 2] ?? 0;
      const a = data[from + 3] ?? 0;
      let to = x * scale * 4;
      for (let repeat = 0; repeat < scale; repeat += 1) {
        row[to] = r;
        row[to + 1] = g;
        row[to + 2] = b;
        row[to + 3] = a;
        to += 4;
      }
    }

    const base = y * scale;
    for (let repeat = 0; repeat < scale; repeat += 1) {
      out.set(row, (base + repeat) * outRowBytes);
    }

    if (shouldYield(mark)) {
      throwIfCancelled(options.signal);
      options.onProgress?.(y / height);
      await yieldToHost();
      mark = performance.now();
    }
  }

  options.onProgress?.(1);
  return { width: outWidth, height: outHeight, data: out };
}
