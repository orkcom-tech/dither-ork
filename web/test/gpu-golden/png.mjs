/**
 * A minimal 8-bit RGBA PNG codec.
 *
 * Written rather than depended on, because the alternative is adding a
 * production dependency to `web/package.json` for something only this harness
 * uses, on a project whose stated rule is that every pin lives in one place and
 * is reviewable. Node's `zlib` does the only hard part; what is left is the
 * chunk framing and the five filter types, both fully specified in the PNG
 * standard and both under a hundred lines.
 *
 * It writes exactly one shape — 8-bit RGBA, non-interlaced — and refuses to read
 * anything else. That refusal matters: a reference silently read as greyscale or
 * as 16-bit would compare against zero-padded nonsense and fail with a message
 * about pixels rather than about the file.
 *
 * The encoder is deliberately not clever. Every scanline is written with filter
 * type 0 (None) and the deflate level is fixed, so re-blessing an unchanged
 * image produces byte-identical output and `git status` stays honest about what
 * actually moved. Comparison is on decoded pixels, so an encoder that compressed
 * better would buy nothing but churn.
 */

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = 4;

/** CRC-32 as PNG specifies it, table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encode 8-bit RGBA pixels as a PNG.
 *
 * @param {Uint8Array} rgba `width * height * 4` bytes
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function encodePng(rgba, width, height) {
  const expected = width * height * CHANNELS;
  if (rgba.length !== expected) {
    throw new Error(`encodePng: got ${rgba.length} bytes for ${width}x${height}, expected ${expected}`);
  }

  const stride = width * CHANNELS;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // non-interlaced

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function undoFilter(type, line, previous, stride) {
  const bpp = CHANNELS;
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < stride; i += 1) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < stride; i += 1) line[i] = (line[i] + previous[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < stride; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < stride; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = previous[i];
        const c = i >= bpp ? previous[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pred) & 0xff;
      }
      return;
    default:
      throw new Error(`unknown PNG filter type ${type}`);
  }
}

/**
 * Decode an 8-bit RGBA PNG.
 *
 * All five filter types are handled even though {@link encodePng} only ever
 * writes None: a reference written by another tool — or by a future encoder that
 * does filter — must still read back, and a decoder that quietly mishandled a
 * filter would report a pixel difference that is really a decoding bug.
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, rgba: Uint8Array }}
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("not a PNG (bad signature)");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      const interlace = data[12];
      if (depth !== 8 || colour !== 6) {
        throw new Error(
          `reference is bit depth ${depth} colour type ${colour}; the harness writes 8-bit RGBA`,
        );
      }
      if (interlace !== 0) throw new Error("interlaced PNGs are not read");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (width === 0 || height === 0) throw new Error("PNG has no IHDR");

  const stride = width * CHANNELS;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) {
    throw new Error(
      `PNG data is ${raw.length} bytes; ${width}x${height} RGBA needs ${(stride + 1) * height}`,
    );
  }

  const rgba = new Uint8Array(stride * height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const at = y * (stride + 1);
    const line = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    undoFilter(raw[at], line, previous, stride);
    rgba.set(line, y * stride);
    previous = line;
  }

  return { width, height, rgba };
}
