/**
 * F-EX-06 — the PNG sequence and the sprite sheet.
 *
 * The ZIP is read back with a small central-directory reader, because "it
 * produced a blob" says nothing about whether an unarchiver will open it, and
 * the sheet is read back through the PNG decoder for the same reason the APNG
 * test decodes its own output: the defect worth catching is a frame in the wrong
 * cell, and that produces a perfectly valid PNG.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import { inflate } from "../zlib";
import type { Bytes, ExportFrame } from "../types";
import {
  createPngSequenceEncoder,
  createSpriteSheetEncoder,
  sequenceEntryName,
} from "./sequence";
import { DEFAULT_ANIMATED_SETTINGS } from "./settings";
import type { AnimatedSettings } from "./types";

setLevel("error");

// --- a ZIP reader, from the central directory ---------------------------

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly offset: number;
}

function readZip(bytes: Uint8Array): readonly ZipEntry[] {
  // The end record is the last 22 bytes when there is no archive comment, and
  // this writer never writes one.
  const end = bytes.length - 22;
  expect(le32(bytes, end)).toBe(0x06_05_4b_50);
  const count = le16(bytes, end + 10);
  let at = le32(bytes, end + 16);

  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(le32(bytes, at)).toBe(0x02_01_4b_50);
    const nameLength = le16(bytes, at + 28);
    entries.push({
      method: le16(bytes, at + 10),
      compressedSize: le32(bytes, at + 20),
      uncompressedSize: le32(bytes, at + 24),
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      offset: le32(bytes, at + 42),
    });
    at += 46 + nameLength + le16(bytes, at + 30) + le16(bytes, at + 32);
  }
  return entries;
}

/** One entry's stored body, located through its local header. */
function entryBody(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  expect(le32(bytes, entry.offset)).toBe(0x04_03_4b_50);
  const nameLength = le16(bytes, entry.offset + 26);
  const extraLength = le16(bytes, entry.offset + 28);
  const from = entry.offset + 30 + nameLength + extraLength;
  return bytes.subarray(from, from + entry.compressedSize);
}

function le16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function le32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}

// --- fixtures -----------------------------------------------------------

function solid(width: number, height: number, colour: readonly number[]): ExportFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = colour[0] ?? 0;
    data[i * 4 + 1] = colour[1] ?? 0;
    data[i * 4 + 2] = colour[2] ?? 0;
    data[i * 4 + 3] = colour[3] ?? 255;
  }
  return { width, height, data };
}

/** Decode an indexed or truecolour PNG far enough to compare pixels. */
async function decodePng(file: Bytes): Promise<{
  width: number;
  height: number;
  colorType: number;
  bitDepth: number;
  pixels: Uint8ClampedArray;
}> {
  let at = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (at + 8 <= file.length) {
    const length =
      (((file[at] ?? 0) << 24) |
        ((file[at + 1] ?? 0) << 16) |
        ((file[at + 2] ?? 0) << 8) |
        (file[at + 3] ?? 0)) >>>
      0;
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    const data = file.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width =
        (((data[0] ?? 0) << 24) | ((data[1] ?? 0) << 16) | ((data[2] ?? 0) << 8) | (data[3] ?? 0)) >>>
        0;
      height =
        (((data[4] ?? 0) << 24) | ((data[5] ?? 0) << 16) | ((data[6] ?? 0) << 8) | (data[7] ?? 0)) >>>
        0;
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
    } else if (type === "PLTE") palette = data.slice();
    else if (type === "tRNS") transparency = data.slice();
    else if (type === "IDAT") idat.push(data.slice());
    at += 12 + length;
    if (type === "IEND") break;
  }

  let total = 0;
  for (const part of idat) total += part.length;
  const joined = new Uint8Array(total) as Bytes;
  let offset = 0;
  for (const part of idat) {
    joined.set(part, offset);
    offset += part.length;
  }
  const raw = await inflate(joined);

  const indexed = colorType === 3;
  const filterUnit = indexed ? 1 : 4;
  const rowBytes = indexed ? Math.ceil((width * bitDepth) / 8) : width * 4;
  const lines = new Uint8Array(height * rowBytes);
  let previous = new Uint8Array(rowBytes);

  for (let y = 0; y < height; y += 1) {
    const from = y * (1 + rowBytes);
    const filter = raw[from] ?? 0;
    const row = new Uint8Array(rowBytes);
    for (let i = 0; i < rowBytes; i += 1) {
      const value = raw[from + 1 + i] ?? 0;
      const left = i >= filterUnit ? (row[i - filterUnit] ?? 0) : 0;
      const above = previous[i] ?? 0;
      const upperLeft = i >= filterUnit ? (previous[i - filterUnit] ?? 0) : 0;
      const restored =
        filter === 0 ? value
        : filter === 1 ? value + left
        : filter === 2 ? value + above
        : filter === 3 ? value + ((left + above) >> 1)
        : value + paeth(left, above, upperLeft);
      row[i] = restored & 0xff;
    }
    lines.set(row, y * rowBytes);
    previous = row;
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  if (!indexed) {
    pixels.set(lines.subarray(0, pixels.length));
    return { width, height, colorType, bitDepth, pixels };
  }
  const perByte = 8 / bitDepth;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = lines[y * rowBytes + Math.floor(x / perByte)] ?? 0;
      const entry =
        bitDepth === 8 ?
          (lines[y * rowBytes + x] ?? 0)
        : (byte >> ((perByte - 1 - (x % perByte)) * bitDepth)) & ((1 << bitDepth) - 1);
      const to = (y * width + x) * 4;
      pixels[to] = palette?.[entry * 3] ?? 0;
      pixels[to + 1] = palette?.[entry * 3 + 1] ?? 0;
      pixels[to + 2] = palette?.[entry * 3 + 2] ?? 0;
      pixels[to + 3] = transparency?.[entry] ?? 255;
    }
  }
  return { width, height, colorType, bitDepth, pixels };
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

const SETTINGS: AnimatedSettings = { ...DEFAULT_ANIMATED_SETTINGS, format: "png-sequence" };

// --- tests --------------------------------------------------------------

describe("entry names", () => {
  it("zero-pads so a directory listing is in playback order", () => {
    expect(sequenceEntryName("loop", 0, 60)).toBe("loop-0000.png");
    expect(sequenceEntryName("loop", 7, 60)).toBe("loop-0007.png");
    // A loop long enough to need five digits gets five, rather than sorting
    // frame 10000 before frame 2.
    expect(sequenceEntryName("loop", 3, 20_000)).toBe("loop-00003.png");
  });
});

describe("the PNG sequence", () => {
  it("writes one readable entry per frame, in order", async () => {
    const encoder = createPngSequenceEncoder({
      settings: SETTINGS,
      timing: { frames: 3, fps: 12 },
      baseName: "loop",
    });
    for (let index = 0; index < 3; index += 1) {
      await encoder.addFrame(solid(4, 4, [index * 40, 10, 20, 255]), index);
    }
    const result = await encoder.finish();
    const archive = new Uint8Array(await result.blob.arrayBuffer());
    const entries = readZip(archive);

    expect(entries.map((entry) => entry.name)).toEqual([
      "loop-0000.png",
      "loop-0001.png",
      "loop-0002.png",
    ]);
    // Stored, not deflated: a PNG is already a deflate stream and running one
    // over it costs seconds and saves nothing.
    for (const entry of entries) {
      expect(entry.method).toBe(0);
      expect(entry.compressedSize).toBe(entry.uncompressedSize);
    }

    const first = entries[0];
    const png = await decodePng(entryBody(archive, first!).slice() as Bytes);
    expect(png.width).toBe(4);
    expect(png.colorType).toBe(3); // a one-colour frame is indexed
    expect([...png.pixels.subarray(0, 4)]).toEqual([0, 10, 20, 255]);
    expect(result.frames).toBe(3);
    expect(result.indexed).toBe(true);
  });

  it("produces the same archive twice, because it reads no clock", async () => {
    const build = async (): Promise<Uint8Array> => {
      const encoder = createPngSequenceEncoder({
        settings: SETTINGS,
        timing: { frames: 2, fps: 12 },
        baseName: "loop",
      });
      await encoder.addFrame(solid(4, 4, [1, 2, 3, 255]), 0);
      await encoder.addFrame(solid(4, 4, [4, 5, 6, 255]), 1);
      const result = await encoder.finish();
      return new Uint8Array(await result.blob.arrayBuffer());
    };
    // Byte-identical. A wall-clock modification time would make two exports of
    // one document impossible to compare, which for an application whose whole
    // determinism story is "same document, same output" is the wrong trade.
    expect([...(await build())]).toEqual([...(await build())]);
  });

  it("applies the scale multiplier", async () => {
    const encoder = createPngSequenceEncoder({
      settings: { ...SETTINGS, scale: 3 },
      timing: { frames: 1, fps: 12 },
      baseName: "loop",
    });
    await encoder.addFrame(solid(2, 2, [9, 9, 9, 255]), 0);
    const result = await encoder.finish();
    expect(result.width).toBe(6);
    expect(result.height).toBe(6);
  });

  it("refuses to finish with no frames", async () => {
    const encoder = createPngSequenceEncoder({
      settings: SETTINGS,
      timing: { frames: 0, fps: 12 },
      baseName: "loop",
    });
    await expect(encoder.finish()).rejects.toThrow(/at least one frame/);
  });
});

describe("the sprite sheet", () => {
  it("puts each frame in its own cell, left to right and then down", async () => {
    const encoder = createSpriteSheetEncoder({
      settings: { ...DEFAULT_ANIMATED_SETTINGS, format: "sprite-sheet", columns: 2 },
      timing: { frames: 3, fps: 12 },
    });
    const colours = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ];
    for (let index = 0; index < 3; index += 1) {
      await encoder.addFrame(solid(2, 2, [...(colours[index] ?? []), 255]), index);
    }
    const result = await encoder.finish();

    // 3 frames at 2 columns is a 2x2 grid of 2x2 cells.
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);

    const png = await decodePng(new Uint8Array(await result.blob.arrayBuffer()) as Bytes);
    const pixelAt = (x: number, y: number): number[] => {
      const at = (y * png.width + x) * 4;
      return [png.pixels[at] ?? 0, png.pixels[at + 1] ?? 0, png.pixels[at + 2] ?? 0];
    };
    expect(pixelAt(0, 0)).toEqual([255, 0, 0]);
    expect(pixelAt(2, 0)).toEqual([0, 255, 0]);
    expect(pixelAt(0, 2)).toEqual([0, 0, 255]);
    // The fourth cell has no frame and is left transparent, so a tool that
    // indexes cells by number never sees a stray tile.
    const spare = (3 * png.width + 3) * 4;
    expect(png.pixels[spare + 3]).toBe(0);
    expect(result.notes.some((note) => note.includes("empty"))).toBe(true);
  });

  it("replicates pixels once, not once per stage", async () => {
    const encoder = createSpriteSheetEncoder({
      settings: { ...DEFAULT_ANIMATED_SETTINGS, format: "sprite-sheet", columns: 1, scale: 2 },
      timing: { frames: 1, fps: 12 },
    });
    await encoder.addFrame(solid(2, 2, [7, 7, 7, 255]), 0);
    const result = await encoder.finish();
    // 2x2 at 2x is 4x4 — not 8x8, which is what a second replication inside the
    // still encoder would have produced.
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
  });

  it("refuses a sheet larger than one image may be, naming the way out", async () => {
    const encoder = createSpriteSheetEncoder({
      settings: { ...DEFAULT_ANIMATED_SETTINGS, format: "sprite-sheet", columns: 8 },
      timing: { frames: 4000, fps: 12 },
    });
    await expect(encoder.addFrame(solid(256, 256, [0, 0, 0, 255]), 0)).rejects.toThrow(
      /PNG sequence instead/,
    );
  });

  it("refuses to finish with no frames", async () => {
    const encoder = createSpriteSheetEncoder({
      settings: { ...DEFAULT_ANIMATED_SETTINGS, format: "sprite-sheet" },
      timing: { frames: 0, fps: 12 },
    });
    await expect(encoder.finish()).rejects.toThrow(/at least one frame/);
  });
});
