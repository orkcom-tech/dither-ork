/**
 * The compressor is the platform's, so what is tested here is the plumbing
 * around it: that the concurrent read/write arrangement does not deadlock on an
 * input larger than the stream's internal queue, that the output is a zlib
 * stream and not a raw deflate one, and that a cancel stops it.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { crc32Of } from "./crc32";
import { ExportCancelledError } from "./progress";
import { deflate, inflate } from "./zlib";

setLevel("error");

function repeating(bytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) out[i] = i & 0xff;
  return out;
}

describe("deflate", () => {
  it("round-trips", async () => {
    const input = repeating(4096);
    expect(await inflate(await deflate(input))).toEqual(input);
  });

  it("writes a zlib wrapper, which is what PNG's IDAT is", async () => {
    // 0x78 is CMF for deflate with a 32K window; the second byte's low bits
    // make the pair a multiple of 31. A raw deflate stream — what
    // "deflate-raw" would give — has neither, and every PNG decoder rejects it.
    const out = await deflate(repeating(256));
    expect(out[0]).toBe(0x78);
    expect(((out[0] ?? 0) * 256 + (out[1] ?? 0)) % 31).toBe(0);
  });

  it("does not deadlock on an input larger than one chunk", async () => {
    // 3 MiB is three writes through a stream whose queue holds one. Reading
    // after writing rather than concurrently hangs here and nowhere smaller,
    // which is why the size is above the 1 MiB chunk rather than beside it.
    //
    // Compared by CRC rather than by `toEqual`: a structural deep-equal over
    // three million elements takes seconds and would make this look like the
    // deadlock it is checking for.
    const input = repeating(3 << 20);
    const out = await inflate(await deflate(input));
    expect(out.length).toBe(input.length);
    expect(crc32Of(out)).toBe(crc32Of(input));
  });

  it("compresses something compressible", async () => {
    const flat = new Uint8Array(64 * 1024);
    const out = await deflate(flat);
    expect(out.length).toBeLessThan(flat.length / 100);
  });

  it("reports progress over the input, ending at 1", async () => {
    const seen: number[] = [];
    await deflate(repeating(3 << 20), { onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(1);
    // Monotonic: a bar that goes backwards reads as a restart.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i] ?? 0).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
    }
  });

  it("refuses before doing any work when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(deflate(repeating(1024), { signal: controller.signal })).rejects.toBeInstanceOf(
      ExportCancelledError,
    );
  });

  it("stops mid-stream when the signal aborts during the write", async () => {
    const controller = new AbortController();
    const promise = deflate(repeating(8 << 20), {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(promise).rejects.toBeInstanceOf(ExportCancelledError);
  });
});
