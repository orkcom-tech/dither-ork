/**
 * F-EX-05, the first half — APNG.
 *
 * ## It is a PNG, so it is written by the PNG writer
 *
 * An APNG is an ordinary PNG with three extra chunks: `acTL` says how many
 * frames there are, `fcTL` describes one, and `fdAT` carries a frame's pixels
 * in exactly the format `IDAT` carries the first one's. So the frames here are
 * **encoded by `export/png.ts`** — the real one, adaptive filtering, indexed
 * packing, `CompressionStream` and all — and this file takes the `IDAT` out of
 * each finished file and re-labels it.
 *
 * That is not a trick, it is the point. It means an APNG frame is byte-for-byte
 * what the still PNG export of that frame would have been, so the two cannot
 * disagree; it means the animated path inherits the filter heuristic and the
 * "filtering palette indices makes the file bigger" finding without a second
 * copy of either; and it means there is no second encoder to keep in step. The
 * cost is one discarded 40-byte header per frame.
 *
 * ## Indexed when the loop is indexed
 *
 * The still export's rule (`export/census.ts`) applied to a loop rather than a
 * frame: if every colour across every frame comes to 256 or fewer, the whole
 * animation is written with one `PLTE` and one index per pixel, which for a
 * dither is most of the file. The palette is the union over the loop, so a frame
 * that only uses four of the sixteen colours still indexes into the same table
 * and no frame is quantized. Above 256 it is RGBA, exactly.
 *
 * ## Frames are cropped to what changed, and here that is safe with alpha
 *
 * Unlike GIF — see the note in `dither-core/src/encode.rs` — an APNG frame
 * declares its own blend operator, and `APNG_BLEND_OP_SOURCE` *replaces* the
 * region including its alpha rather than compositing onto it. So a cropped frame
 * can make a pixel transparent as easily as it can colour it, and the crop is
 * correct for a loop with moving transparency. Every frame therefore uses
 * `SOURCE` with `DISPOSE_OP_NONE`, and the sub-rectangle is a pure size saving
 * with no behavioural condition attached.
 *
 * ## Why the scaled frames are held as `Blob`s
 *
 * The mode — indexed or RGBA — is not known until the last frame has been
 * censused, and the frames cannot be re-rendered. A `Blob` is the browser's to
 * page out to disk, which is the same argument `batch/zip.ts` makes about
 * holding a batch's outputs, and it is the difference between a 240-frame export
 * and a killed tab. The index maps are held too, at one byte a pixel, and are
 * released the moment a 257th colour makes them worthless.
 */

import { logger } from "../../lib/log";
import { bitDepthFor } from "../census";
import { crc32Of } from "../crc32";
import { encodePng } from "../png";
import { scaleNearest } from "../scale";
import { formatBytes } from "../settings";
import { throwIfCancelled } from "../progress";
import type { Bytes, ExportFrame, IndexedImage } from "../types";
import { LoopPaletteBuilder, replicateIndices } from "./palette";
import type {
  AnimatedEncoder,
  AnimatedResult,
  AnimatedSettings,
  AnimatedTiming,
  LoopPalette,
} from "./types";

const log = logger("export");

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Leave the frame in place; the next one is drawn over it. */
const DISPOSE_OP_NONE = 0;
/** Replace the region, alpha included, rather than compositing onto it. */
const BLEND_OP_SOURCE = 0;

/**
 * The scales tried for the delay fraction, largest first.
 *
 * APNG stores a delay as `delay_num / delay_den` seconds with both fields 16
 * bits, so unlike GIF it can represent 24 fps *exactly* — 100/2400. The loop
 * picks the finest scale whose denominator still fits, which makes every whole
 * frame rate exact and every fractional one accurate to a thousandth.
 */
const DELAY_SCALES = [1000, 100, 10, 1] as const;

export interface ApngDelay {
  readonly num: number;
  readonly den: number;
}

/** The exact fraction of a second closest to one frame at `fps`. */
export function apngDelayFor(fps: number): ApngDelay {
  if (!Number.isFinite(fps) || fps <= 0) return { num: 1, den: 1 };
  for (const scale of DELAY_SCALES) {
    const den = Math.round(scale * fps);
    if (den >= 1 && den <= 0xff_ff) return { num: scale, den };
  }
  // Above 65535 fps, which no clock in this application can produce; written
  // rather than left to fall off the end of the loop.
  return { num: 1, den: 0xff_ff };
}

export interface ApngEncoderOptions {
  readonly settings: AnimatedSettings;
  readonly timing: AnimatedTiming;
  readonly signal?: AbortSignal;
  /** 0..1 of the assembly, called from `finish`. */
  readonly onProgress?: (fraction: number) => void;
}

export function createApngEncoder(options: ApngEncoderOptions): AnimatedEncoder {
  return new ApngEncoder(options);
}

/** One frame's RGBA at the document's own resolution, in browser storage. */
interface HeldFrame {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

class ApngEncoder implements AnimatedEncoder {
  readonly format = "apng" as const;

  readonly #options: ApngEncoderOptions;
  readonly #builder = new LoopPaletteBuilder();
  readonly #held: HeldFrame[] = [];
  /** One per frame, at output resolution. Emptied when the palette overflows. */
  #indexMaps: Bytes[] = [];
  #indexed = true;
  #width = 0;
  #height = 0;
  #startedAt = performance.now();

  constructor(options: ApngEncoderOptions) {
    this.#options = options;
  }

  async addFrame(frame: ExportFrame, index: number): Promise<void> {
    throwIfCancelled(this.#options.signal);
    const signalOption =
      this.#options.signal === undefined ? {} : { signal: this.#options.signal };
    const scale = this.#options.settings.scale;

    if (this.#held.length === 0) {
      this.#width = frame.width * scale;
      this.#height = frame.height * scale;
    } else if (frame.width * scale !== this.#width || frame.height * scale !== this.#height) {
      throw new RangeError(
        `frame ${index} is ${frame.width * scale}x${frame.height * scale} and the ` +
          `animation is ${this.#width}x${this.#height}`,
      );
    }

    if (this.#indexed) {
      // Censused before the multiplier, then the *indices* are replicated. Pixel
      // replication cannot invent a colour, so the two give the same table — and
      // this way an 8x export counts one pixel where the other counts 64, and
      // carries one byte a pixel where the other carries four.
      const indexed = await this.#builder.index(frame, signalOption);
      if (indexed === null) {
        // Recorded rather than silent: the file about to be written is several
        // times larger than the one the earlier frames implied, and the reason
        // is a colour that arrived on frame `index`.
        log.info("apng falls back to rgba", {
          frame: index,
          reason: "the loop passed 256 distinct colours",
        });
        this.#indexed = false;
        this.#indexMaps = [];
      } else {
        this.#indexMaps.push(
          replicateIndices(indexed.indices, frame.width, frame.height, scale).indices,
        );
      }
    }

    // Held at the document's own resolution for the RGBA path, which is not
    // chosen until the last frame has been seen and which scales on its way out.
    // `new Blob` copies into browser-managed storage — the browser's to page to
    // disk — and releases the JS buffer with this call.
    // Copied into an `ArrayBuffer`-backed view first, not for tidiness: a frame
    // may be backed by a `SharedArrayBuffer` — cross-origin isolation is
    // mandatory here so the WASM thread pool can exist — and `Blob` refuses one,
    // correctly, since another thread could write it mid-read. The argument is
    // the one `export/types.ts` makes about `Bytes`.
    this.#held.push({
      blob: new Blob([new Uint8Array(frame.data) as Bytes]),
      width: frame.width,
      height: frame.height,
    });
  }

  async finish(): Promise<AnimatedResult> {
    if (this.#held.length === 0) {
      throw new Error("an APNG needs at least one frame, and none were added");
    }
    throwIfCancelled(this.#options.signal);

    const palette = this.#indexed ? this.#builder.palette() : null;
    const bitDepth = palette === null ? 8 : bitDepthFor(palette.count);
    const delay = apngDelayFor(this.#options.timing.fps);
    const frames = this.#held.length;

    const parts: Bytes[] = [SIGNATURE, chunk("IHDR", ihdr(this.#width, this.#height, palette, bitDepth))];
    // `acTL` before `IDAT` is required by the specification, and a reader that
    // finds it afterwards is entitled to show a still image.
    parts.push(chunk("acTL", actl(frames, this.#options.settings.loop ? 0 : 1)));
    if (palette !== null) {
      parts.push(chunk("PLTE", plte(palette)));
      const transparency = trns(palette);
      if (transparency !== null) parts.push(chunk("tRNS", transparency));
    }

    let sequence = 0;
    let previous: Uint8Array | null = null;
    let croppedFrames = 0;

    for (let index = 0; index < frames; index += 1) {
      throwIfCancelled(this.#options.signal);
      const source = await this.#framePixels(index);
      const stride = palette === null ? 4 : 1;

      const rect =
        previous === null ?
          { left: 0, top: 0, width: this.#width, height: this.#height }
        : changedRect(previous, source, this.#width, this.#height, stride);
      if (rect.width !== this.#width || rect.height !== this.#height) croppedFrames += 1;

      const cropped = crop(source, this.#width, rect, stride);
      const payload = await this.#encodeRegion(cropped, rect.width, rect.height, palette, bitDepth);

      parts.push(chunk("fcTL", fctl(sequence, rect, delay)));
      sequence += 1;
      if (index === 0) {
        // The first frame is the PNG's own image, so it is an IDAT and carries
        // no sequence number of its own.
        parts.push(chunk("IDAT", payload));
      } else {
        const framed = new Uint8Array(4 + payload.length) as Bytes;
        writeBe32(framed, 0, sequence);
        framed.set(payload, 4);
        sequence += 1;
        parts.push(chunk("fdAT", framed));
      }

      previous = source;
      this.#options.onProgress?.((index + 1) / frames);
    }

    parts.push(chunk("IEND", new Uint8Array(0) as Bytes));

    const file = concat(parts);
    const playbackFps = delay.den / delay.num;
    const notes: string[] = [];
    if (palette === null) {
      notes.push(
        "This loop has more than 256 distinct colours, so the frames are written as " +
          "full RGBA. A quantizing node in the stack would make the file several " +
          "times smaller without changing what it shows.",
      );
    }
    if (this.#builder.flattened) {
      notes.push(
        "Partly transparent pixels were composited onto black while the palette was " +
          "being built. The RGBA path keeps them; this file does not use it.",
      );
    }

    log.info("apng written", {
      frames,
      width: this.#width,
      height: this.#height,
      bytes: file.length,
      size: formatBytes(file.length),
      indexed: palette !== null,
      paletteEntries: palette?.count ?? 0,
      bitDepth,
      croppedFrames,
      delay: `${delay.num}/${delay.den}`,
      playbackFps: Math.round(playbackFps * 100) / 100,
    });

    return {
      blob: new Blob([file], { type: "image/apng" }),
      format: "apng",
      width: this.#width,
      height: this.#height,
      frames,
      fps: this.#options.timing.fps,
      playbackFps,
      bytes: file.length,
      indexed: palette !== null,
      paletteEntries: palette?.count ?? 0,
      flattened: palette !== null && this.#builder.flattened,
      ms: Math.round(performance.now() - this.#startedAt),
      notes,
    };
  }

  /**
   * One frame's pixels at output resolution: its index map, or its RGBA read
   * back out of the blob and replicated.
   *
   * The multiplier is applied here rather than on the way in because only one of
   * the two paths needs it applied to colour, and the one that does is the one
   * that is not usually taken.
   */
  async #framePixels(index: number): Promise<Uint8Array> {
    const map = this.#indexMaps[index];
    if (map !== undefined) return map;
    const held = this.#held[index];
    if (held === undefined) throw new RangeError(`frame ${index} was never added`);

    const data = new Uint8ClampedArray(await held.blob.arrayBuffer());
    const scaled = await scaleNearest(
      { width: held.width, height: held.height, data },
      this.#options.settings.scale,
      this.#options.signal === undefined ? {} : { signal: this.#options.signal },
    );
    return scaled.data;
  }

  /**
   * One region, through the real PNG encoder, with the file it produced thrown
   * away and its `IDAT` kept. See the note at the top of the file.
   */
  async #encodeRegion(
    pixels: Uint8Array,
    width: number,
    height: number,
    palette: LoopPalette | null,
    bitDepth: 1 | 2 | 4 | 8,
  ): Promise<Bytes> {
    const signalOption =
      this.#options.signal === undefined ? {} : { signal: this.#options.signal };

    if (palette === null) {
      const png = await encodePng({ kind: "rgba", width, height, data: pixels }, signalOption);
      return extractIdat(png);
    }

    // `transparentEntries: 0` is correct for this call and not a shortcut: the
    // encoder only reads it to decide whether to write a `tRNS`, and that chunk
    // is written once for the whole animation up in `finish`, from the loop's
    // palette rather than from one frame's.
    const image: IndexedImage = {
      width,
      height,
      indices: pixels as Bytes,
      palette: palette.rgba,
      count: palette.count,
      transparentEntries: 0,
      bitDepth,
    };
    const png = await encodePng({ kind: "indexed", image }, signalOption);
    return extractIdat(png);
  }
}

// --- chunks -------------------------------------------------------------

function ihdr(
  width: number,
  height: number,
  palette: LoopPalette | null,
  bitDepth: number,
): Bytes {
  const data = new Uint8Array(13) as Bytes;
  writeBe32(data, 0, width);
  writeBe32(data, 4, height);
  data[8] = palette === null ? 8 : bitDepth;
  data[9] = palette === null ? 6 : 3;
  data[10] = 0; // deflate, the only compression the format has
  data[11] = 0; // the five adaptive filters, likewise
  data[12] = 0; // no interlace: Adam7 and APNG are a combination nothing reads
  return data;
}

function actl(frames: number, plays: number): Bytes {
  const data = new Uint8Array(8) as Bytes;
  writeBe32(data, 0, frames);
  // 0 means forever. Not a sentinel this module invented — it is the field's
  // defined value, the same as GIF's Netscape loop count.
  writeBe32(data, 4, plays);
  return data;
}

function fctl(sequence: number, rect: Rect, delay: ApngDelay): Bytes {
  const data = new Uint8Array(26) as Bytes;
  writeBe32(data, 0, sequence);
  writeBe32(data, 4, rect.width);
  writeBe32(data, 8, rect.height);
  writeBe32(data, 12, rect.left);
  writeBe32(data, 16, rect.top);
  data[20] = (delay.num >>> 8) & 0xff;
  data[21] = delay.num & 0xff;
  data[22] = (delay.den >>> 8) & 0xff;
  data[23] = delay.den & 0xff;
  data[24] = DISPOSE_OP_NONE;
  data[25] = BLEND_OP_SOURCE;
  return data;
}

function plte(palette: LoopPalette): Bytes {
  const data = new Uint8Array(palette.count * 3) as Bytes;
  for (let entry = 0; entry < palette.count; entry += 1) {
    const from = entry * 4;
    const to = entry * 3;
    data[to] = palette.rgba[from] ?? 0;
    data[to + 1] = palette.rgba[from + 1] ?? 0;
    data[to + 2] = palette.rgba[from + 2] ?? 0;
  }
  return data;
}

/**
 * The transparency chunk, or `null` when the loop is opaque.
 *
 * `tRNS` may be shorter than the palette and every entry it omits is opaque, so
 * it runs only as far as the transparent entry — which is why the loop palette
 * does not have to be reordered to put non-opaque entries first the way
 * `census.ts` does for a still. Reordering would mean rewriting every index map.
 */
function trns(palette: LoopPalette): Bytes | null {
  if (palette.transparentIndex < 0) return null;
  const data = new Uint8Array(palette.transparentIndex + 1).fill(255) as Bytes;
  data[palette.transparentIndex] = 0;
  return data;
}

function chunk(type: string, data: Bytes): Bytes {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) typeBytes[i] = type.charCodeAt(i);

  const out = new Uint8Array(12 + data.length) as Bytes;
  writeBe32(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  // The CRC covers the type and the data but not the length, and is taken over
  // the two without concatenating them.
  writeBe32(out, 8 + data.length, crc32Of(typeBytes, data));
  return out;
}

/**
 * Pull the image data out of a finished PNG.
 *
 * Every `IDAT` is concatenated, because `encodePng` writes one today and a
 * reader that assumed so would break silently if it ever wrote two.
 */
export function extractIdat(png: Bytes): Bytes {
  const parts: Uint8Array[] = [];
  let at = SIGNATURE.length;
  let total = 0;

  while (at + 8 <= png.length) {
    const length = readBe32(png, at);
    const type = String.fromCharCode(
      png[at + 4] ?? 0,
      png[at + 5] ?? 0,
      png[at + 6] ?? 0,
      png[at + 7] ?? 0,
    );
    const from = at + 8;
    if (type === "IDAT") {
      parts.push(png.subarray(from, from + length));
      total += length;
    }
    at = from + length + 4;
    if (type === "IEND") break;
  }

  if (total === 0) {
    // Unreachable from `encodePng`, and stated rather than assumed: a silent
    // zero-length frame would produce an APNG that decodes to nothing.
    throw new Error("the PNG encoder produced no IDAT for a frame");
  }
  const out = new Uint8Array(total) as Bytes;
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// --- regions ------------------------------------------------------------

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The smallest rectangle covering every pixel that differs.
 *
 * `stride` is bytes per pixel — 1 for an index map, 4 for RGBA — so one
 * implementation serves both. Two identical frames produce a 1x1 rectangle
 * rather than an empty one: there is no zero-size APNG frame, and one redundant
 * pixel is cheaper than a special case in the delay accounting.
 */
export function changedRect(
  previous: Uint8Array,
  current: Uint8Array,
  width: number,
  height: number,
  stride: number,
): Rect {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    const row = y * width * stride;
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1) {
      const at = row + x * stride;
      let differs = false;
      for (let byte = 0; byte < stride; byte += 1) {
        if (previous[at + byte] !== current[at + byte]) {
          differs = true;
          break;
        }
      }
      if (!differs) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0) continue;
    if (first < left) left = first;
    if (last > right) right = last;
    if (y < top) top = y;
    bottom = y;
  }

  if (right < 0) return { left: 0, top: 0, width: 1, height: 1 };
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/** Copy a sub-rectangle out of a full-frame buffer. */
export function crop(
  source: Uint8Array,
  width: number,
  rect: Rect,
  stride: number,
): Uint8Array {
  if (rect.left === 0 && rect.top === 0 && rect.width === width) return source;
  const out = new Uint8Array(rect.width * rect.height * stride);
  for (let y = 0; y < rect.height; y += 1) {
    const from = ((rect.top + y) * width + rect.left) * stride;
    out.set(source.subarray(from, from + rect.width * stride), y * rect.width * stride);
  }
  return out;
}

// --- bytes --------------------------------------------------------------

function writeBe32(target: Uint8Array, at: number, value: number): void {
  target[at] = (value >>> 24) & 0xff;
  target[at + 1] = (value >>> 16) & 0xff;
  target[at + 2] = (value >>> 8) & 0xff;
  target[at + 3] = value & 0xff;
}

function readBe32(source: Uint8Array, at: number): number {
  return (
    (((source[at] ?? 0) << 24) |
      ((source[at + 1] ?? 0) << 16) |
      ((source[at + 2] ?? 0) << 8) |
      (source[at + 3] ?? 0)) >>>
    0
  );
}

function concat(parts: readonly Uint8Array[]): Bytes {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total) as Bytes;
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
