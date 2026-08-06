/**
 * F-IN-01 — bytes to a decoded source.
 *
 * The order of the four steps is the whole design, and it is the order that
 * makes the refusals cheap:
 *
 * 1. **Sniff a short prefix.** A `.png` that is really a PDF is refused here,
 *    naming what this accepts, rather than reaching a browser decoder that
 *    rejects it with a message about a "source image".
 * 2. **Probe the header for the dimensions.** F-IN-04's ceiling is applied
 *    before anything allocates a bitmap, because `createImageBitmap` on a
 *    20000x20000 PNG produces 1.6 GB of pixels before anyone can measure it.
 * 3. **Decode.** One call, no format branches: the browser owns PNG, JPEG,
 *    WebP, BMP and the first frame of a GIF, and a second decoder in here would
 *    be a second set of bugs about colour.
 * 4. **Measure again and convert.** The decoded size is the authority — a
 *    header that lied is caught here — and then the transfer comes off
 *    (F-IN-02) and the alpha is carried through untouched (F-IN-03).
 *
 * ## Why a canvas
 *
 * `ImageBitmap` has no pixel accessor. The only way to read what the browser
 * decoded is to draw it and call `getImageData`, which returns **unassociated**
 * 8-bit sRGB — which is exactly the layout `linearSurfaceFromSrgbBytes` takes.
 * The draw uses `globalCompositeOperation = "copy"` so the bitmap replaces the
 * canvas rather than being composited over it: source-over onto transparent
 * black is the same arithmetic for opaque pixels and is not for translucent
 * ones, and F-IN-03 is precisely about the translucent ones.
 *
 * What that costs is measured rather than guessed at, because a 2D canvas
 * stores **premultiplied** and the round trip through it is lossy at low alpha.
 * Fed a hand-built PNG whose two pixels are `(255,0,0,0)` and `(0,255,0,128)`,
 * the canvas returns `(0,0,0,0)` and `(0,255,0,128)`: partial alpha is exact,
 * and the colour underneath a **fully transparent** pixel is gone — 255/0
 * premultiplies to 0 and no division brings it back. At alpha 1..254 the colour
 * survives to within the precision that alpha can carry.
 *
 * So, precisely: alpha itself is preserved exactly, nothing is composited onto
 * white or onto anything else, and no pixel is dropped — but the colour value
 * hiding under a zero-alpha pixel does not survive the load. It is stated here
 * rather than described as "bit-exact enough".
 *
 * Two ways out exist and neither is taken here. `queue.copyExternalImageToTexture`
 * with `premultipliedAlpha: false` copies an unpremultiplied `ImageBitmap`
 * straight into a texture, which is exact — and puts a `GPUDevice` in the
 * signature of every image load. `ImageDecoder` from WebCodecs returns
 * unpremultiplied frames, and is a second decode path with its own format
 * support matrix. A second decode path is the thing this file exists to avoid,
 * so the choice is recorded rather than hedged.
 *
 * ## Colour management
 *
 * `colorSpaceConversion: "default"` — the browser converts a tagged image to
 * sRGB using its embedded profile, which is what every other application on the
 * machine shows the user. F-IN-06 (read the ICC profile, convert to the working
 * space or refuse with a stated reason) is a P1 requirement and is **not**
 * implemented; this is the browser doing it, not us, and an untagged image is
 * assumed sRGB.
 */

import { logger } from "../lib/log";
import { ImageLoadError } from "./errors";
import { describeAcceptedFormats, sniffImageFormat, IMAGE_SNIFF_BYTES } from "./formats";
import { linearSurfaceFromSrgbBytes } from "./linear";
import { assertSourceExtent, DEFAULT_SOURCE_LIMITS, type SourceLimits } from "./limits";
import { PROBE_BYTES, probeImageExtent } from "./probe";
import { sourceHash, type SourceImage } from "./source";

const log = logger("io");

export interface DecodeImageOptions {
  /** Narrowed by the device's `maxTextureDimension2D` at boot. */
  readonly limits?: SourceLimits;
}

/**
 * Decode one image.
 *
 * `name` is carried through to the document and to every message, so the paste
 * path invents one rather than leaving it empty — a refusal that names no file
 * is a refusal a person cannot act on.
 */
export async function decodeImage(
  blob: Blob,
  name: string,
  options: DecodeImageOptions = {},
): Promise<SourceImage> {
  const limits = options.limits ?? DEFAULT_SOURCE_LIMITS;
  const started = performance.now();

  if (blob.size === 0) {
    throw new ImageLoadError("empty-source", `"${name}" is empty — zero bytes.`, { name });
  }

  const prefix = new Uint8Array(
    await blob.slice(0, Math.max(PROBE_BYTES, IMAGE_SNIFF_BYTES)).arrayBuffer(),
  );

  const format = sniffImageFormat(prefix);
  if (format === null) {
    throw new ImageLoadError(
      "unsupported-format",
      `"${name}" is not an image this can open. Accepted: ${describeAcceptedFormats()}. ` +
        `The check is on the file's own bytes, not on its name.`,
      { name, bytes: blob.size },
    );
  }

  const probed = probeImageExtent(format, prefix);
  if (probed !== null) {
    // Refused here, before the decoder allocates anything.
    assertSourceExtent(probed.width, probed.height, name, limits);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      premultiplyAlpha: "none",
      colorSpaceConversion: "default",
    });
  } catch (error) {
    throw new ImageLoadError(
      "decode-failed",
      `"${name}" looks like a ${format.toUpperCase()} file but the browser could not decode it: ${String(error)}`,
      { name, format, bytes: blob.size },
    );
  }

  try {
    // The authority. A header that under-reported its size is caught here, and
    // this is the number every buffer downstream is allocated from.
    assertSourceExtent(bitmap.width, bitmap.height, name, limits);

    const width = bitmap.width;
    const height = bitmap.height;
    const data = readPixels(bitmap, name);
    const surface = linearSurfaceFromSrgbBytes(data, width, height);
    const image: SourceImage = {
      name,
      format,
      width,
      height,
      surface,
      hash: sourceHash(bytes, format, width, height),
      byteLength: bytes.byteLength,
    };

    log.info("image loaded", {
      name,
      format,
      width,
      height,
      bytes: bytes.byteLength,
      probed: probed !== null,
      ms: Math.round((performance.now() - started) * 100) / 100,
      hash: image.hash,
    });
    return image;
  } finally {
    // Held by the browser outside the JS heap; dropping the reference is not
    // enough, and this runs on the refusal path too.
    bitmap.close();
  }
}

/** Draw once, read once. The only place the decoded pixels are touched. */
function readPixels(bitmap: ImageBitmap, name: string): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", {
    alpha: true,
    // Read exactly once, but the read is the entire point of this canvas, and
    // the hint keeps the browser from putting the surface somewhere that makes
    // `getImageData` a GPU readback.
    willReadFrequently: true,
  });
  if (ctx === null) {
    throw new ImageLoadError(
      "decode-failed",
      `"${name}" decoded, but this browser would not give a 2D context to read it with.`,
      { name, width: bitmap.width, height: bitmap.height },
    );
  }
  // Replace rather than composite: source-over onto transparent black changes
  // translucent pixels, and F-IN-03 is about exactly those.
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}
