/**
 * F-EX-02 and F-EX-03 — JPEG and WebP, which the browser encodes.
 *
 * PNG is written by hand (see `png.ts`) because the format has a palette mode
 * no browser will use. JPEG and WebP are the opposite case: both are large,
 * intricate, patent-adjacent encoders that every target browser already ships,
 * tuned, in native code. Shipping our own would be several thousand lines to
 * own for output that is worse.
 *
 * ## Support is probed, not assumed, and it is stated
 *
 * `convertToBlob` does something specific and unhelpful when asked for a type
 * the browser cannot write: it silently returns a PNG. So every encode here
 * checks the type that came back, and the panel additionally probes each format
 * once at startup so an unavailable one is a disabled control with a reason on
 * it rather than a button that produces the wrong file. The probe is a real
 * 1x1 encode — a user-agent string would be a guess.
 *
 * ## Quality
 *
 * `ImageEncodeOptions.quality` is 0..1 and the panel's control is 1..100, which
 * is the scale every other tool shows. The conversion is here so the number in
 * the UI is the number a person expects and the number in the API is the number
 * it defines.
 *
 * There is no lossless WebP: the canvas API exposes no way to ask for it, so
 * quality 100 is still a lossy encode. The format table says so rather than
 * letting the top of the slider imply otherwise.
 */

import { logger } from "../lib/log";
import type { ExportRaster } from "./types";
import { throwIfCancelled } from "./progress";

const log = logger("export");

export class ExportEncoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportEncoderError";
  }
}

export interface CanvasEncodeOptions {
  readonly signal?: AbortSignal;
  /** 1..100 as the panel shows it. Ignored by formats that are not lossy. */
  readonly quality: number;
}

/**
 * Encode through the platform's own encoder.
 *
 * The picture is put onto the canvas with `putImageData`, which is defined as
 * writing unassociated RGBA — no colour transform, no scaling, no compositing.
 * A `drawImage` of a bitmap would be resampled and colour-managed on some
 * platforms and is the one call to avoid here.
 */
export async function encodeWithCanvas(
  raster: ExportRaster,
  mime: string,
  options: CanvasEncodeOptions,
): Promise<Blob> {
  throwIfCancelled(options.signal);

  if (typeof OffscreenCanvas === "undefined") {
    throw new ExportEncoderError(
      `${mime} is encoded by the browser through OffscreenCanvas, which this ` +
        `browser does not have. PNG is written directly and is unaffected.`,
    );
  }

  const canvas = new OffscreenCanvas(raster.width, raster.height);
  const context = canvas.getContext("2d", { colorSpace: "srgb" });
  if (context === null) {
    throw new ExportEncoderError(
      `a 2D context could not be created for a ${raster.width}x${raster.height} ` +
        `canvas — the size is probably above what this browser allows.`,
    );
  }

  // Allocated and filled rather than constructed around the existing buffer:
  // `ImageData` requires an `ArrayBuffer`-backed view and the raster may be
  // backed by anything, and a copy of the bytes is cheaper than the alternative
  // of making every buffer in the pipeline promise where it lives.
  const image = context.createImageData(raster.width, raster.height);
  image.data.set(raster.data);
  context.putImageData(image, 0, 0);

  const blob = await canvas.convertToBlob({
    type: mime,
    quality: options.quality / 100,
  });

  if (blob.type !== mime) {
    // The silent-PNG behaviour described at the top of the file. It reaches the
    // user as a refusal rather than as a file with the wrong contents inside a
    // correctly named wrapper.
    throw new ExportEncoderError(
      `this browser cannot encode ${mime}: it returned ${blob.type} instead. ` +
        `Choose another format.`,
    );
  }

  log.info("browser encode complete", {
    mime,
    quality: options.quality,
    width: raster.width,
    height: raster.height,
    bytes: blob.size,
  });
  return blob;
}

/**
 * Which of the browser-encoded types this browser actually writes.
 *
 * Probed once per set of types and remembered: the answer cannot change within
 * a session, and the probe is one 1x1 encode per type.
 *
 * Keyed by the list rather than by nothing, because a single cached promise
 * would answer a later call about a *different* set of types with the first
 * set's result — a cache that is silently wrong rather than merely stale.
 */
const probes = new Map<string, Promise<ReadonlySet<string>>>();

export function canvasEncoderSupport(mimes: readonly string[]): Promise<ReadonlySet<string>> {
  const key = [...mimes].join(",");
  const existing = probes.get(key);
  if (existing !== undefined) return existing;
  const started = runProbe(mimes);
  probes.set(key, started);
  return started;
}

async function runProbe(mimes: readonly string[]): Promise<ReadonlySet<string>> {
  const supported = new Set<string>();
  if (typeof OffscreenCanvas === "undefined") {
    log.warn("no OffscreenCanvas: only PNG can be written in this browser");
    return supported;
  }

  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d", { colorSpace: "srgb" });
  if (context === null) {
    log.warn("no 2D context: only PNG can be written in this browser");
    return supported;
  }
  context.fillStyle = "#000000";
  context.fillRect(0, 0, 1, 1);

  for (const mime of mimes) {
    try {
      const blob = await canvas.convertToBlob({ type: mime });
      if (blob.type === mime) supported.add(mime);
      else log.warn("encoder unavailable", { mime, returned: blob.type });
    } catch (error) {
      // A throw is the other way a browser refuses a type. Recorded, not
      // swallowed, and it leaves the format out of the set.
      log.warn("encoder probe threw", { mime, error: String(error) });
    }
  }
  log.info("canvas encoders probed", { supported: [...supported].join(", ") });
  return supported;
}
