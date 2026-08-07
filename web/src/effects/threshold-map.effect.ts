/**
 * Threshold map from an uploaded image (F-PP-07).
 *
 * An ordered dither whose matrix is not a tile generated in Rust but a picture
 * the user chose for this node. Everything else about it — the F-OD-CTL
 * controls, the candidate pair, the linear-light fraction, the index map it
 * emits — is the ordered-dither program, shared from
 * `../gpu/effects/ordered.ts` rather than copied, so a change to those controls
 * reaches this node too.
 *
 * **The image arrives through the per-node bulk data channel**
 * (`InstanceDataBinding`), not as a parameter, because `ParameterValue` is a
 * number, a boolean, a string, a colour or a curve and a decoded image is none
 * of those. The binding declares `supplied: "required"`, which means a node
 * with no image refuses by name rather than rendering something plausible: what
 * a dither with no matrix would render is a plain threshold, and shipping that
 * silently would be the same effect as F-SP-07 wearing this one's label.
 *
 * **This file owns the byte layout**, and {@link encodeThresholdMap} is the one
 * call an image loader has to make. The layout is deliberately the shape a
 * decoded image already has — a 16-byte header and then `ImageData.data`
 * verbatim — so the uploader copies rather than repacks, and the shader unpacks
 * one word per matrix cell. What the shader does with those bytes, and why the
 * threshold is the texel's encoded luma rather than anything normalised, is at
 * the top of `../shaders/threshold-map.wgsl`.
 */

import { defineEffect, staticGpuEffect, type ParamDescriptor } from "../types/registry";
import type {
  ComputePass,
  GpuEffect,
  InstanceDataBinding,
  InstanceDataInput,
  PassBinding,
} from "../types/gpu";
import {
  ORDERED_BINDING,
  ORDERED_CONTROL_PARAMS,
  ORDERED_DITHER_UNIFORMS,
} from "../gpu/effects/ordered";
import { logger } from "../lib/log";

import wgsl from "../shaders/threshold-map.wgsl?raw";

const log = logger("gpu");

/**
 * Names this node's bulk data within the node.
 *
 * The uploader files bytes under this string (`NodeAssetStore.set(nodeId,
 * THRESHOLD_MAP_SLOT, …)`), and the binding below asks for the same string, so
 * the two agree by construction rather than by both spelling it out.
 */
export const THRESHOLD_MAP_SLOT = "threshold-map";

/** `"TMAP"` read as a little-endian 32-bit word. Restated in the shader. */
export const THRESHOLD_MAP_MAGIC = 0x50414d54;

/**
 * Layout version.
 *
 * Present from the first version because the bytes are held by the document
 * (F-DO-02 embeds its assets), so a `.dork` saved today has to be readable by a
 * build whose layout has moved on — and the readable failure is "version 2, I
 * understand 1", not a picture assembled from misaligned words.
 */
export const THRESHOLD_MAP_VERSION = 1;

/** magic, version, width, height. Restated as `HEADER_WORDS` in the shader. */
export const THRESHOLD_MAP_HEADER_WORDS = 4;
export const THRESHOLD_MAP_HEADER_BYTES = THRESHOLD_MAP_HEADER_WORDS * 4;

/**
 * Largest matrix accepted, on each axis.
 *
 * A 2048² matrix is 16 MiB — comfortably inside WebGPU's guaranteed
 * `maxStorageBufferBindingSize` of 128 MiB, and already far past the size at
 * which an image reads as a dither matrix rather than as a second image
 * multiplied over the first. The bound exists so an oversized upload is refused
 * where the file name is still known, rather than at the first render as a
 * buffer-size validation error naming a node id.
 */
export const THRESHOLD_MAP_MAX_EXTENT = 2048;

/** Thrown when bytes filed under this node's slot are not a threshold map. */
export class ThresholdMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThresholdMapError";
  }
}

/** A validated map's declared extent. */
export interface ThresholdMapExtent {
  readonly width: number;
  readonly height: number;
}

function isPositiveExtent(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= THRESHOLD_MAP_MAX_EXTENT;
}

/**
 * Pack a decoded image into the layout the shader reads.
 *
 * `rgba` is `width * height * 4` bytes in the order `ImageData.data` already
 * uses — R, G, B, A per texel, sRGB-encoded, straight alpha. Nothing is
 * converted: the shader reads the encoded value on purpose, and the alpha it
 * ignores.
 *
 * This is the whole interface between the image-loading path and this effect.
 * A loader decodes the file however the browser decodes it, hands the pixels
 * here, and files the result under {@link THRESHOLD_MAP_SLOT}.
 */
export function encodeThresholdMap(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
): Uint8Array {
  if (!isPositiveExtent(width) || !isPositiveExtent(height)) {
    throw new ThresholdMapError(
      `a threshold map is 1..${THRESHOLD_MAP_MAX_EXTENT} texels on each axis; got ${width}x${height}`,
    );
  }
  const expected = width * height * 4;
  if (rgba.byteLength !== expected) {
    throw new ThresholdMapError(
      `a ${width}x${height} threshold map needs ${expected} bytes of RGBA; got ${rgba.byteLength}`,
    );
  }

  const bytes = new Uint8Array(THRESHOLD_MAP_HEADER_BYTES + expected);
  const header = new DataView(bytes.buffer, 0, THRESHOLD_MAP_HEADER_BYTES);
  // Little-endian explicitly, the same statement `web/src/gpu/uniforms.ts`
  // makes: WebGPU buffer contents are host-endian and every platform WebGPU
  // ships on is little-endian, so writing the flag out means the assumption is
  // stated rather than inherited from a default.
  header.setUint32(0, THRESHOLD_MAP_MAGIC, true);
  header.setUint32(4, THRESHOLD_MAP_VERSION, true);
  header.setUint32(8, width, true);
  header.setUint32(12, height, true);
  bytes.set(
    rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, expected),
    THRESHOLD_MAP_HEADER_BYTES,
  );

  log.debug("threshold map encoded", {
    width,
    height,
    bytes: bytes.byteLength,
  });
  return bytes;
}

/**
 * Check that bytes are a threshold map this build can read, and say how big it
 * is.
 *
 * Every condition is one the shader cannot check. A compute shader has no way
 * to refuse: handed a truncated buffer it reads zeroes, because robust buffer
 * access clamps out-of-bounds indices, and the frame comes out black with no
 * error anywhere. So the whole header is checked here, once per frame, at the
 * cost of four `DataView` reads.
 */
export function readThresholdMapExtent(bytes: Uint8Array): ThresholdMapExtent {
  if (bytes.byteLength < THRESHOLD_MAP_HEADER_BYTES) {
    throw new ThresholdMapError(
      `a threshold map starts with a ${THRESHOLD_MAP_HEADER_BYTES}-byte header; these bytes are ${bytes.byteLength} long`,
    );
  }
  // A DataView rather than a Uint32Array: the bytes may arrive as a view with
  // any byte offset, and a Uint32Array view demands 4-byte alignment.
  const header = new DataView(bytes.buffer, bytes.byteOffset, THRESHOLD_MAP_HEADER_BYTES);

  const magic = header.getUint32(0, true);
  if (magic !== THRESHOLD_MAP_MAGIC) {
    throw new ThresholdMapError(
      `these bytes are not a threshold map: expected magic 0x${THRESHOLD_MAP_MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
    );
  }
  const version = header.getUint32(4, true);
  if (version !== THRESHOLD_MAP_VERSION) {
    throw new ThresholdMapError(
      `threshold map layout version ${version}; this build reads version ${THRESHOLD_MAP_VERSION}`,
    );
  }

  const width = header.getUint32(8, true);
  const height = header.getUint32(12, true);
  if (!isPositiveExtent(width) || !isPositiveExtent(height)) {
    throw new ThresholdMapError(
      `threshold map declares ${width}x${height}, outside 1..${THRESHOLD_MAP_MAX_EXTENT} on each axis`,
    );
  }

  const expected = THRESHOLD_MAP_HEADER_BYTES + width * height * 4;
  if (bytes.byteLength !== expected) {
    // Not "at least": a longer buffer means the header and the payload disagree
    // about what this image is, and the shader would index the wrong rows.
    throw new ThresholdMapError(
      `threshold map declares ${width}x${height}, which needs ${expected} bytes; the buffer is ${bytes.byteLength}`,
    );
  }

  return { width, height };
}

/**
 * The node's matrix, checked and passed straight through.
 *
 * Deliberately not a conversion. The bytes the uploader produced are already
 * the layout the shader reads, so this builder validates and returns the same
 * array — which means no per-frame work proportional to the image, and an
 * unchanged upload digests identically and costs no re-upload.
 */
function buildThresholdMap(input: InstanceDataInput): Uint8Array {
  const supplied = input.supplied;
  if (supplied === null) {
    // Unreachable: `resolveInstanceData` refuses a `required` slot with no
    // bytes before the builder runs. Stated rather than assumed, because the
    // alternative to this line is a `null` dereference in a stack trace that
    // names neither the node nor the slot.
    throw new ThresholdMapError(
      `node ${input.nodeId} carries no image for slot "${THRESHOLD_MAP_SLOT}"`,
    );
  }
  try {
    readThresholdMapExtent(supplied);
  } catch (error) {
    log.error("threshold map rejected", {
      node: input.nodeId,
      slot: THRESHOLD_MAP_SLOT,
      bytes: supplied.byteLength,
      error: String(error),
    });
    throw error;
  }
  return supplied;
}

/**
 * The uploaded matrix.
 *
 * Binding 6 is where the ordered dithers put their threshold tile
 * (`ORDERED_BINDING.matrix`), and this is the same data in the same place —
 * only its origin differs, which is why it is an `instance-data` binding rather
 * than a `table`.
 */
const mapBinding: InstanceDataBinding = {
  role: "instance-data",
  binding: ORDERED_BINDING.matrix,
  slot: THRESHOLD_MAP_SLOT,
  supplied: "required",
  build: buildThresholdMap,
};

const bindings: readonly PassBinding[] = [
  { role: "input-color", binding: ORDERED_BINDING.inputColor },
  { role: "output-color", binding: ORDERED_BINDING.outputColor },
  { role: "output-index", binding: ORDERED_BINDING.outputIndex },
  { role: "palette", binding: ORDERED_BINDING.palette },
  { role: "uniforms", binding: ORDERED_BINDING.uniforms },
  mapBinding,
];

const pass: ComputePass = {
  id: "threshold-map/threshold",
  label: "Threshold map",
  wgsl,
  entryPoint: "main",
  workgroupSize: [8, 8, 1],
  dispatch: { kind: "per-pixel" },
  // Reads only its own pixel; the threshold comes from the coordinate, not from
  // a neighbour.
  access: "pointwise",
  bindings,
  uniforms: ORDERED_DITHER_UNIFORMS,
};

/** The compute pass, for the pass compiler. */
export const THRESHOLD_MAP_GPU: GpuEffect = {
  effect: "threshold-map",
  passes: [pass],
};

/**
 * F-OD-CTL, unchanged.
 *
 * Shared rather than copied: these are the same seven controls every ordered
 * dither exposes, and this node is an ordered dither whose matrix came from
 * somewhere else. `tileScale` reads as pixels per matrix cell here exactly as
 * it does there, so a 64×64 upload at scale 2 covers 128 pixels.
 */
export const THRESHOLD_MAP_PARAMS: readonly ParamDescriptor[] = ORDERED_CONTROL_PARAMS;

export default defineEffect({
  id: "threshold-map",
  name: "Threshold map",
  summary:
    "An ordered dither whose threshold tile is an image you supply, so any picture can be used as a dither matrix.",
  description:
    "Everything about it is the ordered-dither program — the same tile scale, rotation, offset and spread controls, the same index map — except that the matrix is a decoded image rather than a tile generated from a recursion. Bright texels of your image become high thresholds, so the picture you upload shows up as the texture of the one you are dithering. A node with no image refuses to render rather than falling back to a plain threshold, because a plain threshold is a different effect wearing this one's label.",
  keywords: ["custom matrix", "uploaded image", "user matrix", "own image", "texture", "stencil", "threshold map", "second image"],
  concept: "ordered-dithering",
  requirement: "F-PP-07",
  // The dither slot and the ordered family, whatever its requirement id says:
  // it quantizes against the palette and emits the index map, which is what
  // that slot means. F-PP-07 is filed under preprocessing in the spec because
  // it is *about* supplying a matrix, but the node that consumes the matrix is
  // a dither.
  slot: "dither",
  family: "ordered",
  execution: "gpu",
  params: THRESHOLD_MAP_PARAMS,
  // As low as the validator permits, and it should be lower still.
  //
  // Surprise Me cannot upload an image, so every stack it generates containing
  // this node is unrenderable — `resolveInstanceData` refuses the required slot
  // by design. The honest weight is zero, and `EffectDescriptor` cannot express
  // it: `validateRegistry` requires `surpriseWeight > 0`, and there is no field
  // that says "this effect needs an asset the generator cannot produce". Until
  // there is, a generator must skip any effect whose passes declare an
  // `InstanceDataBinding` with `supplied: "required"` — the fact is already in
  // the passes, it is just not in the descriptor.
  surpriseWeight: 0.01,
  // Quantizing is the point: the index map it emits is what makes outline,
  // dilate/erode, hue-targeted recolour and the tracer lossless downstream.
  producesIndexMap: true,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("threshold-map", () => THRESHOLD_MAP_GPU);
