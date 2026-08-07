/**
 * The format table and the two ceilings the scale control obeys.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_FORMATS,
  MAX_EXPORT_PIXELS,
  MAX_SCALE_MULTIPLIER,
  clampSettings,
  formatBytes,
  formatInfo,
  isExportFormat,
  maxScaleFor,
  outputExtent,
} from "./settings";
import { DEFAULT_TRACE_SETTINGS } from "./trace";

describe("the format table", () => {
  it("covers exactly the formats the spec names", () => {
    // The three stills of F-EX-01..03, and F-EX-08's SVG.
    expect(EXPORT_FORMATS.map((entry) => entry.id)).toEqual(["png", "jpeg", "webp", "svg"]);
  });

  it("states which formats carry alpha, which are lossy, and which are vector", () => {
    // The panel reads these rather than testing the id, so a fifth format added
    // later cannot forget to declare any of them.
    expect(formatInfo("png")).toMatchObject({ alpha: true, lossy: false, vector: false });
    expect(formatInfo("jpeg")).toMatchObject({ alpha: false, lossy: true, vector: false });
    expect(formatInfo("webp")).toMatchObject({ alpha: true, lossy: true, vector: false });
    // SVG declares `alpha: false` because an SVG layer is a fill colour and has
    // nowhere to carry per-pixel coverage; that is what makes the panel say so
    // before a picture with transparency is traced.
    expect(formatInfo("svg")).toMatchObject({ alpha: false, lossy: false, vector: true });
  });

  it("marks exactly one format as vector, and it is the one with no pixel grid", () => {
    expect(EXPORT_FORMATS.filter((entry) => entry.vector).map((entry) => entry.id)).toEqual([
      "svg",
    ]);
  });

  it("gives every format a distinct mime type and extension", () => {
    expect(new Set(EXPORT_FORMATS.map((e) => e.mime)).size).toBe(EXPORT_FORMATS.length);
    expect(new Set(EXPORT_FORMATS.map((e) => e.extension)).size).toBe(EXPORT_FORMATS.length);
  });

  it("refuses an id that is not a format", () => {
    expect(isExportFormat("gif")).toBe(false);
    expect(isExportFormat("png")).toBe(true);
  });
});

describe("maxScaleFor", () => {
  it("offers the whole ladder for a small image", () => {
    expect(maxScaleFor(256, 256)).toBe(MAX_SCALE_MULTIPLIER);
  });

  it("narrows as the frame grows, and never below 1", () => {
    const edge = Math.floor(Math.sqrt(MAX_EXPORT_PIXELS));
    expect(maxScaleFor(edge, edge)).toBe(1);
    // A frame already past the ceiling still exports at its own size: the
    // memory is already spent, it is on screen.
    expect(maxScaleFor(edge * 2, edge * 2)).toBe(1);
  });

  it("never offers a multiplier whose output is past the ceiling", () => {
    for (const [width, height] of [
      [640, 480],
      [1920, 1080],
      [4096, 4096],
      [317, 911],
    ] as const) {
      const scale = maxScaleFor(width, height);
      const out = outputExtent(width, height, scale);
      if (width * height <= MAX_EXPORT_PIXELS) {
        expect(out.width * out.height).toBeLessThanOrEqual(MAX_EXPORT_PIXELS);
      }
    }
  });
});

describe("clampSettings", () => {
  it("leaves legal settings alone, by identity", () => {
    // Identity matters: the panel stores this in React state and a new object
    // every render is a render loop.
    const settings = { ...DEFAULT_EXPORT_SETTINGS };
    expect(clampSettings(settings, 512, 512)).toBe(settings);
  });

  it("pulls a scale back when a larger image is opened under it", () => {
    const settings = {
      format: "png",
      quality: 92,
      scale: 8,
      trace: DEFAULT_TRACE_SETTINGS,
    } as const;
    const clamped = clampSettings(settings, 4096, 4096);
    expect(clamped.scale).toBe(maxScaleFor(4096, 4096));
    expect(clamped.scale).toBeLessThan(8);
  });

  it("keeps quality inside 1..100", () => {
    expect(clampSettings({ format: "jpeg", quality: 0, scale: 1, trace: DEFAULT_TRACE_SETTINGS }, 16, 16).quality).toBe(1);
    expect(clampSettings({ format: "jpeg", quality: 500, scale: 1, trace: DEFAULT_TRACE_SETTINGS }, 16, 16).quality).toBe(100);
  });
});

describe("formatBytes", () => {
  it("reads the way a person expects at each magnitude", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 kB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });
});
