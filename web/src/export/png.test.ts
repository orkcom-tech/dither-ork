/**
 * F-EX-01 — the PNG writer, checked by reading back what it wrote.
 *
 * The test decodes the file the same way a viewer would: it walks the chunks
 * and verifies every CRC, parses IHDR, inflates the IDAT, reverses the
 * scanline filters and — for an indexed file — unpacks the sub-byte indices and
 * maps them back through PLTE and tRNS. Then it compares the reconstruction to
 * the pixels that went in.
 *
 * That is deliberately more work than asserting on byte offsets. A test that
 * only checks the header would pass a file whose scanlines are filtered wrongly,
 * whose palette is in a different order than the indices assume, or whose
 * sub-byte packing is little-endian — three defects that produce a
 * structurally valid PNG showing the wrong picture, which is exactly the class
 * of defect a golden image cannot catch either because the golden would be
 * blessed from the same wrong encoder.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { indexImage } from "./census";
import { crc32Of } from "./crc32";
import { encodePng } from "./png";
import { ExportCancelledError } from "./progress";
import { inflate } from "./zlib";

setLevel("error");

// --- a decoder, written against the specification -----------------------

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly paletteEntries: number;
  readonly transparencyEntries: number;
  readonly chunkTypes: readonly string[];
  /** The picture, reconstructed as 8-bit RGBA. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readBe32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) * 0x100_00_00 +
      ((bytes[at + 1] ?? 0) << 16) +
      ((bytes[at + 2] ?? 0) << 8) +
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

async function decodePng(file: Uint8Array<ArrayBuffer>): Promise<DecodedPng> {
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    expect(file[i]).toBe(SIGNATURE[i]);
  }

  const chunkTypes: string[] = [];
  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = new Uint8Array(0);
  let transparency = new Uint8Array(0);

  let at = SIGNATURE.length;
  while (at < file.length) {
    const length = readBe32(file, at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const data = file.subarray(at + 8, at + 8 + length);
    const stored = readBe32(file, at + 8 + length);
    expect(crc32Of(file.subarray(at + 4, at + 8), data)).toBe(stored);

    chunkTypes.push(type);
    if (type === "IHDR") {
      width = readBe32(data, 0);
      height = readBe32(data, 4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      expect(data[10]).toBe(0);
      expect(data[11]).toBe(0);
      expect(data[12]).toBe(0);
    } else if (type === "PLTE") {
      palette = data.slice();
    } else if (type === "tRNS") {
      transparency = data.slice();
    } else if (type === "IDAT") {
      idat.push(data.slice());
    }
    at += 12 + length;
  }

  expect(chunkTypes[0]).toBe("IHDR");
  expect(chunkTypes[chunkTypes.length - 1]).toBe("IEND");

  let total = 0;
  for (const part of idat) total += part.length;
  const compressed = new Uint8Array(total);
  let offset = 0;
  for (const part of idat) {
    compressed.set(part, offset);
    offset += part.length;
  }

  const raw = await inflate(compressed);
  const bpp = colorType === 6 ? 4 : 1;
  const rowBytes =
    colorType === 6 ? width * 4 : Math.ceil((width * bitDepth) / 8);
  const lines = unfilter(raw, height, rowBytes, bpp);

  const rgba =
    colorType === 6
      ? lines
      : expandIndexed(lines, width, height, rowBytes, bitDepth, palette, transparency);

  return {
    width,
    height,
    bitDepth,
    colorType,
    paletteEntries: palette.length / 3,
    transparencyEntries: transparency.length,
    chunkTypes,
    rgba,
  };
}

/** Reverse the five filters. Straight from the specification's pseudocode. */
function unfilter(
  raw: Uint8Array,
  height: number,
  rowBytes: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (1 + rowBytes)] ?? 0;
    const from = y * (1 + rowBytes) + 1;
    const to = y * rowBytes;
    for (let i = 0; i < rowBytes; i += 1) {
      const value = raw[from + i] ?? 0;
      const left = i >= bpp ? (out[to + i - bpp] ?? 0) : 0;
      const above = y > 0 ? (out[to - rowBytes + i] ?? 0) : 0;
      const upperLeft = y > 0 && i >= bpp ? (out[to - rowBytes + i - bpp] ?? 0) : 0;
      let restored: number;
      switch (filter) {
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + above;
          break;
        case 3:
          restored = value + ((left + above) >> 1);
          break;
        case 4:
          restored = value + paeth(left, above, upperLeft);
          break;
        default:
          restored = value;
          break;
      }
      out[to + i] = restored & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function expandIndexed(
  lines: Uint8Array,
  width: number,
  height: number,
  rowBytes: number,
  bitDepth: number,
  palette: Uint8Array,
  transparency: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = lines[y * rowBytes + Math.floor(x / perByte)] ?? 0;
      const shift = (perByte - 1 - (x % perByte)) * bitDepth;
      const index = (byte >> shift) & mask;
      const at = (y * width + x) * 4;
      out[at] = palette[index * 3] ?? 0;
      out[at + 1] = palette[index * 3 + 1] ?? 0;
      out[at + 2] = palette[index * 3 + 2] ?? 0;
      // tRNS may be shorter than the palette; every entry it omits is opaque.
      out[at + 3] = index < transparency.length ? (transparency[index] ?? 255) : 255;
    }
  }
  return out;
}

// --- fixtures -----------------------------------------------------------

/** A seeded gradient with noise: continuous enough to defeat the census. */
function continuousImage(width: number, height: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(width * height * 4);
  let state = 0x2545_f491 >>> 0;
  for (let i = 0; i < width * height; i += 1) {
    // A tiny LCG rather than Math.random: nothing in this repository puts an
    // unseeded draw anywhere near a pixel, tests included.
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const x = i % width;
    const y = Math.floor(i / width);
    data.set(
      [
        (x * 3 + (state & 0x1f)) & 0xff,
        (y * 5 + ((state >>> 8) & 0x1f)) & 0xff,
        (x + y + ((state >>> 16) & 0x3f)) & 0xff,
        255,
      ],
      i * 4,
    );
  }
  return data;
}

function ditheredImage(
  width: number,
  height: number,
  colours: readonly (readonly number[])[],
): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pick = colours[(x + y * 3) % colours.length] ?? [0, 0, 0, 255];
      data.set(pick, (y * width + x) * 4);
    }
  }
  return data;
}

// --- the tests ----------------------------------------------------------

describe("truecolour PNG", () => {
  it("round-trips a continuous image exactly", async () => {
    const width = 37;
    const height = 23;
    const pixels = continuousImage(width, height);
    const file = await encodePng({ kind: "rgba", width, height, data: pixels });
    const decoded = await decodePng(file);

    expect(decoded.colorType).toBe(6);
    expect(decoded.bitDepth).toBe(8);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.chunkTypes).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(decoded.rgba).toEqual(pixels);
  });

  it("keeps partial alpha exactly, which a canvas round trip would not", async () => {
    // A premultiplied backing store loses almost all of an a=1 pixel's colour.
    // Writing the bytes directly is the whole reason this encoder exists.
    const data = new Uint8Array([
      200, 100, 50, 1, 200, 100, 50, 0, 10, 20, 30, 128, 0, 0, 0, 255,
    ]);
    const decoded = await decodePng(
      await encodePng({ kind: "rgba", width: 4, height: 1, data }),
    );
    expect(decoded.rgba).toEqual(data);
  });

  it("chooses different filters for different rows", async () => {
    // The adaptive heuristic is what makes the file small. If every row came out
    // as filter 0 the encoder would be writing a legal PNG with no compression
    // help at all, and nothing else in the test would notice.
    const width = 64;
    const height = 32;
    const file = await encodePng({
      kind: "rgba",
      width,
      height,
      data: continuousImage(width, height),
    });
    const decoded = await decodePng(file);
    expect(decoded.rgba.length).toBe(width * height * 4);

    // Read the filter bytes back out of the reconstructed stream.
    const filters = new Set<number>();
    const raw = await rawScanlines(file);
    for (let y = 0; y < height; y += 1) filters.add(raw[y * (1 + width * 4)] ?? 0);
    expect(filters.size).toBeGreaterThan(1);
  });

  it("refuses a zero extent rather than writing a header nothing can read", async () => {
    await expect(
      encodePng({ kind: "rgba", width: 0, height: 4, data: new Uint8Array(0) }),
    ).rejects.toThrow(/cannot be 0x4/);
  });

  it("refuses a buffer that is not the size the header claims", async () => {
    await expect(
      encodePng({ kind: "rgba", width: 4, height: 4, data: new Uint8Array(16) }),
    ).rejects.toThrow(/expected 64 bytes/);
  });
});

describe("indexed PNG", () => {
  it("round-trips a two-colour image at 1 bit a pixel", async () => {
    const width = 19; // deliberately not a multiple of 8: the last byte is partial
    const height = 5;
    const pixels = ditheredImage(width, height, [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ]);
    const indexed = await indexImage(width, height, pixels);
    expect(indexed).not.toBeNull();
    if (indexed === null) return;

    const decoded = await decodePng(await encodePng({ kind: "indexed", image: indexed }));
    expect(decoded.colorType).toBe(3);
    expect(decoded.bitDepth).toBe(1);
    expect(decoded.paletteEntries).toBe(2);
    expect(decoded.transparencyEntries).toBe(0);
    expect(decoded.chunkTypes).toEqual(["IHDR", "PLTE", "IDAT", "IEND"]);
    expect(decoded.rgba).toEqual(pixels);
  });

  it("round-trips four colours at 2 bits and sixteen at 4", async () => {
    for (const [count, depth] of [
      [4, 2],
      [16, 4],
    ] as const) {
      const colours = Array.from({ length: count }, (_, i) => [i * 7, 255 - i * 5, i * 3, 255]);
      const width = 13;
      const height = 7;
      const pixels = ditheredImage(width, height, colours);
      const indexed = await indexImage(width, height, pixels);
      expect(indexed).not.toBeNull();
      if (indexed === null) continue;

      const decoded = await decodePng(await encodePng({ kind: "indexed", image: indexed }));
      expect(decoded.bitDepth).toBe(depth);
      expect(decoded.paletteEntries).toBe(count);
      expect(decoded.rgba).toEqual(pixels);
    }
  });

  it("writes tRNS only as long as it has to be", async () => {
    const pixels = new Uint8Array([
      0, 0, 0, 255, 10, 20, 30, 0, 40, 50, 60, 255, 10, 20, 30, 0,
    ]);
    const indexed = await indexImage(4, 1, pixels);
    expect(indexed).not.toBeNull();
    if (indexed === null) return;

    const decoded = await decodePng(await encodePng({ kind: "indexed", image: indexed }));
    expect(decoded.chunkTypes).toContain("tRNS");
    // One transparent colour out of three, ordered first, so tRNS is one byte.
    expect(decoded.transparencyEntries).toBe(1);
    expect(decoded.rgba).toEqual(pixels);
  });

  it("is dramatically smaller than the same picture as RGBA", async () => {
    // The reason F-EX-01 asks for it. A four-colour dither is the case, and the
    // margin is large enough that a regression is not a rounding difference.
    const width = 128;
    const height = 128;
    const pixels = ditheredImage(width, height, [
      [0, 0, 0, 255],
      [85, 85, 85, 255],
      [170, 170, 170, 255],
      [255, 255, 255, 255],
    ]);
    const indexed = await indexImage(width, height, pixels);
    expect(indexed).not.toBeNull();
    if (indexed === null) return;

    const asIndexed = await encodePng({ kind: "indexed", image: indexed });
    const asRgba = await encodePng({ kind: "rgba", width, height, data: pixels });
    expect(asIndexed.length).toBeLessThan(asRgba.length);
  });
});

describe("progress and cancellation", () => {
  it("reports progress that ends at 1", async () => {
    const seen: number[] = [];
    await encodePng(
      { kind: "rgba", width: 64, height: 64, data: continuousImage(64, 64) },
      { onProgress: (f) => seen.push(f) },
    );
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("stops when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      encodePng(
        { kind: "rgba", width: 8, height: 8, data: continuousImage(8, 8) },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(ExportCancelledError);
  });
});

/** The inflated scanline stream, for the filter-choice assertion. */
async function rawScanlines(file: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let at = SIGNATURE.length;
  while (at < file.length) {
    const length = readBe32(file, at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    if (type === "IDAT") parts.push(file.subarray(at + 8, at + 8 + length).slice());
    at += 12 + length;
  }
  let total = 0;
  for (const part of parts) total += part.length;
  const compressed = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    compressed.set(part, offset);
    offset += part.length;
  }
  return inflate(compressed);
}
