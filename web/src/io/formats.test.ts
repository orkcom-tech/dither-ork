/**
 * Format sniffing (F-IN-01).
 *
 * The claim being tested is that the decision is made on the bytes. A test that
 * fed it file names would prove the opposite.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import {
  IMAGE_ACCEPT_ATTRIBUTE,
  IMAGE_FORMATS,
  IMAGE_SNIFF_BYTES,
  describeAcceptedFormats,
  formatInfo,
  sniffImageFormat,
  type ImageFormat,
} from "./formats";

setLevel("error");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF87A = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 4, 0, 4, 0, 0, 0]);
const GIF89A = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 0, 4, 0, 0, 0]);
const BMP = new Uint8Array([0x42, 0x4d, 0x46, 0, 0, 0, 0, 0, 0, 0, 0x36, 0]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);
/** A WAV: the same RIFF container, a different form type. */
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0]);
const SVG = new Uint8Array([...'<svg xmlns="'].map((c) => c.charCodeAt(0)));

describe("sniffImageFormat", () => {
  it("recognises the five formats F-IN-01 names", () => {
    expect(sniffImageFormat(PNG)).toBe("png");
    expect(sniffImageFormat(JPEG)).toBe("jpeg");
    expect(sniffImageFormat(GIF87A)).toBe("gif");
    expect(sniffImageFormat(GIF89A)).toBe("gif");
    expect(sniffImageFormat(BMP)).toBe("bmp");
    expect(sniffImageFormat(WEBP)).toBe("webp");
  });

  it("refuses a RIFF container that is not a WebP", () => {
    // Four bytes of signature would accept every WAV file on the machine.
    expect(sniffImageFormat(WAV)).toBeNull();
  });

  it("refuses what it does not know, including SVG", () => {
    // SVG is F-IN-05 — a P1 requirement with a rasterization density control.
    // Accepting it here would rasterize at whatever size the browser guessed.
    expect(sniffImageFormat(PDF)).toBeNull();
    expect(sniffImageFormat(SVG)).toBeNull();
    expect(sniffImageFormat(new Uint8Array(0))).toBeNull();
  });

  it("refuses a prefix too short to be the signature it starts", () => {
    // A truncated PNG signature is not a PNG, and matching on what is present
    // would send a fragment to the decoder.
    expect(sniffImageFormat(PNG.slice(0, 4))).toBeNull();
    expect(sniffImageFormat(WEBP.slice(0, 8))).toBeNull();
  });

  it("needs no more than IMAGE_SNIFF_BYTES to decide", () => {
    for (const sample of [PNG, JPEG, GIF89A, BMP, WEBP]) {
      expect(sniffImageFormat(sample.slice(0, IMAGE_SNIFF_BYTES))).not.toBeNull();
    }
  });
});

describe("the format table", () => {
  it("has an entry for every format the sniffer can return", () => {
    const formats: readonly ImageFormat[] = ["png", "jpeg", "webp", "bmp", "gif"];
    for (const format of formats) expect(formatInfo(format).format).toBe(format);
    expect(IMAGE_FORMATS).toHaveLength(formats.length);
  });

  it("builds the picker's accept list and the message from one table", () => {
    for (const info of IMAGE_FORMATS) {
      expect(IMAGE_ACCEPT_ATTRIBUTE).toContain(info.mime);
      expect(describeAcceptedFormats()).toContain(info.label);
    }
  });
});
