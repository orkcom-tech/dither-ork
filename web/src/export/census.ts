/**
 * F-EX-01, the first half: deciding whether the output *is* indexed.
 *
 * The requirement says "indexed when the output is indexed, RGBA otherwise",
 * and the interesting word is "is". There are two ways to answer it and only
 * one of them is right.
 *
 * **The wrong way is to ask the render graph.** The graph does carry an index
 * map after a quantizing node (docs/ARCHITECTURE.md, "Data layout"), and it is
 * tempting to reach for it. But the index map describes the frame *at the
 * quantizer*, and a stack can put a dozen postprocess nodes after it — a bloom,
 * a chromatic aberration, an emboss — every one of which writes continuous
 * colour over the top. Exporting that index map would produce a file that is
 * not the picture. The frame's own colours are the only thing that is.
 *
 * **The right way is to count the colours in the frame.** If the finished
 * picture contains 256 distinct RGBA values or fewer, an indexed PNG holds it
 * exactly — not approximately, exactly, because the palette is built from the
 * values that are there. So the census is not an optimisation applied when it
 * seems safe; it is the definition of "the output is indexed", and it is
 * lossless by construction in every case where it fires.
 *
 * It is also the case that answers correctly for a stack that quantizes twice,
 * for a hand-painted 4-colour source that never went through a dither at all,
 * and for a dither followed by an index-map recolour — none of which the graph's
 * own index map would have got right.
 *
 * ## The bail is what makes it free
 *
 * A photograph reaches 257 distinct colours within the first few hundred pixels,
 * so the census over a 16-megapixel continuous-tone frame ends after reading a
 * few kilobytes. The full two passes only run on images that are actually going
 * to be indexed, where they are the price of a file several times smaller.
 */

import type { IndexedImage } from "./types";
import { throwIfCancelled, shouldYield, yieldToHost } from "./progress";

/** PNG colour type 3 addresses at most 256 entries. */
export const MAX_PALETTE_ENTRIES = 256;

export interface CensusOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
}

/**
 * The smallest PNG bit depth that addresses `count` palette entries.
 *
 * This is where most of the size win lives. A 4-colour dither at 8 bits a pixel
 * is already four times smaller than RGBA before deflate; at 2 bits it is
 * sixteen times smaller, and deflate then has a quarter as many bytes to chew
 * through, which shows up in the export time as well as the file.
 */
export function bitDepthFor(count: number): 1 | 2 | 4 | 8 {
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 16) return 4;
  return 8;
}

/**
 * Index the image, or refuse.
 *
 * Returns `null` — never a partial or approximate palette — when the frame has
 * more than {@link MAX_PALETTE_ENTRIES} distinct RGBA values. The caller writes
 * RGBA in that case; nothing here quantizes, because quantizing at export time
 * would be a second dither the document never asked for.
 */
export async function indexImage(
  width: number,
  height: number,
  data: Uint8Array | Uint8ClampedArray,
  options: CensusOptions = {},
): Promise<IndexedImage | null> {
  const pixels = width * height;
  if (pixels <= 0) return null;
  if (data.length !== pixels * 4) {
    throw new RangeError(
      `expected ${pixels * 4} bytes for ${width}x${height} RGBA, got ${data.length}`,
    );
  }

  // First seen order, per colour. Insertion order is a property of Map and is
  // the reason the palette is deterministic: the same pixels always produce the
  // same palette in the same order, which the golden-image habit of this
  // project would otherwise have no way to rely on.
  const seen = new Map<number, number>();
  let mark = performance.now();

  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    const key =
      (((data[at] ?? 0) << 24) |
        ((data[at + 1] ?? 0) << 16) |
        ((data[at + 2] ?? 0) << 8) |
        (data[at + 3] ?? 0)) >>>
      0;
    if (!seen.has(key)) {
      if (seen.size === MAX_PALETTE_ENTRIES) return null;
      seen.set(key, seen.size);
    }
    if (shouldYield(mark)) {
      throwIfCancelled(options.signal);
      options.onProgress?.((i / pixels) * 0.5);
      await yieldToHost();
      mark = performance.now();
    }
  }

  const count = seen.size;
  if (count === 0) return null;

  // Non-opaque entries first. PNG's tRNS chunk may be shorter than the palette
  // and every entry it omits is opaque, so putting the transparent ones at the
  // front makes the chunk exactly as long as it has to be — and for the usual
  // case of a fully opaque frame, absent altogether.
  const keys = [...seen.keys()];
  const transparent = keys.filter((key) => (key & 0xff) !== 0xff);
  const opaque = keys.filter((key) => (key & 0xff) === 0xff);
  const ordered = [...transparent, ...opaque];

  const palette = new Uint8Array(count * 4);
  const indexOf = new Map<number, number>();
  for (let entry = 0; entry < ordered.length; entry += 1) {
    const key = ordered[entry] ?? 0;
    indexOf.set(key, entry);
    const at = entry * 4;
    palette[at] = (key >>> 24) & 0xff;
    palette[at + 1] = (key >>> 16) & 0xff;
    palette[at + 2] = (key >>> 8) & 0xff;
    palette[at + 3] = key & 0xff;
  }

  const indices = new Uint8Array(pixels);
  mark = performance.now();
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    const key =
      (((data[at] ?? 0) << 24) |
        ((data[at + 1] ?? 0) << 16) |
        ((data[at + 2] ?? 0) << 8) |
        (data[at + 3] ?? 0)) >>>
      0;
    // Every key was inserted in the first pass over the same bytes, so a miss
    // is impossible; `?? 0` is what `noUncheckedIndexedAccess` requires of the
    // lookup and not a fallback for a case that can happen.
    indices[i] = indexOf.get(key) ?? 0;
    if (shouldYield(mark)) {
      throwIfCancelled(options.signal);
      options.onProgress?.(0.5 + (i / pixels) * 0.5);
      await yieldToHost();
      mark = performance.now();
    }
  }

  options.onProgress?.(1);
  return {
    width,
    height,
    indices,
    palette,
    count,
    transparentEntries: transparent.length,
    bitDepth: bitDepthFor(count),
  };
}

/**
 * The same palette over a band of rows.
 *
 * The pre-export size estimate (F-EX-14) encodes a band and multiplies up, and
 * a band re-censused on its own would very often produce a *smaller* palette
 * than the whole image — a band of a two-tone region of a sixteen-colour dither
 * would come out at 1 bit a pixel and the estimate would be eight times too
 * small. Keeping the whole image's palette keeps the bit depth, the tRNS chunk
 * and therefore the bytes per pixel identical to what the real export writes.
 */
export function sliceIndexed(
  source: IndexedImage,
  fromRow: number,
  rows: number,
): IndexedImage {
  const first = Math.max(0, Math.min(source.height, Math.trunc(fromRow)));
  const height = Math.max(1, Math.min(source.height - first, Math.trunc(rows)));
  return {
    ...source,
    height,
    indices: source.indices.slice(first * source.width, (first + height) * source.width),
  };
}

/**
 * Replicate an index map by an integer factor — the index-map half of F-EX-12.
 *
 * An indexed PNG never needs the scaled RGBA buffer at all: the palette does not
 * change under pixel replication, so scaling the indices is the whole operation,
 * at one byte a pixel instead of four. On a 4x export of a 16-megapixel frame
 * that is 256 MB of allocation that never happens.
 */
export function scaleIndices(source: IndexedImage, scale: number): IndexedImage {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new RangeError(`the export scale must be a positive integer, got ${scale}`);
  }
  if (scale === 1) return source;

  const width = source.width * scale;
  const height = source.height * scale;
  const indices = new Uint8Array(width * height);
  const row = new Uint8Array(width);

  for (let y = 0; y < source.height; y += 1) {
    const from = y * source.width;
    for (let x = 0; x < source.width; x += 1) {
      const value = source.indices[from + x] ?? 0;
      const at = x * scale;
      for (let repeat = 0; repeat < scale; repeat += 1) row[at + repeat] = value;
    }
    const base = y * scale;
    for (let repeat = 0; repeat < scale; repeat += 1) {
      indices.set(row, (base + repeat) * width);
    }
  }

  return { ...source, width, height, indices };
}
