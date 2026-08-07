/**
 * F-EX-06 — the PNG sequence as a ZIP, and the sprite sheet.
 *
 * Neither of these is an animated format. They are the two ways of handing a
 * loop to something that is not a player: a folder of numbered frames for
 * another tool, and one image for a game engine or a CSS animation. They sit in
 * this module rather than beside the still export because everything around them
 * is the animated path — the loop, the seam check, the per-frame progress — and
 * only the last step differs.
 *
 * ## Both are written by the existing PNG encoder
 *
 * `export/encode.ts` already turns a frame plus settings into a PNG, indexed
 * when the frame is. A sequence entry is exactly that call, and the sheet is
 * that call on one large frame. So a frame in the ZIP is byte-identical to what
 * the still export of that frame would have produced, and the sheet of a
 * four-colour dither comes out as a 2-bit indexed PNG without this file knowing
 * what a palette is.
 *
 * ## The ZIP is written by the batch module's writer
 *
 * `batch/zip.ts` is a complete, tested ZIP writer with a stated Zip64 limit, a
 * per-entry store-or-deflate decision and `Blob`-backed bodies so a long
 * sequence does not sit in the JS heap. A second one here would be two hundred
 * lines of the same format with its own bugs; PNG bodies are already deflated,
 * and that writer stores them rather than deflating them twice, which is
 * precisely the decision a sequence of PNGs needs.
 *
 * ## The archive has no clock in it
 *
 * `ZipBuilder` requires a modification time with no default, deliberately, so
 * that the one place a clock may be read is the call site that can say why. This
 * one says: **it does not read one.** Every entry is stamped with the format's
 * own 1980 epoch, so two exports of the same document produce byte-identical
 * archives. A wall-clock stamp would make a `.zip` a thing that cannot be
 * compared, diffed or checksummed against a previous run, which for an
 * application whose whole determinism story is "same document, same output" is
 * a worse trade than a file date nobody reads.
 */

import { logger } from "../../lib/log";
import { ZipBuilder } from "../../batch/zip";
import { encodeFrame } from "../encode";
import { DEFAULT_TRACE_SETTINGS } from "../trace";
import { formatBytes } from "../settings";
import { throwIfCancelled } from "../progress";
import type { Bytes, ExportFrame, ExportSettings } from "../types";
import { MAX_ANIMATED_FRAME_PIXELS, sheetGrid } from "./settings";
import type {
  AnimatedEncoder,
  AnimatedResult,
  AnimatedSettings,
  AnimatedTiming,
} from "./types";

const log = logger("export");

/**
 * The date every archive entry carries.
 *
 * The ZIP format's own epoch. `dosDateTime` clamps anything before 1980 to it,
 * so this is the one value that is both representable and constant.
 */
const ARCHIVE_EPOCH = new Date(0);

/** Digits in a frame number. Four sorts a 9999-frame loop correctly as text. */
const FRAME_DIGITS = 4;

/** `name-0007.png`. Zero-padded so a directory listing is in playback order. */
export function sequenceEntryName(base: string, index: number, total: number): string {
  const digits = Math.max(FRAME_DIGITS, String(Math.max(1, total) - 1).length);
  return `${base}-${String(index).padStart(digits, "0")}.png`;
}

/** The still settings one frame of a sequence or a sheet is encoded with. */
function pngSettings(settings: AnimatedSettings, scale: number): ExportSettings {
  return {
    format: "png",
    quality: settings.quality,
    scale,
    trace: DEFAULT_TRACE_SETTINGS,
  };
}

export interface SequenceEncoderOptions {
  readonly settings: AnimatedSettings;
  readonly timing: AnimatedTiming;
  /** The stem every entry is named from — the export file name without its suffix. */
  readonly baseName: string;
  readonly signal?: AbortSignal;
}

export function createPngSequenceEncoder(options: SequenceEncoderOptions): AnimatedEncoder {
  return new PngSequenceEncoder(options);
}

class PngSequenceEncoder implements AnimatedEncoder {
  readonly format = "png-sequence" as const;

  readonly #options: SequenceEncoderOptions;
  readonly #zip: ZipBuilder;
  #width = 0;
  #height = 0;
  #frames = 0;
  #indexedFrames = 0;
  #startedAt = performance.now();

  constructor(options: SequenceEncoderOptions) {
    this.#options = options;
    this.#zip = new ZipBuilder({
      modifiedAt: ARCHIVE_EPOCH,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async addFrame(frame: ExportFrame, index: number): Promise<void> {
    throwIfCancelled(this.#options.signal);
    const encoded = await encodeFrame(
      frame,
      pngSettings(this.#options.settings, this.#options.settings.scale),
      this.#options.signal === undefined ? {} : { signal: this.#options.signal },
    );
    this.#width = encoded.width;
    this.#height = encoded.height;
    if (encoded.indexed) this.#indexedFrames += 1;

    await this.#zip.add(
      sequenceEntryName(this.#options.baseName, index, this.#options.timing.frames),
      encoded.blob,
      "image/png",
    );
    this.#frames += 1;
  }

  async finish(): Promise<AnimatedResult> {
    if (this.#frames === 0) {
      throw new Error("a PNG sequence needs at least one frame, and none were added");
    }
    const blob = this.#zip.finish();
    const notes: string[] = [];
    if (this.#indexedFrames > 0 && this.#indexedFrames < this.#frames) {
      // Worth saying: a sequence where some frames are indexed and some are not
      // is a sequence whose files jump in size, and the reason is a frame that
      // crossed 256 colours rather than anything about the export.
      notes.push(
        `${this.#indexedFrames} of ${this.#frames} frames came out indexed; the rest ` +
          `have more than 256 colours and are RGBA, so they are several times larger.`,
      );
    }
    notes.push(
      "The archive stores each PNG rather than deflating it again, and every entry " +
        "carries the ZIP epoch as its date, so the same document always produces the " +
        "same archive.",
    );

    log.info("png sequence written", {
      frames: this.#frames,
      indexedFrames: this.#indexedFrames,
      width: this.#width,
      height: this.#height,
      bytes: blob.size,
      size: formatBytes(blob.size),
    });

    return {
      blob,
      format: "png-sequence",
      width: this.#width,
      height: this.#height,
      frames: this.#frames,
      fps: this.#options.timing.fps,
      playbackFps: this.#options.timing.fps,
      bytes: blob.size,
      indexed: this.#indexedFrames === this.#frames,
      paletteEntries: 0,
      flattened: false,
      ms: Math.round(performance.now() - this.#startedAt),
      notes,
    };
  }
}

// --- sprite sheet -------------------------------------------------------

export interface SheetEncoderOptions {
  readonly settings: AnimatedSettings;
  readonly timing: AnimatedTiming;
  readonly signal?: AbortSignal;
}

export function createSpriteSheetEncoder(options: SheetEncoderOptions): AnimatedEncoder {
  return new SpriteSheetEncoder(options);
}

/**
 * Frames tiled into one image, left to right and then down.
 *
 * The sheet is allocated once, from the first frame's extent, and each frame is
 * blitted into its cell as it arrives — so the memory cost is the finished sheet
 * and nothing else, rather than the sheet plus every frame that went into it.
 *
 * Cells past the last frame are left at zero, which is transparent black. Not a
 * colour choice: an engine reading a sheet indexes cells by number and never
 * looks at the trailing ones, and filling them with anything visible would show
 * up as a stray tile in any tool that displays the sheet whole.
 */
class SpriteSheetEncoder implements AnimatedEncoder {
  readonly format = "sprite-sheet" as const;

  readonly #options: SheetEncoderOptions;
  #sheet: Bytes | null = null;
  #cellWidth = 0;
  #cellHeight = 0;
  #columns = 1;
  #rows = 1;
  #frames = 0;
  #startedAt = performance.now();

  constructor(options: SheetEncoderOptions) {
    this.#options = options;
  }

  async addFrame(frame: ExportFrame, index: number): Promise<void> {
    throwIfCancelled(this.#options.signal);
    const scale = this.#options.settings.scale;

    if (this.#sheet === null) {
      const grid = sheetGrid(this.#options.timing.frames, this.#options.settings.columns);
      this.#cellWidth = frame.width * scale;
      this.#cellHeight = frame.height * scale;
      this.#columns = grid.columns;
      this.#rows = grid.rows;

      const pixels = this.#cellWidth * this.#columns * this.#cellHeight * this.#rows;
      if (pixels > MAX_ANIMATED_FRAME_PIXELS) {
        throw new RangeError(
          `a sheet of ${this.#options.timing.frames} frames at ${this.#cellWidth}x` +
            `${this.#cellHeight} is ${pixels} pixels, past the ${MAX_ANIMATED_FRAME_PIXELS} ` +
            `one image may be here. Lower the scale, or export the PNG sequence instead — ` +
            `the column count does not change the total.`,
        );
      }
      this.#sheet = new Uint8Array(pixels * 4) as Bytes;
    } else if (frame.width * scale !== this.#cellWidth || frame.height * scale !== this.#cellHeight) {
      throw new RangeError(
        `frame ${index} is ${frame.width * scale}x${frame.height * scale} and the sheet's ` +
          `cells are ${this.#cellWidth}x${this.#cellHeight}`,
      );
    }

    const sheetWidth = this.#cellWidth * this.#columns;
    const cellX = (index % this.#columns) * this.#cellWidth;
    const cellY = Math.floor(index / this.#columns) * this.#cellHeight;
    const sheet = this.#sheet;

    // Replication and placement in one pass. Going through `scaleNearest` first
    // would allocate a second buffer per frame for a copy that lands here
    // anyway.
    for (let y = 0; y < frame.height; y += 1) {
      const sourceRow = y * frame.width * 4;
      for (let repeatY = 0; repeatY < scale; repeatY += 1) {
        let at = ((cellY + y * scale + repeatY) * sheetWidth + cellX) * 4;
        for (let x = 0; x < frame.width; x += 1) {
          const from = sourceRow + x * 4;
          const r = frame.data[from] ?? 0;
          const g = frame.data[from + 1] ?? 0;
          const b = frame.data[from + 2] ?? 0;
          const a = frame.data[from + 3] ?? 0;
          for (let repeatX = 0; repeatX < scale; repeatX += 1) {
            sheet[at] = r;
            sheet[at + 1] = g;
            sheet[at + 2] = b;
            sheet[at + 3] = a;
            at += 4;
          }
        }
      }
    }
    this.#frames += 1;
  }

  async finish(): Promise<AnimatedResult> {
    const sheet = this.#sheet;
    if (sheet === null) {
      throw new Error("a sprite sheet needs at least one frame, and none were added");
    }
    const width = this.#cellWidth * this.#columns;
    const height = this.#cellHeight * this.#rows;

    // The scale multiplier has already been applied cell by cell, so the still
    // encoder is asked for 1 — replicating again here would produce a sheet of
    // the square of the multiplier.
    const encoded = await encodeFrame(
      { width, height, data: new Uint8ClampedArray(sheet.buffer, 0, sheet.length) },
      pngSettings(this.#options.settings, 1),
      this.#options.signal === undefined ? {} : { signal: this.#options.signal },
    );

    const notes: string[] = [
      `${this.#frames} frames in a ${this.#columns} by ${this.#rows} grid, each cell ` +
        `${this.#cellWidth} by ${this.#cellHeight}.`,
    ];
    if (this.#columns * this.#rows > this.#frames) {
      notes.push(
        `${this.#columns * this.#rows - this.#frames} cell(s) at the end are empty, ` +
          `because ${this.#frames} does not divide by ${this.#columns}.`,
      );
    }

    log.info("sprite sheet written", {
      frames: this.#frames,
      columns: this.#columns,
      rows: this.#rows,
      width,
      height,
      indexed: encoded.indexed,
      paletteEntries: encoded.paletteEntries,
      bytes: encoded.blob.size,
      size: formatBytes(encoded.blob.size),
    });

    return {
      blob: encoded.blob,
      format: "sprite-sheet",
      width,
      height,
      frames: this.#frames,
      fps: this.#options.timing.fps,
      playbackFps: this.#options.timing.fps,
      bytes: encoded.blob.size,
      indexed: encoded.indexed,
      paletteEntries: encoded.paletteEntries,
      flattened: encoded.flattened,
      ms: Math.round(performance.now() - this.#startedAt),
      notes,
    };
  }
}
