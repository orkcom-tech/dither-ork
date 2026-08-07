/**
 * The name matters because it is what the save picker opens with, and the one
 * thing it must never be is the source image's own name.
 */

import { describe, expect, it } from "vitest";

import { UNTITLED_BASE, baseName, exportFileName } from "./filename";
import { DEFAULT_TRACE_SETTINGS } from "./trace";
import type { ExportSettings } from "./types";

const png: ExportSettings = {
  format: "png",
  quality: 92,
  scale: 1,
  trace: DEFAULT_TRACE_SETTINGS,
};

describe("baseName", () => {
  it("drops the last extension and only the last", () => {
    expect(baseName("photo.png")).toBe("photo");
    expect(baseName("portrait.v2.png")).toBe("portrait.v2");
    expect(baseName("no-extension")).toBe("no-extension");
  });

  it("keeps a leading dot file from becoming nothing", () => {
    expect(baseName(".hidden")).toBe(".hidden");
  });

  it("drops any path in front of the name", () => {
    expect(baseName("/Users/someone/Pictures/photo.png")).toBe("photo");
    expect(baseName("C:\\Users\\someone\\photo.png")).toBe("photo");
  });

  it("removes what a filesystem will not take", () => {
    expect(baseName('we:ird na*me?.png')).toBe("weird name");
    expect(baseName('a"b|c.png')).toBe("abc");
  });

  it("falls back rather than producing a file with no name", () => {
    // A stem made only of reserved characters leaves nothing, and a file called
    // ".png" is one most systems do not show.
    expect(baseName("???.png")).toBe(UNTITLED_BASE);
    expect(baseName("|||")).toBe(UNTITLED_BASE);
    expect(baseName(null)).toBe(UNTITLED_BASE);
  });

  it("bounds the length", () => {
    expect(baseName(`${"a".repeat(300)}.png`).length).toBe(96);
  });
});

describe("exportFileName", () => {
  it("never offers the source's own name back", () => {
    // A picker pre-filled with photo.png in the folder photo.png came from is
    // one Enter key away from overwriting the original.
    expect(exportFileName("photo.png", png)).toBe("photo-dither.png");
  });

  it("marks the multiplier so two scales are two files", () => {
    expect(exportFileName("photo.png", { ...png, scale: 4 })).toBe("photo-dither@4x.png");
    expect(exportFileName("photo.png", { ...png, scale: 1 })).toBe("photo-dither.png");
  });

  it("uses the format's own extension", () => {
    expect(exportFileName("a.png", { ...png, format: "jpeg" })).toBe("a-dither.jpg");
    expect(exportFileName("a.png", { ...png, format: "webp" })).toBe("a-dither.webp");
  });
});
