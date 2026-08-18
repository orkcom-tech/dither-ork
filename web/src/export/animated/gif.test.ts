/**
 * F-EX-04's GIF driver — everything on this side of the WASM boundary.
 *
 * The encoding itself is `dither-core/src/encode.rs` and is tested there,
 * against a decoder written from the specification. What is tested here is what
 * this side is responsible for and what a Rust test cannot see: that the palette
 * handed across is the loop's own colours in first-seen order, that the indices
 * describe the picture, that the delay is the one the format can store, and that
 * a picture with no 256-colour form is refused rather than quantized.
 *
 * The core is a double, exactly as `export/trace.test.ts` uses one for the SVG
 * tracer. That is not a stand-in for a missing test — it is the seam, and the
 * arguments crossing it are the thing worth pinning.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import type { ExportFrame } from "../types";
import {
  GifBytesLostError,
  GifPaletteError,
  MIN_GIF_DELAY,
  createGifEncoder,
  gifDelayFor,
  gifPlaybackFps,
  type GifCore,
  type GifCoreAnimation,
  type GifCoreResult,
} from "./gif";
import { DEFAULT_ANIMATED_SETTINGS } from "./settings";
import type { AnimatedSettings } from "./types";

setLevel("error");

interface Recorded {
  width: number;
  height: number;
  frames: Uint8Array[];
  paletteRgb: Uint8Array | null;
  delay: number;
  loopForever: boolean;
  transparentIndex: number;
}

/** A core that records its arguments and hands back a plausible report. */
function recordingCore(): { core: GifCore; recorded: Recorded } {
  const recorded: Recorded = {
    width: 0,
    height: 0,
    frames: [],
    paletteRgb: null,
    delay: 0,
    loopForever: false,
    transparentIndex: -2,
  };

  const core: GifCore = {
    createAnimation(width, height): GifCoreAnimation {
      recorded.width = width;
      recorded.height = height;
      return {
        pushFrame(indices) {
          // Copied: the real encoder copies into WASM memory, and a double that
          // kept the caller's view would hide a driver that reuses one buffer.
          recorded.frames.push(indices.slice());
        },
        finish(paletteRgb, delay, loopForever, transparentIndex): GifCoreResult {
          recorded.paletteRgb = paletteRgb.slice();
          recorded.delay = delay;
          recorded.loopForever = loopForever;
          recorded.transparentIndex = transparentIndex;
          return {
            bytes: new Uint8Array([0x47, 0x49, 0x46]),
            frames: recorded.frames.length,
            byteLength: 3,
            paletteEntries: paletteRgb.length / 3,
            tableEntries: 4,
            minCodeSize: 2,
            croppedFrames: 0,
            pixelsWritten: width * height * recorded.frames.length,
            transparent: transparentIndex >= 0,
          };
        },
      };
    },
  };
  return { core, recorded };
}

const SETTINGS: AnimatedSettings = { ...DEFAULT_ANIMATED_SETTINGS, format: "gif" };

function frameOf(width: number, height: number, pixels: readonly number[][]): ExportFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const pixel = pixels[i % pixels.length] ?? [0, 0, 0, 255];
    data[i * 4] = pixel[0] ?? 0;
    data[i * 4 + 1] = pixel[1] ?? 0;
    data[i * 4 + 2] = pixel[2] ?? 0;
    data[i * 4 + 3] = pixel[3] ?? 255;
  }
  return { width, height, data };
}

describe("the GIF driver", () => {
  it("hands the loop's own colours across, in first-seen order", async () => {
    const { core, recorded } = recordingCore();
    const encoder = createGifEncoder({
      core,
      settings: SETTINGS,
      timing: { frames: 2, fps: 10 },
    });

    await encoder.addFrame(
      frameOf(2, 1, [
        [200, 100, 50, 255],
        [10, 20, 30, 255],
      ]),
      0,
    );
    await encoder.addFrame(frameOf(2, 1, [[1, 2, 3, 255]]), 1);
    const result = await encoder.finish();

    // Three colours, in the order the pixels introduced them. Verbatim: not
    // sorted, not deduplicated by distance, not matched to anything.
    expect([...(recorded.paletteRgb ?? [])]).toEqual([200, 100, 50, 10, 20, 30, 1, 2, 3]);
    expect([...(recorded.frames[0] ?? [])]).toEqual([0, 1]);
    expect([...(recorded.frames[1] ?? [])]).toEqual([2, 2]);
    expect(result.indexed).toBe(true);
    expect(result.format).toBe("gif");
  });

  it("refuses a picture with no 256-colour form rather than quantizing it", async () => {
    const { core } = recordingCore();
    const encoder = createGifEncoder({
      core,
      settings: SETTINGS,
      timing: { frames: 1, fps: 10 },
    });

    const width = 300;
    const data = new Uint8ClampedArray(width * 4);
    for (let i = 0; i < width; i += 1) {
      data[i * 4] = i % 256;
      data[i * 4 + 1] = Math.floor(i / 256);
      data[i * 4 + 3] = 255;
    }

    await expect(encoder.addFrame({ width, height: 1, data }, 0)).rejects.toThrow(
      GifPaletteError,
    );
    // The message has to name the way out, because there is no way for the
    // application to take it on the person's behalf.
    await expect(
      createGifEncoder({ core, settings: SETTINGS, timing: { frames: 1, fps: 10 } }).addFrame(
        { width, height: 1, data },
        0,
      ),
    ).rejects.toThrow(/quantizing node/);
  });

  it("passes the transparent index through", async () => {
    const { core, recorded } = recordingCore();
    const encoder = createGifEncoder({
      core,
      settings: SETTINGS,
      timing: { frames: 1, fps: 10 },
    });
    await encoder.addFrame(
      frameOf(2, 1, [
        [5, 5, 5, 255],
        [0, 0, 0, 0],
      ]),
      0,
    );
    await encoder.finish();
    expect(recorded.transparentIndex).toBe(1);
  });

  it("passes -1 when the loop is opaque, so the core writes no transparency", async () => {
    const { core, recorded } = recordingCore();
    const encoder = createGifEncoder({
      core,
      settings: SETTINGS,
      timing: { frames: 1, fps: 10 },
    });
    await encoder.addFrame(frameOf(2, 1, [[5, 5, 5, 255]]), 0);
    await encoder.finish();
    expect(recorded.transparentIndex).toBe(-1);
  });

  it("scales by replicating indices, not pixels", async () => {
    const { core, recorded } = recordingCore();
    const encoder = createGifEncoder({
      core,
      settings: { ...SETTINGS, scale: 2 },
      timing: { frames: 1, fps: 10 },
    });
    await encoder.addFrame(
      frameOf(2, 2, [
        [1, 1, 1, 255],
        [2, 2, 2, 255],
      ]),
      0,
    );
    await encoder.finish();
    expect([recorded.width, recorded.height]).toEqual([4, 4]);
    expect(recorded.frames[0]).toHaveLength(16);
    // The source is two columns, so every output row is the same: each pixel
    // became a 2x2 block and nothing was resampled.
    expect([...(recorded.frames[0] ?? [])]).toEqual([
      0, 0, 1, 1, //
      0, 0, 1, 1, //
      0, 0, 1, 1, //
      0, 0, 1, 1,
    ]);
  });

  it("carries the loop flag", async () => {
    const { core, recorded } = recordingCore();
    const encoder = createGifEncoder({
      core,
      settings: { ...SETTINGS, loop: false },
      timing: { frames: 1, fps: 10 },
    });
    await encoder.addFrame(frameOf(1, 1, [[0, 0, 0, 255]]), 0);
    await encoder.finish();
    expect(recorded.loopForever).toBe(false);
  });

  it("refuses to finish with no frames", async () => {
    const { core } = recordingCore();
    const encoder = createGifEncoder({
      core,
      settings: SETTINGS,
      timing: { frames: 0, fps: 10 },
    });
    await expect(encoder.finish()).rejects.toThrow(/at least one frame/);
  });
});

/**
 * The file the encoder wrote has to be the file that goes in the Blob.
 *
 * The real core runs in the render worker and its buffer is **transferred**
 * across `postMessage`, which detaches it at the sender. A detached
 * `ArrayBuffer` reads as zero length and throws nothing at all, so a driver that
 * reports the core's own `byteLength` while blobbing the array it was handed
 * writes an empty file and calls it a success — which is precisely the failure
 * a person sees as "it downloaded and it is zero bytes, and nothing said
 * anything was wrong".
 *
 * The detach below is a real one, performed the way the worker performs it,
 * rather than a description of one.
 */
function detach(bytes: Uint8Array): Uint8Array {
  structuredClone(bytes.buffer, { transfer: [bytes.buffer as ArrayBuffer] });
  return bytes;
}

/** A core whose file is lost on the way out, exactly as a transfer loses it. */
function losingCore(byteLength: number): GifCore {
  return {
    createAnimation(width, height): GifCoreAnimation {
      let frames = 0;
      return {
        pushFrame() {
          frames += 1;
        },
        finish(paletteRgb, _delay, _loopForever, transparentIndex): GifCoreResult {
          const file = new Uint8Array(byteLength);
          file.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61].slice(0, byteLength));
          return {
            bytes: detach(file),
            frames,
            // The core measured the file it wrote. This number is right; the
            // bytes are the thing that did not arrive.
            byteLength,
            paletteEntries: paletteRgb.length / 3,
            tableEntries: 4,
            minCodeSize: 2,
            croppedFrames: 0,
            pixelsWritten: width * height * frames,
            transparent: transparentIndex >= 0,
          };
        },
      };
    },
  };
}

describe("bytes that did not survive the trip out of the encoder", () => {
  it("is refused, rather than blobbed as an empty file with the encoder's size on it", async () => {
    const encoder = createGifEncoder({
      core: losingCore(930_012),
      settings: SETTINGS,
      timing: { frames: 1, fps: 10 },
    });
    await encoder.addFrame(frameOf(2, 2, [[0, 0, 0, 255]]), 0);

    await expect(encoder.finish()).rejects.toThrow(GifBytesLostError);
  });

  it("says both numbers, because the difference between them is the diagnosis", async () => {
    const encoder = createGifEncoder({
      core: losingCore(930_012),
      settings: SETTINGS,
      timing: { frames: 1, fps: 10 },
    });
    await encoder.addFrame(frameOf(2, 2, [[0, 0, 0, 255]]), 0);

    const error = await encoder.finish().catch((reason: unknown) => reason);
    expect((error as Error).message).toContain("930012");
    expect((error as Error).message).toContain("0 arrived");
  });

  it("reports the file's own size, not the encoder's claim about it", async () => {
    const { core } = recordingCore();
    const encoder = createGifEncoder({
      core,
      settings: SETTINGS,
      timing: { frames: 1, fps: 10 },
    });
    await encoder.addFrame(frameOf(2, 2, [[0, 0, 0, 255]]), 0);

    const result = await encoder.finish();
    // Measured from the artifact, so the number beside the button and the number
    // on disk cannot disagree. Every other animated encoder here already does
    // this, and so does the still path.
    expect(result.bytes).toBe(result.blob.size);
    expect(result.blob.size).toBeGreaterThan(0);
  });
});

describe("the delay", () => {
  it("is a whole number of hundredths of a second", () => {
    expect(gifDelayFor(10)).toBe(10);
    expect(gifDelayFor(25)).toBe(4);
    // 24 fps is 4.1666 centiseconds and is simply not representable.
    expect(gifDelayFor(24)).toBe(4);
    expect(gifPlaybackFps(4)).toBe(25);
  });

  it("never goes below 2, because 0 and 1 are read as 10", () => {
    expect(gifDelayFor(100)).toBe(MIN_GIF_DELAY);
    expect(gifDelayFor(1000)).toBe(MIN_GIF_DELAY);
    expect(gifDelayFor(0)).toBe(MIN_GIF_DELAY);
  });

  it("reports the rate the file will actually play at", async () => {
    const { core, recorded } = recordingCore();
    const encoder = createGifEncoder({
      core,
      settings: SETTINGS,
      timing: { frames: 1, fps: 24 },
    });
    await encoder.addFrame(frameOf(1, 1, [[0, 0, 0, 255]]), 0);
    const result = await encoder.finish();

    expect(recorded.delay).toBe(4);
    expect(result.fps).toBe(24);
    expect(result.playbackFps).toBe(25);
    // Said out loud rather than absorbed: a 24 fps loop that plays at 25 drifts
    // against anything it is cut with, and it is found a week later.
    expect(result.notes.some((note) => note.includes("plays at 25.00 fps"))).toBe(true);
  });

  it("says nothing when the rate is exact", async () => {
    const { core } = recordingCore();
    const encoder = createGifEncoder({
      core,
      settings: SETTINGS,
      timing: { frames: 1, fps: 20 },
    });
    await encoder.addFrame(frameOf(1, 1, [[0, 0, 0, 255]]), 0);
    const result = await encoder.finish();
    expect(result.notes.some((note) => note.includes("plays at"))).toBe(false);
  });
});
