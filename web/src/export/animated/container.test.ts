/**
 * The three containers, checked by parsing back what was written.
 *
 * None of these can be produced end to end in a test runner — animated WebP
 * needs `OffscreenCanvas` and the video paths need `VideoEncoder`, and neither
 * exists outside a browser. What *can* be tested, and is the part that would
 * actually be wrong, is the container: the byte layout, the size fields, the
 * index tables. So each muxer is driven with synthetic coded frames and the
 * result is walked back apart.
 *
 * That split is deliberate and it is where the risk is. The pixels come from
 * encoders nobody here wrote — the browser's WebP encoder, `VideoEncoder` — and
 * are copied through untouched. The bytes around them are this repository's,
 * and a wrong size field or a table with the wrong count produces a file that is
 * structurally plausible and plays as nothing.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import type { Bytes } from "../types";
import { box, muxMp4 } from "./mp4";
import type { CodedFrame, MuxedTrack } from "./video-types";
import { imageChunksOf, riffChunk, riffFile, webpDurationFor } from "./webp";
import { muxWebm, vint } from "./webm";

setLevel("error");

function bytes(...values: number[]): Bytes {
  return new Uint8Array(values) as Bytes;
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

// --- WebP ---------------------------------------------------------------

describe("RIFF assembly", () => {
  it("pads an odd chunk without counting the pad in its size", () => {
    // The classic RIFF bug in both directions: a reader that skips `size` bytes
    // lands mid-chunk, and a writer that puts the pad in `size` overruns.
    const chunk = riffChunk("TEST", bytes(1, 2, 3));
    expect(chunk).toHaveLength(12);
    expect([...chunk.subarray(4, 8)]).toEqual(u32le(3));
    expect(chunk[11]).toBe(0);
  });

  it("counts the form type in the file's own size field", () => {
    const file = riffFile([riffChunk("AAAA", bytes(1, 2))]);
    // 4 for "WEBP" plus 10 for the chunk.
    expect([...file.subarray(4, 8)]).toEqual(u32le(14));
    expect(String.fromCharCode(...file.subarray(8, 12))).toBe("WEBP");
    expect(file).toHaveLength(22);
  });
});

describe("taking a still WebP apart", () => {
  it("keeps the lossy bitstream and drops everything else", () => {
    const still = riffFile([
      riffChunk("VP8X", new Uint8Array(10) as Bytes),
      riffChunk("ICCP", bytes(1, 2, 3, 4)),
      riffChunk("VP8 ", bytes(9, 8, 7)),
    ]);
    const frame = imageChunksOf(still, 0);
    expect(String.fromCharCode(...frame.payload.subarray(0, 4))).toBe("VP8 ");
    // The VP8X and the colour profile are gone: an ANMF body holds image chunks
    // only, and a nested VP8X makes the frame unreadable.
    expect(frame.payload).toHaveLength(12);
    expect(frame.hasAlpha).toBe(false);
  });

  it("keeps an ALPH chunk and notices that the file has alpha", () => {
    const still = riffFile([
      riffChunk("VP8X", new Uint8Array(10) as Bytes),
      riffChunk("ALPH", bytes(1, 2)),
      riffChunk("VP8 ", bytes(3, 4)),
    ]);
    const frame = imageChunksOf(still, 0);
    expect(frame.hasAlpha).toBe(true);
    expect(String.fromCharCode(...frame.payload.subarray(0, 4))).toBe("ALPH");
    expect(String.fromCharCode(...frame.payload.subarray(10, 14))).toBe("VP8 ");
  });

  it("reads the alpha flag out of a lossless bitstream", () => {
    // VP8L: 0x2F, then 14 bits of width-1, 14 of height-1, one alpha bit, three
    // of version, little-endian. The alpha bit is bit 28.
    const withAlpha = new Uint8Array(5) as Bytes;
    withAlpha[0] = 0x2f;
    new DataView(withAlpha.buffer).setUint32(1, 1 << 28, true);
    const still = riffFile([riffChunk("VP8L", withAlpha)]);
    expect(imageChunksOf(still, 0).hasAlpha).toBe(true);

    const opaque = new Uint8Array(5) as Bytes;
    opaque[0] = 0x2f;
    expect(imageChunksOf(riffFile([riffChunk("VP8L", opaque)]), 0).hasAlpha).toBe(false);
  });

  it("refuses something that is not a WebP, naming the frame", () => {
    expect(() => imageChunksOf(bytes(1, 2, 3), 4)).toThrow(/frame 4/);
    // A well-formed RIFF with no bitstream is the shape a browser returns when
    // it silently wrote a PNG instead, which is the failure `bitmap.ts` warns
    // about; it must not be copied through as if it were image data.
    expect(() => imageChunksOf(riffFile([riffChunk("EXIF", bytes(0))]), 2)).toThrow(
      /no VP8 or VP8L/,
    );
  });
});

describe("the WebP frame duration", () => {
  it("is whole milliseconds, floored at 10", () => {
    expect(webpDurationFor(10)).toBe(100);
    expect(webpDurationFor(30)).toBe(33);
    // Above 100 fps every player substitutes 100 ms, so a shorter duration would
    // be a file claiming a rate it does not play at.
    expect(webpDurationFor(1000)).toBe(10);
  });
});

// --- WebM ---------------------------------------------------------------

describe("EBML sizes", () => {
  it("takes the next length up rather than emitting the reserved value", () => {
    // 127 is all-ones in one byte, which means "unknown size"; a naive encoder
    // writes it and produces a file players read to the end of.
    expect([...vint(126)]).toEqual([0x80 | 126]);
    expect(vint(127)).toHaveLength(2);
    expect(vint(16_382)).toHaveLength(2);
    expect(vint(16_383)).toHaveLength(3);
  });

  it("refuses a size that is not a non-negative integer", () => {
    expect(() => vint(-1)).toThrow(RangeError);
    expect(() => vint(1.5)).toThrow(RangeError);
  });
});

/** A minimal EBML walker: id, size, and either children or a payload. */
interface EbmlNode {
  readonly id: string;
  readonly payload: Uint8Array;
  readonly children: readonly EbmlNode[];
}

const MASTER_IDS = new Set(["1a45dfa3", "18538067", "1549a966", "1654ae6b", "ae", "e0", "1f43b675"]);

function readVint(bytes: Uint8Array, at: number): { value: number; length: number } {
  const first = bytes[at] ?? 0;
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  let value = first & (0xff >> length);
  for (let i = 1; i < length; i += 1) value = value * 256 + (bytes[at + i] ?? 0);
  return { value, length };
}

function readId(bytes: Uint8Array, at: number): { id: string; length: number } {
  const first = bytes[at] ?? 0;
  let length = 1;
  while (length <= 4 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  let id = "";
  for (let i = 0; i < length; i += 1) id += (bytes[at + i] ?? 0).toString(16).padStart(2, "0");
  return { id, length };
}

function parseEbml(bytes: Uint8Array, from = 0, to = bytes.length): EbmlNode[] {
  const nodes: EbmlNode[] = [];
  let at = from;
  while (at < to) {
    const id = readId(bytes, at);
    const size = readVint(bytes, at + id.length);
    const start = at + id.length + size.length;
    const end = start + size.value;
    nodes.push({
      id: id.id,
      payload: bytes.subarray(start, end),
      children: MASTER_IDS.has(id.id) ? parseEbml(bytes, start, end) : [],
    });
    at = end;
  }
  return nodes;
}

function find(nodes: readonly EbmlNode[], id: string): EbmlNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inside = find(node.children, id);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

const VP9_TRACK: MuxedTrack = {
  width: 64,
  height: 48,
  codec: "vp9",
  fps: 25,
  description: null,
};

function codedFrames(count: number, fps: number, keyEvery = count): CodedFrame[] {
  const durationUs = Math.round(1_000_000 / fps);
  return Array.from({ length: count }, (_, index) => ({
    data: bytes(index & 0xff, 0xaa, 0xbb),
    keyFrame: index % keyEvery === 0,
    timestampUs: index * durationUs,
    durationUs,
  }));
}

describe("the WebM muxer", () => {
  it("writes a header, a track and every frame as a SimpleBlock", () => {
    const file = muxWebm(VP9_TRACK, codedFrames(5, 25));
    const tree = parseEbml(file);

    expect(find(tree, "1a45dfa3")).toBeDefined(); // EBML
    const docType = find(tree, "4282");
    expect(new TextDecoder().decode(docType?.payload)).toBe("webm");

    const codecId = find(tree, "86");
    expect(new TextDecoder().decode(codecId?.payload)).toBe("V_VP9");
    expect([...(find(tree, "b0")?.payload ?? [])]).toEqual([64]); // PixelWidth
    expect([...(find(tree, "ba")?.payload ?? [])]).toEqual([48]); // PixelHeight

    const cluster = find(tree, "1f43b675");
    expect(cluster).toBeDefined();
    const blocks = (cluster?.children ?? []).filter((node) => node.id === "a3");
    expect(blocks).toHaveLength(5);
  });

  it("stamps each block with the track, its offset and its keyframe flag", () => {
    const file = muxWebm(VP9_TRACK, codedFrames(3, 25, 3));
    const cluster = find(parseEbml(file), "1f43b675");
    const blocks = (cluster?.children ?? []).filter((node) => node.id === "a3");

    for (let index = 0; index < blocks.length; index += 1) {
      const payload = blocks[index]?.payload;
      expect(payload?.[0]).toBe(0x81); // track 1, as a one-byte vint
      const offset = ((payload?.[1] ?? 0) << 8) | (payload?.[2] ?? 0);
      expect(offset).toBe(Math.round((index * 1_000_000) / 25 / 1000));
      expect(payload?.[3]).toBe(index === 0 ? 0x80 : 0x00);
      // The coded bytes follow the four-byte block header, untouched.
      expect([...(payload?.subarray(4) ?? [])]).toEqual([index, 0xaa, 0xbb]);
    }
  });

  it("starts a new cluster on a later keyframe", () => {
    // Cluster-relative timestamps are signed 16-bit, so a long file must break
    // into clusters whatever else happens; breaking on a keyframe is what makes
    // a scanning seek land on something decodable.
    const file = muxWebm(VP9_TRACK, codedFrames(80, 25, 50));
    const segment = find(parseEbml(file), "18538067");
    const clusters = (segment?.children ?? []).filter((node) => node.id === "1f43b675");
    expect(clusters.length).toBeGreaterThan(1);
  });

  it("writes no CodecPrivate for VP9, which has none", () => {
    const file = muxWebm(VP9_TRACK, codedFrames(2, 25, 2));
    expect(find(parseEbml(file), "63a2")).toBeUndefined();
  });

  it("writes CodecPrivate when the codec has one", () => {
    // AV1 needs its `av1C` out of band. A WebM without it starts nowhere, and
    // the failure at play time says nothing about where it came from.
    const av1: MuxedTrack = { ...VP9_TRACK, codec: "av1", description: bytes(0x81, 0x05, 0x0c) };
    const file = muxWebm(av1, codedFrames(2, 25, 2));
    const tree = parseEbml(file);
    expect(new TextDecoder().decode(find(tree, "86")?.payload)).toBe("V_AV1");
    expect([...(find(tree, "63a2")?.payload ?? [])]).toEqual([0x81, 0x05, 0x0c]);
  });

  it("refuses a first frame that is not a keyframe", () => {
    const frames = codedFrames(2, 25);
    const broken = [{ ...frames[0]!, keyFrame: false }, frames[1]!];
    expect(() => muxWebm(VP9_TRACK, broken)).toThrow(/must be a keyframe/);
  });

  it("refuses a codec that does not belong in WebM", () => {
    expect(() => muxWebm({ ...VP9_TRACK, codec: "avc" }, codedFrames(1, 25))).toThrow(
      /not a codec this muxer writes into WebM/,
    );
  });

  it("refuses an empty animation", () => {
    expect(() => muxWebm(VP9_TRACK, [])).toThrow(/at least one coded frame/);
  });
});

// --- MP4 ----------------------------------------------------------------

interface Mp4Box {
  readonly type: string;
  readonly start: number;
  readonly payload: Uint8Array;
  readonly children: readonly Mp4Box[];
}

const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf"]);

function parseBoxes(bytes: Uint8Array, from = 0, to = bytes.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size =
      (((bytes[at] ?? 0) << 24) |
        ((bytes[at + 1] ?? 0) << 16) |
        ((bytes[at + 2] ?? 0) << 8) |
        (bytes[at + 3] ?? 0)) >>>
      0;
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const payload = bytes.subarray(at + 8, at + size);
    boxes.push({
      type,
      start: at,
      payload,
      children: CONTAINER_BOXES.has(type) ? parseBoxes(bytes, at + 8, at + size) : [],
    });
    if (size <= 0) break;
    at += size;
  }
  return boxes;
}

function findBox(boxes: readonly Mp4Box[], type: string): Mp4Box | undefined {
  for (const candidate of boxes) {
    if (candidate.type === type) return candidate;
    const inside = findBox(candidate.children, type);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

function readBe32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

const AVC_TRACK: MuxedTrack = {
  width: 320,
  height: 240,
  codec: "avc",
  fps: 30,
  description: bytes(1, 0x42, 0x00, 0x1e, 0xff),
};

describe("the MP4 muxer", () => {
  it("writes ftyp, then the samples, then the tables", () => {
    const frames = codedFrames(4, 30, 4);
    const file = muxMp4(AVC_TRACK, frames);
    const boxes = parseBoxes(file);
    expect(boxes.map((entry) => entry.type)).toEqual(["ftyp", "mdat", "moov"]);
  });

  it("points stco at the first sample and stsz at each one", () => {
    const frames = codedFrames(4, 30, 4);
    const file = muxMp4(AVC_TRACK, frames);
    const boxes = parseBoxes(file);

    const mdat = boxes.find((entry) => entry.type === "mdat");
    const stco = findBox(boxes, "stco");
    expect(stco).toBeDefined();
    expect(readBe32(stco!.payload, 4)).toBe(1);
    // The offset is absolute in the file, which is the whole reason `moov` is
    // written after `mdat`.
    expect(readBe32(stco!.payload, 8)).toBe((mdat?.start ?? 0) + 8);

    const stsz = findBox(boxes, "stsz");
    expect(readBe32(stsz!.payload, 4)).toBe(0); // sizes listed individually
    expect(readBe32(stsz!.payload, 8)).toBe(frames.length);
    for (let index = 0; index < frames.length; index += 1) {
      expect(readBe32(stsz!.payload, 12 + index * 4)).toBe(frames[index]!.data.length);
    }
  });

  it("collapses a constant frame rate into one stts entry", () => {
    const file = muxMp4(AVC_TRACK, codedFrames(10, 30, 10));
    const stts = findBox(parseBoxes(file), "stts");
    expect(readBe32(stts!.payload, 4)).toBe(1);
    expect(readBe32(stts!.payload, 8)).toBe(10);
    // 90 000 ticks a second at 30 fps is 3000 a frame, exactly — which is why
    // the timescale is 90 kHz rather than 1000.
    expect(readBe32(stts!.payload, 12)).toBe(3000);
  });

  it("omits stss when every sample is a keyframe and writes it when they are not", () => {
    const allKeys = muxMp4(AVC_TRACK, codedFrames(4, 30, 1));
    expect(findBox(parseBoxes(allKeys), "stss")).toBeUndefined();

    const some = muxMp4(AVC_TRACK, codedFrames(6, 30, 3));
    const stss = findBox(parseBoxes(some), "stss");
    expect(stss).toBeDefined();
    expect(readBe32(stss!.payload, 4)).toBe(2);
    // Sample numbers are one-based in this table and zero-based nowhere else.
    expect(readBe32(stss!.payload, 8)).toBe(1);
    expect(readBe32(stss!.payload, 12)).toBe(4);
  });

  it("puts the codec's configuration record inside the sample entry", () => {
    const file = muxMp4(AVC_TRACK, codedFrames(2, 30, 2));
    const stsd = findBox(parseBoxes(file), "stsd");
    // stsd's payload is version/flags, an entry count, then the sample entry.
    const entry = parseBoxes(stsd!.payload, 8)[0];
    expect(entry?.type).toBe("avc1");
    const avcc = parseBoxes(entry!.payload, 78)[0];
    expect(avcc?.type).toBe("avcC");
    expect([...(avcc?.payload ?? [])]).toEqual([...AVC_TRACK.description!]);
  });

  it("writes the extent into tkhd as 16.16 fixed point", () => {
    const file = muxMp4(AVC_TRACK, codedFrames(1, 30, 1));
    const tkhd = findBox(parseBoxes(file), "tkhd");
    expect(readBe32(tkhd!.payload, 76)).toBe(320 << 16);
    expect(readBe32(tkhd!.payload, 80)).toBe(240 << 16);
  });

  it("copies every sample's bytes into mdat, in order and untouched", () => {
    const frames = codedFrames(3, 30, 3);
    const file = muxMp4(AVC_TRACK, frames);
    const mdat = parseBoxes(file).find((entry) => entry.type === "mdat");
    expect([...(mdat?.payload ?? [])]).toEqual(frames.flatMap((frame) => [...frame.data]));
  });

  it("refuses a codec configuration it was not given", () => {
    // Both codecs this muxer writes need one. A file without it is a file no
    // decoder can start, and the failure at play time says nothing about where
    // it came from.
    expect(() => muxMp4({ ...AVC_TRACK, description: null }, codedFrames(1, 30, 1))).toThrow(
      /needs the encoder's avcC record/,
    );
  });

  it("refuses a codec that does not belong in MP4", () => {
    expect(() => muxMp4({ ...AVC_TRACK, codec: "vp9" }, codedFrames(1, 30, 1))).toThrow(
      /not a codec this muxer writes into MP4/,
    );
  });
});

describe("the box writer", () => {
  it("counts its own header in the size", () => {
    const written = box("free", bytes(1, 2, 3, 4));
    expect(readBe32(written, 0)).toBe(12);
    expect(written).toHaveLength(12);
    expect(String.fromCharCode(...written.subarray(4, 8))).toBe("free");
  });
});
