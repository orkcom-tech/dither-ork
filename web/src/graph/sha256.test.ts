/**
 * SHA-256 against published and derived vectors.
 *
 * The module's own comment says it is written to be checkable against the
 * published vectors without a browser or a bundler; this is that check. It
 * matters more than it looks: every content hash in the graph is this function,
 * and a wrong digest does not fail — it shows a stale cached image with no error
 * anywhere.
 *
 * The padding boundaries are the only part of SHA-256 with a genuinely tricky
 * edge. A message of 55 bytes still fits its 0x80 byte and 8-byte length in one
 * block; 56 does not and needs a second. The same step repeats at 119/120. Those
 * four lengths are covered explicitly because an off-by-one in `Math.ceil((len +
 * 9) / 64)` passes every short vector and then corrupts one message in sixty-four.
 */

import { describe, expect, it } from "vitest";

import { sha256Hex } from "./sha256";

const UTF8 = new TextEncoder();

function digestOf(text: string): string {
  return sha256Hex(UTF8.encode(text));
}

describe("sha256Hex", () => {
  it("matches the FIPS 180-4 example vectors", () => {
    expect(digestOf("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(digestOf("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      digestOf("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("matches the one-million-'a' vector", () => {
    expect(digestOf("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("pads correctly on both sides of every block boundary", () => {
    // 55 and 119 are the last lengths whose padding fits the current block;
    // 56 and 120 are the first that force one more.
    const expected: ReadonlyMap<number, string> = new Map([
      [55, "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"],
      [56, "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"],
      [63, "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34"],
      [64, "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"],
      [119, "31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb"],
      [120, "2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c"],
    ]);
    for (const [length, digest] of expected) {
      expect(digestOf("a".repeat(length)), `length ${length}`).toBe(digest);
    }
  });

  it("digests bytes, not code points", () => {
    // A multi-byte character has to be hashed as its UTF-8 encoding. If the
    // encoder were ever swapped for something that walked code units, this is
    // the assertion that would notice.
    const snowman = UTF8.encode("☃");
    expect(snowman.length).toBe(3);
    expect(sha256Hex(snowman)).toBe(
      sha256Hex(new Uint8Array([0xe2, 0x98, 0x83])),
    );
  });

  it("is a pure function of its input", () => {
    const bytes = UTF8.encode("dither-ork");
    expect(sha256Hex(bytes)).toBe(sha256Hex(bytes));
    expect(sha256Hex(bytes)).toBe(digestOf("dither-ork"));
  });

  it("does not read past the end of a subarray view", () => {
    // The graph hands it `ByteWriter.take()`, which is a subarray over a larger
    // backing buffer. Digesting the view must not see the slack capacity.
    const backing = new Uint8Array(64).fill(0xff);
    backing.set(UTF8.encode("abc"));
    expect(sha256Hex(backing.subarray(0, 3))).toBe(digestOf("abc"));
  });
});
