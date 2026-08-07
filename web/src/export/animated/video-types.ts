/**
 * What a muxer takes, written down away from both muxers.
 *
 * The two containers share nothing structurally — one is EBML, the other is a
 * tree of length-prefixed boxes — but they take exactly the same input, and the
 * driver in `video.ts` must be able to hand either the same thing. Declaring it
 * here rather than in one of them is what stops `mp4.ts` importing `webm.ts` for
 * a type and pulling a whole Matroska writer into a build that only wanted MP4.
 */

import type { Bytes } from "../types";
import type { VideoCodec } from "./types";

/**
 * One frame as `VideoEncoder` produced it.
 *
 * Timestamps are microseconds, which is `EncodedVideoChunk`'s own unit. They are
 * kept in it all the way to the muxer so that the one conversion to the
 * container's unit happens in the place that knows what that unit is — a
 * millisecond here and a 90 kHz tick there — rather than twice, differently.
 */
export interface CodedFrame {
  readonly data: Bytes;
  readonly keyFrame: boolean;
  readonly timestampUs: number;
  readonly durationUs: number;
}

export interface MuxedTrack {
  readonly width: number;
  readonly height: number;
  readonly codec: VideoCodec;
  readonly fps: number;
  /**
   * The codec's out-of-band configuration, as `VideoEncoder` supplied it:
   * `avcC` for H.264, `av1C` for AV1, and `null` for VP8 and VP9, which have
   * none at all.
   *
   * `null` rather than an empty array, because "this codec has no configuration"
   * and "the encoder did not give us one" are different states and only the
   * first is acceptable. `video.ts` refuses the second by name.
   */
  readonly description: Bytes | null;
}
