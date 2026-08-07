/**
 * The CRC is the one part of a PNG that is checked by every decoder and by
 * nothing else. A wrong table produces a file that looks structurally perfect
 * and that no viewer will open, so it is pinned against the published check
 * value rather than against our own output.
 */

import { describe, expect, it } from "vitest";

import { crc32, crc32Final, crc32Of } from "./crc32";

const CHECK_INPUT = new Uint8Array(
  [..."123456789"].map((character) => character.charCodeAt(0)),
);

describe("crc32", () => {
  it("matches the published check value for CRC-32/ISO-HDLC", () => {
    // The standard's own check vector: CRC of the ASCII "123456789".
    expect(crc32Of(CHECK_INPUT)).toBe(0xcb_f4_39_26);
  });

  it("is the same whether the input arrives in one piece or several", () => {
    // The continuation form is what lets a chunk's CRC cover its type and its
    // data without concatenating a multi-megabyte IDAT with its four-byte tag.
    const whole = crc32Of(CHECK_INPUT);
    const split = crc32Final(
      crc32(CHECK_INPUT.subarray(4), crc32(CHECK_INPUT.subarray(0, 4))),
    );
    expect(split).toBe(whole);
  });

  it("is zero over nothing, which is what an empty IEND needs", () => {
    // IEND carries no data, so its CRC is the CRC of its four type bytes alone.
    expect(crc32Of(new Uint8Array(0))).toBe(0);
  });

  it("returns an unsigned 32-bit value", () => {
    // A signed result writes the wrong high byte through `>>> 24` and produces
    // a chunk that fails validation in exactly one of four cases.
    const value = crc32Of(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xff_ff_ff_ff);
  });
});
