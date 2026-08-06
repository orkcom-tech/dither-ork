/**
 * Image input — F-IN-01 through F-IN-04.
 *
 * ```ts
 * const intake: ImageIntake = {
 *   onImage: (image) => store.openSource(image),
 *   onError: (error) => banner.show(error.message),
 * };
 * installImageDrop(window, { intake, limits });
 * installClipboardPaste(window, { intake, limits });
 * await pickImageFile({ intake, limits });   // from a toolbar button
 * ```
 *
 * What the layer guarantees, and where each is enforced:
 *
 * - PNG, JPEG, WebP, BMP and the first frame of a GIF, decided by the file's
 *   own bytes — `formats.ts`.
 * - Linear light on the way in, sRGB only at the edges — `linear.ts`.
 * - Alpha unassociated and never composited onto white — `linear.ts` and the
 *   `"copy"` draw in `decode.ts`.
 * - A stated maximum, refused rather than silently resampled — `limits.ts`,
 *   applied from the header before a decoder allocates anything (`probe.ts`)
 *   and again against the decoded image.
 */

export { ImageLoadError, type ImageLoadErrorCode } from "./errors";

export {
  IMAGE_ACCEPT_ATTRIBUTE,
  IMAGE_FORMATS,
  IMAGE_SNIFF_BYTES,
  describeAcceptedFormats,
  formatInfo,
  sniffImageFormat,
  type ImageFormat,
  type ImageFormatInfo,
} from "./formats";

export {
  DEFAULT_SOURCE_LIMITS,
  MAX_SOURCE_DIMENSION,
  MAX_SOURCE_PIXELS,
  assertSourceExtent,
  sourceLimits,
  type SourceLimits,
} from "./limits";

export { PROBE_BYTES, probeImageExtent, type ProbedExtent } from "./probe";

export {
  linearOfSrgbByte,
  linearSurfaceFromSrgbBytes,
  srgbBytesFromLinearSurface,
} from "./linear";

export { sourceFrameBuffer, sourceHash, sourceRefOf, type SourceImage } from "./source";

export { decodeImage, type DecodeImageOptions } from "./decode";

export {
  installClipboardPaste,
  installImageDrop,
  pickImageFile,
  receiveImage,
  type DropTargetOptions,
  type ImageInputOptions,
  type ImageIntake,
} from "./input";
