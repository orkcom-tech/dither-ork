/**
 * Deflate, from the platform.
 *
 * PNG's IDAT is a zlib stream (RFC 1950 wrapper around RFC 1951 deflate), which
 * is exactly what `CompressionStream("deflate")` produces — the "deflate" name
 * in that API is the zlib-wrapped form, and "deflate-raw" is the unwrapped one.
 * So there is no compressor in this repository and there should not be: a
 * hand-written one would be slower than the browser's, would be another
 * thousand lines to own, and would have no way to be more correct.
 *
 * ## Why the write loop looks like that
 *
 * A `TransformStream` has a bounded internal queue. Writing the whole buffer
 * and *then* reading would block on a queue nobody is draining, so the read
 * loop is started first and runs concurrently with the writes. That is not a
 * micro-optimisation; the straightforward order deadlocks on any input large
 * enough to matter, which is every input this is used on.
 *
 * The chunking is what makes F-EX-13 possible at all: progress is reported and
 * cancellation is checked between chunks, and a single `write` of forty
 * megabytes has no inside to check from.
 */

import { logger } from "../lib/log";
import type { Bytes } from "./types";
import { ExportCancelledError, throwIfCancelled } from "./progress";

const log = logger("export");

/**
 * 1 MiB. Small enough that a cancel lands within a frame or two on any machine
 * that can run WebGPU; large enough that the per-chunk overhead is noise.
 */
const CHUNK_BYTES = 1 << 20;

export interface DeflateOptions {
  readonly signal?: AbortSignal;
  /** Called with 0..1 of the *input* consumed, which is what is knowable. */
  readonly onProgress?: (fraction: number) => void;
}

/**
 * Compress to a zlib stream.
 *
 * Progress is over bytes fed in rather than bytes produced, because the output
 * length is not known until the stream closes — an honest fraction of a known
 * quantity beats a made-up fraction of an unknown one.
 */
export async function deflate(
  bytes: Bytes,
  options: DeflateOptions = {},
): Promise<Bytes> {
  throwIfCancelled(options.signal);

  const stream = new CompressionStream("deflate");
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();

  const parts: Uint8Array[] = [];
  let produced = 0;

  // Started before the first write, deliberately — see the note above.
  const drain = (async (): Promise<void> => {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      parts.push(result.value);
      produced += result.value.length;
    }
  })();

  try {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      throwIfCancelled(options.signal);
      const end = Math.min(offset + CHUNK_BYTES, bytes.length);
      await writer.write(bytes.subarray(offset, end));
      options.onProgress?.(end / Math.max(1, bytes.length));
    }
    await writer.close();
    await drain;
  } catch (error) {
    // Both halves are torn down, and both are reported. Leaving either open
    // would keep the compressor alive until collection; swallowing either would
    // hide the reason the export stopped.
    await writer.abort(error).catch((reason: unknown) => {
      log.warn("the deflate writer would not abort", { reason: String(reason) });
    });
    await reader.cancel(error).catch((reason: unknown) => {
      log.warn("the deflate reader would not cancel", { reason: String(reason) });
    });
    if (error instanceof ExportCancelledError) throw error;
    log.error("deflate failed", { error: String(error), bytes: bytes.length });
    throw error;
  }

  const out = new Uint8Array(produced);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The inverse. Not used by the encoder — it exists so the PNG tests can read
 * back what they wrote, which is the only way to check that an IDAT holds the
 * scanlines it is supposed to rather than merely that the file has the right
 * shape.
 */
export async function inflate(bytes: Bytes): Promise<Bytes> {
  const stream = new DecompressionStream("deflate");
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

  const out = new Uint8Array(produced);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
