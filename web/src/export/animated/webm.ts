/**
 * F-EX-07, the WebM half — a Matroska muxer.
 *
 * `VideoEncoder` produces *coded frames*. It does not produce a file: the
 * container is the caller's problem, and there is no platform API that writes
 * one. So this is the smallest correct WebM that plays: an EBML header, one
 * Segment holding Info, Tracks and a run of Clusters, and one `SimpleBlock` per
 * frame.
 *
 * ## What is deliberately not written, and what that costs
 *
 * No `Cues`, no `SeekHead`, no `Tags`. The consequence is stated rather than
 * hidden: a player can play the file from the start and can seek by scanning,
 * but cannot seek instantly to an arbitrary point. For an animation loop of a
 * few seconds that is the difference between two indexes nobody reads and a
 * fifth of the code in this file. It is also why every cluster starts on a
 * keyframe — a scanning seek lands on something decodable.
 *
 * ## Why the size fields are all known
 *
 * Every element here is assembled after its children exist, so no element needs
 * the "unknown size" form that live streaming muxers use. That matters because
 * unknown-size elements are the part of Matroska that players disagree about;
 * a file with none of them is one fewer thing for a decoder to be lenient about.
 *
 * ## Timestamps
 *
 * `TimestampScale` is a million, so the file's unit is one millisecond, and
 * every block timestamp is a whole number of them. `VideoEncoder` reports
 * microseconds, so the conversion is a divide by a thousand and a round — done
 * once, here, rather than at each call site.
 */

import { logger } from "../../lib/log";
import type { Bytes } from "../types";
import type { CodedFrame, MuxedTrack } from "./video-types";

const log = logger("export");

/** Matroska's own unit, in nanoseconds. A million is one millisecond. */
const TIMESTAMP_SCALE_NS = 1_000_000;

/**
 * Largest span one cluster covers, in milliseconds.
 *
 * A `SimpleBlock`'s timestamp is a *signed 16-bit* offset from its cluster, so
 * 32.767 seconds is the hard ceiling and not a tuning choice. 30 000 leaves room
 * for the last frame's duration without arithmetic that has to be right.
 */
const MAX_CLUSTER_MS = 30_000;

const ID = {
  ebml: [0x1a, 0x45, 0xdf, 0xa3],
  ebmlVersion: [0x42, 0x86],
  ebmlReadVersion: [0x42, 0xf7],
  ebmlMaxIdLength: [0x42, 0xf2],
  ebmlMaxSizeLength: [0x42, 0xf3],
  docType: [0x42, 0x82],
  docTypeVersion: [0x42, 0x87],
  docTypeReadVersion: [0x42, 0x85],
  segment: [0x18, 0x53, 0x80, 0x67],
  info: [0x15, 0x49, 0xa9, 0x66],
  timestampScale: [0x2a, 0xd7, 0xb1],
  muxingApp: [0x4d, 0x80],
  writingApp: [0x57, 0x41],
  duration: [0x44, 0x89],
  tracks: [0x16, 0x54, 0xae, 0x6b],
  trackEntry: [0xae],
  trackNumber: [0xd7],
  trackUid: [0x73, 0xc5],
  flagLacing: [0x9c],
  language: [0x22, 0xb5, 0x9c],
  codecId: [0x86],
  codecPrivate: [0x63, 0xa2],
  trackType: [0x83],
  defaultDuration: [0x23, 0xe3, 0x83],
  video: [0xe0],
  pixelWidth: [0xb0],
  pixelHeight: [0xba],
  cluster: [0x1f, 0x43, 0xb6, 0x75],
  clusterTimestamp: [0xe7],
  simpleBlock: [0xa3],
} as const;

/**
 * Matroska's names for the codecs this muxer writes.
 *
 * AV1 is here although `settings.ts` currently routes it to MP4, because this is
 * a muxer rather than a private helper of the panel: `V_AV1` with its `av1C` in
 * `CodecPrivate` is the format's own mapping, it is what makes the
 * `CodecPrivate` branch below correct rather than speculative, and it is
 * covered by a test. Moving AV1 into the WebM column of the codec table is then
 * a one-line change to a table, not a change to a muxer.
 */
const CODEC_IDS: Readonly<Record<string, string>> = {
  vp8: "V_VP8",
  vp9: "V_VP9",
  av1: "V_AV1",
};

export function muxWebm(track: MuxedTrack, frames: readonly CodedFrame[]): Bytes {
  if (frames.length === 0) throw new Error("a WebM needs at least one coded frame");
  const codecId = CODEC_IDS[track.codec];
  if (codecId === undefined) {
    throw new Error(`${track.codec} is not a codec this muxer writes into WebM`);
  }

  const first = frames[0];
  if (first === undefined || !first.keyFrame) {
    // Not defensiveness: a file whose first frame is a delta decodes to garbage
    // in every player, and the failure looks like a corrupt encoder rather than
    // a mis-ordered muxer call.
    throw new Error("the first coded frame of a WebM must be a keyframe");
  }

  const header = element(ID.ebml, [
    uintElement(ID.ebmlVersion, 1),
    uintElement(ID.ebmlReadVersion, 1),
    uintElement(ID.ebmlMaxIdLength, 4),
    uintElement(ID.ebmlMaxSizeLength, 8),
    stringElement(ID.docType, "webm"),
    uintElement(ID.docTypeVersion, 2),
    uintElement(ID.docTypeReadVersion, 2),
  ]);

  const last = frames[frames.length - 1];
  const durationMs =
    last === undefined ? 0 : msOf(last.timestampUs + last.durationUs) - msOf(first.timestampUs);

  const info = element(ID.info, [
    uintElement(ID.timestampScale, TIMESTAMP_SCALE_NS),
    stringElement(ID.muxingApp, "dither-ork"),
    stringElement(ID.writingApp, "dither-ork"),
    floatElement(ID.duration, durationMs),
  ]);

  const videoChildren: Bytes[] = [
    uintElement(ID.pixelWidth, track.width),
    uintElement(ID.pixelHeight, track.height),
  ];
  const trackChildren: Bytes[] = [
    uintElement(ID.trackNumber, 1),
    uintElement(ID.trackUid, 1),
    // Lacing is for audio and every video muxer disables it. Written rather than
    // left to the default, because the default is "on" in the specification and
    // a decoder that honours it will look for lace headers that are not there.
    uintElement(ID.flagLacing, 0),
    stringElement(ID.language, "und"),
    stringElement(ID.codecId, codecId),
    uintElement(ID.trackType, 1),
    uintElement(ID.defaultDuration, Math.round(1_000_000_000 / Math.max(1, track.fps))),
    element(ID.video, videoChildren),
  ];
  if (track.description !== null) {
    // AV1 needs its `av1C` here; VP8 and VP9 have no out-of-band configuration
    // at all, which is why the field is optional rather than always written.
    trackChildren.push(element(ID.codecPrivate, [track.description]));
  }
  const tracks = element(ID.tracks, [element(ID.trackEntry, trackChildren)]);

  const clusters: Bytes[] = [];
  let index = 0;
  while (index < frames.length) {
    const start = frames[index];
    if (start === undefined) break;
    const baseMs = msOf(start.timestampUs);
    const blocks: Bytes[] = [];

    while (index < frames.length) {
      const frame = frames[index];
      if (frame === undefined) break;
      const relative = msOf(frame.timestampUs) - baseMs;
      // A new cluster on a keyframe that is far enough along, or whenever the
      // signed 16-bit offset would not reach. Both conditions are the format's,
      // not a heuristic.
      if (blocks.length > 0 && (relative > MAX_CLUSTER_MS || (frame.keyFrame && relative > 1000))) {
        break;
      }
      blocks.push(simpleBlock(frame, relative));
      index += 1;
    }

    clusters.push(element(ID.cluster, [uintElement(ID.clusterTimestamp, baseMs), ...blocks]));
  }

  const segment = element(ID.segment, [info, tracks, ...clusters]);
  const file = concat([header, segment]);

  log.info("webm muxed", {
    frames: frames.length,
    clusters: clusters.length,
    width: track.width,
    height: track.height,
    codec: codecId,
    durationMs,
    bytes: file.length,
  });
  return file;
}

/**
 * One `SimpleBlock`: a track number as a variable-size integer, a signed 16-bit
 * offset from the cluster, a flag byte, and the coded frame.
 *
 * The keyframe bit is the high one. Nothing else is set: no invisible frames,
 * no lacing, no discardable frames — every frame this application produces is
 * shown exactly once, in order.
 */
function simpleBlock(frame: CodedFrame, relativeMs: number): Bytes {
  const payload = new Uint8Array(4 + frame.data.length) as Bytes;
  // Track 1 as a one-byte vint: the marker bit plus the value.
  payload[0] = 0x81;
  payload[1] = (relativeMs >> 8) & 0xff;
  payload[2] = relativeMs & 0xff;
  payload[3] = frame.keyFrame ? 0x80 : 0x00;
  payload.set(frame.data, 4);
  return element(ID.simpleBlock, [payload]);
}

function msOf(microseconds: number): number {
  return Math.round(microseconds / 1000);
}

// --- EBML ---------------------------------------------------------------

/**
 * An EBML variable-size integer.
 *
 * The length is written as a leading marker bit: one byte holds seven bits, two
 * hold fourteen, and so on. The all-ones value at each length is reserved for
 * "unknown", so a value that would collide with it takes the next length up —
 * which is the case a naive `while (value >> bits)` loop gets wrong, and it gets
 * it wrong only for sizes that are exactly 127, 16383 and so on.
 */
export function vint(value: number): Bytes {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`an EBML size must be a non-negative integer, got ${value}`);
  }
  for (let length = 1; length <= 8; length += 1) {
    const capacity = 2 ** (7 * length) - 1;
    if (value >= capacity) continue;
    const out = new Uint8Array(length) as Bytes;
    let remaining = value;
    for (let i = length - 1; i >= 0; i -= 1) {
      out[i] = remaining % 256;
      remaining = Math.floor(remaining / 256);
    }
    out[0] = (out[0] ?? 0) | (0x80 >> (length - 1));
    return out;
  }
  throw new RangeError(`${value} is too large for an EBML size`);
}

function element(id: readonly number[], children: readonly Bytes[]): Bytes {
  const body = concat(children);
  const size = vint(body.length);
  const out = new Uint8Array(id.length + size.length + body.length) as Bytes;
  out.set(id, 0);
  out.set(size, id.length);
  out.set(body, id.length + size.length);
  return out;
}

function uintElement(id: readonly number[], value: number): Bytes {
  // The shortest big-endian encoding, which is what every writer emits and what
  // keeps a header from being padded with leading zeros nobody reads.
  const bytes: number[] = [];
  let remaining = Math.round(value);
  do {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return element(id, [new Uint8Array(bytes) as Bytes]);
}

function stringElement(id: readonly number[], value: string): Bytes {
  return element(id, [new TextEncoder().encode(value) as Bytes]);
}

/** Matroska floats are IEEE 754, big-endian, and `Duration` is one. */
function floatElement(id: readonly number[], value: number): Bytes {
  const data = new Uint8Array(8) as Bytes;
  new DataView(data.buffer).setFloat64(0, value, false);
  return element(id, [data]);
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
