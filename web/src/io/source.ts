/**
 * The decoded source image, as the rest of the application holds it.
 *
 * One record with four jobs: it is the pixels the renderer starts from, the
 * `source` field the document writes down, the root of every content hash in
 * the graph, and the thing the viewport measures its zoom against.
 *
 * **The hash is over the encoded file, not over the decoded pixels.** Both are
 * exact identities and the difference is cost: a 16-megapixel image is 64 MB of
 * RGBA to digest and a few megabytes as a PNG, and the digest is computed on
 * the main thread while somebody is waiting to see their picture. The only
 * thing the cheaper choice gives up is that two files which decode to identical
 * pixels hash differently — a missed cache hit between two loads, never a wrong
 * one, and the wrong one is the failure that matters. The dimensions and the
 * format go into the label so that two files which are byte-identical but
 * reached here through different decoders cannot collide either.
 */

import type { SourceRef } from "../types/document";
import type { ContentHash, CpuColorSurface, FrameBuffer } from "../types/graph";
import { hashBytes } from "../graph/hash";
import type { ImageFormat } from "./formats";

/**
 * What a source image was made of.
 *
 * `"blank"` is not one of `ImageFormat`'s members and cannot be: that union is
 * the set of things the decoder sniffs, and each member owes a MIME type and a
 * list of extensions. A blank canvas came from no file, has no encoding and
 * would have to invent both. It is a separate member here rather than a `null`
 * so that every place this is printed — the log line, the document's source
 * name, the memory readout — says *blank* instead of saying nothing.
 */
export type SourceFormat = ImageFormat | "blank";

export interface SourceImage {
  /** File name as it arrived, or a name the paste path invented. Display only. */
  readonly name: string;
  readonly format: SourceFormat;
  readonly width: number;
  readonly height: number;
  /** Linear light, planar `f32`, unassociated alpha (F-IN-02, F-IN-03). */
  readonly surface: CpuColorSurface;
  /** Roots every node hash in the graph. */
  readonly hash: ContentHash;
  /** Size of the encoded file. Zero for a blank canvas, which has none. */
  readonly byteLength: number;
}

/** The digest that becomes {@link SourceImage.hash}. */
export function sourceHash(
  bytes: Uint8Array,
  format: SourceFormat,
  width: number,
  height: number,
): ContentHash {
  return hashBytes(`source:${format}:${width}x${height}`, bytes);
}

/**
 * A blank canvas — the source a document with a generator starts from.
 *
 * ## Why this exists at all
 *
 * A generator produces an image from its parameters, so a document containing
 * one needs no photograph. It still needs **a size**: every extent in the
 * pipeline is derived from the source's, the preview scales a fraction of it
 * (F-UI-03), and an export writes it. Nothing else in the document carries a
 * size, and putting one on the generator node would mean two generators in a
 * stack could disagree about how big the picture is.
 *
 * So "a document with no image" is really "a document whose image is a stated
 * empty canvas of a chosen size", and that is what this makes. Every layer
 * downstream is untouched: the renderer gets a real `SourceImage`, the graph
 * roots at a real hash, the compare view has a real reference, and export has a
 * real extent. There is no second render path and no branch anywhere on
 * "is there a source".
 *
 * ## Why it is not a fallback
 *
 * It is created only when the user asks for it, it says what it is in its own
 * name, and it is transparent rather than a plausible-looking grey. Nothing
 * substitutes it for a failed load: an image that will not decode is still an
 * `ImageLoadError` and still says so.
 *
 * ## Transparent black, not white
 *
 * Zero in all four channels. A canvas with no generator on it then shows the
 * transparency checkerboard (F-UI-05), which reads as *empty* — white would
 * read as a white picture, and the difference matters the moment somebody
 * exports one. A generator writes alpha 1 over the whole frame, so a stack that
 * starts with one never shows it.
 */
export function blankSource(width: number, height: number): SourceImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(
      `a blank canvas needs positive integer dimensions; got ${width}x${height}`,
    );
  }
  const texels = width * height;
  return {
    name: `Blank ${width}×${height}`,
    format: "blank",
    width,
    height,
    surface: {
      residency: "cpu",
      r: new Float32Array(texels),
      g: new Float32Array(texels),
      b: new Float32Array(texels),
      a: new Float32Array(texels),
    },
    // The dimensions are already in the label, and there are no file bytes to
    // digest — two blank canvases of one size *are* the same picture, so they
    // share a hash and share every cache entry derived from it.
    hash: sourceHash(new Uint8Array(0), "blank", width, height),
    byteLength: 0,
  };
}

/**
 * The source as the render graph reads it.
 *
 * CPU-resident: the decode produced planar `f32` in JS memory, and the first
 * GPU node uploads it — one crossing, logged like every other, rather than a
 * texture created here that the graph would then have to be told about.
 */
export function sourceFrameBuffer(image: SourceImage): FrameBuffer {
  return {
    width: image.width,
    height: image.height,
    color: image.surface,
    // Nothing has quantized yet, so there is no index map and no palette it
    // could refer to.
    quantization: { kind: "continuous" },
    hash: image.hash,
  };
}

/**
 * The document's reference to the image (F-DO-01).
 *
 * A reference, not the picture: a `.dork` carries the recipe and a share URL
 * never carries the image. The self-contained variant (F-DO-02) adds
 * `dataUrl`, and this does not produce one — nothing in this round writes that
 * variant, and a field filled in on the off chance is a field nobody checks.
 */
export function sourceRefOf(image: SourceImage): SourceRef {
  return { name: image.name, width: image.width, height: image.height };
}
