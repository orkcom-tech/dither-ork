/**
 * The animated format table and the arithmetic around it.
 *
 * Pure functions over a settings object, tested without a browser, a device or
 * an image — the same arrangement `export/settings.test.ts` uses. The two
 * interesting properties are the ones a person can actually hit: a scale that
 * was legal for a short loop and is not for a long one, and a codec that was
 * legal in one container and is not in the other.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import {
  ANIMATED_FORMATS,
  DEFAULT_ANIMATED_SETTINGS,
  MAX_ANIMATED_SCALE,
  MAX_BITRATE_KBPS,
  MIN_BITRATE_KBPS,
  VIDEO_CODECS,
  animatedExtent,
  animatedFormatInfo,
  clampAnimatedSettings,
  codecsFor,
  isAnimatedFormat,
  isVideoCodec,
  maxAnimatedScaleFor,
  sheetGrid,
  videoCodecInfo,
} from "./settings";

setLevel("error");

describe("the format table", () => {
  it("has one entry per format id and no duplicates", () => {
    const ids = ANIMATED_FORMATS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ANIMATED_FORMATS) {
      expect(animatedFormatInfo(entry.id)).toBe(entry);
      expect(isAnimatedFormat(entry.id)).toBe(true);
    }
    expect(isAnimatedFormat("tiff")).toBe(false);
  });

  it("refuses a format that is not one, rather than returning something", () => {
    // Reachable through a restored setting, which is why it throws instead of
    // falling back to PNG and exporting a still nobody asked for.
    expect(() => animatedFormatInfo("gif89" as never)).toThrow(RangeError);
  });

  it("says which formats loop and which merely hold frames", () => {
    expect(animatedFormatInfo("gif").loops).toBe(true);
    expect(animatedFormatInfo("apng").loops).toBe(true);
    expect(animatedFormatInfo("webp").loops).toBe(true);
    // A WebM has no loop flag and a ZIP has no timeline: a control that claimed
    // otherwise would be wired to nothing.
    expect(animatedFormatInfo("webm").loops).toBe(false);
    expect(animatedFormatInfo("png-sequence").loops).toBe(false);
    expect(animatedFormatInfo("sprite-sheet").plays).toBe(false);
  });

  it("declares the video formats as having no alpha", () => {
    // The codecs here produce no alpha plane, so the panel must warn before the
    // export rather than the file quietly losing transparency.
    expect(animatedFormatInfo("webm").alpha).toBe(false);
    expect(animatedFormatInfo("mp4").alpha).toBe(false);
    expect(animatedFormatInfo("gif").alpha).toBe(true);
    expect(animatedFormatInfo("apng").alpha).toBe(true);
  });
});

describe("the codec table", () => {
  it("puts each codec in exactly one container", () => {
    for (const codec of VIDEO_CODECS) {
      expect(videoCodecInfo(codec.id)).toBe(codec);
      expect(isVideoCodec(codec.id)).toBe(true);
      expect(codecsFor(codec.container)).toContain(codec);
    }
    expect(codecsFor("gif")).toEqual([]);
    expect(codecsFor("mp4").map((entry) => entry.id)).toEqual(["avc", "av1"]);
    expect(codecsFor("webm").map((entry) => entry.id)).toEqual(["vp9", "vp8"]);
  });

  it("carries the exact string VideoEncoder.configure takes", () => {
    // A codec string with a wrong profile byte is accepted by the table and
    // refused by the encoder at the first frame, which is the worst place to
    // find out.
    expect(videoCodecInfo("avc").codec).toBe("avc1.420032");
    expect(videoCodecInfo("vp9").codec).toBe("vp09.00.10.08");
  });
});

describe("the scale ceiling", () => {
  it("is bounded by one frame's own memory", () => {
    // 2^25 pixels a frame: a 4096x4096 frame allows exactly 1x.
    expect(maxAnimatedScaleFor(4096, 4096, 1, "apng")).toBe(1);
    expect(maxAnimatedScaleFor(64, 64, 1, "apng")).toBe(MAX_ANIMATED_SCALE);
  });

  it("is additionally bounded by the whole loop, and only for GIF", () => {
    // GIF holds one byte a pixel for every frame at once, which is what makes a
    // long loop the binding constraint rather than one frame's size.
    const short = maxAnimatedScaleFor(512, 512, 4, "gif");
    const long = maxAnimatedScaleFor(512, 512, 240, "gif");
    expect(long).toBeLessThan(short);
    // The same loop as APNG pays only the per-frame ceiling, so nothing moves.
    expect(maxAnimatedScaleFor(512, 512, 240, "apng")).toBe(
      maxAnimatedScaleFor(512, 512, 4, "apng"),
    );
  });

  it("never goes below 1, however large the loop", () => {
    // A loop already past the ceiling still exports at its own size: it is on
    // screen, so the memory is already spent.
    expect(maxAnimatedScaleFor(8192, 8192, 600, "gif")).toBe(1);
    expect(maxAnimatedScaleFor(0, 0, 0, "gif")).toBe(1);
  });
});

describe("clamping", () => {
  const base = DEFAULT_ANIMATED_SETTINGS;

  it("brings a scale that was legal for a shorter loop back into range", () => {
    const legal = clampAnimatedSettings({ ...base, format: "gif", scale: 8 }, 512, 512, 4);
    const illegal = clampAnimatedSettings({ ...base, format: "gif", scale: 8 }, 512, 512, 240);
    expect(legal.scale).toBeGreaterThan(illegal.scale);
    expect(illegal.scale).toBeGreaterThanOrEqual(1);
  });

  it("switches a codec the chosen container cannot hold", () => {
    // Not clamped to some nearest value — a WebM simply cannot carry H.264, and
    // the control has to show the codec that will actually be used.
    const moved = clampAnimatedSettings(
      { ...base, format: "webm", codec: "avc" },
      64,
      64,
      10,
    );
    expect(moved.codec).toBe("vp9");
    const kept = clampAnimatedSettings({ ...base, format: "mp4", codec: "av1" }, 64, 64, 10);
    expect(kept.codec).toBe("av1");
  });

  it("leaves a codec alone for a format that has none", () => {
    const gif = clampAnimatedSettings({ ...base, format: "gif", codec: "avc" }, 64, 64, 10);
    expect(gif.codec).toBe("avc");
  });

  it("holds quality, columns and bitrate inside their ranges", () => {
    const clamped = clampAnimatedSettings(
      { ...base, quality: 400, columns: 900, bitrateKbps: 1 },
      64,
      64,
      12,
    );
    expect(clamped.quality).toBe(100);
    expect(clamped.columns).toBe(12);
    expect(clamped.bitrateKbps).toBe(MIN_BITRATE_KBPS);

    const other = clampAnimatedSettings(
      { ...base, quality: 0, columns: 0, bitrateKbps: 10_000_000 },
      64,
      64,
      12,
    );
    expect(other.quality).toBe(1);
    expect(other.columns).toBe(1);
    expect(other.bitrateKbps).toBe(MAX_BITRATE_KBPS);
  });

  it("returns the same object when nothing had to move", () => {
    // Identity, not equality: the panel re-clamps on every change and a new
    // object each time would re-render everything downstream of it.
    const settled = clampAnimatedSettings(base, 64, 64, 8);
    expect(clampAnimatedSettings(settled, 64, 64, 8)).toBe(settled);
  });
});

describe("extents", () => {
  it("multiplies a moving format by the scale and nothing else", () => {
    expect(animatedExtent(100, 50, { ...DEFAULT_ANIMATED_SETTINGS, scale: 3 }, 10)).toEqual({
      width: 300,
      height: 150,
    });
  });

  it("lays a sheet out as a grid", () => {
    const settings = { ...DEFAULT_ANIMATED_SETTINGS, format: "sprite-sheet" as const, columns: 4 };
    // 10 frames at 4 columns is 4x3 with two cells to spare.
    expect(animatedExtent(16, 16, settings, 10)).toEqual({ width: 64, height: 48 });
    expect(sheetGrid(10, 4)).toEqual({ columns: 4, rows: 3 });
  });

  it("never asks for more columns than there are frames", () => {
    // Otherwise a 3-frame loop at 8 columns produces five empty cells and a
    // sheet five times wider than the picture.
    expect(sheetGrid(3, 8)).toEqual({ columns: 3, rows: 1 });
    expect(sheetGrid(1, 8)).toEqual({ columns: 1, rows: 1 });
  });
});
