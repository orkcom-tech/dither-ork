/**
 * What an animated export is, as types.
 *
 * Seven outputs across four requirements — F-EX-04 GIF, F-EX-05 APNG and
 * animated WebP, F-EX-06 a PNG sequence as a ZIP and a sprite sheet, F-EX-07
 * MP4 and WebM through `VideoEncoder` — and one shape that covers all of them:
 * frames go in one at a time, one file comes out, and the result says what
 * actually happened rather than only handing back bytes.
 *
 * ## Frames arrive one at a time and are never all held at once
 *
 * A 60-frame loop of a 1600x1200 document is 460 MB as RGBA. Nothing here ever
 * holds that: {@link AnimatedEncoder.addFrame} is called with a frame that is
 * valid only for the duration of the call, and every encoder turns it into the
 * smallest thing it can keep — a palette index map at one byte a pixel, an
 * already-compressed frame `Blob`, or an encoded video chunk — before returning.
 * The one buffer that is proportional to the whole loop is GIF's, and it is one
 * byte a pixel and the core states its own ceiling.
 *
 * That is also the reason this is an interface with three methods rather than a
 * function taking an array of frames. A function taking an array is a function
 * that has already decided the array exists.
 *
 * ## Every frame is the picture that was rendered, at the picture's own grid
 *
 * The same rule the still path follows (`export/source.ts`): the renderer
 * produces the frame, the sRGB transfer has already been applied exactly once,
 * and F-EX-12's integer multiplier replicates finished pixels rather than
 * re-running the graph at a larger size — a dither is a function of the pixel
 * grid it ran on, so a 2x render would be a different picture, not a bigger one.
 */

import type { Bytes, ExportFrame } from "../types";

/**
 * The animated outputs, as one union.
 *
 * The sprite sheet is in it despite being a still PNG, for the reason SVG is in
 * the still module's union: everything the panel does with a format — name the
 * file, choose a destination, measure the size, report the result — is the same
 * operation for it, and what differs is stated as data on
 * {@link AnimatedFormatInfo} rather than as a second code path.
 */
export type AnimatedFormat =
  | "gif"
  | "apng"
  | "webp"
  | "webm"
  | "mp4"
  | "png-sequence"
  | "sprite-sheet";

/**
 * How the frames are held in the file, which is what decides everything else
 * about a format's behaviour.
 *
 * - `palette` — one global colour table for the whole loop, one index per
 *   pixel. GIF. Refuses a picture of more than 256 colours rather than
 *   quantizing it a second time.
 * - `lossless` — full colour per frame, exactly. APNG, the PNG sequence, the
 *   sheet.
 * - `browser` — the platform's own still encoder, one frame at a time, assembled
 *   into an animated container here. Animated WebP.
 * - `video` — `VideoEncoder` produces coded chunks and a muxer here writes the
 *   container. MP4 and WebM.
 */
export type AnimatedCarrier = "palette" | "lossless" | "browser" | "video";

export interface AnimatedFormatInfo {
  readonly id: AnimatedFormat;
  readonly label: string;
  readonly mime: string;
  /** Without the dot. */
  readonly extension: string;
  readonly carrier: AnimatedCarrier;
  /** Whether the container can carry an alpha channel at all. */
  readonly alpha: boolean;
  /** Whether the quality control does anything. */
  readonly lossy: boolean;
  /** Whether the file plays on its own — false for the sheet and the ZIP. */
  readonly plays: boolean;
  /** Whether the loop control does anything. A ZIP has no loop. */
  readonly loops: boolean;
  /** One line a person reads before choosing it. */
  readonly detail: string;
}

/**
 * The codecs offered for F-EX-07, and the container each belongs in.
 *
 * Which of them a browser can actually encode is probed rather than assumed —
 * `VideoEncoder.isConfigSupported` answers it exactly — and an unsupported one
 * is a disabled control with the reason on it, never a silent substitution.
 */
export type VideoCodec = "avc" | "av1" | "vp9" | "vp8";

export interface VideoCodecInfo {
  readonly id: VideoCodec;
  readonly label: string;
  /** The string `VideoEncoder.configure` takes. */
  readonly codec: string;
  /** Which container this codec is written into. */
  readonly container: "mp4" | "webm";
  readonly detail: string;
}

/** Everything the animated export panel decides. */
export interface AnimatedSettings {
  readonly format: AnimatedFormat;
  /**
   * 1..100, read only by the formats whose {@link AnimatedFormatInfo.lossy} is
   * true. Kept across a format change, like the still panel's.
   */
  readonly quality: number;
  /** Integer multiplier, nearest-neighbour (F-EX-12). Never the preview zoom. */
  readonly scale: number;
  /** Play forever, or once. Read only by a format whose `loops` is true. */
  readonly loop: boolean;
  /** Columns in the sprite sheet (F-EX-06). Read only by `sprite-sheet`. */
  readonly columns: number;
  /** Read only by the video formats. */
  readonly codec: VideoCodec;
  /**
   * Video bitrate in kilobits per second.
   *
   * Explicit rather than derived from `quality`, because `VideoEncoder` takes a
   * bitrate and nothing else: a quality slider mapped onto one would be this
   * module inventing a curve and then being blamed for it.
   */
  readonly bitrateKbps: number;
}

/**
 * The frames and the clock, as the encoders see them.
 *
 * `fps` is what the document asked for. What a container can actually store is
 * a different question for each of them — GIF's delay is quantised to a
 * hundredth of a second and cannot represent 24 fps at all — and the difference
 * is reported in {@link AnimatedResult.notes} rather than silently absorbed.
 */
export interface AnimatedTiming {
  readonly frames: number;
  readonly fps: number;
}

/** What an animated export produced. Every field is a fact, not an inference. */
export interface AnimatedResult {
  readonly blob: Blob;
  readonly format: AnimatedFormat;
  /** Output extent, after the scale multiplier. */
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  /** What the document asked for. */
  readonly fps: number;
  /**
   * What the file will actually play at.
   *
   * Equal to {@link fps} for every format but GIF, whose delay is an integer
   * number of hundredths of a second.
   */
  readonly playbackFps: number;
  readonly bytes: number;
  /** True when the frames are held as palette indices. */
  readonly indexed: boolean;
  /** Palette entries written, when {@link indexed}. Zero otherwise. */
  readonly paletteEntries: number;
  /** True when transparency was flattened onto the matte. */
  readonly flattened: boolean;
  /** Wall time for the encode alone; rendering is reported separately. */
  readonly ms: number;
  /**
   * Things a person should be told, in the words they should be told them in.
   *
   * Not a log: these are consequences of what was asked for that are invisible
   * in the file — a frame rate the container rounded, an alpha channel a codec
   * dropped, a GIF that came out four times larger than the PNG of one frame.
   */
  readonly notes: readonly string[];
}

/**
 * One format's encoder.
 *
 * Constructed per export, fed frames in playback order, then finished. It is
 * not reusable and nothing here resets it: an encoder that can be finished
 * twice is an encoder whose second answer is a question nobody has thought
 * about.
 */
export interface AnimatedEncoder {
  readonly format: AnimatedFormat;
  /**
   * Take one frame.
   *
   * The buffer belongs to the caller and is valid only until this resolves —
   * `graph/animate.ts` hands out a cache-owned frame and the next frame may
   * evict it. Copy or encode inside the call.
   */
  addFrame(frame: ExportFrame, index: number): Promise<void>;
  /** Assemble the file. Called once, after the last frame. */
  finish(): Promise<AnimatedResult>;
}

/** Packed RGBA palette entries plus the one index, if any, drawn as nothing. */
export interface LoopPalette {
  /** `count * 4` bytes. Every entry is opaque except the transparent one. */
  readonly rgba: Bytes;
  readonly count: number;
  /** Index of the fully transparent entry, or -1 when the loop is opaque. */
  readonly transparentIndex: number;
}
