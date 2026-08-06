/**
 * Header dimensions, so F-IN-04's refusal lands before a decoder allocates.
 *
 * Each case is a hand-built header, which is the point: a fixture image would
 * test that one file parses, and these test that the *offsets* are right, which
 * is the only thing that can be wrong here.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { probeImageExtent } from "./probe";

setLevel("error");

function bytes(length: number, fill: (view: DataView, raw: Uint8Array) => void): Uint8Array {
  const raw = new Uint8Array(length);
  fill(new DataView(raw.buffer), raw);
  return raw;
}

function ascii(raw: Uint8Array, at: number, text: string): void {
  for (const [index, char] of [...text].entries()) raw[at + index] = char.charCodeAt(0);
}

describe("PNG", () => {
  it("reads IHDR", () => {
    const png = bytes(32, (view, raw) => {
      raw.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      view.setUint32(8, 13, false);
      ascii(raw, 12, "IHDR");
      view.setUint32(16, 1920, false);
      view.setUint32(20, 1080, false);
    });
    expect(probeImageExtent("png", png)).toEqual({ width: 1920, height: 1080 });
  });

  it("reads a size no 16-bit field could hold", () => {
    // The whole reason the probe exists: this is the file that kills the tab.
    const png = bytes(32, (view, raw) => {
      raw.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      view.setUint32(16, 70_000, false);
      view.setUint32(20, 70_000, false);
    });
    expect(probeImageExtent("png", png)).toEqual({ width: 70_000, height: 70_000 });
  });

  it("says nothing when the header is truncated", () => {
    expect(probeImageExtent("png", new Uint8Array(20))).toBeNull();
  });
});

describe("GIF", () => {
  it("reads the logical screen descriptor, little-endian", () => {
    const gif = bytes(16, (view, raw) => {
      ascii(raw, 0, "GIF89a");
      view.setUint16(6, 640, true);
      view.setUint16(8, 480, true);
    });
    expect(probeImageExtent("gif", gif)).toEqual({ width: 640, height: 480 });
  });
});

describe("BMP", () => {
  it("reads a BITMAPINFOHEADER", () => {
    const bmp = bytes(64, (view, raw) => {
      ascii(raw, 0, "BM");
      view.setUint32(14, 40, true);
      view.setInt32(18, 800, true);
      view.setInt32(22, 600, true);
    });
    expect(probeImageExtent("bmp", bmp)).toEqual({ width: 800, height: 600 });
  });

  it("takes a top-down bitmap's negative height as a size", () => {
    // The sign is a row order. Reading it as a size gives -600 and the limit
    // check would pass anything.
    const bmp = bytes(64, (view, raw) => {
      ascii(raw, 0, "BM");
      view.setUint32(14, 40, true);
      view.setInt32(18, 800, true);
      view.setInt32(22, -600, true);
    });
    expect(probeImageExtent("bmp", bmp)).toEqual({ width: 800, height: 600 });
  });

  it("reads the older BITMAPCOREHEADER, whose fields are 16-bit", () => {
    const bmp = bytes(64, (view, raw) => {
      ascii(raw, 0, "BM");
      view.setUint32(14, 12, true);
      view.setUint16(18, 320, true);
      view.setUint16(20, 200, true);
    });
    expect(probeImageExtent("bmp", bmp)).toEqual({ width: 320, height: 200 });
  });
});

describe("WebP", () => {
  it("reads a lossy VP8 frame header", () => {
    const webp = bytes(40, (view, raw) => {
      ascii(raw, 0, "RIFF");
      ascii(raw, 8, "WEBP");
      ascii(raw, 12, "VP8 ");
      raw.set([0x9d, 0x01, 0x2a], 23);
      // The top two bits are a scaling hint and are not part of the size.
      view.setUint16(26, 1024 | 0x8000, true);
      view.setUint16(28, 768, true);
    });
    expect(probeImageExtent("webp", webp)).toEqual({ width: 1024, height: 768 });
  });

  it("reads a lossless VP8L bit-packed header", () => {
    const webp = bytes(40, (view, raw) => {
      ascii(raw, 0, "RIFF");
      ascii(raw, 8, "WEBP");
      ascii(raw, 12, "VP8L");
      raw[20] = 0x2f;
      // 14 bits of width-1, then 14 bits of height-1.
      view.setUint32(21, (999 - 1) | ((555 - 1) << 14), true);
    });
    expect(probeImageExtent("webp", webp)).toEqual({ width: 999, height: 555 });
  });

  it("reads an extended VP8X canvas size", () => {
    const webp = bytes(40, (_view, raw) => {
      ascii(raw, 0, "RIFF");
      ascii(raw, 8, "WEBP");
      ascii(raw, 12, "VP8X");
      // Two 24-bit little-endian "minus one" fields.
      raw.set([0x0e, 0x27, 0x00], 24); // 9999 - 1 = 0x270e
      raw.set([0x27, 0x23, 0x00], 27); // 9000 - 1 = 0x2327
    });
    expect(probeImageExtent("webp", webp)).toEqual({ width: 9999, height: 9000 });
  });
});

describe("JPEG", () => {
  /** APP0, then `segments` filler segments, then a frame header. */
  function jpeg(sof: number, width: number, height: number, filler: number): Uint8Array {
    const parts: number[] = [0xff, 0xd8];
    for (let i = 0; i < filler; i += 1) {
      // APP1 segments of 100 bytes each — Exif, in a real file.
      parts.push(0xff, 0xe1, 0x00, 0x64);
      for (let b = 0; b < 98; b += 1) parts.push(0x00);
    }
    parts.push(0xff, sof, 0x00, 0x11, 0x08);
    parts.push((height >> 8) & 0xff, height & 0xff);
    parts.push((width >> 8) & 0xff, width & 0xff);
    return new Uint8Array(parts);
  }

  it("walks past metadata to a baseline frame header", () => {
    expect(probeImageExtent("jpeg", jpeg(0xc0, 4032, 3024, 6))).toEqual({
      width: 4032,
      height: 3024,
    });
  });

  it("reads a progressive frame header too", () => {
    // SOF2. A build that only knew SOF0 would report null for most large
    // photographs on the web, which are exactly the ones the probe is for.
    expect(probeImageExtent("jpeg", jpeg(0xc2, 6000, 4000, 2))).toEqual({
      width: 6000,
      height: 4000,
    });
  });

  it("does not mistake a Huffman table for a frame header", () => {
    // 0xC4 sits inside the SOF numeric range and is not one.
    const parts = [0xff, 0xd8, 0xff, 0xc4, 0x00, 0x06, 0, 0, 0, 0];
    const withFrame = new Uint8Array([
      ...parts,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00,
    ]);
    expect(probeImageExtent("jpeg", withFrame)).toEqual({ width: 512, height: 256 });
  });

  it("says nothing when the frame header is past the bytes it was given", () => {
    const truncated = jpeg(0xc0, 100, 100, 3).slice(0, 200);
    expect(probeImageExtent("jpeg", truncated)).toBeNull();
  });

  it("says nothing rather than guessing once the scan starts", () => {
    const noFrame = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]);
    expect(probeImageExtent("jpeg", noFrame)).toBeNull();
  });
});
