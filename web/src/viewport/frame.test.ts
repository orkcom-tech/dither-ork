import { describe, expect, it } from "vitest";

import { frameImageSize, frameScale, releaseFrame, type ViewportFrame } from "./frame";

/**
 * A stand-in for a `FrameImage` with the two members the module reads. It is not
 * a mock of a renderer — nothing here pretends to produce pixels; it is the
 * smallest object that satisfies the structural type, which is what lets this
 * layer be tested in the node suite alongside everything else.
 */
function image(width: number, height: number): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement;
}

function frame(
  imageWidth: number,
  documentWidth: number,
  quality: "full" | "preview" = "full",
): ViewportFrame {
  return {
    image: image(imageWidth, imageWidth),
    documentWidth,
    documentHeight: documentWidth,
    quality,
  };
}

describe("frameScale", () => {
  it("is 1 for a frame at document resolution", () => {
    expect(frameScale(frame(800, 800))).toBe(1);
  });

  it("reports the reduction for a frame rendered below document resolution", () => {
    expect(frameScale(frame(400, 800))).toBe(0.5);
  });

  it("answers for a degenerate document instead of dividing by zero", () => {
    expect(frameScale(frame(400, 0))).toBe(1);
  });
});

describe("frameImageSize", () => {
  it("is the image's own size, not the document's", () => {
    expect(frameImageSize(frame(400, 1600))).toEqual({ width: 400, height: 400 });
  });
});

describe("releaseFrame", () => {
  it("closes an image that owns resources", () => {
    let closed = false;
    const bitmap = {
      width: 4,
      height: 4,
      close: () => {
        closed = true;
      },
    } as unknown as ImageBitmap;
    releaseFrame({
      image: bitmap,
      documentWidth: 4,
      documentHeight: 4,
      quality: "full",
    });
    expect(closed).toBe(true);
  });

  it("leaves an image that owns nothing alone", () => {
    expect(() => releaseFrame(frame(4, 4))).not.toThrow();
  });

  it("accepts no frame at all", () => {
    expect(() => releaseFrame(null)).not.toThrow();
  });
});
