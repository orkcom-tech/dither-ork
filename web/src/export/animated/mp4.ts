/**
 * F-EX-07, the MP4 half — an ISO base media file format muxer.
 *
 * The same situation `webm.ts` describes: `VideoEncoder` produces coded frames
 * and no platform API produces a file, so the container is written here. No
 * ffmpeg, no WASM demuxer, no library — which is exactly what dropping video
 * *input* buys, because a muxer is a few hundred lines of table writing and a
 * demuxer is a project.
 *
 * ## The layout, and why `moov` comes last
 *
 * `ftyp`, then `mdat` holding every sample end to end, then `moov` holding the
 * tables that index into it. `moov` last is what makes a single pass possible:
 * `stco` stores an absolute file offset for the sample data, so `moov` cannot be
 * written until `mdat`'s position and length are known. Writers that put `moov`
 * first do it for progressive download and pay for it with a second pass or a
 * reserved hole; neither is worth it for a file that is being handed to the user
 * as a whole.
 *
 * ## One chunk
 *
 * Every sample is in a single chunk, so `stsc` has one entry and `stco` has one
 * offset. That is legal and it is the right shape here: chunking exists to
 * interleave a video track with an audio one, and there is no audio track.
 *
 * ## What is not written
 *
 * No `edts`, no `ctts`, no fragments. There is no composition offset because
 * nothing here reorders frames — `VideoEncoder` is configured in
 * `latencyMode: "quality"` with no B-frame reordering exposed, and the samples
 * are written in the order it produced them, which is display order. An `edts`
 * would only be needed to shift a track that starts late, and this one starts at
 * zero.
 */

import { logger } from "../../lib/log";
import type { Bytes } from "../types";
import type { CodedFrame, MuxedTrack } from "./video-types";

const log = logger("export");

/**
 * Ticks per second in the media timeline.
 *
 * 90 kHz — the value MPEG has used since MPEG-2 — because it divides exactly by
 * every frame rate anyone uses: 24, 25, 30, 50, 60 and the 1000/1001 rates all
 * land on whole ticks. A timescale of 1000 would make 24 fps a repeating
 * fraction and the drift would be visible over a long loop.
 */
const MEDIA_TIMESCALE = 90_000;

/** The movie header's own unit. Milliseconds, which is conventional. */
const MOVIE_TIMESCALE = 1000;

/** The 3x3 display matrix, as 16.16 fixed point. Identity. */
const IDENTITY_MATRIX = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

/** Which sample entry and brand a codec needs. */
const CODEC_BOXES: Readonly<Record<string, { entry: string; config: string; brand: string }>> = {
  avc: { entry: "avc1", config: "avcC", brand: "avc1" },
  av1: { entry: "av01", config: "av1C", brand: "av01" },
};

export function muxMp4(track: MuxedTrack, frames: readonly CodedFrame[]): Bytes {
  if (frames.length === 0) throw new Error("an MP4 needs at least one coded frame");
  const boxes = CODEC_BOXES[track.codec];
  if (boxes === undefined) {
    throw new Error(`${track.codec} is not a codec this muxer writes into MP4`);
  }
  if (track.description === null) {
    // Both codecs this muxer writes need their configuration record in `stsd`.
    // A file without it is a file no decoder can start, and the failure at play
    // time says nothing about where it came from.
    throw new Error(
      `an MP4 of ${track.codec} needs the encoder's ${boxes.config} record, and none was ` +
        `supplied; configure VideoEncoder with avc: { format: "avc" } so it emits one`,
    );
  }

  const first = frames[0];
  if (first === undefined || !first.keyFrame) {
    throw new Error("the first coded frame of an MP4 must be a keyframe");
  }

  // Sample deltas in media ticks, taken from the timestamps rather than from the
  // nominal frame rate: an encoder that drops or coalesces a frame reports it,
  // and a table built from `1/fps` would then drift against the samples.
  const deltas: number[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame === undefined) continue;
    const next = frames[index + 1];
    const span =
      next === undefined ?
        Math.max(1, frame.durationUs)
      : Math.max(1, next.timestampUs - frame.timestampUs);
    deltas.push(Math.max(1, Math.round((span * MEDIA_TIMESCALE) / 1_000_000)));
  }

  const mediaDuration = deltas.reduce((total, delta) => total + delta, 0);
  const movieDuration = Math.round((mediaDuration / MEDIA_TIMESCALE) * MOVIE_TIMESCALE);

  let payloadBytes = 0;
  for (const frame of frames) payloadBytes += frame.data.length;

  const ftyp = box(
    "ftyp",
    concat([
      fourcc("isom"),
      be32(0x0000_0200),
      fourcc("isom"),
      fourcc("iso2"),
      fourcc(boxes.brand),
      fourcc("mp41"),
    ]),
  );

  // `mdat` is assembled as a header plus the samples, and the samples are not
  // copied into one array first: at 8 megabits a second for a minute that is a
  // 60 MB copy for nothing.
  const mdatHeader = new Uint8Array(8) as Bytes;
  writeBe32(mdatHeader, 0, 8 + payloadBytes);
  mdatHeader.set(fourcc("mdat"), 4);
  const dataOffset = ftyp.length + mdatHeader.length;

  const moov = buildMoov(track, boxes, frames, deltas, mediaDuration, movieDuration, dataOffset);

  const file = new Uint8Array(ftyp.length + mdatHeader.length + payloadBytes + moov.length) as Bytes;
  let at = 0;
  file.set(ftyp, at);
  at += ftyp.length;
  file.set(mdatHeader, at);
  at += mdatHeader.length;
  for (const frame of frames) {
    file.set(frame.data, at);
    at += frame.data.length;
  }
  file.set(moov, at);

  log.info("mp4 muxed", {
    frames: frames.length,
    width: track.width,
    height: track.height,
    codec: boxes.entry,
    mediaDuration,
    bytes: file.length,
    sampleBytes: payloadBytes,
  });
  return file;
}

function buildMoov(
  track: MuxedTrack,
  boxes: { entry: string; config: string; brand: string },
  frames: readonly CodedFrame[],
  deltas: readonly number[],
  mediaDuration: number,
  movieDuration: number,
  dataOffset: number,
): Bytes {
  const description = track.description;
  if (description === null) throw new Error("unreachable: checked by the caller");

  const mvhd = box(
    "mvhd",
    concat([
      be32(0), // version 0, flags 0
      be32(0), // creation time. Zero rather than a clock read: nothing in a
      be32(0), // render or export path may read one (F-AN-05), and a timestamp
      //          here would make two exports of one document differ.
      be32(MOVIE_TIMESCALE),
      be32(movieDuration),
      be32(0x0001_0000), // rate 1.0
      be16(0x0100), // volume 1.0
      be16(0),
      be32(0),
      be32(0),
      concat(IDENTITY_MATRIX.map(be32)),
      concat([be32(0), be32(0), be32(0), be32(0), be32(0), be32(0)]), // pre_defined
      be32(2), // next track id
    ]),
  );

  const tkhd = box(
    "tkhd",
    concat([
      be32(0x0000_0003), // version 0, flags: enabled | in movie
      be32(0),
      be32(0),
      be32(1), // track id
      be32(0),
      be32(movieDuration),
      be32(0),
      be32(0),
      be16(0), // layer
      be16(0), // alternate group
      be16(0), // volume: zero for a video track
      be16(0),
      concat(IDENTITY_MATRIX.map(be32)),
      be32(track.width << 16),
      be32(track.height << 16),
    ]),
  );

  const mdhd = box(
    "mdhd",
    concat([
      be32(0),
      be32(0),
      be32(0),
      be32(MEDIA_TIMESCALE),
      be32(mediaDuration),
      // 'und', packed as three five-bit values offset from 0x60. Written as the
      // constant it always is rather than computed, because the packing is the
      // sort of thing that is wrong once and never noticed.
      be16(0x55c4),
      be16(0),
    ]),
  );

  const hdlr = box(
    "hdlr",
    concat([
      be32(0),
      be32(0),
      fourcc("vide"),
      be32(0),
      be32(0),
      be32(0),
      new TextEncoder().encode("VideoHandler\0") as Bytes,
    ]),
  );

  const vmhd = box("vmhd", concat([be32(0x0000_0001), be16(0), be16(0), be16(0), be16(0)]));
  const dref = box("dref", concat([be32(0), be32(1), box("url ", be32(0x0000_0001))]));
  const dinf = box("dinf", dref);

  const compressor = new Uint8Array(32) as Bytes;
  const sampleEntry = box(
    boxes.entry,
    concat([
      new Uint8Array(6) as Bytes, // reserved
      be16(1), // data reference index
      be16(0), // pre_defined
      be16(0), // reserved
      be32(0),
      be32(0),
      be32(0), // pre_defined[3]
      be16(track.width),
      be16(track.height),
      be32(0x0048_0000), // 72 dpi horizontal
      be32(0x0048_0000), // 72 dpi vertical
      be32(0), // reserved
      be16(1), // frame count per sample
      compressor, // a Pascal string, left empty
      be16(0x0018), // depth: 24-bit colour
      be16(0xff_ff), // pre_defined: -1
      box(boxes.config, description),
    ]),
  );
  const stsd = box("stsd", concat([be32(0), be32(1), sampleEntry]));

  // Runs of equal deltas, coalesced. A constant frame rate collapses to one
  // entry, which is the usual case and the one worth not writing N times.
  const runs: Array<{ count: number; delta: number }> = [];
  for (const delta of deltas) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.delta === delta) last.count += 1;
    else runs.push({ count: 1, delta });
  }
  const stts = box(
    "stts",
    concat([
      be32(0),
      be32(runs.length),
      concat(runs.flatMap((run) => [be32(run.count), be32(run.delta)])),
    ]),
  );

  const syncSamples: Bytes[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    if (frames[index]?.keyFrame === true) syncSamples.push(be32(index + 1));
  }
  // Omitted entirely when every sample is a keyframe: the absence of `stss` is
  // defined to mean exactly that, and a table listing every sample says the same
  // thing in four bytes each.
  const stss =
    syncSamples.length === frames.length ?
      null
    : box("stss", concat([be32(0), be32(syncSamples.length), concat(syncSamples)]));

  const stsc = box(
    "stsc",
    concat([be32(0), be32(1), be32(1), be32(frames.length), be32(1)]),
  );
  const stsz = box(
    "stsz",
    concat([
      be32(0),
      be32(0), // 0 means the sizes are listed individually
      be32(frames.length),
      concat(frames.map((frame) => be32(frame.data.length))),
    ]),
  );
  const stco = box("stco", concat([be32(0), be32(1), be32(dataOffset)]));

  const stbl = box(
    "stbl",
    concat(stss === null ? [stsd, stts, stsc, stsz, stco] : [stsd, stts, stss, stsc, stsz, stco]),
  );
  const minf = box("minf", concat([vmhd, dinf, stbl]));
  const mdia = box("mdia", concat([mdhd, hdlr, minf]));
  const trak = box("trak", concat([tkhd, mdia]));
  return box("moov", concat([mvhd, trak]));
}

// --- boxes --------------------------------------------------------------

/** One box: a 32-bit length covering itself, a four-character type, a payload. */
export function box(type: string, payload: Bytes): Bytes {
  const out = new Uint8Array(8 + payload.length) as Bytes;
  writeBe32(out, 0, out.length);
  out.set(fourcc(type), 4);
  out.set(payload, 8);
  return out;
}

function fourcc(type: string): Bytes {
  const out = new Uint8Array(4) as Bytes;
  for (let i = 0; i < 4; i += 1) out[i] = type.charCodeAt(i);
  return out;
}

function be32(value: number): Bytes {
  const out = new Uint8Array(4) as Bytes;
  writeBe32(out, 0, value);
  return out;
}

function be16(value: number): Bytes {
  const out = new Uint8Array(2) as Bytes;
  out[0] = (value >>> 8) & 0xff;
  out[1] = value & 0xff;
  return out;
}

function writeBe32(target: Uint8Array, at: number, value: number): void {
  target[at] = (value >>> 24) & 0xff;
  target[at + 1] = (value >>> 16) & 0xff;
  target[at + 2] = (value >>> 8) & 0xff;
  target[at + 3] = value & 0xff;
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
