/**
 * The two alphabets.
 *
 * The round trip is the easy half. The half that matters is the boundary
 * behaviour — padding, the three substituted characters, and a `data:` URL that
 * is not one — because every one of those failures produces *some* bytes rather
 * than an error, and bytes that are almost right are a corrupt image or a
 * corrupt stack.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import { DocumentFileError } from "./errors";
import {
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  encodeDataUrl,
  parseDataUrl,
} from "./base64";

setLevel("error");

function bytes(...values: readonly number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("base64", () => {
  it("round trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    expect([...base64Decode(base64Encode(all), "test")]).toEqual([...all]);
  });

  it("round trips each of the three padding lengths", () => {
    for (const length of [1, 2, 3, 4, 5]) {
      const value = bytes(...Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff));
      expect([...base64Decode(base64Encode(value), "test")], `length ${length}`).toEqual([
        ...value,
      ]);
    }
  });

  it("encodes a payload larger than one chunk", () => {
    // The encoder walks the array in 8k blocks so that a spread does not
    // overflow the argument stack; this is the case that would catch a block
    // boundary handled wrongly.
    const large = new Uint8Array(20_000);
    for (let i = 0; i < large.length; i += 1) large[i] = (i * 31) & 0xff;
    const back = base64Decode(base64Encode(large), "test");
    expect(back.length).toBe(large.length);
    expect(back[0]).toBe(large[0]);
    expect(back[9_999]).toBe(large[9_999]);
    expect(back[19_999]).toBe(large[19_999]);
  });
});

describe("base64url", () => {
  it("never writes a character a URL treats specially", () => {
    // 0xfb 0xff produces both `+` and `/` under the standard alphabet, which is
    // exactly what must not appear in a fragment.
    const awkward = bytes(0xfb, 0xff, 0xbf, 0xfe);
    const standard = base64Encode(awkward);
    expect(standard).toMatch(/[+/]/);
    const url = base64UrlEncode(awkward);
    expect(url).not.toMatch(/[+/=]/);
    expect([...base64UrlDecode(url, "test")]).toEqual([...awkward]);
  });

  it("round trips without padding at every length", () => {
    for (let length = 1; length <= 8; length += 1) {
      const value = bytes(...Array.from({ length }, (_, i) => (i * 53 + 7) & 0xff));
      expect([...base64UrlDecode(base64UrlEncode(value), "test")], `length ${length}`).toEqual(
        [...value],
      );
    }
  });

  it("refuses text that is not base64url rather than returning partial bytes", () => {
    // A truncated link is the overwhelmingly common failure and it must not
    // decode to something.
    expect(() => base64UrlDecode("!!!not base64!!!", "this share link")).toThrow(
      DocumentFileError,
    );
  });
});

describe("data URLs", () => {
  it("round trips", () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const url = encodeDataUrl("image/png", png);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const parsed = parseDataUrl(url);
    expect(parsed.mime).toBe("image/png");
    expect([...parsed.bytes]).toEqual([...png]);
  });

  it("refuses a URL that is not a base64 data URL", () => {
    for (const bad of ["", "https://example.invalid/x.png", "data:image/png,%89PNG"]) {
      expect(() => parseDataUrl(bad), bad).toThrow(DocumentFileError);
    }
  });

  it("refuses a data URL carrying no data", () => {
    expect(() => parseDataUrl("data:image/png;base64,")).toThrow(DocumentFileError);
  });
});
