/**
 * Which bytes we accept, and how we tell (F-IN-01).
 *
 * **Sniffed from the bytes, never from the file name or the reported MIME
 * type.** A `.png` that is really a JPEG loads fine either way; a `.png` that is
 * really a PDF must be refused with a message that says so, and an extension is
 * not evidence about content. The browser's own decoder sniffs too, so trusting
 * the name would only move the same failure later and make it less legible —
 * `createImageBitmap` rejects with a `DOMException` whose message is
 * browser-specific and says nothing about what the file actually was.
 *
 * The five formats are the ones the requirement names. GIF is accepted as its
 * **first frame** — animated input is out of scope (docs/ARCHITECTURE.md), and
 * `createImageBitmap` gives the first frame of a GIF by definition.
 *
 * No SVG. F-IN-05 is a P1 requirement that needs a rasterization density
 * control, and an SVG accepted here would rasterize at whatever intrinsic size
 * the browser guessed. Refusing it with its own message is better than
 * producing a picture at a size nobody chose.
 */

/** The five formats F-IN-01 names, as the sniffer reports them. */
export type ImageFormat = "png" | "jpeg" | "webp" | "bmp" | "gif";

export interface ImageFormatInfo {
  readonly format: ImageFormat;
  readonly label: string;
  /** MIME type, for the file picker's `accept` list and for diagnostics. */
  readonly mime: string;
  /** Conventional extensions, for the picker only. Nothing is decided by them. */
  readonly extensions: readonly string[];
}

export const IMAGE_FORMATS: readonly ImageFormatInfo[] = [
  { format: "png", label: "PNG", mime: "image/png", extensions: [".png"] },
  { format: "jpeg", label: "JPEG", mime: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  { format: "webp", label: "WebP", mime: "image/webp", extensions: [".webp"] },
  { format: "bmp", label: "BMP", mime: "image/bmp", extensions: [".bmp"] },
  { format: "gif", label: "GIF (first frame)", mime: "image/gif", extensions: [".gif"] },
];

/** The `accept` attribute for a file input, built from the table above. */
export const IMAGE_ACCEPT_ATTRIBUTE: string = IMAGE_FORMATS.flatMap((info) => [
  info.mime,
  ...info.extensions,
]).join(",");

/** "PNG, JPEG, WebP, BMP, GIF (first frame)" — for a message shown to a person. */
export function describeAcceptedFormats(): string {
  return IMAGE_FORMATS.map((info) => info.label).join(", ");
}

/**
 * How many leading bytes the sniffer needs.
 *
 * WebP is the long one: `RIFF` at 0, the size at 4, and `WEBP` at 8, so twelve
 * bytes settle every case. Reading a fixed prefix rather than the whole file
 * matters for the drop path, where a 200 MB file should be refused before it is
 * read into memory.
 */
export const IMAGE_SNIFF_BYTES = 12;

function matches(bytes: Uint8Array, at: number, signature: readonly number[]): boolean {
  if (bytes.length < at + signature.length) return false;
  for (const [index, expected] of signature.entries()) {
    if (bytes[at + index] !== expected) return false;
  }
  return true;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const BMP = [0x42, 0x4d];
const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/**
 * The format these bytes are, or `null`.
 *
 * `null` is the honest answer for anything not in the list — including a format
 * the browser could decode. Accepting a decodable-but-undeclared format would
 * make the set of things that work a property of the browser rather than of the
 * application, and the first person to hit it would be told nothing.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (matches(bytes, 0, PNG)) return "png";
  if (matches(bytes, 0, JPEG)) return "jpeg";
  if (matches(bytes, 0, BMP)) return "bmp";
  if (matches(bytes, 0, GIF87A) || matches(bytes, 0, GIF89A)) return "gif";
  // A RIFF container is only an image when its form type says WEBP; a WAV file
  // opens with the same four bytes.
  if (matches(bytes, 0, RIFF) && matches(bytes, 8, WEBP)) return "webp";
  return null;
}

export function formatInfo(format: ImageFormat): ImageFormatInfo {
  const info = IMAGE_FORMATS.find((candidate) => candidate.format === format);
  if (info === undefined) {
    // Unreachable while ImageFormat and IMAGE_FORMATS agree, which a test pins.
    throw new Error(`no format table entry for "${format}"`);
  }
  return info;
}
