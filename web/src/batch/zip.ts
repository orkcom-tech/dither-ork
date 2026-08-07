/**
 * A ZIP writer — the half of F-BA-03 that works in every browser.
 *
 * Written here, in about two hundred lines, for the same reason `export/png.ts`
 * is written here: the format is small, the alternative is a dependency in a
 * project with three, and the one thing a ZIP must be is *readable by every
 * unarchiver on earth*, which is a property you get by writing the documented
 * bytes rather than by trusting a package.
 *
 * ## What is written
 *
 * PKWARE APPNOTE 6.3.x, the plain 32-bit form: a local file header and a body
 * per entry, then a central directory, then an end-of-central-directory record.
 * No Zip64, no data descriptors, no encryption, no comments. Sizes and CRCs are
 * known before each header is written — the whole body exists as a `Blob` by
 * then — so the data-descriptor form that streaming writers need has nothing to
 * offer here.
 *
 * Zip64's absence is a stated limit rather than an oversight: an archive, an
 * entry or a central-directory offset above 4 GiB - 1 is **refused** with a
 * message naming the alternative (write to a directory instead). Truncating the
 * field, which is what a 32-bit writer does if it does not check, produces an
 * archive that opens and is wrong.
 *
 * ## Compressed or stored, decided per entry
 *
 * PNG, JPEG and WebP are already deflated or DCT-coded; running deflate over
 * them again costs seconds per file and saves, typically, nothing. So those are
 * **stored** (method 0) and SVG — which is text, and compresses by an order of
 * magnitude — is **deflated** (method 8). The decision is a function of the
 * mime type and is stated in {@link zipMethodFor} rather than being a constant
 * somebody has to guess at.
 *
 * ## Names are UTF-8
 *
 * General-purpose bit 11 is set on every entry, which is the flag that says the
 * name is UTF-8 rather than IBM Code Page 437. Without it an unarchiver is
 * entitled to read `é` as `Ú`, and the names come from the user's own files.
 */

import { crc32, crc32Final } from "../export";
import { logger } from "../lib/log";

const log = logger("batch");

/**
 * A buffer this module allocated, or one read out of a `Blob`.
 *
 * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, which since
 * TypeScript 5.7 might be backed by a `SharedArrayBuffer` — and the stream
 * writers refuse one, correctly, since another thread could write it mid-read.
 * A `SharedArrayBuffer` is very much in scope here: cross-origin isolation is
 * mandatory so that the WASM thread pool can exist. The same argument and the
 * same alias as `export/types.ts`.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const LOCAL_SIGNATURE = 0x04_03_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const END_SIGNATURE = 0x06_05_4b_50;

/** Bit 11 — the name and comment are UTF-8. */
const FLAG_UTF8 = 0x08_00;

export const METHOD_STORE = 0;
export const METHOD_DEFLATE = 8;

export type ZipMethod = typeof METHOD_STORE | typeof METHOD_DEFLATE;

/** The largest value any 32-bit field in this format can hold. */
const MAX_U32 = 0xff_ff_ff_ff;

/**
 * Bytes CRC'd between abort checks.
 *
 * 4 MiB: the loop is a table lookup per byte, so this is a few milliseconds on
 * any machine that can run WebGPU — short enough that a cancel lands promptly,
 * long enough that the check is not the cost.
 */
const CRC_CHUNK = 4 << 20;

/** Which method suits a payload. See the note at the top. */
export function zipMethodFor(mime: string): ZipMethod {
  // Everything raster this application writes is already compressed. Text is
  // not, and an SVG trace of a dither is very repetitive text.
  return mime.startsWith("image/svg") || mime.startsWith("text/") ? METHOD_DEFLATE : METHOD_STORE;
}

/**
 * MS-DOS date and time, as the format has recorded them since 1989.
 *
 * Two-second resolution and a 1980 epoch are properties of the format, not
 * choices. A date before 1980 cannot be represented, so it is clamped to the
 * epoch rather than wrapping to some year in the future.
 */
export function dosDateTime(when: Date): { readonly date: number; readonly time: number } {
  const year = when.getFullYear();
  if (year < 1980) {
    return { date: (1 << 5) | 1, time: 0 };
  }
  const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const time =
    (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  return { date: date & 0xff_ff, time: time & 0xff_ff };
}

/**
 * Raw deflate.
 *
 * `export/zlib.ts` produces the *zlib-wrapped* stream PNG's IDAT needs; ZIP
 * method 8 is the unwrapped one, which is the browser's `"deflate-raw"`. The
 * two are one header and four trailing bytes apart and are not interchangeable
 * — a ZIP containing zlib streams is an archive every unarchiver rejects.
 *
 * The read loop is started before the first write for the reason `zlib.ts`
 * gives: a `TransformStream` has a bounded queue, and writing first deadlocks
 * on any input large enough to matter.
 */
export async function deflateRaw(bytes: Bytes): Promise<Bytes> {
  const stream = new CompressionStream("deflate-raw");
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();

  const parts: Uint8Array[] = [];
  let produced = 0;

  const drain = (async (): Promise<void> => {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      parts.push(result.value);
      produced += result.value.length;
    }
  })();

  await writer.write(bytes);
  await writer.close();
  await drain;

  const out = new Uint8Array(produced) as Bytes;
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** CRC-32 of a buffer, checking for cancellation between chunks. */
function crcOf(bytes: Uint8Array, signal: AbortSignal | undefined): number {
  let running = 0xff_ff_ff_ff;
  for (let offset = 0; offset < bytes.length; offset += CRC_CHUNK) {
    if (signal?.aborted === true) throw new ZipCancelledError();
    running = crc32(bytes.subarray(offset, Math.min(offset + CRC_CHUNK, bytes.length)), running);
  }
  return crc32Final(running);
}

/** Thrown when the signal aborts mid-archive. Never an error state. */
export class ZipCancelledError extends Error {
  constructor() {
    super("the archive was cancelled");
    this.name = "ZipCancelledError";
  }
}

/**
 * A limit of the format, hit. Separate from every other failure because the
 * message has to name the way out rather than only the problem.
 */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

interface Entry {
  readonly name: Uint8Array;
  readonly method: ZipMethod;
  readonly crc: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly offset: number;
  readonly date: number;
  readonly time: number;
  /** The body, exactly as it goes on the wire. */
  readonly body: Blob;
}

function u16(view: DataView, at: number, value: number): void {
  view.setUint16(at, value, true);
}

function u32(view: DataView, at: number, value: number): void {
  view.setUint32(at, value >>> 0, true);
}

export interface ZipBuilderOptions {
  /**
   * The modification time every entry records.
   *
   * Required, with no default: a `new Date()` in here would make two archives
   * of the same files differ, and the one place a clock may be read is the call
   * site that can say why.
   */
  readonly modifiedAt: Date;
  readonly signal?: AbortSignal;
}

/**
 * Accumulate entries, then assemble one `Blob`.
 *
 * Bodies are kept as `Blob`s rather than as `Uint8Array`s: a `Blob` is the
 * browser's to page out to disk, and a two-hundred-file batch is precisely the
 * case where holding every output in the JS heap is what kills the tab. The
 * bytes are read once, to compute the CRC the format requires, and then
 * released.
 */
export class ZipBuilder {
  readonly #entries: Entry[] = [];
  readonly #options: ZipBuilderOptions;
  #offset = 0;

  constructor(options: ZipBuilderOptions) {
    this.#options = options;
  }

  get count(): number {
    return this.#entries.length;
  }

  /** Bytes written so far, headers included. */
  get bytes(): number {
    return this.#offset;
  }

  /**
   * Add one file.
   *
   * `name` is written as given — it has already been through `naming.ts`, which
   * is the one place that decides what an output is called.
   */
  async add(name: string, blob: Blob, mime: string): Promise<void> {
    const signal = this.#options.signal;
    if (signal?.aborted === true) throw new ZipCancelledError();

    if (this.#entries.length >= MAX_ZIP_ENTRIES) {
      throw new ZipLimitError(
        `a ZIP without Zip64 can hold ${MAX_ZIP_ENTRIES} entries and this batch has ` +
          `more. Write to a directory instead, or run the batch in smaller groups.`,
      );
    }

    const nameBytes = new TextEncoder().encode(name);
    const headerBytes = 30 + nameBytes.length;

    const tooLarge = (): ZipLimitError =>
      new ZipLimitError(
        `"${name}" would take the archive past 4 GiB, which is the largest a ZIP ` +
          `without Zip64 can address. Write to a directory instead, or run the ` +
          `batch in smaller groups.`,
      );

    // Checked from the blob's own size, *before* it is read: refusing a four
    // gigabyte entry by first pulling four gigabytes into the JS heap is a
    // refusal that kills the tab it was meant to protect.
    if (blob.size > MAX_U32 || this.#offset + headerBytes + blob.size > MAX_U32) {
      throw tooLarge();
    }

    const raw = new Uint8Array(await blob.arrayBuffer());
    const crc = crcOf(raw, signal);
    const method = zipMethodFor(mime);

    let body: Blob;
    let compressedSize: number;
    if (method === METHOD_DEFLATE) {
      const deflated = await deflateRaw(raw);
      body = new Blob([deflated]);
      compressedSize = deflated.length;
    } else {
      // The original blob, not a copy of the array: see the class note.
      body = blob;
      compressedSize = raw.length;
    }

    const { date, time } = dosDateTime(this.#options.modifiedAt);
    const next = this.#offset + headerBytes + compressedSize;

    // Deflate can expand incompressible input by a fraction of a percent, so
    // the bound is taken again against what was actually produced.
    if (compressedSize > MAX_U32 || next > MAX_U32) throw tooLarge();

    this.#entries.push({
      name: nameBytes,
      method,
      crc,
      compressedSize,
      uncompressedSize: raw.length,
      offset: this.#offset,
      date,
      time,
      body,
    });
    this.#offset = next;

    log.debug("zip entry added", {
      name,
      method: method === METHOD_DEFLATE ? "deflate" : "store",
      bytes: raw.length,
      stored: compressedSize,
      at: this.#offset,
    });
  }

  /** The archive. Callable once the last entry is in; the builder is not reset. */
  finish(): Blob {
    const parts: BlobPart[] = [];

    for (const entry of this.#entries) {
      const header = new Uint8Array(30 + entry.name.length) as Bytes;
      const view = new DataView(header.buffer);
      u32(view, 0, LOCAL_SIGNATURE);
      // 20 — the version that introduced deflate. Written for stored entries
      // too, because every reader in existence accepts it and a mixed archive
      // with two version numbers is a needless difference.
      u16(view, 4, 20);
      u16(view, 6, FLAG_UTF8);
      u16(view, 8, entry.method);
      u16(view, 10, entry.time);
      u16(view, 12, entry.date);
      u32(view, 14, entry.crc);
      u32(view, 18, entry.compressedSize);
      u32(view, 22, entry.uncompressedSize);
      u16(view, 26, entry.name.length);
      u16(view, 28, 0);
      header.set(entry.name, 30);
      parts.push(header, entry.body);
    }

    const centralStart = this.#offset;
    let centralSize = 0;
    for (const entry of this.#entries) {
      const record = new Uint8Array(46 + entry.name.length) as Bytes;
      const view = new DataView(record.buffer);
      u32(view, 0, CENTRAL_SIGNATURE);
      // Version made by: 20, host 0 (MS-DOS / FAT). The external attributes are
      // zero, so claiming a Unix host would promise permission bits that are
      // not there.
      u16(view, 4, 20);
      u16(view, 6, 20);
      u16(view, 8, FLAG_UTF8);
      u16(view, 10, entry.method);
      u16(view, 12, entry.time);
      u16(view, 14, entry.date);
      u32(view, 16, entry.crc);
      u32(view, 20, entry.compressedSize);
      u32(view, 24, entry.uncompressedSize);
      u16(view, 28, entry.name.length);
      u16(view, 30, 0);
      u16(view, 32, 0);
      u16(view, 34, 0);
      u16(view, 36, 0);
      u32(view, 38, 0);
      u32(view, 42, entry.offset);
      record.set(entry.name, 46);
      parts.push(record);
      centralSize += record.length;
    }

    if (centralStart + centralSize > MAX_U32) {
      throw new ZipLimitError(
        "the central directory would sit past 4 GiB, which a ZIP without Zip64 " +
          "cannot address. Write to a directory instead, or run the batch in " +
          "smaller groups.",
      );
    }

    const end = new Uint8Array(22) as Bytes;
    const view = new DataView(end.buffer);
    u32(view, 0, END_SIGNATURE);
    u16(view, 4, 0);
    u16(view, 6, 0);
    u16(view, 8, this.#entries.length);
    u16(view, 10, this.#entries.length);
    u32(view, 12, centralSize);
    u32(view, 16, centralStart);
    u16(view, 20, 0);
    parts.push(end);

    const blob = new Blob(parts, { type: "application/zip" });
    log.info("archive assembled", {
      entries: this.#entries.length,
      bytes: blob.size,
      centralAt: centralStart,
      centralBytes: centralSize,
    });
    return blob;
  }
}

/**
 * The number of entries a ZIP end-record can count.
 *
 * The field is 16 bits. Above it, Zip64 is not optional — and a batch of 65 536
 * files is a real folder, not a hypothetical one, so it is refused with a
 * message rather than wrapping the count.
 */
export const MAX_ZIP_ENTRIES = 0xff_ff;
