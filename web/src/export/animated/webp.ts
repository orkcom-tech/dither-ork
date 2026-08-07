/**
 * F-EX-05, the second half — animated WebP.
 *
 * ## No WebP encoder is written here, and none needs to be
 *
 * `export/bitmap.ts` already argues that JPEG and WebP belong to the browser:
 * they are large, intricate, patent-adjacent encoders that every target platform
 * ships in tuned native code, and shipping our own would be thousands of lines
 * to own for output that is worse. That argument does not change because the
 * frames now move.
 *
 * What changes is that the browser will not write the *container*. So each frame
 * is encoded as an ordinary still WebP by `convertToBlob`, and this file does
 * the one thing the platform leaves undone: it takes each still's coded
 * bitstream out of its RIFF wrapper and re-frames the lot as `VP8X` + `ANIM` +
 * one `ANMF` per frame. The pixels are never touched, never re-encoded and never
 * decoded — every byte of image data in the output came out of the browser's own
 * encoder.
 *
 * That is worth being precise about, because "assembled here" could be read as
 * "re-compressed here". It is not: an `ANMF` payload is *defined* as a still
 * WebP's image chunks, which is exactly what is copied into it.
 *
 * ## Frames are whole
 *
 * WebP's frame rectangle is stored in units of two pixels, so a sub-rectangle
 * can only start on an even coordinate; and the frame's bitstream would have to
 * have been encoded at the cropped size, which means deciding the crop *before*
 * the encode rather than after. The saving is not worth encoding every frame
 * twice or rounding a rectangle outwards, so every frame is full-size with
 * disposal "none" and blending off — which is also the only combination that is
 * exactly the picture in every player.
 *
 * ## Duration
 *
 * Milliseconds, 24 bits, so a frame rate is representable to a thousandth of a
 * second — much finer than GIF and coarser than APNG. The rounding is reported
 * the same way it is for the other two rather than absorbed.
 */

import { logger } from "../../lib/log";
import { encodeWithCanvas } from "../bitmap";
import { isFullyOpaque } from "../flatten";
import { scaleNearest } from "../scale";
import { formatBytes } from "../settings";
import { throwIfCancelled } from "../progress";
import type { Bytes, ExportFrame } from "../types";
import type {
  AnimatedEncoder,
  AnimatedResult,
  AnimatedSettings,
  AnimatedTiming,
} from "./types";

const log = logger("export");

/** `ANMF` flag bit 1: restore to background after this frame. Left clear. */
const ANMF_DISPOSE_BACKGROUND = 0x01;
/** `ANMF` flag bit 0 inverted: 1 means "do not blend, overwrite". Always set. */
const ANMF_NO_BLEND = 0x02;
/** `VP8X` feature flag: the file is an animation. */
const VP8X_ANIMATION = 0x02;
/** `VP8X` feature flag: some frame carries alpha. */
const VP8X_ALPHA = 0x10;

/** The still-WebP chunks that make up one animation frame. */
interface FrameBitstream {
  /** `ALPH` and `VP8 `/`VP8L`, already framed as RIFF chunks. */
  readonly payload: Bytes;
  readonly hasAlpha: boolean;
}

export interface WebpEncoderOptions {
  readonly settings: AnimatedSettings;
  readonly timing: AnimatedTiming;
  readonly signal?: AbortSignal;
}

export function createAnimatedWebpEncoder(options: WebpEncoderOptions): AnimatedEncoder {
  return new AnimatedWebpEncoder(options);
}

/** Frame duration in milliseconds, which is the unit the format stores. */
export function webpDurationFor(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 100;
  // The floor is 10 ms rather than 1: below it every player substitutes 100 ms,
  // the same decades-old behaviour GIF has, so a shorter duration would produce
  // a file that claims a frame rate it does not play at.
  return Math.max(10, Math.min(0xff_ff_ff, Math.round(1000 / fps)));
}

class AnimatedWebpEncoder implements AnimatedEncoder {
  readonly format = "webp" as const;

  readonly #options: WebpEncoderOptions;
  readonly #frames: FrameBitstream[] = [];
  #width = 0;
  #height = 0;
  #anyAlpha = false;
  #startedAt = performance.now();

  constructor(options: WebpEncoderOptions) {
    this.#options = options;
  }

  async addFrame(frame: ExportFrame, index: number): Promise<void> {
    throwIfCancelled(this.#options.signal);
    const signalOption =
      this.#options.signal === undefined ? {} : { signal: this.#options.signal };

    const scaled = await scaleNearest(frame, this.#options.settings.scale, signalOption);
    if (this.#frames.length === 0) {
      this.#width = scaled.width;
      this.#height = scaled.height;
    } else if (scaled.width !== this.#width || scaled.height !== this.#height) {
      throw new RangeError(
        `frame ${index} is ${scaled.width}x${scaled.height} and the animation is ` +
          `${this.#width}x${this.#height}`,
      );
    }

    const blob = await encodeWithCanvas(
      {
        width: scaled.width,
        height: scaled.height,
        data: scaled.data,
        flattened: false,
        hadTransparency: !isFullyOpaque(scaled.data),
      },
      "image/webp",
      { ...signalOption, quality: this.#options.settings.quality },
    );

    const still = new Uint8Array(await blob.arrayBuffer()) as Bytes;
    const bitstream = imageChunksOf(still, index);
    if (bitstream.hasAlpha) this.#anyAlpha = true;
    this.#frames.push(bitstream);
  }

  async finish(): Promise<AnimatedResult> {
    if (this.#frames.length === 0) {
      throw new Error("an animated WebP needs at least one frame, and none were added");
    }
    throwIfCancelled(this.#options.signal);

    const duration = webpDurationFor(this.#options.timing.fps);
    const parts: Bytes[] = [];

    const flags = VP8X_ANIMATION | (this.#anyAlpha ? VP8X_ALPHA : 0);
    const vp8x = new Uint8Array(10) as Bytes;
    vp8x[0] = flags;
    // Bytes 1..3 are reserved and must be zero. The extent is stored minus one,
    // which is why a zero-size WebP is unrepresentable rather than merely
    // strange.
    writeUint24(vp8x, 4, this.#width - 1);
    writeUint24(vp8x, 7, this.#height - 1);
    parts.push(riffChunk("VP8X", vp8x));

    const anim = new Uint8Array(6) as Bytes;
    // Background colour, BGRA. Fully transparent: the canvas behind the frames
    // is not a colour this application chose, and a player that paints it is
    // painting nothing.
    anim[0] = 0;
    anim[1] = 0;
    anim[2] = 0;
    anim[3] = 0;
    const loops = this.#options.settings.loop ? 0 : 1;
    anim[4] = loops & 0xff;
    anim[5] = (loops >>> 8) & 0xff;
    parts.push(riffChunk("ANIM", anim));

    for (const frame of this.#frames) {
      const header = new Uint8Array(16) as Bytes;
      // Offsets are in units of two pixels; both are zero because every frame is
      // full-size. See the note at the top.
      writeUint24(header, 0, 0);
      writeUint24(header, 3, 0);
      writeUint24(header, 6, this.#width - 1);
      writeUint24(header, 9, this.#height - 1);
      writeUint24(header, 12, duration);
      header[15] = ANMF_NO_BLEND & ~ANMF_DISPOSE_BACKGROUND;

      const body = new Uint8Array(header.length + frame.payload.length) as Bytes;
      body.set(header, 0);
      body.set(frame.payload, header.length);
      parts.push(riffChunk("ANMF", body));
    }

    const file = riffFile(parts);
    const playbackFps = 1000 / duration;
    const notes: string[] = [];
    if (Math.abs(playbackFps - this.#options.timing.fps) > 0.1) {
      notes.push(
        `WebP stores a frame duration in whole milliseconds, so ${this.#options.timing.fps} ` +
          `fps cannot be written exactly. This file plays at ${playbackFps.toFixed(2)} fps.`,
      );
    }
    notes.push(
      "Every frame was encoded by this browser's own WebP encoder and copied into " +
        "the animation unchanged. Quality is lossy: the canvas API exposes no " +
        "lossless WebP mode, so 100 is still a lossy encode.",
    );

    log.info("animated webp written", {
      frames: this.#frames.length,
      width: this.#width,
      height: this.#height,
      bytes: file.length,
      size: formatBytes(file.length),
      alpha: this.#anyAlpha,
      durationMs: duration,
      quality: this.#options.settings.quality,
    });

    return {
      blob: new Blob([file], { type: "image/webp" }),
      format: "webp",
      width: this.#width,
      height: this.#height,
      frames: this.#frames.length,
      fps: this.#options.timing.fps,
      playbackFps,
      bytes: file.length,
      indexed: false,
      paletteEntries: 0,
      flattened: false,
      ms: Math.round(performance.now() - this.#startedAt),
      notes,
    };
  }
}

// --- RIFF ---------------------------------------------------------------

/**
 * The image chunks of a still WebP, ready to be an `ANMF` body.
 *
 * Handles all three shapes a browser can return: the simple lossy form
 * (`RIFF....WEBPVP8 `), the simple lossless form (`VP8L`), and the extended form
 * (`VP8X` followed by an optional `ALPH` and one of the two). Anything else is
 * refused by name rather than copied through and hoped for.
 */
export function imageChunksOf(still: Bytes, frameIndex: number): FrameBitstream {
  if (still.length < 12 || ascii(still, 0, 4) !== "RIFF" || ascii(still, 8, 4) !== "WEBP") {
    throw new Error(
      `frame ${frameIndex} did not come back as a WebP file; this browser's encoder ` +
        `returned ${still.length} bytes that are not RIFF/WEBP.`,
    );
  }

  const kept: Uint8Array[] = [];
  let hasAlpha = false;
  let at = 12;

  while (at + 8 <= still.length) {
    const id = ascii(still, at, 4);
    const size = readUint32(still, at + 4);
    // RIFF pads every odd-length chunk to an even boundary, and the pad byte is
    // not counted in the size. Reading it as data is the classic RIFF bug.
    const padded = size + (size % 2);
    const from = at;
    const to = at + 8 + padded;

    if (id === "ALPH") {
      kept.push(still.subarray(from, to));
      hasAlpha = true;
    } else if (id === "VP8 ") {
      kept.push(still.subarray(from, to));
    } else if (id === "VP8L") {
      kept.push(still.subarray(from, to));
      if (vp8lUsesAlpha(still, at + 8, size)) hasAlpha = true;
    }
    // VP8X, ICCP, EXIF and XMP are deliberately dropped: an ANMF body holds the
    // image chunks only, and a nested VP8X would make the frame unreadable.
    at = to;
  }

  if (kept.length === 0) {
    throw new Error(
      `frame ${frameIndex} contains no VP8 or VP8L bitstream; this browser wrote a ` +
        `WebP this module cannot re-frame.`,
    );
  }

  let total = 0;
  for (const part of kept) total += part.length;
  const payload = new Uint8Array(total) as Bytes;
  let offset = 0;
  for (const part of kept) {
    payload.set(part, offset);
    offset += part.length;
  }
  return { payload, hasAlpha };
}

/**
 * Whether a lossless bitstream declares an alpha channel.
 *
 * The `VP8L` header is a 0x2F signature byte followed by 14 bits of width-1, 14
 * of height-1, one `alpha_is_used` bit and three of version, packed
 * little-endian. So the flag is bit 28 of the 32-bit word after the signature.
 */
function vp8lUsesAlpha(bytes: Bytes, at: number, size: number): boolean {
  if (size < 5 || (bytes[at] ?? 0) !== 0x2f) return false;
  return ((readUint32(bytes, at + 1) >>> 28) & 1) === 1;
}

/** One RIFF chunk: a four-character id, a little-endian size, data, and a pad. */
export function riffChunk(id: string, data: Bytes): Bytes {
  const padded = data.length + (data.length % 2);
  const out = new Uint8Array(8 + padded) as Bytes;
  for (let i = 0; i < 4; i += 1) out[i] = id.charCodeAt(i);
  writeUint32(out, 4, data.length);
  out.set(data, 8);
  return out;
}

/** Wrap chunks in the `RIFF....WEBP` envelope. */
export function riffFile(chunks: readonly Bytes[]): Bytes {
  let body = 0;
  for (const chunk of chunks) body += chunk.length;
  const out = new Uint8Array(12 + body) as Bytes;
  out[0] = 0x52;
  out[1] = 0x49;
  out[2] = 0x46;
  out[3] = 0x46;
  // The size field counts everything after it — the four-character form type
  // included, which is the off-by-four every hand-written RIFF gets wrong.
  writeUint32(out, 4, 4 + body);
  out[8] = 0x57;
  out[9] = 0x45;
  out[10] = 0x42;
  out[11] = 0x50;
  let at = 12;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[at + i] ?? 0);
  return out;
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) >>> 0) +
    (bytes[at + 3] ?? 0) * 0x01_00_00_00
  );
}

function writeUint32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

function writeUint24(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
}
