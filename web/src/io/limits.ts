/**
 * F-IN-04 — the maximum source, and the refusal above it.
 *
 * **The requirement is that there is no silent downscale.** An application that
 * quietly resamples a 12000-pixel scan to something it can afford has changed
 * the picture without saying so, and every dither is a function of the pixel
 * grid it ran on — the same document at two resolutions is two different
 * images, not one image at two sizes. So the ceiling is a number stated here,
 * and above it the load is refused with a message naming both the image's size
 * and the limit.
 *
 * Two ceilings, because they bound different things:
 *
 * - **The edge**, at 8192. This is WebGPU's guaranteed `maxTextureDimension2D`,
 *   which every working surface in the renderer is allocated against; an image
 *   wider than that cannot become a texture at all on a conforming device, so
 *   accepting it would only move the failure into the texture pool. A device
 *   that reports a smaller limit narrows this further — {@link sourceLimits}
 *   takes the device's number, so the refusal names the limit that actually
 *   applies rather than a constant that happens to be optimistic.
 *
 * - **The area**, at 2^24 pixels (16.8 Mpx, e.g. 4096x4096). The edge alone is
 *   not enough: 8192x8192 is 67 Mpx, and one `rgba16float` working surface at
 *   that size is 537 MB. A stack holds several at once and the node cache holds
 *   more, so an image that passes the edge check can still be one the renderer
 *   cannot hold. 2^24 is 128 MiB per colour surface, which a preview session
 *   with a cache budget can live inside.
 *
 * Both are pure numbers over two integers, so the whole of this file is tested
 * without a browser, a device or an image.
 */

import { ImageLoadError } from "./errors";

/** WebGPU's guaranteed `maxTextureDimension2D`; every working surface is one. */
export const MAX_SOURCE_DIMENSION = 8192;

/** 2^24 pixels — 128 MiB as one `rgba16float` surface. */
export const MAX_SOURCE_PIXELS = 16_777_216;

export interface SourceLimits {
  readonly maxDimension: number;
  readonly maxPixels: number;
}

export const DEFAULT_SOURCE_LIMITS: SourceLimits = {
  maxDimension: MAX_SOURCE_DIMENSION,
  maxPixels: MAX_SOURCE_PIXELS,
};

/**
 * The limits that apply on this device.
 *
 * `maxTextureDimension2D` is a device limit, and it is allowed to be larger
 * than the guaranteed 8192 — but a source larger than 8192 would still have to
 * survive every intermediate allocation, and the area ceiling above is the one
 * that binds first anyway. So the device can only ever narrow this, never widen
 * it, and the number in the refusal is the one the renderer will actually
 * enforce.
 */
export function sourceLimits(maxTextureDimension2D: number): SourceLimits {
  return {
    maxDimension: Math.min(MAX_SOURCE_DIMENSION, Math.trunc(maxTextureDimension2D)),
    maxPixels: MAX_SOURCE_PIXELS,
  };
}

/** Megapixels, to one decimal, for a message a person reads. */
function megapixels(pixels: number): string {
  return (pixels / 1_000_000).toFixed(1);
}

/**
 * Refuse a source above either ceiling.
 *
 * Throws {@link ImageLoadError} with code `too-large` or `zero-dimension`;
 * returns nothing, because the only two outcomes are "fine" and "refused" and a
 * boolean return invites a caller to ignore it.
 */
export function assertSourceExtent(
  width: number,
  height: number,
  name: string,
  limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new ImageLoadError(
      "zero-dimension",
      `"${name}" decoded to ${width}x${height}, which is not an image this can work on.`,
      { name, width, height },
    );
  }

  if (width > limits.maxDimension || height > limits.maxDimension) {
    throw new ImageLoadError(
      "too-large",
      `"${name}" is ${width}x${height}. The longest edge this build accepts is ` +
        `${limits.maxDimension} pixels — every working surface is a GPU texture and ` +
        `that is the limit this device reports. Resize the image and open it again; ` +
        `nothing here will resize it for you, because a dither is a function of the ` +
        `pixel grid it ran on.`,
      { name, width, height, maxDimension: limits.maxDimension },
    );
  }

  const pixels = width * height;
  if (pixels > limits.maxPixels) {
    throw new ImageLoadError(
      "too-large",
      `"${name}" is ${width}x${height} — ${megapixels(pixels)} megapixels, above the ` +
        `${megapixels(limits.maxPixels)} this build accepts. One working buffer at that ` +
        `size is ${Math.round((pixels * 8) / 1_048_576)} MB and a stack holds several. ` +
        `Resize the image and open it again; nothing here will resize it for you.`,
      { name, width, height, pixels, maxPixels: limits.maxPixels },
    );
  }
}
