/**
 * F-EX-04 — animated GIF.
 *
 * The encoding is `core/crates/dither-core/src/encode.rs` and reaches the
 * browser through `dither-wasm`. This file is the contract between the two:
 * what export needs done, in export's own vocabulary, plus the conversions
 * either side of it. Exactly the arrangement `export/trace.ts` uses for the SVG
 * tracer, and for the same reason — nothing in this directory may know that a
 * `DitherCore` exists.
 *
 * ## What is actually done here, and what is not
 *
 * Done here: the loop census (`palette.ts`), which is the whole of "the document
 * palette is used directly, no second quantization"; the scale multiplier, as
 * index replication rather than pixel replication; and the honest arithmetic
 * about what the format can and cannot store.
 *
 * Not done here: LZW, the colour table, the sub-rectangles, the disposal
 * methods. Those are the core's, and the core cannot quantize because it never
 * sees a colour — it is handed indices and a table.
 *
 * ## The delay is an integer number of hundredths of a second
 *
 * That is the only unit GIF has, and it is the format's most-missed limitation:
 * 24 fps is 4.1666 centiseconds and cannot be written. So the delay is rounded
 * and {@link AnimatedResult.playbackFps} reports what the file will *actually*
 * play at, with a note when it differs. Silently exporting a 24 fps loop that
 * plays at 25 is the kind of defect that gets found in someone else's editor a
 * week later.
 *
 * The floor is 2 rather than 1, and that is not caution. A delay of 0 or 1 is
 * treated by browsers as 10 — a decades-old compatibility behaviour from
 * animations that asked to run as fast as possible — so writing 1 would produce
 * a file that claims 100 fps and plays at 10. Refusing to write a value that
 * does not mean what it says, and reporting the 50 fps ceiling that follows, is
 * the only honest option.
 */

import { logger } from "../../lib/log";
import { MAX_PALETTE_ENTRIES } from "../census";
import { formatBytes } from "../settings";
import { throwIfCancelled } from "../progress";
import type { Bytes, ExportFrame } from "../types";
import { LoopPaletteBuilder, paletteAsRgbTriplets, replicateIndices } from "./palette";
import type {
  AnimatedEncoder,
  AnimatedResult,
  AnimatedSettings,
  AnimatedTiming,
} from "./types";

const log = logger("export");

/** The fastest a GIF can honestly claim to play. See the note at the top. */
export const MAX_GIF_FPS = 50;
/** The slowest, from the delay field's 16 bits. 655.35 s a frame. */
export const MIN_GIF_DELAY = 2;

/**
 * What the core hands back. Every field is measured rather than modelled.
 *
 * Mirrors `EncodedGif` in `dither-wasm`. Declared here rather than imported so
 * that this module has no dependency on the WASM package — the same reason
 * `VectorTracer` is declared in `export/trace.ts`.
 */
export interface GifCoreResult {
  readonly bytes: Uint8Array;
  readonly frames: number;
  readonly byteLength: number;
  readonly paletteEntries: number;
  readonly tableEntries: number;
  /** The colour table's bit depth: 2 for a four-colour picture, 8 for 256. */
  readonly minCodeSize: number;
  readonly croppedFrames: number;
  readonly pixelsWritten: number;
  readonly transparent: boolean;
}

/** One GIF being built. Frames are pushed in playback order. */
export interface GifCoreAnimation {
  pushFrame(indices: Uint8Array): void;
  finish(
    paletteRgb: Uint8Array,
    delayCentiseconds: number,
    loopForever: boolean,
    /** A palette index, or any negative number for "no transparent entry". */
    transparentIndex: number,
  ): GifCoreResult | Promise<GifCoreResult>;
}

/**
 * The core's GIF encoder, as export needs it.
 *
 * May answer asynchronously and the real one does: the encoder lives in the
 * render worker beside the WASM instance, so every call is a message. A test
 * double can still be written as plain synchronous code, which is what the
 * union is for.
 */
export interface GifCore {
  createAnimation(width: number, height: number): GifCoreAnimation | Promise<GifCoreAnimation>;
}

/** Asked for a GIF of a picture that has no 256-colour form. */
export class GifPaletteError extends Error {
  constructor(frames: number) {
    super(
      `this loop needs more than ${MAX_PALETTE_ENTRIES} colours, so it cannot be a GIF: ` +
        `the format has one ${MAX_PALETTE_ENTRIES}-entry table for all ${frames} frames. ` +
        `Put a quantizing node in the stack, or export APNG or WebP, which have no ` +
        `palette. Nothing here will quantize it for you — that would dither a dither.`,
    );
    this.name = "GifPaletteError";
  }
}

/**
 * The delay, in hundredths of a second, that comes closest to `fps`.
 *
 * Exported because the panel states the consequence before the export runs
 * rather than after it, and it must state the same number the encoder will use.
 */
export function gifDelayFor(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return MIN_GIF_DELAY;
  const delay = Math.round(100 / fps);
  return Math.max(MIN_GIF_DELAY, Math.min(0xff_ff, delay));
}

/** What a GIF at this delay actually plays at. */
export function gifPlaybackFps(delayCentiseconds: number): number {
  return 100 / Math.max(1, delayCentiseconds);
}

export interface GifEncoderOptions {
  readonly core: GifCore;
  readonly settings: AnimatedSettings;
  readonly timing: AnimatedTiming;
  readonly signal?: AbortSignal;
  /** 0..1 of one frame's share of the work, called during `addFrame`. */
  readonly onFrameProgress?: (fraction: number) => void;
}

export function createGifEncoder(options: GifEncoderOptions): AnimatedEncoder {
  return new GifAnimationEncoder(options);
}

class GifAnimationEncoder implements AnimatedEncoder {
  readonly format = "gif" as const;

  readonly #options: GifEncoderOptions;
  readonly #builder = new LoopPaletteBuilder();
  #animation: GifCoreAnimation | null = null;
  #width = 0;
  #height = 0;
  #frames = 0;
  #startedAt = performance.now();
  #censusMs = 0;

  constructor(options: GifEncoderOptions) {
    this.#options = options;
  }

  async addFrame(frame: ExportFrame, index: number): Promise<void> {
    throwIfCancelled(this.#options.signal);
    const started = performance.now();

    const signalOption =
      this.#options.signal === undefined ? {} : { signal: this.#options.signal };
    const indexed = await this.#builder.index(frame, {
      ...signalOption,
      ...(this.#options.onFrameProgress === undefined ?
        {}
      : { onProgress: this.#options.onFrameProgress }),
    });
    if (indexed === null) throw new GifPaletteError(this.#options.timing.frames);

    const scaled = replicateIndices(
      indexed.indices,
      frame.width,
      frame.height,
      this.#options.settings.scale,
    );
    this.#censusMs += performance.now() - started;

    if (this.#animation === null) {
      this.#width = scaled.width;
      this.#height = scaled.height;
      this.#animation = await this.#options.core.createAnimation(scaled.width, scaled.height);
    } else if (scaled.width !== this.#width || scaled.height !== this.#height) {
      // Every frame of one animation is the same document at the same extent;
      // a change means the source moved under the export, and a GIF whose
      // frames disagree is not a file with a small defect, it is not a GIF.
      throw new RangeError(
        `frame ${index} is ${scaled.width}x${scaled.height} and the animation is ` +
          `${this.#width}x${this.#height}`,
      );
    }

    this.#animation.pushFrame(scaled.indices);
    this.#frames += 1;
  }

  async finish(): Promise<AnimatedResult> {
    const animation = this.#animation;
    if (animation === null) {
      throw new Error("an animated GIF needs at least one frame, and none were added");
    }
    throwIfCancelled(this.#options.signal);

    const palette = this.#builder.palette();
    const delay = gifDelayFor(this.#options.timing.fps);
    const encoded = await animation.finish(
      paletteAsRgbTriplets(palette),
      delay,
      this.#options.settings.loop,
      palette.transparentIndex,
    );
    throwIfCancelled(this.#options.signal);

    const playbackFps = gifPlaybackFps(delay);
    const notes: string[] = [];

    // A tenth of a frame per second is the point at which a loop visibly drifts
    // against a soundtrack or a second animation; below it, saying so is noise.
    if (Math.abs(playbackFps - this.#options.timing.fps) > 0.1) {
      notes.push(
        `GIF stores a frame delay as a whole number of hundredths of a second, so ` +
          `${this.#options.timing.fps} fps cannot be written. This file plays at ` +
          `${playbackFps.toFixed(2)} fps.`,
      );
    }
    if (this.#options.timing.fps > MAX_GIF_FPS) {
      notes.push(
        `${MAX_GIF_FPS} fps is the fastest a GIF can honestly claim: a shorter delay ` +
          `is read as 10 hundredths by every browser, so the file would play at 10 fps.`,
      );
    }
    if (this.#builder.flattened) {
      notes.push(
        "Partly transparent pixels were composited onto black. GIF has one bit of " +
          "alpha — a pixel is drawn or it is not — so there is nowhere to keep a " +
          "coverage value.",
      );
    }
    if (encoded.croppedFrames === 0 && encoded.frames > 1) {
      notes.push(
        "No frame could be stored as a sub-rectangle: every one of them differs from " +
          "the frame before it somewhere near the edge. That is normal for a dither " +
          "and it is why the file is this size.",
      );
    }

    const bytesPerPixel = encoded.byteLength / Math.max(1, encoded.pixelsWritten);
    log.info("gif written", {
      frames: encoded.frames,
      width: this.#width,
      height: this.#height,
      bytes: encoded.byteLength,
      size: formatBytes(encoded.byteLength),
      paletteEntries: encoded.paletteEntries,
      tableEntries: encoded.tableEntries,
      minCodeSize: encoded.minCodeSize,
      croppedFrames: encoded.croppedFrames,
      bytesPerPixel: Math.round(bytesPerPixel * 1000) / 1000,
      delayCentiseconds: delay,
      playbackFps: Math.round(playbackFps * 100) / 100,
      censusMs: Math.round(this.#censusMs),
    });

    // Copied into the Blob rather than wrapped, so the encoder's buffer is
    // released with the job rather than pinned for the life of the file.
    const bytes = encoded.bytes as Bytes;
    return {
      blob: new Blob([bytes], { type: "image/gif" }),
      format: "gif",
      width: this.#width,
      height: this.#height,
      frames: encoded.frames,
      fps: this.#options.timing.fps,
      playbackFps,
      bytes: encoded.byteLength,
      indexed: true,
      paletteEntries: encoded.paletteEntries,
      flattened: this.#builder.flattened,
      ms: Math.round(performance.now() - this.#startedAt),
      notes,
    };
  }
}
