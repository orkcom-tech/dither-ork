/**
 * F-EX-14 — the pre-export size estimate.
 *
 * Two things have to hold. Below the budget the number is the file size and is
 * declared exact, so a person who sees "1.2 MB" gets a 1.2 MB file. Above it
 * the number comes from encoding a real band with the real encoder, so it has
 * to land close to the truth rather than merely being a plausible number.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { indexImage } from "./census";
import { encodeFrame } from "./encode";
import { ESTIMATE_PIXEL_BUDGET, estimateExportSize, sliceFrame } from "./estimate";
import { DEFAULT_TRACE_SETTINGS } from "./trace";
import type { ExportFrame, ExportSettings } from "./types";

setLevel("error");

const PNG: ExportSettings = {
  format: "png",
  quality: 92,
  scale: 1,
  trace: DEFAULT_TRACE_SETTINGS,
};

function ditheredFrame(width: number, height: number): ExportFrame {
  const colours = [
    [0, 0, 0, 255],
    [85, 85, 85, 255],
    [170, 170, 170, 255],
    [255, 255, 255, 255],
  ];
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // A pattern with no large-scale structure, so any band is as
      // representative as any other — which is what the ratio assumes.
      data.set(colours[(x * 3 + y * 5 + ((x * y) & 3)) % 4] ?? [], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

describe("sliceFrame", () => {
  it("takes a band of rows at full width", () => {
    const frame = ditheredFrame(6, 10);
    const band = sliceFrame(frame, 3, 4);
    expect(band.width).toBe(6);
    expect(band.height).toBe(4);
    expect(band.data.length).toBe(6 * 4 * 4);
    expect([...band.data.subarray(0, 4)]).toEqual([
      ...frame.data.subarray(3 * 6 * 4, 3 * 6 * 4 + 4),
    ]);
  });

  it("clamps a band that runs past the bottom", () => {
    const band = sliceFrame(ditheredFrame(4, 4), 3, 99);
    expect(band.height).toBe(1);
  });
});

describe("estimateExportSize", () => {
  it("is the file size, exactly, below the budget", async () => {
    const frame = ditheredFrame(64, 64);
    const estimate = await estimateExportSize(frame, PNG);
    const encoded = await encodeFrame(frame, PNG);
    expect(estimate.exact).toBe(true);
    expect(estimate.bytes).toBe(encoded.blob.size);
    expect(estimate.sampledRows).toBe(estimate.totalRows);
  });

  it("reports the output extent and what the file will be", async () => {
    const estimate = await estimateExportSize(ditheredFrame(32, 16), { ...PNG, scale: 3 });
    expect(estimate.width).toBe(96);
    expect(estimate.height).toBe(48);
    expect(estimate.indexed).toBe(true);
    expect(estimate.paletteEntries).toBe(4);
  });

  it("samples above the budget and lands close to the real size", async () => {
    // 1200x1200 at 2x is 5.76 megapixels of output, above the 4.19 the budget
    // allows, so this takes the sampled path.
    const frame = ditheredFrame(1200, 1200);
    const settings: ExportSettings = { ...PNG, scale: 2 };
    const census = { indexed: await indexImage(frame.width, frame.height, frame.data) };

    expect(frame.width * 2 * frame.height * 2).toBeGreaterThan(ESTIMATE_PIXEL_BUDGET);

    const estimate = await estimateExportSize(frame, settings, { census });
    expect(estimate.exact).toBe(false);
    expect(estimate.sampledRows).toBeLessThan(estimate.totalRows);

    const actual = (await encodeFrame(frame, settings, { census })).blob.size;
    const error = Math.abs(estimate.bytes - actual) / actual;
    expect(error).toBeLessThan(0.3);
    // The bias is upward, because every band carries a full set of headers and
    // the ratio multiplies them too. Stated rather than corrected away.
    expect(estimate.bytes).toBeGreaterThan(actual * 0.9);
  });

  it("keeps the whole image's palette when it samples", async () => {
    // A band re-censused alone would often find fewer colours, drop to a
    // smaller bit depth, and estimate several times too small.
    const frame = ditheredFrame(1200, 1200);
    const census = { indexed: await indexImage(frame.width, frame.height, frame.data) };
    const estimate = await estimateExportSize(frame, { ...PNG, scale: 2 }, { census });
    expect(estimate.indexed).toBe(true);
    expect(estimate.paletteEntries).toBe(4);
  });
});
