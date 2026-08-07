/**
 * F-EX-01 — the PNG writer.
 *
 * ## Why this is not `canvas.convertToBlob("image/png")`
 *
 * Two reasons, and the first is the requirement.
 *
 * **Indexed output.** No browser will write a colour-type-3 PNG. Handed a
 * 4-colour dither, every one of them emits truecolour RGBA — the same picture
 * at roughly four to sixteen times the size, in a format that has had a
 * palette mode since 1996 for exactly this image. "Indexed when the output is
 * indexed" cannot be delegated, so the file is written here.
 *
 * **Alpha precision.** A 2D canvas backing store is premultiplied. `putImageData`
 * of unassociated RGBA and a read back out of it is lossy for every pixel whose
 * alpha is below 255 — an a=1 pixel keeps about one bit of its colour. The
 * pipeline carries unassociated alpha from the decoder to here (F-IN-03) and
 * refuses to composite it onto anything; running it through a canvas at the
 * last step would undo that quietly. Writing the bytes ourselves does not touch
 * them.
 *
 * ## What it writes
 *
 * Signature, IHDR, PLTE and tRNS when indexed, one IDAT, IEND. No ancillary
 * chunks: no gAMA, no sRGB, no iCCP. That is deliberate rather than lazy — the
 * absence of a colour chunk means "sRGB, the web default", which is exactly what
 * the frame is (`io/linear.ts` reapplies the transfer on the way out), and a
 * gAMA of 1/2.2 alongside would be a second, disagreeing statement of the same
 * fact. Decoders treat an unmarked PNG as sRGB.
 *
 * ## Filtering
 *
 * Truecolour rows are filtered adaptively by the minimum-sum-of-absolute-
 * differences heuristic the PNG specification itself recommends: all five
 * filters are computed and the row with the smallest sum of its bytes read as
 * signed is kept. Indexed rows are written unfiltered, which is the other half
 * of the same recommendation — palette indices are labels, not magnitudes, and
 * subtracting one label from another produces noise where the raw indices had
 * runs. Measured on a 4-colour dither, filtering the indices makes the file
 * larger, not smaller.
 */

import { logger } from "../lib/log";
import { crc32Of } from "./crc32";
import type { Bytes, IndexedImage } from "./types";
import { shouldYield, throwIfCancelled, yieldToHost } from "./progress";
import { deflate } from "./zlib";

const log = logger("export");

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const COLOR_TYPE_INDEXED = 3;
const COLOR_TYPE_RGBA = 6;

/**
 * What is being written, as a union rather than as a buffer plus a flag.
 *
 * A truecolour PNG and an indexed one do not share an input: one is four bytes
 * a pixel of colour, the other is one byte a pixel of palette index plus the
 * palette. Modelling it as "RGBA, and also maybe an index map" leaves an unused
 * 4-byte-per-pixel buffer alive for every indexed export, which at the scale
 * ceiling is a quarter of a gigabyte nobody reads.
 */
export type PngImage =
  | {
      readonly kind: "rgba";
      readonly width: number;
      readonly height: number;
      /** Interleaved 8-bit RGBA, `width * height * 4` bytes. */
      readonly data: Uint8Array | Uint8ClampedArray;
    }
  | { readonly kind: "indexed"; readonly image: IndexedImage };

export interface EncodePngOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
}

/** The share of the encode spent building filtered scanlines, before deflate. */
const FILTER_SHARE = 0.45;

export async function encodePng(
  image: PngImage,
  options: EncodePngOptions = {},
): Promise<Bytes> {
  const width = image.kind === "rgba" ? image.width : image.image.width;
  const height = image.kind === "rgba" ? image.height : image.image.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`a PNG cannot be ${width}x${height}`);
  }

  const indexed = image.kind === "indexed" ? image.image : null;
  const started = performance.now();

  const raw =
    image.kind === "rgba"
      ? await filterTruecolour(image.width, image.height, image.data, options)
      : await packIndexed(width, height, image.image, options);

  const compressed = await deflate(raw, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: (fraction) => {
      options.onProgress?.(FILTER_SHARE + (1 - FILTER_SHARE) * fraction);
    },
  });

  const parts: Bytes[] = [
    SIGNATURE,
    chunk(
      "IHDR",
      ihdr(
        width,
        height,
        indexed === null ? 8 : indexed.bitDepth,
        indexed === null ? COLOR_TYPE_RGBA : COLOR_TYPE_INDEXED,
      ),
    ),
  ];

  if (indexed !== null) {
    parts.push(chunk("PLTE", plte(indexed)));
    if (indexed.transparentEntries > 0) parts.push(chunk("tRNS", trns(indexed)));
  }

  parts.push(chunk("IDAT", compressed), chunk("IEND", new Uint8Array(0)));

  const file = concat(parts);
  log.info("png written", {
    width,
    height,
    colorType: indexed === null ? COLOR_TYPE_RGBA : COLOR_TYPE_INDEXED,
    bitDepth: indexed === null ? 8 : indexed.bitDepth,
    paletteEntries: indexed?.count ?? 0,
    rawBytes: raw.length,
    bytes: file.length,
    ms: Math.round(performance.now() - started),
  });
  options.onProgress?.(1);
  return file;
}

// --- chunks -------------------------------------------------------------

function ihdr(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
): Bytes {
  const data = new Uint8Array(13);
  writeBe32(data, 0, width);
  writeBe32(data, 4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0; // compression: deflate, the only value the format has
  data[11] = 0; // filter method: the five adaptive filters, likewise
  data[12] = 0; // interlace: none. Adam7 costs size and buys a progressive
  //               render of a file that is already on the local disk.
  return data;
}

function plte(indexed: IndexedImage): Bytes {
  const data = new Uint8Array(indexed.count * 3);
  for (let entry = 0; entry < indexed.count; entry += 1) {
    const from = entry * 4;
    const to = entry * 3;
    data[to] = indexed.palette[from] ?? 0;
    data[to + 1] = indexed.palette[from + 1] ?? 0;
    data[to + 2] = indexed.palette[from + 2] ?? 0;
  }
  return data;
}

function trns(indexed: IndexedImage): Bytes {
  const data = new Uint8Array(indexed.transparentEntries);
  for (let entry = 0; entry < indexed.transparentEntries; entry += 1) {
    data[entry] = indexed.palette[entry * 4 + 3] ?? 0;
  }
  return data;
}

function chunk(type: string, data: Uint8Array): Bytes {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) typeBytes[i] = type.charCodeAt(i);

  const out = new Uint8Array(12 + data.length);
  writeBe32(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  // The CRC covers the type and the data but not the length, and is taken over
  // the two without concatenating them — for an IDAT of several megabytes that
  // would otherwise be a second copy of the whole payload.
  writeBe32(out, 8 + data.length, crc32Of(typeBytes, data));
  return out;
}

function writeBe32(target: Uint8Array, at: number, value: number): void {
  target[at] = (value >>> 24) & 0xff;
  target[at + 1] = (value >>> 16) & 0xff;
  target[at + 2] = (value >>> 8) & 0xff;
  target[at + 3] = value & 0xff;
}

function concat(parts: readonly Uint8Array[]): Bytes {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// --- scanlines ----------------------------------------------------------

/** Bytes per scanline for an indexed image at a given bit depth. */
export function indexedRowBytes(width: number, bitDepth: number): number {
  return Math.ceil((width * bitDepth) / 8);
}

async function packIndexed(
  width: number,
  height: number,
  indexed: IndexedImage,
  options: EncodePngOptions,
): Promise<Bytes> {
  const depth = indexed.bitDepth;
  const rowBytes = indexedRowBytes(width, depth);
  const out = new Uint8Array(height * (1 + rowBytes));
  const perRow = 8 / depth;
  let mark = performance.now();

  for (let y = 0; y < height; y += 1) {
    const rowAt = y * (1 + rowBytes);
    // Filter type 0. See the note at the top of the file: filtering palette
    // indices makes the file bigger, because an index is a label.
    out[rowAt] = 0;
    const source = y * width;
    if (depth === 8) {
      out.set(indexed.indices.subarray(source, source + width), rowAt + 1);
    } else {
      for (let x = 0; x < width; x += 1) {
        const slot = x % perRow;
        const shift = (perRow - 1 - slot) * depth;
        const byteAt = rowAt + 1 + Math.floor(x / perRow);
        out[byteAt] = (out[byteAt] ?? 0) | ((indexed.indices[source + x] ?? 0) << shift);
      }
    }

    if (shouldYield(mark)) {
      throwIfCancelled(options.signal);
      options.onProgress?.((y / height) * FILTER_SHARE);
      await yieldToHost();
      mark = performance.now();
    }
  }

  return out;
}

/** The five filters, by their PNG type byte. Exported so the tests can name them. */
export const FILTER_NONE = 0;
export const FILTER_SUB = 1;
export const FILTER_UP = 2;
export const FILTER_AVERAGE = 3;
export const FILTER_PAETH = 4;

async function filterTruecolour(
  width: number,
  height: number,
  data: Uint8Array | Uint8ClampedArray,
  options: EncodePngOptions,
): Promise<Bytes> {
  const bpp = 4;
  const rowBytes = width * bpp;
  if (data.length !== rowBytes * height) {
    throw new RangeError(
      `expected ${rowBytes * height} bytes for ${width}x${height} RGBA, got ${data.length}`,
    );
  }

  const out = new Uint8Array(height * (1 + rowBytes));
  // One scratch row per filter. All five are produced in a single pass over the
  // source row rather than five passes: the four neighbours a filter needs are
  // the same four for every filter, and reading them once instead of five times
  // is the difference between a 16-megapixel export taking a second and taking
  // five.
  const none = new Uint8Array(rowBytes);
  const sub = new Uint8Array(rowBytes);
  const up = new Uint8Array(rowBytes);
  const average = new Uint8Array(rowBytes);
  const paethRow = new Uint8Array(rowBytes);
  let mark = performance.now();

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    const prevStart = rowStart - rowBytes;
    const hasPrevious = y > 0;

    let sumNone = 0;
    let sumSub = 0;
    let sumUp = 0;
    let sumAverage = 0;
    let sumPaeth = 0;

    for (let i = 0; i < rowBytes; i += 1) {
      const raw = data[rowStart + i] ?? 0;
      const left = i >= bpp ? (data[rowStart + i - bpp] ?? 0) : 0;
      const above = hasPrevious ? (data[prevStart + i] ?? 0) : 0;
      const upperLeft = hasPrevious && i >= bpp ? (data[prevStart + i - bpp] ?? 0) : 0;

      const vNone = raw;
      const vSub = (raw - left) & 0xff;
      const vUp = (raw - above) & 0xff;
      const vAverage = (raw - ((left + above) >> 1)) & 0xff;
      const vPaeth = (raw - paeth(left, above, upperLeft)) & 0xff;

      none[i] = vNone;
      sub[i] = vSub;
      up[i] = vUp;
      average[i] = vAverage;
      paethRow[i] = vPaeth;

      // The specification's own heuristic: treat each filtered byte as signed
      // and take the sum of the magnitudes. The filter whose output sits
      // closest to zero everywhere is the one deflate compresses best.
      sumNone += vNone < 128 ? vNone : 256 - vNone;
      sumSub += vSub < 128 ? vSub : 256 - vSub;
      sumUp += vUp < 128 ? vUp : 256 - vUp;
      sumAverage += vAverage < 128 ? vAverage : 256 - vAverage;
      sumPaeth += vPaeth < 128 ? vPaeth : 256 - vPaeth;
    }

    let best = FILTER_NONE;
    let chosen = none;
    let bestSum = sumNone;
    if (sumSub < bestSum) {
      best = FILTER_SUB;
      chosen = sub;
      bestSum = sumSub;
    }
    if (sumUp < bestSum) {
      best = FILTER_UP;
      chosen = up;
      bestSum = sumUp;
    }
    if (sumAverage < bestSum) {
      best = FILTER_AVERAGE;
      chosen = average;
      bestSum = sumAverage;
    }
    if (sumPaeth < bestSum) {
      best = FILTER_PAETH;
      chosen = paethRow;
    }

    const outAt = y * (1 + rowBytes);
    out[outAt] = best;
    out.set(chosen, outAt + 1);

    if (shouldYield(mark)) {
      throwIfCancelled(options.signal);
      options.onProgress?.((y / height) * FILTER_SHARE);
      await yieldToHost();
      mark = performance.now();
    }
  }

  return out;
}

/** The PNG specification's predictor, transcribed from its own pseudocode. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
