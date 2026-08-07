import { describe, expect, it } from "vitest";

import { crc32Of } from "../export";
import {
  METHOD_DEFLATE,
  METHOD_STORE,
  ZipBuilder,
  ZipLimitError,
  deflateRaw,
  dosDateTime,
  zipMethodFor,
} from "./zip";

/**
 * The archive is read back with a small parser rather than compared against a
 * golden blob, because a golden would pin the bytes without saying whether they
 * are the *right* bytes. Every field this reader checks is one an unarchiver
 * checks, and the two agree by construction: the offsets in the central
 * directory are followed, and the local header at each one is verified to be
 * the one that entry names.
 */
interface ReadEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly offset: number;
  readonly flags: number;
  readonly body: Uint8Array<ArrayBuffer>;
}

function readZip(bytes: Uint8Array<ArrayBuffer>): readonly ReadEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end record is the last 22 bytes when there is no archive comment, and
  // this writer never writes one.
  const endAt = bytes.length - 22;
  expect(view.getUint32(endAt, true)).toBe(0x06_05_4b_50);
  const count = view.getUint16(endAt + 10, true);
  const centralSize = view.getUint32(endAt + 12, true);
  const centralAt = view.getUint32(endAt + 16, true);
  expect(centralAt + centralSize).toBe(endAt);

  const entries: ReadEntry[] = [];
  let at = centralAt;
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02_01_4b_50);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // Follow the offset the way an unarchiver does, and check it lands on the
    // local header for this entry rather than merely on *a* header.
    expect(view.getUint32(offset, true)).toBe(0x04_03_4b_50);
    const localNameLength = view.getUint16(offset + 26, true);
    const localExtraLength = view.getUint16(offset + 28, true);
    const localName = new TextDecoder().decode(
      bytes.subarray(offset + 30, offset + 30 + localNameLength),
    );
    expect(localName).toBe(name);
    expect(view.getUint32(offset + 14, true)).toBe(crc);
    expect(view.getUint32(offset + 18, true)).toBe(compressedSize);
    expect(view.getUint32(offset + 22, true)).toBe(uncompressedSize);

    const bodyAt = offset + 30 + localNameLength + localExtraLength;
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      offset,
      flags,
      body: bytes.subarray(bodyAt, bodyAt + compressedSize),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  expect(at).toBe(centralAt + centralSize);
  return entries;
}

async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const parts: Uint8Array[] = [];
  let total = 0;
  const drain = (async (): Promise<void> => {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      parts.push(result.value);
      total += result.value.length;
    }
  })();
  await writer.write(bytes);
  await writer.close();
  await drain;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const MODIFIED = new Date(Date.UTC(2020, 5, 15, 12, 30, 20));

describe("zipMethodFor", () => {
  it("stores what is already compressed", () => {
    expect(zipMethodFor("image/png")).toBe(METHOD_STORE);
    expect(zipMethodFor("image/jpeg")).toBe(METHOD_STORE);
    expect(zipMethodFor("image/webp")).toBe(METHOD_STORE);
  });

  it("deflates text", () => {
    expect(zipMethodFor("image/svg+xml")).toBe(METHOD_DEFLATE);
    expect(zipMethodFor("text/plain")).toBe(METHOD_DEFLATE);
  });
});

describe("dosDateTime", () => {
  it("packs the fields the format defines", () => {
    const { date, time } = dosDateTime(new Date(2020, 5, 15, 12, 30, 20));
    expect((date >> 9) + 1980).toBe(2020);
    expect((date >> 5) & 0xf).toBe(6);
    expect(date & 0x1f).toBe(15);
    expect(time >> 11).toBe(12);
    expect((time >> 5) & 0x3f).toBe(30);
    // Two-second resolution is a property of the format, not a rounding bug.
    expect((time & 0x1f) * 2).toBe(20);
  });

  it("clamps below the format's 1980 epoch rather than wrapping", () => {
    const { date, time } = dosDateTime(new Date(1970, 0, 1));
    expect(date >> 9).toBe(0);
    expect(time).toBe(0);
    // Month and day are 1-based in the format; zero in either is invalid.
    expect((date >> 5) & 0xf).toBe(1);
    expect(date & 0x1f).toBe(1);
  });
});

describe("ZipBuilder", () => {
  it("writes an archive whose central directory agrees with its local headers", async () => {
    const builder = new ZipBuilder({ modifiedAt: MODIFIED });
    const one = new Uint8Array([1, 2, 3, 4, 5]);
    const two = new Uint8Array([9, 9, 9]);
    await builder.add("a.png", new Blob([one]), "image/png");
    await builder.add("b.png", new Blob([two]), "image/png");

    const bytes = new Uint8Array(await builder.finish().arrayBuffer());
    const entries = readZip(bytes);

    expect(entries.map((entry) => entry.name)).toEqual(["a.png", "b.png"]);
    expect(entries[0]?.offset).toBe(0);
    // The second local header sits after the first header plus its body.
    expect(entries[1]?.offset).toBe(30 + "a.png".length + one.length);
  });

  it("stores raster bodies verbatim, with the CRC the format wants", async () => {
    const builder = new ZipBuilder({ modifiedAt: MODIFIED });
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await builder.add("x.png", new Blob([payload]), "image/png");

    const entries = readZip(new Uint8Array(await builder.finish().arrayBuffer()));
    const entry = entries[0];
    expect(entry?.method).toBe(METHOD_STORE);
    expect([...(entry?.body ?? [])]).toEqual([...payload]);
    expect(entry?.crc).toBe(crc32Of(payload));
    expect(entry?.uncompressedSize).toBe(payload.length);
    expect(entry?.compressedSize).toBe(payload.length);
  });

  it("deflates an SVG and the deflated body inflates back to it", async () => {
    const svg = `<svg>${"<g/>".repeat(400)}</svg>`;
    const raw = new TextEncoder().encode(svg);
    const builder = new ZipBuilder({ modifiedAt: MODIFIED });
    await builder.add("x.svg", new Blob([raw]), "image/svg+xml");

    const entries = readZip(new Uint8Array(await builder.finish().arrayBuffer()));
    const entry = entries[0];
    expect(entry?.method).toBe(METHOD_DEFLATE);
    expect(entry?.uncompressedSize).toBe(raw.length);
    expect(entry?.compressedSize).toBeLessThan(raw.length);
    expect(entry?.crc).toBe(crc32Of(raw));

    const back = await inflateRaw(entry?.body ?? new Uint8Array());
    expect(new TextDecoder().decode(back)).toBe(svg);
  });

  it("marks every name as UTF-8, so a non-ASCII name survives", async () => {
    const builder = new ZipBuilder({ modifiedAt: MODIFIED });
    await builder.add("café-dither.png", new Blob([new Uint8Array([1])]), "image/png");
    const entries = readZip(new Uint8Array(await builder.finish().arrayBuffer()));
    expect(entries[0]?.name).toBe("café-dither.png");
    // Bit 11 — without it an unarchiver may read the name as Code Page 437.
    expect((entries[0]?.flags ?? 0) & 0x08_00).toBe(0x08_00);
  });

  it("counts bytes and entries as it goes", async () => {
    const builder = new ZipBuilder({ modifiedAt: MODIFIED });
    expect(builder.count).toBe(0);
    expect(builder.bytes).toBe(0);
    await builder.add("a.png", new Blob([new Uint8Array(10)]), "image/png");
    expect(builder.count).toBe(1);
    expect(builder.bytes).toBe(30 + "a.png".length + 10);
  });

  it("produces an empty but well-formed archive when nothing was added", async () => {
    const builder = new ZipBuilder({ modifiedAt: MODIFIED });
    const bytes = new Uint8Array(await builder.finish().arrayBuffer());
    expect(bytes.length).toBe(22);
    expect(readZip(bytes)).toEqual([]);
  });

  it("refuses rather than truncating when an entry cannot be addressed", async () => {
    const builder = new ZipBuilder({ modifiedAt: MODIFIED });
    // A blob whose reported size is past what a 32-bit field can hold. Reading
    // it would allocate four gigabytes, so the guard has to sit before the read
    // — which is what this pins.
    const huge = { size: 0x1_00_00_00_00 } as Blob;
    await expect(builder.add("huge.png", huge, "image/png")).rejects.toThrow(ZipLimitError);
  });
});

describe("deflateRaw", () => {
  it("round-trips through the platform's inflater", async () => {
    const payload = new TextEncoder().encode("orkorkork".repeat(200));
    const deflated = await deflateRaw(payload);
    expect(deflated.length).toBeLessThan(payload.length);
    expect([...(await inflateRaw(deflated))]).toEqual([...payload]);
  });

  it("is raw, not zlib-wrapped", async () => {
    // A zlib stream begins 0x78; a raw deflate block does not carry that header,
    // and an archive full of zlib streams is one every unarchiver rejects.
    const deflated = await deflateRaw(new TextEncoder().encode("a"));
    const inflated = await inflateRaw(deflated);
    expect(new TextDecoder().decode(inflated)).toBe("a");
  });
});
