/**
 * The image's dimensions, read from its header, before anything decodes it.
 *
 * This exists so that F-IN-04's refusal happens *before* the browser allocates
 * a bitmap. `createImageBitmap` on a 20000x20000 PNG will try to produce 1.6 GB
 * of pixels before anyone can measure it, and on the machines where that
 * matters it does not fail cleanly — the tab dies. Reading four integers out of
 * a header costs nothing and turns that into a sentence.
 *
 * It is a *probe*, not a decoder. `null` means "this header did not tell me",
 * which is a legitimate answer for a truncated file or a JPEG whose frame
 * header sits past the bytes we were given, and the caller goes on to decode
 * and then checks the decoded size against the same limits. The decoded size is
 * always the authority; this only ever refuses early.
 *
 * Every format here is one the sniffer already accepted, so an unknown
 * container is not this function's problem.
 */

import type { ImageFormat } from "./formats";

export interface ProbedExtent {
  readonly width: number;
  readonly height: number;
}

/**
 * Enough bytes for every header this reads.
 *
 * PNG, GIF, BMP and WebP settle inside 32. JPEG does not — its frame header
 * follows an arbitrary run of metadata segments, and an Exif thumbnail alone
 * routinely pushes it past 64 KB — so the probe is given 128 KB, and a JPEG
 * whose SOF is further in than that simply probes as `null` and is measured
 * after decoding.
 */
export const PROBE_BYTES = 131_072;

/** Dimensions from the header, or `null` when it does not say. */
export function probeImageExtent(
  format: ImageFormat,
  bytes: Uint8Array,
): ProbedExtent | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (format) {
    case "png":
      return probePng(view);
    case "gif":
      return probeGif(view);
    case "bmp":
      return probeBmp(view);
    case "webp":
      return probeWebp(view, bytes);
    case "jpeg":
      return probeJpeg(view);
  }
}

function extent(width: number, height: number): ProbedExtent | null {
  // A header that says zero is a header that has not told us anything useful;
  // `assertSourceExtent` says what a zero dimension means, and it says it about
  // the decoded image rather than about a byte range.
  if (width < 1 || height < 1) return null;
  return { width, height };
}

/** IHDR is the first chunk by specification: length, type, then two u32 BE. */
function probePng(view: DataView): ProbedExtent | null {
  if (view.byteLength < 24) return null;
  return extent(view.getUint32(16, false), view.getUint32(20, false));
}

/** The logical screen descriptor follows the six-byte signature. */
function probeGif(view: DataView): ProbedExtent | null {
  if (view.byteLength < 10) return null;
  return extent(view.getUint16(6, true), view.getUint16(8, true));
}

/**
 * The DIB header at offset 14 says which of the two layouts it is.
 *
 * A negative height means a top-down bitmap; the sign is a row order, not a
 * size, so it is taken as its magnitude.
 */
function probeBmp(view: DataView): ProbedExtent | null {
  if (view.byteLength < 26) return null;
  const headerSize = view.getUint32(14, true);
  if (headerSize === 12) {
    // BITMAPCOREHEADER: two u16.
    return extent(view.getUint16(18, true), view.getUint16(20, true));
  }
  if (headerSize < 40) return null;
  return extent(
    Math.abs(view.getInt32(18, true)),
    Math.abs(view.getInt32(22, true)),
  );
}

function fourcc(bytes: Uint8Array, at: number): string {
  if (bytes.length < at + 4) return "";
  let text = "";
  for (let i = 0; i < 4; i += 1) text += String.fromCharCode(bytes[at + i] ?? 0);
  return text;
}

/**
 * Three chunk layouts, because WebP is three formats in one container.
 *
 * `VP8X` first: an extended file states the canvas size in its own chunk, and
 * that is the size the image presents at even when the frame inside it is
 * smaller.
 */
function probeWebp(view: DataView, bytes: Uint8Array): ProbedExtent | null {
  const chunk = fourcc(bytes, 12);

  if (chunk === "VP8X") {
    if (view.byteLength < 30) return null;
    // Two 24-bit little-endian "minus one" fields.
    const width = readUint24LE(view, 24) + 1;
    const height = readUint24LE(view, 27) + 1;
    return extent(width, height);
  }

  if (chunk === "VP8 ") {
    // Frame tag (3 bytes), start code 9d 01 2a, then two 16-bit fields whose
    // low 14 bits are the size and whose top 2 bits are a scaling hint.
    if (view.byteLength < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return extent(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  }

  if (chunk === "VP8L") {
    if (view.byteLength < 25) return null;
    if (bytes[20] !== 0x2f) return null;
    // 14 bits of width-1 then 14 bits of height-1, packed little-endian.
    const packed = view.getUint32(21, true);
    return extent((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
  }

  return null;
}

function readUint24LE(view: DataView, at: number): number {
  return (
    view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
  );
}

/**
 * Walk the marker segments to the frame header.
 *
 * Every SOF marker carries the size in the same place, which is why the list
 * below is a range test rather than an enumeration of baseline and progressive:
 * a build that only understood SOF0 would report `null` for every progressive
 * JPEG on the web, and those are the large ones.
 *
 * The four exclusions are the markers in that numeric range that are not frame
 * headers at all: `C4` is a Huffman table, `C8` an extension, `CC` an
 * arithmetic-coding table, and `D8`..`D9` have no payload.
 */
function probeJpeg(view: DataView): ProbedExtent | null {
  let at = 2;
  while (at + 4 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) {
      // Fill bytes are legal between segments; anything else means the stream is
      // not a marker sequence any more and there is nothing to walk.
      at += 1;
      continue;
    }
    const marker = view.getUint8(at + 1);
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Standalone markers: no length field follows, so stepping over a length
    // that is not there would land in the middle of entropy-coded data.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      at += 2;
      continue;
    }
    const length = view.getUint16(at + 2, false);
    if (length < 2) return null;

    const isFrameHeader =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrameHeader) {
      if (at + 9 > view.byteLength) return null;
      // length(2), precision(1), height(2), width(2) — height first.
      return extent(view.getUint16(at + 7, false), view.getUint16(at + 5, false));
    }

    // Start of scan: the frame header is always before it, so if we reach here
    // there is nothing more to find.
    if (marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}
