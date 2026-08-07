/**
 * F-EX-07 — MP4 and WebM, encoded from generated frames through
 * `VideoEncoder`.
 *
 * **No decoder is involved anywhere, and that is the whole reason this is a
 * couple of hundred lines rather than a project.** Video *input* is out of
 * scope (docs/ARCHITECTURE.md), so nothing here has to parse a bitstream, guess
 * a container's flavour, or carry ffmpeg. What is left is: hand the platform's
 * own hardware-accelerated encoder a sequence of frames, collect what it emits,
 * and write a container around it. The containers are `mp4.ts` and `webm.ts`.
 *
 * ## Alpha is dropped, and it is said out loud
 *
 * `VideoEncoder` takes a `VideoFrame`; every codec here encodes it as Y'CbCr
 * with no alpha plane. A transparent pixel handed straight in would come out as
 * whatever colour happened to be sitting under its zero alpha, which for this
 * pipeline is the untouched source colour — a picture nobody has seen. So the
 * frame is composited onto the export matte first, through the same
 * linear-light table JPEG's flatten uses, and the result reports `flattened`.
 *
 * ## Support is probed, never assumed
 *
 * `VideoEncoder.isConfigSupported` answers exactly the question the panel needs
 * — can *this browser* encode *this codec at this size* — and it is asked before
 * a frame is rendered rather than discovered on the first `encode`. An
 * unsupported codec is a refusal naming the codec and the alternative, not a
 * silent substitution: a person who asked for AV1 and got H.264 has a file that
 * is three times the size they planned for.
 *
 * ## Backpressure without an event
 *
 * `encodeQueueSize` is read and the loop yields until it drops. The `dequeue`
 * event would be tidier and is newer than the rest of the API; a poll that
 * hands the thread back is the same behaviour with nothing to feature-detect,
 * and this loop is already yielding for F-EX-13's cancel button.
 */

import { logger } from "../../lib/log";
import { EXPORT_MATTE, flattenOntoMatte } from "../flatten";
import { scaleNearest } from "../scale";
import { formatBytes } from "../settings";
import { throwIfCancelled, yieldToHost } from "../progress";
import type { Bytes, ExportFrame } from "../types";
import { muxMp4 } from "./mp4";
import { videoCodecInfo } from "./settings";
import type {
  AnimatedEncoder,
  AnimatedResult,
  AnimatedSettings,
  AnimatedTiming,
  VideoCodec,
} from "./types";
import type { CodedFrame, MuxedTrack } from "./video-types";
import { muxWebm } from "./webm";

const log = logger("export");

/**
 * How many frames may sit in the encoder's queue before the loop waits.
 *
 * Each queued frame holds a full uncompressed picture, so this is a memory
 * bound rather than a throughput one: eight frames of a 4K export is 265 MB.
 */
const MAX_QUEUE_DEPTH = 8;

/**
 * Seconds between forced keyframes.
 *
 * Two, because a loop is short and a player that starts mid-file — or a
 * scanning seek in a WebM with no cues — needs somewhere to begin. It costs a
 * few percent of the file and buys the difference between a seekable animation
 * and one that must be watched from the top.
 */
const KEYFRAME_INTERVAL_SECONDS = 2;

/** This browser cannot encode what was asked for. Never a substitution. */
export class VideoEncoderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoEncoderUnavailableError";
  }
}

/** Whether `VideoEncoder` exists at all. */
export function videoEncodingAvailable(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

export interface VideoSupport {
  readonly supported: boolean;
  /** Why not, in the words the panel shows. Empty when supported. */
  readonly reason: string;
}

/**
 * Ask the platform whether it can encode this configuration.
 *
 * Takes the extent as well as the codec because the answer depends on it: a
 * browser that encodes H.264 at 1080p may refuse it at 8K, and a probe that
 * ignored the size would enable a control that fails on the first frame.
 */
export async function probeVideoCodec(
  codec: VideoCodec,
  width: number,
  height: number,
  bitrateKbps: number,
): Promise<VideoSupport> {
  if (!videoEncodingAvailable()) {
    return {
      supported: false,
      reason:
        "this browser has no VideoEncoder, so MP4 and WebM cannot be written here. " +
        "GIF, APNG and animated WebP are unaffected.",
    };
  }
  const info = videoCodecInfo(codec);
  try {
    const support = await VideoEncoder.isConfigSupported(configFor(info.codec, width, height, bitrateKbps, 30));
    if (support.supported === true) return { supported: true, reason: "" };
    return {
      supported: false,
      reason: `this browser will not encode ${info.label} at ${width}x${height}.`,
    };
  } catch (error) {
    // A throw is the other way the API refuses a configuration — an unparseable
    // codec string, for instance. Reported rather than swallowed, and it leaves
    // the codec unsupported.
    log.warn("video codec probe threw", { codec, error: String(error) });
    return {
      supported: false,
      reason: `this browser refused the ${info.label} configuration: ${String(error)}`,
    };
  }
}

function configFor(
  codec: string,
  width: number,
  height: number,
  bitrateKbps: number,
  fps: number,
): VideoEncoderConfig {
  return {
    codec,
    width,
    height,
    bitrate: Math.round(bitrateKbps * 1000),
    framerate: fps,
    // "quality" rather than "realtime": nothing here is being streamed, and the
    // realtime mode trades exactly the high-frequency detail a dither is made of
    // for latency nobody is waiting on.
    latencyMode: "quality",
    ...(codec.startsWith("avc1") ?
      // Without this the encoder emits Annex B, whose start codes an MP4 sample
      // must not contain, and no `avcC` record at all.
      { avc: { format: "avc" as const } }
    : {}),
  };
}

export interface VideoEncoderOptions {
  readonly settings: AnimatedSettings;
  readonly timing: AnimatedTiming;
  readonly signal?: AbortSignal;
}

export function createVideoEncoder(options: VideoEncoderOptions): AnimatedEncoder {
  return new WebCodecsEncoder(options);
}

class WebCodecsEncoder implements AnimatedEncoder {
  readonly format: "mp4" | "webm";

  readonly #options: VideoEncoderOptions;
  readonly #coded: CodedFrame[] = [];
  #encoder: VideoEncoder | null = null;
  #description: Bytes | null = null;
  #width = 0;
  #height = 0;
  #frames = 0;
  #keyFrames = 0;
  #flattened = false;
  #failure: Error | null = null;
  #startedAt = performance.now();

  constructor(options: VideoEncoderOptions) {
    this.#options = options;
    this.format = videoCodecInfo(options.settings.codec).container;
  }

  async addFrame(frame: ExportFrame, index: number): Promise<void> {
    throwIfCancelled(this.#options.signal);
    this.#throwIfFailed();

    const signalOption =
      this.#options.signal === undefined ? {} : { signal: this.#options.signal };
    const scaled = await scaleNearest(frame, this.#options.settings.scale, signalOption);

    // Codecs have no alpha plane; see the note at the top. The composite runs on
    // the scaled copy, which nobody else holds.
    const flattened = await flattenOntoMatte(scaled.data, EXPORT_MATTE, signalOption);
    if (flattened.hadTransparency) this.#flattened = true;

    if (this.#encoder === null) {
      this.#width = scaled.width;
      this.#height = scaled.height;
      await this.#start();
    } else if (scaled.width !== this.#width || scaled.height !== this.#height) {
      throw new RangeError(
        `frame ${index} is ${scaled.width}x${scaled.height} and the video is ` +
          `${this.#width}x${this.#height}`,
      );
    }

    const encoder = this.#encoder;
    if (encoder === null) throw new Error("unreachable: the encoder was just configured");

    while (encoder.encodeQueueSize >= MAX_QUEUE_DEPTH) {
      throwIfCancelled(this.#options.signal);
      this.#throwIfFailed();
      await yieldToHost();
    }

    const durationUs = Math.round(1_000_000 / Math.max(1, this.#options.timing.fps));
    const videoFrame = new VideoFrame(flattened.data, {
      format: "RGBA",
      codedWidth: this.#width,
      codedHeight: this.#height,
      timestamp: index * durationUs,
      duration: durationUs,
    });

    const interval = Math.max(1, Math.round(this.#options.timing.fps * KEYFRAME_INTERVAL_SECONDS));
    const keyFrame = index % interval === 0;
    try {
      encoder.encode(videoFrame, { keyFrame });
    } finally {
      // A `VideoFrame` holds a platform buffer that is not garbage collected;
      // leaking one per frame exhausts the pool within a few dozen frames and
      // the encoder then rejects everything. Closed on the throwing path too.
      videoFrame.close();
    }
    this.#frames += 1;
  }

  async finish(): Promise<AnimatedResult> {
    const encoder = this.#encoder;
    if (encoder === null) {
      throw new Error("a video needs at least one frame, and none were added");
    }
    this.#throwIfFailed();
    await encoder.flush();
    this.#throwIfFailed();
    encoder.close();
    this.#encoder = null;
    throwIfCancelled(this.#options.signal);

    const info = videoCodecInfo(this.#options.settings.codec);
    const track: MuxedTrack = {
      width: this.#width,
      height: this.#height,
      codec: this.#options.settings.codec,
      fps: this.#options.timing.fps,
      description: this.#description,
    };
    const file = info.container === "mp4" ? muxMp4(track, this.#coded) : muxWebm(track, this.#coded);

    const notes: string[] = [];
    if (this.#flattened) {
      notes.push(
        "Transparency was composited onto black. A video codec has no alpha channel, " +
          "so there is nowhere in the file for it to go.",
      );
    }
    notes.push(
      `Encoded at ${this.#options.settings.bitrateKbps} kb/s. Dither noise is the ` +
        `worst case for a video codec — it is exactly the high-frequency detail the ` +
        `transform discards first — so raise the bitrate if the dots smear.`,
    );
    if (info.container === "webm") {
      notes.push(
        "WebM carries no loop flag: whether it repeats is the player's decision, not " +
          "the file's.",
      );
    }

    log.info("video written", {
      container: info.container,
      codec: info.codec,
      frames: this.#coded.length,
      keyFrames: this.#keyFrames,
      width: this.#width,
      height: this.#height,
      bitrateKbps: this.#options.settings.bitrateKbps,
      bytes: file.length,
      size: formatBytes(file.length),
    });

    return {
      blob: new Blob([file], { type: info.container === "mp4" ? "video/mp4" : "video/webm" }),
      format: this.format,
      width: this.#width,
      height: this.#height,
      frames: this.#coded.length,
      fps: this.#options.timing.fps,
      // A video's frame rate is stored as a per-sample duration in a fine
      // timescale, so there is no rounding to report.
      playbackFps: this.#options.timing.fps,
      bytes: file.length,
      indexed: false,
      paletteEntries: 0,
      flattened: this.#flattened,
      ms: Math.round(performance.now() - this.#startedAt),
      notes,
    };
  }

  async #start(): Promise<void> {
    if (!videoEncodingAvailable()) {
      throw new VideoEncoderUnavailableError(
        "this browser has no VideoEncoder, so MP4 and WebM cannot be written here. " +
          "GIF, APNG and animated WebP are unaffected.",
      );
    }
    const info = videoCodecInfo(this.#options.settings.codec);
    const config = configFor(
      info.codec,
      this.#width,
      this.#height,
      this.#options.settings.bitrateKbps,
      this.#options.timing.fps,
    );

    const support = await VideoEncoder.isConfigSupported(config);
    if (support.supported !== true) {
      throw new VideoEncoderUnavailableError(
        `this browser will not encode ${info.label} at ${this.#width}x${this.#height}. ` +
          `Choose another codec — the panel marks which ones it accepts.`,
      );
    }

    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const description = metadata?.decoderConfig?.description;
        if (description !== undefined && this.#description === null) {
          this.#description = new Uint8Array(
            description instanceof ArrayBuffer ? description : (
              (description as ArrayBufferView).buffer.slice(
                (description as ArrayBufferView).byteOffset,
                (description as ArrayBufferView).byteOffset +
                  (description as ArrayBufferView).byteLength,
              )
            ),
          ) as Bytes;
        }
        const data = new Uint8Array(chunk.byteLength) as Bytes;
        chunk.copyTo(data);
        if (chunk.type === "key") this.#keyFrames += 1;
        this.#coded.push({
          data,
          keyFrame: chunk.type === "key",
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? Math.round(1_000_000 / Math.max(1, this.#options.timing.fps)),
        });
      },
      error: (error: DOMException) => {
        // Recorded and rethrown from the next call rather than swallowed. The
        // callback cannot reject the caller's promise, so the failure is held
        // and surfaced at the first point that can.
        log.error("the video encoder failed", { error: error.message, name: error.name });
        this.#failure = new Error(`the video encoder failed: ${error.message}`);
      },
    });
    encoder.configure(config);
    this.#encoder = encoder;

    log.info("video encoder configured", {
      codec: info.codec,
      container: info.container,
      width: this.#width,
      height: this.#height,
      bitrateKbps: this.#options.settings.bitrateKbps,
      fps: this.#options.timing.fps,
    });
  }

  #throwIfFailed(): void {
    const failure = this.#failure;
    if (failure !== null) {
      this.#failure = null;
      const encoder = this.#encoder;
      this.#encoder = null;
      if (encoder !== null && encoder.state !== "closed") encoder.close();
      throw failure;
    }
  }
}
