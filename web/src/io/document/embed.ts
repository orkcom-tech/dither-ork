/**
 * The image inside a self-contained `.dork` — F-DO-02.
 *
 * Two directions, and they are not symmetric.
 *
 * ## Out: the decoded surface, re-encoded as PNG
 *
 * The original file's bytes are **not kept**. `SourceImage` holds the decoded
 * linear-light surface, its dimensions and a hash of the file — not the file —
 * because holding a second megabytes-sized copy of every opened image for the
 * sake of a save that may never happen is a memory cost paid by everybody.
 *
 * So embedding re-encodes: linear light back through the sRGB transfer
 * (`srgbBytesFromLinearSurface`, the same call the viewport presents with), then
 * PNG. Two consequences, both stated rather than hidden:
 *
 * - **The pixels are exact.** The decode built the surface from 8-bit sRGB and
 *   the transfer table is exact in both directions, so the round trip returns
 *   the same code values. PNG is lossless. What comes back out of a
 *   self-contained document is what went in.
 * - **The bytes are not.** A JPEG embeds as a PNG and gets larger — often
 *   several times larger. That is the honest price of not keeping a second copy
 *   of every file in memory, and the UI states the resulting size rather than
 *   letting somebody discover it from their disk.
 *
 * The one thing that does not survive is the colour hiding under a fully
 * transparent pixel, and it did not survive the *load* either — `io/decode.ts`
 * measures exactly that and says so. Embedding adds no loss of its own.
 *
 * ## In: straight back through the ordinary intake
 *
 * A document's `dataUrl` becomes a `File` and goes through `receiveImage` like
 * anything dropped on the window. That is deliberate: the sniff, the extent
 * limit, the decode and the log line are the same ones every other image gets,
 * so an embedded image cannot be the one path that skips F-IN-04's ceiling.
 */

import type { DitherDocument } from "../../types/document";
import { logger } from "../../lib/log";
import { srgbBytesFromLinearSurface } from "../linear";
import type { SourceImage } from "../source";
import { encodeDataUrl, parseDataUrl } from "./base64";
import { DocumentFileError } from "./errors";

const log = logger("io");

/** What {@link encodeSourceDataUrl} writes. Lossless, and the browser has it. */
export const EMBEDDED_IMAGE_MIME = "image/png";

/**
 * The open image as a `data:` URL, for {@link withEmbeddedSource}.
 *
 * `OffscreenCanvas` rather than a document canvas: nothing here needs to be in
 * the tree, and this is the same class `io/decode.ts` reads pixels back with, so
 * the two ends of the round trip go through one implementation.
 */
export async function encodeSourceDataUrl(image: SourceImage): Promise<string> {
  const bytes = srgbBytesFromLinearSurface(image.surface, image.width, image.height);
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext("2d", { alpha: true });
  if (context === null) {
    throw new DocumentFileError(
      "no-source",
      `this browser would not give a 2D context to encode "${image.name}" with, so the ` +
        `self-contained document cannot be written.`,
      { name: image.name, width: image.width, height: image.height },
    );
  }
  // `putImageData` writes the buffer verbatim — no compositing, no premultiply
  // — which is what keeps unassociated alpha (F-IN-03) intact on the way out.
  context.putImageData(new ImageData(bytes, image.width, image.height), 0, 0);

  const blob = await canvas.convertToBlob({ type: EMBEDDED_IMAGE_MIME });
  const encoded = new Uint8Array(await blob.arrayBuffer());
  const url = encodeDataUrl(EMBEDDED_IMAGE_MIME, encoded);
  log.info("source embedded", {
    name: image.name,
    width: image.width,
    height: image.height,
    png: encoded.byteLength,
    chars: url.length,
  });
  return url;
}

/**
 * The image out of a self-contained document, as a file the intake can open.
 *
 * Refuses a document that has none rather than returning `null`: the caller
 * asked because `isSelfContained` said yes, and a `null` here would be a
 * disagreement between the two that the type system cannot see.
 */
export function embeddedSourceFile(document: DitherDocument): File {
  const source = document.source;
  if (source?.dataUrl === undefined) {
    throw new DocumentFileError(
      "no-source",
      `this document references its image rather than carrying one, so there is nothing ` +
        `to unpack. Open "${source?.name ?? "the image"}" yourself.`,
    );
  }
  const { mime, bytes } = parseDataUrl(source.dataUrl);
  log.info("embedded source unpacked", {
    name: source.name,
    mime,
    bytes: bytes.byteLength,
  });
  // The name is carried through to every message and to the document's own
  // source reference; the *format* is decided by the intake from the bytes, as
  // it is for every other image.
  return new File([bytes], source.name, { type: mime });
}
