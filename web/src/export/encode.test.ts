/**
 * The dispatch: which encoder runs, and whether F-EX-01's "indexed when the
 * output is indexed" survives the scale multiplier.
 *
 * Only PNG is exercised end to end, because JPEG and WebP are the browser's
 * encoders and there is no browser here. That absence is itself checked: the
 * refusal has to name what is missing rather than producing a PNG with a `.jpg`
 * on it, which is precisely what `convertToBlob` does when left alone.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { indexImage } from "./census";
import { encodeFrame } from "./encode";
import { DEFAULT_TRACE_SETTINGS } from "./trace";
import type { ExportFrame, ExportSettings } from "./types";

setLevel("error");

const PNG: ExportSettings = {
  format: "png",
  quality: 92,
  scale: 1,
  trace: DEFAULT_TRACE_SETTINGS,
};

function ditheredFrame(
  width: number,
  height: number,
  colours: readonly (readonly number[])[],
): ExportFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(colours[(x + y) % colours.length] ?? [], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

function continuousFrame(width: number, height: number): ExportFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = 0x1234_5678 >>> 0;
  for (let i = 0; i < width * height; i += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    data.set([state & 0xff, (state >>> 8) & 0xff, (state >>> 16) & 0xff, 255], i * 4);
  }
  return { width, height, data };
}

/** IHDR is at a fixed offset in every PNG, which is all this needs. */
async function header(blob: Blob): Promise<{ colorType: number; bitDepth: number }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bitDepth: bytes[24] ?? 0, colorType: bytes[25] ?? 0 };
}

const FOUR_COLOURS = [
  [0, 0, 0, 255],
  [85, 85, 85, 255],
  [170, 170, 170, 255],
  [255, 255, 255, 255],
];

describe("encodeFrame, PNG", () => {
  it("writes an indexed file for an output with few colours", async () => {
    const encoded = await encodeFrame(ditheredFrame(32, 32, FOUR_COLOURS), PNG);
    expect(encoded.indexed).toBe(true);
    expect(encoded.paletteEntries).toBe(4);
    expect(encoded.blob.type).toBe("image/png");
    expect(await header(encoded.blob)).toEqual({ colorType: 3, bitDepth: 2 });
  });

  it("writes RGBA for a continuous output", async () => {
    const encoded = await encodeFrame(continuousFrame(64, 64), PNG);
    expect(encoded.indexed).toBe(false);
    expect(encoded.paletteEntries).toBe(0);
    expect(await header(encoded.blob)).toEqual({ colorType: 6, bitDepth: 8 });
  });

  it("stays indexed through the scale multiplier", async () => {
    // The property F-EX-12 has to preserve: replication cannot invent a colour,
    // so a 4x pixel-art export is still a four-entry palette.
    const encoded = await encodeFrame(ditheredFrame(16, 16, FOUR_COLOURS), {
      ...PNG,
      scale: 4,
    });
    expect(encoded.width).toBe(64);
    expect(encoded.height).toBe(64);
    expect(encoded.indexed).toBe(true);
    expect(encoded.paletteEntries).toBe(4);
  });

  it("honours a census it is given rather than taking its own", async () => {
    // This is what makes the estimate and the export agree, and what stops the
    // panel from paying for the census on every keystroke.
    const frame = ditheredFrame(16, 16, FOUR_COLOURS);
    const forced = await encodeFrame(frame, PNG, { census: { indexed: null } });
    expect(forced.indexed).toBe(false);

    const natural = await encodeFrame(frame, PNG, {
      census: { indexed: await indexImage(frame.width, frame.height, frame.data) },
    });
    expect(natural.indexed).toBe(true);
  });

  it("reports transparency without flattening it, because PNG carries alpha", async () => {
    const frame = ditheredFrame(8, 8, [
      [0, 0, 0, 255],
      [255, 255, 255, 0],
    ]);
    const encoded = await encodeFrame(frame, PNG);
    expect(encoded.flattened).toBe(false);
    expect(encoded.hadTransparency).toBe(true);
  });

  it("reports the output extent, not the frame's", async () => {
    const encoded = await encodeFrame(continuousFrame(9, 7), { ...PNG, scale: 3 });
    expect(encoded.width).toBe(27);
    expect(encoded.height).toBe(21);
  });
});

describe("encodeFrame, the browser's formats", () => {
  it("refuses by name where there is no canvas rather than writing a PNG", async () => {
    // `convertToBlob` silently returns a PNG for a type it cannot write. A
    // ".jpg" holding a PNG is the failure this refusal exists to prevent, and
    // in a Node test the absence of OffscreenCanvas is the same shape of gap.
    await expect(
      encodeFrame(continuousFrame(4, 4), { ...PNG, format: "jpeg" }),
    ).rejects.toThrow(/OffscreenCanvas/);
  });
});
