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

export interface SourceImage {
  /** File name as it arrived, or a name the paste path invented. Display only. */
  readonly name: string;
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
  /** Linear light, planar `f32`, unassociated alpha (F-IN-02, F-IN-03). */
  readonly surface: CpuColorSurface;
  /** Roots every node hash in the graph. */
  readonly hash: ContentHash;
  /** Size of the encoded file. Diagnostics and the memory readout. */
  readonly byteLength: number;
}

/** The digest that becomes {@link SourceImage.hash}. */
export function sourceHash(
  bytes: Uint8Array,
  format: ImageFormat,
  width: number,
  height: number,
): ContentHash {
  return hashBytes(`source:${format}:${width}x${height}`, bytes);
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
