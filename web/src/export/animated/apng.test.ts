/**
 * F-EX-05's APNG, checked by decoding it the way a viewer would.
 *
 * The test walks the chunks, verifies every CRC, parses `acTL` and each `fcTL`,
 * inflates each frame's data, reverses the scanline filters, unpacks sub-byte
 * indices, maps them through `PLTE` and `tRNS`, and composites the result onto a
 * canvas at the offsets the file declares. Then it compares that reconstruction
 * to the frames that went in.
 *
 * That is deliberately more work than asserting on chunk names, and it is the
 * same argument `export/png.test.ts` makes: a header assertion passes a file
 * whose frames are cropped to the wrong rectangle, whose sequence numbers are
 * out of order, or whose sub-byte packing is little-endian — three defects that
 * produce a structurally valid APNG showing the wrong animation, and none of
 * which a golden image would catch either, because the golden would have been
 * blessed from the same wrong encoder.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import { crc32Of } from "../crc32";
import { inflate } from "../zlib";
import type { Bytes, ExportFrame } from "../types";
import { DEFAULT_ANIMATED_SETTINGS } from "./settings";
import { apngDelayFor, changedRect, createApngEncoder, crop } from "./apng";
import type { AnimatedSettings, AnimatedTiming } from "./types";

setLevel("error");

// --- a decoder, written against the specification -----------------------

interface DecodedApng {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly plays: number;
  readonly declaredFrames: number;
  readonly chunkOrder: readonly string[];
  readonly sequenceNumbers: readonly number[];
  readonly rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
  readonly delays: ReadonlyArray<{ num: number; den: number }>;
  /** Each frame composited onto the canvas, as 8-bit RGBA. */
  readonly frames: readonly Uint8ClampedArray[];
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function decodeApng(file: Bytes): Promise<DecodedApng> {
  expect([...file.subarray(0, 8)]).toEqual(SIGNATURE);

  let at = 8;
  const order: string[] = [];
  const sequenceNumbers: number[] = [];
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  const delays: Array<{ num: number; den: number }> = [];
  const payloads: Bytes[] = [];

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let plays = 0;
  let declaredFrames = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;

  while (at + 8 <= file.length) {
    const length = be32(file, at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const data = file.subarray(at + 8, at + 8 + length) as Bytes;
    const stored = be32(file, at + 8 + length);
    expect(crc32Of(file.subarray(at + 4, at + 8), data)).toBe(stored);
    order.push(type);

    if (type === "IHDR") {
      width = be32(data, 0);
      height = be32(data, 4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === "acTL") {
      declaredFrames = be32(data, 0);
      plays = be32(data, 4);
    } else if (type === "PLTE") {
      palette = data.slice();
    } else if (type === "tRNS") {
      transparency = data.slice();
    } else if (type === "fcTL") {
      sequenceNumbers.push(be32(data, 0));
      rects.push({
        w: be32(data, 4),
        h: be32(data, 8),
        x: be32(data, 12),
        y: be32(data, 16),
      });
      delays.push({
        num: ((data[20] ?? 0) << 8) | (data[21] ?? 0),
        den: ((data[22] ?? 0) << 8) | (data[23] ?? 0),
      });
      // Every frame this encoder writes replaces its region outright, which is
      // what makes cropping safe with alpha.
      expect(data[24]).toBe(0); // dispose: none
      expect(data[25]).toBe(0); // blend: source
    } else if (type === "IDAT") {
      payloads.push(data.slice() as Bytes);
    } else if (type === "fdAT") {
      sequenceNumbers.push(be32(data, 0));
      payloads.push(data.slice(4) as Bytes);
    }

    at += 12 + length;
    if (type === "IEND") break;
  }

  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames: Uint8ClampedArray[] = [];

  for (let index = 0; index < payloads.length; index += 1) {
    const rect = rects[index];
    const payload = payloads[index];
    if (rect === undefined || payload === undefined) continue;
    const region = await unpack(payload, rect.w, rect.h, bitDepth, colorType, palette, transparency);
    for (let y = 0; y < rect.h; y += 1) {
      for (let x = 0; x < rect.w; x += 1) {
        const from = (y * rect.w + x) * 4;
        const to = ((rect.y + y) * width + rect.x + x) * 4;
        canvas[to] = region[from] ?? 0;
        canvas[to + 1] = region[from + 1] ?? 0;
        canvas[to + 2] = region[from + 2] ?? 0;
        canvas[to + 3] = region[from + 3] ?? 0;
      }
    }
    frames.push(canvas.slice());
  }

  return {
    width,
    height,
    bitDepth,
    colorType,
    plays,
    declaredFrames,
    chunkOrder: order,
    sequenceNumbers,
    rects,
    delays,
    frames,
  };
}

/** Inflate, unfilter, unpack and colour one region. */
async function unpack(
  payload: Bytes,
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  palette: Uint8Array | null,
  transparency: Uint8Array | null,
): Promise<Uint8ClampedArray> {
  const raw = await inflate(payload);
  const indexed = colorType === 3;
  const bytesPerPixel = indexed ? 4 : 4;
  // The filter's "previous pixel" distance is bytes per pixel rounded up to one,
  // which for any bit depth below eight is one byte.
  const filterUnit = indexed ? Math.max(1, Math.floor(bitDepth / 8)) : bytesPerPixel;
  const rowBytes = indexed ? Math.ceil((width * bitDepth) / 8) : width * 4;

  const lines = new Uint8Array(height * rowBytes);
  let previousRow = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const from = y * (1 + rowBytes);
    const filter = raw[from] ?? 0;
    const row = new Uint8Array(rowBytes);
    for (let i = 0; i < rowBytes; i += 1) {
      const value = raw[from + 1 + i] ?? 0;
      const left = i >= filterUnit ? (row[i - filterUnit] ?? 0) : 0;
      const above = previousRow[i] ?? 0;
      const upperLeft = i >= filterUnit ? (previousRow[i - filterUnit] ?? 0) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
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
          throw new Error(`unknown filter ${filter}`);
      }
      row[i] = restored & 0xff;
    }
    lines.set(row, y * rowBytes);
    previousRow = row;
  }

  const out = new Uint8ClampedArray(width * height * 4);
  if (!indexed) {
    out.set(lines.subarray(0, out.length));
    return out;
  }
  if (palette === null) throw new Error("an indexed APNG with no PLTE");

  const perByte = 8 / bitDepth;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let entry: number;
      if (bitDepth === 8) entry = lines[y * rowBytes + x] ?? 0;
      else {
        const byte = lines[y * rowBytes + Math.floor(x / perByte)] ?? 0;
        const shift = (perByte - 1 - (x % perByte)) * bitDepth;
        entry = (byte >> shift) & ((1 << bitDepth) - 1);
      }
      const to = (y * width + x) * 4;
      out[to] = palette[entry * 3] ?? 0;
      out[to + 1] = palette[entry * 3 + 1] ?? 0;
      out[to + 2] = palette[entry * 3 + 2] ?? 0;
      out[to + 3] = transparency === null ? 255 : (transparency[entry] ?? 255);
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

function be32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

// --- fixtures -----------------------------------------------------------

const SETTINGS: AnimatedSettings = { ...DEFAULT_ANIMATED_SETTINGS, format: "apng" };

function blank(width: number, height: number, colour: readonly number[]): ExportFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = colour[0] ?? 0;
    data[i * 4 + 1] = colour[1] ?? 0;
    data[i * 4 + 2] = colour[2] ?? 0;
    data[i * 4 + 3] = colour[3] ?? 255;
  }
  return { width, height, data };
}

function withPixel(frame: ExportFrame, x: number, y: number, colour: readonly number[]): ExportFrame {
  const data = new Uint8ClampedArray(frame.data);
  const at = (y * frame.width + x) * 4;
  data[at] = colour[0] ?? 0;
  data[at + 1] = colour[1] ?? 0;
  data[at + 2] = colour[2] ?? 0;
  data[at + 3] = colour[3] ?? 255;
  return { width: frame.width, height: frame.height, data };
}

async function encode(
  frames: readonly ExportFrame[],
  settings: AnimatedSettings = SETTINGS,
  timing?: AnimatedTiming,
): Promise<{ file: Bytes; result: Awaited<ReturnType<ReturnType<typeof createApngEncoder>["finish"]>> }> {
  const encoder = createApngEncoder({
    settings,
    timing: timing ?? { frames: frames.length, fps: 10 },
  });
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame !== undefined) await encoder.addFrame(frame, index);
  }
  const result = await encoder.finish();
  const file = new Uint8Array(await result.blob.arrayBuffer()) as Bytes;
  return { file, result };
}

// --- tests --------------------------------------------------------------

describe("the APNG writer", () => {
  it("reproduces every frame exactly, indexed", async () => {
    const a = blank(8, 6, [255, 0, 0, 255]);
    const b = withPixel(a, 3, 2, [0, 255, 0, 255]);
    const c = withPixel(b, 6, 5, [0, 0, 255, 255]);

    const { file, result } = await encode([a, b, c]);
    const decoded = await decodeApng(file);

    expect(decoded.colorType).toBe(3);
    expect(decoded.declaredFrames).toBe(3);
    expect(decoded.frames).toHaveLength(3);
    expect(decoded.frames[0]).toEqual(a.data);
    expect(decoded.frames[1]).toEqual(b.data);
    expect(decoded.frames[2]).toEqual(c.data);
    expect(result.indexed).toBe(true);
    expect(result.paletteEntries).toBe(3);
    // Three colours fit two bits, which is most of the size win.
    expect(decoded.bitDepth).toBe(2);
  });

  it("crops a frame to what changed", async () => {
    const a = blank(8, 6, [10, 10, 10, 255]);
    const b = withPixel(a, 5, 4, [200, 200, 200, 255]);
    const { file } = await encode([a, b]);
    const decoded = await decodeApng(file);

    // The first frame is the image itself and must be full-size at 0,0.
    expect(decoded.rects[0]).toEqual({ x: 0, y: 0, w: 8, h: 6 });
    expect(decoded.rects[1]).toEqual({ x: 5, y: 4, w: 1, h: 1 });
    expect(decoded.frames[1]).toEqual(b.data);
  });

  it("numbers fcTL and fdAT in one shared sequence", async () => {
    const a = blank(4, 4, [1, 2, 3, 255]);
    const b = withPixel(a, 0, 0, [9, 9, 9, 255]);
    const c = withPixel(a, 1, 1, [8, 8, 8, 255]);
    const { file } = await encode([a, b, c]);
    const decoded = await decodeApng(file);

    // fcTL(0), IDAT, fcTL(1), fdAT(2), fcTL(3), fdAT(4). A sequence with a gap
    // or a repeat is a file most decoders reject and some silently reorder.
    expect(decoded.sequenceNumbers).toEqual([0, 1, 2, 3, 4]);
  });

  it("puts acTL before the image data, where the format requires it", async () => {
    const { file } = await encode([blank(4, 4, [0, 0, 0, 255])]);
    const decoded = await decodeApng(file);
    const actl = decoded.chunkOrder.indexOf("acTL");
    const idat = decoded.chunkOrder.indexOf("IDAT");
    expect(actl).toBeGreaterThan(decoded.chunkOrder.indexOf("IHDR"));
    expect(actl).toBeLessThan(idat);
    expect(decoded.chunkOrder.indexOf("PLTE")).toBeLessThan(idat);
    expect(decoded.chunkOrder[decoded.chunkOrder.length - 1]).toBe("IEND");
  });

  it("writes 0 plays for a loop and 1 for a single pass", async () => {
    const frame = blank(4, 4, [0, 0, 0, 255]);
    const looping = await encode([frame], { ...SETTINGS, loop: true });
    const once = await encode([frame], { ...SETTINGS, loop: false });
    expect((await decodeApng(looping.file)).plays).toBe(0);
    expect((await decodeApng(once.file)).plays).toBe(1);
  });

  it("keeps transparency, and does not reorder the palette to do it", async () => {
    // The transparent colour is second, so a writer that put non-opaque entries
    // first — as the still path does — would have had to rewrite every index.
    const data = new Uint8ClampedArray(2 * 1 * 4);
    data.set([5, 6, 7, 255], 0);
    data.set([0, 0, 0, 0], 4);
    const frame: ExportFrame = { width: 2, height: 1, data };

    const { file, result } = await encode([frame]);
    const decoded = await decodeApng(file);
    expect(result.indexed).toBe(true);
    expect(decoded.frames[0]).toEqual(data);
  });

  it("falls back to RGBA above 256 colours, exactly", async () => {
    const width = 300;
    const data = new Uint8ClampedArray(width * 4);
    for (let i = 0; i < width; i += 1) {
      // The low byte and the high byte of the index, so all 300 are distinct.
      // A multiplicative pattern is not enough: `(i * 7) % 256` repeats every
      // 256, which is exactly the length that would make this fixture 256
      // colours and the test pass for the wrong reason.
      data[i * 4] = i % 256;
      data[i * 4 + 1] = Math.floor(i / 256);
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 255;
    }
    const frame: ExportFrame = { width, height: 1, data };

    const { file, result } = await encode([frame]);
    const decoded = await decodeApng(file);
    expect(result.indexed).toBe(false);
    expect(decoded.colorType).toBe(6);
    expect(decoded.frames[0]).toEqual(data);
    expect(result.notes.some((note) => note.includes("more than 256"))).toBe(true);
  });

  it("applies the scale multiplier by replicating pixels", async () => {
    const frame = blank(2, 2, [1, 2, 3, 255]);
    const { result } = await encode([frame], { ...SETTINGS, scale: 3 });
    expect(result.width).toBe(6);
    expect(result.height).toBe(6);
  });

  it("refuses to finish with no frames", async () => {
    const encoder = createApngEncoder({ settings: SETTINGS, timing: { frames: 0, fps: 10 } });
    await expect(encoder.finish()).rejects.toThrow(/at least one frame/);
  });
});

describe("the delay fraction", () => {
  it("is exact for every whole frame rate", async () => {
    for (const fps of [1, 10, 12, 24, 25, 30, 50, 60]) {
      const delay = apngDelayFor(fps);
      expect(delay.den / delay.num).toBeCloseTo(fps, 10);
      expect(delay.den).toBeLessThanOrEqual(0xff_ff);
    }
  });

  it("stays inside the 16-bit denominator at a fractional rate", () => {
    const delay = apngDelayFor(29.97);
    expect(delay.den).toBeLessThanOrEqual(0xff_ff);
    expect(delay.den / delay.num).toBeCloseTo(29.97, 3);
  });

  it("reaches the file, so the reported rate is the stored one", async () => {
    const { file, result } = await encode([blank(4, 4, [0, 0, 0, 255])], SETTINGS, {
      frames: 1,
      fps: 24,
    });
    const decoded = await decodeApng(file);
    expect(decoded.delays[0]).toEqual(apngDelayFor(24));
    expect(result.playbackFps).toBeCloseTo(24, 10);
  });
});

describe("the changed rectangle", () => {
  it("is the tight bound of the differing pixels", () => {
    const previous = new Uint8Array(16);
    const current = new Uint8Array(16);
    current[1 * 4 + 1] = 1; // (1,1) in a 4x4 one-byte-per-pixel buffer
    current[2 * 4 + 2] = 1; // (2,2)
    expect(changedRect(previous, current, 4, 4, 1)).toEqual({
      left: 1,
      top: 1,
      width: 2,
      height: 2,
    });
  });

  it("is one pixel when nothing changed, because there is no empty frame", () => {
    const same = new Uint8Array(16);
    expect(changedRect(same, same, 4, 4, 1)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  it("compares whole pixels, not bytes, at four bytes each", () => {
    const previous = new Uint8Array(4 * 4 * 4);
    const current = new Uint8Array(previous);
    // Only the alpha of the last pixel moves. A comparator that walked bytes
    // without a stride would find it at a different x.
    current[current.length - 1] = 255;
    expect(changedRect(previous, current, 4, 4, 4)).toEqual({
      left: 3,
      top: 3,
      width: 1,
      height: 1,
    });
  });
});

describe("cropping", () => {
  it("hands the original back when the rectangle is the whole frame", () => {
    const source = new Uint8Array(16);
    expect(crop(source, 4, { left: 0, top: 0, width: 4, height: 4 }, 1)).toBe(source);
  });

  it("copies the requested rows and columns and nothing else", () => {
    const source = new Uint8Array([
      0, 1, 2, 3, //
      4, 5, 6, 7, //
      8, 9, 10, 11, //
      12, 13, 14, 15,
    ]);
    expect([...crop(source, 4, { left: 1, top: 1, width: 2, height: 2 }, 1)]).toEqual([
      5, 6, 9, 10,
    ]);
  });
});
