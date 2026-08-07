/**
 * F-EX-04, the part that matters: **one palette for the whole loop, taken from
 * the pixels, never chosen.**
 *
 * The requirement says the document palette becomes the global colour table
 * directly, with no second quantization, and the reason is worth stating in
 * full because it is the difference between a GIF that is the picture and a GIF
 * that is a picture of the picture. The frames have already been quantized —
 * that is what the stack does — and quantizing them again at encode time would
 * dither a dither: a second nearest-colour pass over pixels that were placed by
 * the first one, producing exactly the muddy, drifting result the whole
 * pipeline exists to avoid.
 *
 * ## Why the census rather than `document.palette`
 *
 * `export/census.ts` argues at length that "indexed" is a fact about the
 * finished pixels and not about the graph, and every word of it applies here
 * and then some. A stack can put a bloom, an emboss or a chromatic aberration
 * after the quantizer, and each writes continuous colour over the top; the
 * document's palette would then be a list of colours that are *not what the
 * frames contain*, and encoding against it would mean matching every pixel to
 * its nearest entry — the second quantization the requirement forbids, arrived
 * at by trying to obey the requirement literally.
 *
 * So the palette is the set of distinct colours actually present, accumulated
 * across every frame. When the stack ends at a quantizer that set *is* the
 * document palette, entry for entry, which is the case the requirement is
 * written about. When it does not, this is the only answer that quantizes
 * nothing. And in both cases the encoding is exact: the table is built from the
 * values that are there.
 *
 * ## Above 256 it refuses
 *
 * There is no honest 256-colour version of a continuous-tone loop, so the
 * builder returns `null` and the caller reports it with the way out — put a
 * quantizing node in the stack, or export APNG, which has no such limit. It
 * does not posterize behind the user's back.
 *
 * The refusal is cheap. A loop whose frames are continuous tone reaches 257
 * colours within the first few hundred pixels of the first frame, so the whole
 * census over a 60-frame export ends after reading a couple of kilobytes.
 *
 * ## Alpha, which GIF has exactly one bit of
 *
 * Three cases, and each is handled as what it is:
 *
 * - **Opaque** — the colour goes in the table.
 * - **Fully transparent** — every such pixel shares one reserved entry, which
 *   is GIF's transparent index. One entry for the whole loop, not one per
 *   colour, because a transparent pixel has no colour.
 * - **Partly transparent** — composited onto the export matte through the same
 *   linear-light table JPEG's flatten uses, and reported as flattened. GIF has
 *   no partial coverage to store it in, and inventing one bit of alpha out of
 *   an eight-bit one by thresholding would put a hard edge where the picture
 *   has a soft one.
 */

import { logger } from "../../lib/log";
import { MAX_PALETTE_ENTRIES } from "../census";
import { EXPORT_MATTE, flattenOntoMatte } from "../flatten";
import { shouldYield, throwIfCancelled, yieldToHost } from "../progress";
import type { Bytes } from "../types";
import type { LoopPalette } from "./types";

const log = logger("export");

/**
 * Pixels to census, whoever owns them.
 *
 * Wider than {@link import("../types").ExportFrame}, whose `data` is a
 * `Uint8ClampedArray`, because half the callers hand over a scaled buffer this
 * module's own code allocated as a `Uint8Array`. Every byte is read and none is
 * written, so the distinction between the two — what happens on assignment out
 * of range — cannot matter here, and a cast at each call site to say so would be
 * a cast standing in for a signature.
 */
export interface PixelSource {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

export interface LoopIndexOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
}

/** What indexing one frame did, beside producing the indices. */
export interface FrameIndexResult {
  /** One palette index per pixel, at the frame's own resolution. */
  readonly indices: Bytes;
  /** True when partial alpha in this frame was composited onto the matte. */
  readonly flattened: boolean;
  /** True when this frame contained a fully transparent pixel. */
  readonly transparent: boolean;
}

/**
 * Accumulates one palette across a loop, and maps each frame onto it.
 *
 * Stateful because the palette is not known until the last frame has been seen
 * and the frames cannot be kept — the whole reason the GIF encoder buffers index
 * maps rather than pictures.
 */
export class LoopPaletteBuilder {
  /** Packed opaque RGB (24 bits) to table index, in first-seen order. */
  readonly #entries = new Map<number, number>();
  #transparentIndex = -1;
  #flattened = false;
  #frames = 0;

  /** Entries assigned so far, the transparent one included. */
  get size(): number {
    return this.#entries.size + (this.#transparentIndex < 0 ? 0 : 1);
  }

  /** True when any frame's partial alpha was composited onto the matte. */
  get flattened(): boolean {
    return this.#flattened;
  }

  get transparentIndex(): number {
    return this.#transparentIndex;
  }

  /**
   * Map one frame onto the accumulating palette.
   *
   * Returns `null` — never a partial or approximate table — the moment the loop
   * would need a 257th entry. The frames already indexed remain valid; the
   * caller abandons the export rather than continuing with a table that cannot
   * hold what is coming.
   */
  async index(
    frame: PixelSource,
    options: LoopIndexOptions = {},
  ): Promise<FrameIndexResult | null> {
    const pixels = frame.width * frame.height;
    if (pixels <= 0) return null;
    if (frame.data.length !== pixels * 4) {
      throw new RangeError(
        `expected ${pixels * 4} bytes for ${frame.width}x${frame.height} RGBA, got ${frame.data.length}`,
      );
    }

    // One cheap stride-4 pass first, so the usual case — a fully opaque frame —
    // pays nothing for alpha handling and never copies the buffer.
    let hasZero = false;
    let hasPartial = false;
    for (let at = 3; at < frame.data.length; at += 4) {
      const alpha = frame.data[at] ?? 0;
      if (alpha === 255) continue;
      if (alpha === 0) hasZero = true;
      else {
        hasPartial = true;
        break;
      }
    }

    // The composite runs on a copy: the frame belongs to the renderer's cache
    // and writing through it would change the picture the next frame is diffed
    // against. Fully transparent pixels are composited too and the result is
    // then ignored for them — they take the transparent entry — which is why
    // this can reuse the still path's flatten unchanged rather than needing a
    // second, subtly different one.
    let colours: Uint8Array | Uint8ClampedArray = frame.data;
    if (hasPartial) {
      const copy = new Uint8Array(frame.data) as Bytes;
      await flattenOntoMatte(copy, EXPORT_MATTE, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      colours = copy;
      this.#flattened = true;
    }

    const indices = new Uint8Array(pixels) as Bytes;
    let mark = performance.now();

    for (let i = 0; i < pixels; i += 1) {
      const at = i * 4;
      if ((frame.data[at + 3] ?? 0) === 0) {
        if (this.#transparentIndex < 0) {
          if (this.size === MAX_PALETTE_ENTRIES) return null;
          this.#transparentIndex = this.size;
        }
        indices[i] = this.#transparentIndex;
      } else {
        const key =
          (((colours[at] ?? 0) << 16) | ((colours[at + 1] ?? 0) << 8) | (colours[at + 2] ?? 0)) >>>
          0;
        let entry = this.#entries.get(key);
        if (entry === undefined) {
          if (this.size === MAX_PALETTE_ENTRIES) return null;
          entry = this.size;
          this.#entries.set(key, entry);
        }
        indices[i] = entry;
      }

      if (shouldYield(mark)) {
        throwIfCancelled(options.signal);
        options.onProgress?.(i / pixels);
        await yieldToHost();
        mark = performance.now();
      }
    }

    options.onProgress?.(1);
    this.#frames += 1;
    return { indices, flattened: hasPartial, transparent: hasZero };
  }

  /**
   * The finished table.
   *
   * Entries come out in the order they were first seen, which makes the palette
   * a deterministic function of the pixels — the same loop always produces the
   * same table in the same order, which is what lets a golden test exist at all.
   */
  palette(): LoopPalette {
    const count = this.size;
    const rgba = new Uint8Array(count * 4) as Bytes;
    for (const [key, entry] of this.#entries) {
      const at = entry * 4;
      rgba[at] = (key >>> 16) & 0xff;
      rgba[at + 1] = (key >>> 8) & 0xff;
      rgba[at + 2] = key & 0xff;
      rgba[at + 3] = 255;
    }
    if (this.#transparentIndex >= 0) {
      // The matte's own colour, at zero alpha. A viewer that ignores the
      // transparency shows the same thing the JPEG of this frame would.
      const at = this.#transparentIndex * 4;
      rgba[at] = EXPORT_MATTE[0];
      rgba[at + 1] = EXPORT_MATTE[1];
      rgba[at + 2] = EXPORT_MATTE[2];
      rgba[at + 3] = 0;
    }

    log.info("loop palette built", {
      entries: count,
      frames: this.#frames,
      transparentIndex: this.#transparentIndex,
      flattened: this.#flattened,
    });
    return { rgba, count, transparentIndex: this.#transparentIndex };
  }
}

/** The palette's RGB triplets, which is what GIF's colour table takes. */
export function paletteAsRgbTriplets(palette: LoopPalette): Bytes {
  const rgb = new Uint8Array(palette.count * 3) as Bytes;
  for (let entry = 0; entry < palette.count; entry += 1) {
    const from = entry * 4;
    const to = entry * 3;
    rgb[to] = palette.rgba[from] ?? 0;
    rgb[to + 1] = palette.rgba[from + 1] ?? 0;
    rgb[to + 2] = palette.rgba[from + 2] ?? 0;
  }
  return rgb;
}

/**
 * Replicate an index map by an integer factor — the index-map half of F-EX-12,
 * for a palette that is not finished yet.
 *
 * `export/census.ts` already has `scaleIndices`, and this is not it: that one
 * takes a complete {@link import("../types").IndexedImage}, palette and bit
 * depth included, because a still's palette is known before its indices are
 * scaled. An animation's is not known until the last frame, so what there is to
 * scale here is a bare index map. Constructing a throwaway `IndexedImage` per
 * frame around a palette that is still growing would be a lie in the shape of
 * reuse.
 *
 * The saving is the same one: the palette does not change under pixel
 * replication, so a 4x export never materialises the scaled RGBA at all — one
 * byte a pixel instead of four, per frame, for the whole loop.
 */
export function replicateIndices(
  indices: Bytes,
  width: number,
  height: number,
  scale: number,
): { readonly indices: Bytes; readonly width: number; readonly height: number } {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new RangeError(`the export scale must be a positive integer, got ${scale}`);
  }
  if (scale === 1) return { indices, width, height };

  const wide = width * scale;
  const tall = height * scale;
  const out = new Uint8Array(wide * tall) as Bytes;
  const row = new Uint8Array(wide);

  for (let y = 0; y < height; y += 1) {
    const from = y * width;
    for (let x = 0; x < width; x += 1) {
      const value = indices[from + x] ?? 0;
      const at = x * scale;
      for (let repeat = 0; repeat < scale; repeat += 1) row[at + repeat] = value;
    }
    const base = y * scale;
    for (let repeat = 0; repeat < scale; repeat += 1) out.set(row, (base + repeat) * wide);
  }

  return { indices: out, width: wide, height: tall };
}
