/**
 * CRC-32 as PNG defines it, which is the CRC-32/ISO-HDLC of the RFC.
 *
 * Written here because the PNG writer is written here: every chunk carries one
 * over its type and data, a wrong one makes a file that every decoder refuses,
 * and the whole of it is twenty lines. Bringing in a dependency for this would
 * be a dependency in a project that has three.
 *
 * The table is built once from the polynomial rather than transcribed, for the
 * reason `core/.../diffusion.rs` gives about Ostromoukhov's table: a
 * transcribed table of 256 magic numbers is 256 chances to be wrong in a way
 * that looks right, and the construction is one line.
 */

const POLYNOMIAL = 0xed_b8_83_20;

const TABLE: Uint32Array = buildTable();

function buildTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/**
 * CRC of one buffer, or of a continuation.
 *
 * The continuation form exists so a chunk's CRC can be taken over its type
 * bytes and its data without concatenating them first — which for an IDAT of
 * several megabytes would be a second copy of the whole payload.
 */
export function crc32(bytes: Uint8Array, seed = 0xff_ff_ff_ff): number {
  let c = seed;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return c >>> 0;
}

/** Finish a CRC begun with {@link crc32}. */
export function crc32Final(running: number): number {
  return (running ^ 0xff_ff_ff_ff) >>> 0;
}

/** The complete CRC of one buffer, ready to write into a chunk. */
export function crc32Of(...parts: readonly Uint8Array[]): number {
  let running = 0xff_ff_ff_ff;
  for (const part of parts) running = crc32(part, running);
  return crc32Final(running);
}
