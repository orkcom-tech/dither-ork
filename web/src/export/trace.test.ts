/**
 * The vector export's own arithmetic — everything either side of the WASM call.
 *
 * The tracer itself is proved in Rust (`core/crates/dither-core/src/trace.rs`).
 * What is proved here is the part that only exists on this side and that a
 * golden image would never catch: the widening of the census's one-byte indices,
 * the palette flatten that has to happen before an RGB-only boundary sees a
 * non-opaque colour, the clamps that keep a slider from reaching a value the
 * core throws on, and the fact that an unindexable frame is refused rather than
 * quantized a second time.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { indexImage } from "./census";
import { encodeFrame } from "./encode";
import { DEFAULT_EXPORT_SETTINGS } from "./settings";
import {
  DEFAULT_TRACE_SETTINGS,
  MAX_MIN_FEATURE_AREA,
  MAX_STROKE_WIDTH,
  MAX_TRACE_TOLERANCE,
  clampTraceSettings,
  isTraceMode,
  paletteAsRgb,
  traceIndexedImage,
  traceReportSummary,
  widenIndices,
  type VectorTracer,
} from "./trace";
import type { Bytes, ExportFrame, VectorTraceReport } from "./types";

setLevel("error");

const SVG: typeof DEFAULT_EXPORT_SETTINGS = { ...DEFAULT_EXPORT_SETTINGS, format: "svg" };

const NOTHING: VectorTraceReport = {
  layers: 0,
  contours: 0,
  points: 0,
  contoursDropped: 0,
  regionsDropped: 0,
  regionPixelsDropped: 0,
  holesFilled: 0,
  holePixelsFilled: 0,
  uncoveredPixels: 0,
};

/**
 * A tracer that records what it was handed and answers with a document naming
 * it. The point of the double is the *arguments*, which is where every mistake
 * this file is guarding against would show up.
 */
function recordingTracer(): VectorTracer & {
  readonly calls: {
    indices: Uint16Array;
    width: number;
    height: number;
    paletteRgb: Uint8Array;
    mode: string;
    tolerance: number;
    minFeatureArea: number;
    strokeOnly: boolean;
    strokeWidth: number;
  }[];
} {
  const calls: ReturnType<typeof recordingTracer>["calls"] = [];
  return {
    calls,
    trace(indices, width, height, paletteRgb, settings) {
      calls.push({
        indices: indices.slice(),
        width,
        height,
        paletteRgb: paletteRgb.slice(),
        mode: settings.mode,
        tolerance: settings.tolerance,
        minFeatureArea: settings.minFeatureArea,
        strokeOnly: settings.strokeOnly,
        strokeWidth: settings.strokeWidth,
      });
      const groups = paletteRgb.length / 3;
      return {
        svg:
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
          Array.from({ length: groups }, (_, g) => `<g id="layer-${g}"/>`).join("") +
          "</svg>",
        report: { ...NOTHING, layers: groups },
      };
    },
  };
}

/** A frame of exactly the colours given, one per pixel, cycling. */
function frameOf(
  width: number,
  height: number,
  colours: readonly (readonly [number, number, number, number])[],
): ExportFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const colour = colours[i % colours.length];
    if (colour === undefined) throw new Error("frameOf needs at least one colour");
    data.set(colour, i * 4);
  }
  return { width, height, data };
}

describe("widenIndices", () => {
  it("copies every index into a u16 array of the same length", () => {
    const narrow = new Uint8Array([0, 1, 255, 7]);
    const wide = widenIndices(narrow);
    expect(wide).toBeInstanceOf(Uint16Array);
    expect([...wide]).toEqual([0, 1, 255, 7]);
  });

  it("does not alias the source, so the census's buffer stays the census's", () => {
    const narrow = new Uint8Array([1, 2, 3]);
    const wide = widenIndices(narrow);
    wide[0] = 9;
    expect(narrow[0]).toBe(1);
  });
});

describe("paletteAsRgb", () => {
  it("drops the alpha byte of an opaque palette and says nothing was flattened", async () => {
    const palette = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 12, 34, 56, 255]) as Bytes;
    const { rgb, flattened } = await paletteAsRgb(palette);
    expect([...rgb]).toEqual([0, 0, 0, 255, 255, 255, 12, 34, 56]);
    expect(flattened).toBe(false);
  });

  it("composites a non-opaque entry onto the matte, and says it did", async () => {
    // Half-covered white over black. The composite is in linear light, so the
    // answer is emphatically not 128 — that is the whole reason it is not done
    // in gamma space, and pinning the value here is what would catch a
    // regression to the naive multiply.
    const palette = new Uint8Array([255, 255, 255, 128]) as Bytes;
    const { rgb, flattened } = await paletteAsRgb(palette);
    expect(flattened).toBe(true);
    expect(rgb[0]).toBeGreaterThan(180);
    expect(rgb[0]).toBeLessThan(200);
    expect(rgb[1]).toBe(rgb[0]);
    expect(rgb[2]).toBe(rgb[0]);
  });

  it("leaves the caller's palette alone", async () => {
    const palette = new Uint8Array([255, 255, 255, 0]) as Bytes;
    await paletteAsRgb(palette);
    expect([...palette]).toEqual([255, 255, 255, 0]);
  });
});

describe("clampTraceSettings", () => {
  it("returns the same object when nothing had to move", () => {
    expect(clampTraceSettings(DEFAULT_TRACE_SETTINGS)).toBe(DEFAULT_TRACE_SETTINGS);
  });

  it("keeps every control inside what the core accepts", () => {
    const clamped = clampTraceSettings({
      mode: "simplified",
      tolerance: -3,
      minFeatureArea: 1e9,
      strokeOnly: true,
      strokeWidth: 0,
    });
    expect(clamped.tolerance).toBe(0);
    expect(clamped.minFeatureArea).toBe(MAX_MIN_FEATURE_AREA);
    expect(clamped.strokeWidth).toBeGreaterThan(0);
    expect(clamped.strokeWidth).toBeLessThanOrEqual(MAX_STROKE_WIDTH);
  });

  it("rounds the minimum feature area, which the core counts in whole pixels", () => {
    expect(clampTraceSettings({ ...DEFAULT_TRACE_SETTINGS, minFeatureArea: 7.6 }).minFeatureArea)
      .toBe(8);
  });

  it("takes a NaN to the bottom of the range rather than through to the core", () => {
    const clamped = clampTraceSettings({ ...DEFAULT_TRACE_SETTINGS, tolerance: Number.NaN });
    expect(clamped.tolerance).toBe(0);
    expect(clamped.tolerance).toBeLessThanOrEqual(MAX_TRACE_TOLERANCE);
  });
});

describe("isTraceMode", () => {
  it("accepts the two modes and nothing else", () => {
    expect(isTraceMode("pixel-perfect")).toBe(true);
    expect(isTraceMode("simplified")).toBe(true);
    expect(isTraceMode("potrace")).toBe(false);
  });
});

describe("traceIndexedImage", () => {
  it("hands the tracer the census's own indices, widened, and RGB triplets", async () => {
    const indexed = await indexImage(
      2,
      2,
      new Uint8ClampedArray([
        0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
      ]),
    );
    expect(indexed).not.toBeNull();
    const tracer = recordingTracer();
    await traceIndexedImage(tracer, indexed!, DEFAULT_TRACE_SETTINGS);

    const call = tracer.calls[0];
    expect(call).toBeDefined();
    expect(call!.width).toBe(2);
    expect(call!.height).toBe(2);
    expect(call!.indices).toBeInstanceOf(Uint16Array);
    expect([...call!.indices]).toEqual([...indexed!.indices]);
    // Two colours, three bytes each, alpha gone.
    expect(call!.paletteRgb.length).toBe(indexed!.count * 3);
  });

  it("clamps the settings on the way in, so the core is never given a bad one", async () => {
    const indexed = await indexImage(
      1,
      2,
      new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]),
    );
    const tracer = recordingTracer();
    await traceIndexedImage(tracer, indexed!, {
      mode: "simplified",
      tolerance: -1,
      minFeatureArea: -5,
      strokeOnly: true,
      strokeWidth: -2,
    });
    const call = tracer.calls[0];
    expect(call!.tolerance).toBe(0);
    expect(call!.minFeatureArea).toBe(0);
    expect(call!.strokeWidth).toBeGreaterThan(0);
  });
});

describe("encodeFrame, for SVG", () => {
  it("produces an image/svg+xml blob with one group per colour in the picture", async () => {
    const frame = frameOf(4, 4, [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
      [255, 0, 0, 255],
    ]);
    const encoded = await encodeFrame(frame, SVG, { tracer: recordingTracer() });

    expect(encoded.blob.type).toBe("image/svg+xml");
    expect(encoded.width).toBe(4);
    expect(encoded.height).toBe(4);
    expect(encoded.indexed).toBe(true);
    expect(encoded.paletteEntries).toBe(3);
    expect(encoded.trace).not.toBeNull();
    expect(encoded.trace?.layers).toBe(3);
    expect(await encoded.blob.text()).toContain("<g id=\"layer-2\"/>");
  });

  it("ignores the scale multiplier, which a document with no pixel grid has no use for", async () => {
    const frame = frameOf(4, 4, [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
    ]);
    const at1 = await encodeFrame(frame, SVG, { tracer: recordingTracer() });
    const at4 = await encodeFrame(frame, { ...SVG, scale: 4 }, { tracer: recordingTracer() });
    expect(at4.width).toBe(at1.width);
    expect(at4.height).toBe(at1.height);
    expect(await at4.blob.text()).toBe(await at1.blob.text());
  });

  it("refuses a picture of more than 256 colours rather than quantizing it again", async () => {
    // Genuinely 300 distinct values: the green channel carries the high byte,
    // so nothing wraps back onto a colour already seen.
    const colours = Array.from(
      { length: 300 },
      (_, i) => [i % 256, Math.floor(i / 256), 0, 255] as const,
    );
    const frame = frameOf(20, 20, colours);
    expect(new Set(colours.map((c) => c.join(","))).size).toBe(300);
    await expect(encodeFrame(frame, SVG, { tracer: recordingTracer() })).rejects.toThrow(
      /more than 256 distinct colours/,
    );
  });

  it("refuses to pretend it can trace without the core, rather than writing an empty file", async () => {
    const frame = frameOf(2, 2, [[0, 0, 0, 255]]);
    await expect(encodeFrame(frame, SVG)).rejects.toThrow(/needs the core's tracer/);
  });
});

describe("traceReportSummary", () => {
  it("says only what happened", () => {
    const line = traceReportSummary({ ...NOTHING, layers: 2, contours: 9, points: 40 }, 100);
    expect(line).toBe("2 layers, 9 contours, 40 points.");
  });

  it("names the cost of a minimum feature size, in the terms a person needs", () => {
    const line = traceReportSummary(
      { ...NOTHING, layers: 1, contours: 1, points: 4, regionsDropped: 412, uncoveredPixels: 50 },
      1000,
    );
    expect(line).toContain("412 regions removed as too small");
    expect(line).toContain("5.0% of the picture is left bare");
  });
});
