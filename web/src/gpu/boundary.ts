/**
 * The GPU/CPU boundary.
 *
 * Error diffusion is serial and runs in WASM; everything else is a compute
 * pass. Each serial node sitting between parallel ones therefore costs a
 * readback plus an upload, and **the number of those crossings, not the number
 * of passes, is what sets the ceiling on how live the preview feels**
 * (docs/ARCHITECTURE.md, "The constraint everything follows from").
 *
 * So every crossing in this file is measured and logged with its transfer size.
 * The known performance trap has to be readable from the console rather than
 * found with a profiler, and that only holds if there is no unlogged path
 * across.
 *
 * Readbacks report their true end-to-end duration, because the caller has to
 * wait for the data anyway. Uploads report the CPU-side issue cost immediately
 * and then log completion when the queue fence resolves — awaiting the fence
 * inline would add a stall that does not otherwise exist, and reporting only
 * the issue cost would hide the transfer.
 */

import type { CpuColorSurface } from "../types/graph";
import type { BoundaryCrossing } from "../types/gpu";
import { logger } from "../lib/log";
import type { GpuContext } from "./device";

const log = logger("gpu");

/** `copyTextureToBuffer` requires the destination row pitch to be a multiple of this. */
const COPY_BYTES_PER_ROW_ALIGNMENT = 256;

const COLOR_BYTES_PER_TEXEL = 8;
const INDEX_BYTES_PER_TEXEL = 4;

export class BoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundaryError";
  }
}

function round2(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function paddedBytesPerRow(width: number, bytesPerTexel: number): number {
  const tight = width * bytesPerTexel;
  return Math.ceil(tight / COPY_BYTES_PER_ROW_ALIGNMENT) * COPY_BYTES_PER_ROW_ALIGNMENT;
}

// --- half float ---------------------------------------------------------
//
// The working colour format is rgba16float, and JavaScript has no f16 view, so
// both directions are converted by hand. Getting this subtly wrong — dropping
// subnormals, truncating instead of rounding — would show up as banding in the
// shadows on exactly the path the 16-bit format was chosen to protect, so both
// directions handle the full encoding.

const HALF_SCRATCH = new DataView(new ArrayBuffer(4));

/** IEEE-754 binary16 to a JS number. Handles subnormals, infinities and NaN. */
export function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * (fraction + 1024) * 2 ** (exponent - 25);
}

/** A JS number to IEEE-754 binary16, round-to-nearest-even on the normal path. */
export function floatToHalf(value: number): number {
  HALF_SCRATCH.setFloat32(0, value, true);
  const bits = HALF_SCRATCH.getUint32(0, true);

  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;

  if (exponent === 0xff) {
    // Infinity keeps its mantissa at zero; any NaN payload collapses to a
    // quiet NaN, which is all a texel can carry anyway.
    return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x0200);
  }

  const half16Exponent = exponent - 127 + 15;
  if (half16Exponent >= 0x1f) return sign | 0x7c00;

  if (half16Exponent <= 0) {
    if (half16Exponent < -10) return sign;
    // Subnormal: restore the implicit leading one and shift it down into the
    // 10-bit field, rounding half away from zero. The alternative — flushing to
    // zero — loses the darkest three stops of a linear-light image.
    const withImplicit = mantissa | 0x800000;
    const shift = 14 - half16Exponent;
    const rounded = (withImplicit + (1 << (shift - 1))) >>> shift;
    return sign | rounded;
  }

  const roundBit = mantissa & 0x1000;
  const sticky = mantissa & 0x0fff;
  let half = (half16Exponent << 10) | (mantissa >>> 13);
  if (roundBit !== 0 && (sticky !== 0 || (half & 1) !== 0)) half += 1;
  return sign | half;
}

// --- staging buffers ----------------------------------------------------

/**
 * Mappable buffers, reused by size.
 *
 * A readback happens once per serial node per frame, so allocating a
 * multi-megabyte mappable buffer each time is a per-frame allocation in the
 * hottest place there is.
 */
export class StagingPool {
  readonly #ctx: GpuContext;
  readonly #idle = new Map<number, GPUBuffer[]>();
  readonly #all: GPUBuffer[] = [];

  constructor(ctx: GpuContext) {
    this.#ctx = ctx;
  }

  acquire(sizeBytes: number, label: string): GPUBuffer {
    const free = this.#idle.get(sizeBytes);
    const recycled = free?.pop();
    if (recycled !== undefined) return recycled;
    const buffer = this.#ctx.device.createBuffer({
      label: `staging ${label}`,
      size: sizeBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.#all.push(buffer);
    log.debug("staging buffer created", { label, bytes: sizeBytes });
    return buffer;
  }

  release(buffer: GPUBuffer): void {
    const free = this.#idle.get(buffer.size);
    if (free === undefined) this.#idle.set(buffer.size, [buffer]);
    else free.push(buffer);
  }

  destroy(): void {
    for (const buffer of this.#all) buffer.destroy();
    log.info("staging pool destroyed", { buffers: this.#all.length });
    this.#all.length = 0;
    this.#idle.clear();
  }
}

// --- readback -----------------------------------------------------------

async function copyToStaging(
  ctx: GpuContext,
  staging: StagingPool,
  texture: GPUTexture,
  width: number,
  height: number,
  bytesPerTexel: number,
  label: string,
): Promise<{ buffer: GPUBuffer; rowBytes: number; wireBytes: number }> {
  const rowBytes = paddedBytesPerRow(width, bytesPerTexel);
  const wireBytes = rowBytes * height;
  const buffer = staging.acquire(wireBytes, label);

  const encoder = ctx.device.createCommandEncoder({ label: `readback ${label}` });
  encoder.copyTextureToBuffer(
    { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
    { buffer, offset: 0, bytesPerRow: rowBytes, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  ctx.device.queue.submit([encoder.finish()]);

  try {
    await buffer.mapAsync(GPUMapMode.READ);
  } catch (error) {
    staging.release(buffer);
    log.error("readback map failed", { label, bytes: wireBytes, error: String(error) });
    throw new BoundaryError(`readback of ${label} could not be mapped: ${String(error)}`);
  }
  return { buffer, rowBytes, wireBytes };
}

export interface ColorReadback {
  readonly surface: CpuColorSurface;
  readonly crossing: BoundaryCrossing;
}

/**
 * Pull an `rgba16float` texture into the planar `f32` layout the serial kernels
 * work in.
 *
 * Planar because diffusion walks one channel at a time and per-channel
 * diffusion (F-ED-CTL) is then a choice of which planes to touch rather than a
 * strided access pattern.
 */
export async function readColorSurface(
  ctx: GpuContext,
  staging: StagingPool,
  texture: GPUTexture,
  width: number,
  height: number,
  nodeId: string,
): Promise<ColorReadback> {
  ctx.assertUsable("readColorSurface");
  const started = performance.now();

  const { buffer, rowBytes, wireBytes } = await copyToStaging(
    ctx,
    staging,
    texture,
    width,
    height,
    COLOR_BYTES_PER_TEXEL,
    `${nodeId} color`,
  );

  const pixels = width * height;
  const r = new Float32Array(pixels);
  const g = new Float32Array(pixels);
  const b = new Float32Array(pixels);
  const a = new Float32Array(pixels);

  try {
    const mapped = new Uint16Array(buffer.getMappedRange());
    const rowHalves = rowBytes / 2;
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * rowHalves;
      const outStart = y * width;
      for (let x = 0; x < width; x += 1) {
        const at = rowStart + x * 4;
        r[outStart + x] = halfToFloat(mapped[at] ?? 0);
        g[outStart + x] = halfToFloat(mapped[at + 1] ?? 0);
        b[outStart + x] = halfToFloat(mapped[at + 2] ?? 0);
        a[outStart + x] = halfToFloat(mapped[at + 3] ?? 0);
      }
    }
  } finally {
    // Unmap on every path, including a decode that throws; a buffer left mapped
    // can never be reused and the pool would quietly grow without bound.
    buffer.unmap();
    staging.release(buffer);
  }

  const crossing: BoundaryCrossing = {
    nodeId,
    direction: "readback",
    bytes: wireBytes,
    ms: round2(performance.now() - started),
  };
  log.info("boundary readback", {
    node: nodeId,
    surface: "color",
    width,
    height,
    bytes: crossing.bytes,
    payloadBytes: width * height * COLOR_BYTES_PER_TEXEL,
    ms: crossing.ms,
  });
  return { surface: { residency: "cpu", r, g, b, a }, crossing };
}

export interface IndexReadback {
  readonly indices: Uint16Array;
  readonly crossing: BoundaryCrossing;
}

/** Pull an `r32uint` index map into the `u16` layout the CPU side carries. */
export async function readIndexSurface(
  ctx: GpuContext,
  staging: StagingPool,
  texture: GPUTexture,
  width: number,
  height: number,
  nodeId: string,
): Promise<IndexReadback> {
  ctx.assertUsable("readIndexSurface");
  const started = performance.now();

  const { buffer, rowBytes, wireBytes } = await copyToStaging(
    ctx,
    staging,
    texture,
    width,
    height,
    INDEX_BYTES_PER_TEXEL,
    `${nodeId} index`,
  );

  const indices = new Uint16Array(width * height);
  try {
    const mapped = new Uint32Array(buffer.getMappedRange());
    const rowWords = rowBytes / 4;
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * rowWords;
      const outStart = y * width;
      for (let x = 0; x < width; x += 1) {
        const value = mapped[rowStart + x] ?? 0;
        if (value > 0xffff) {
          // The CPU index map is u16 by contract. Truncating here would corrupt
          // the tracer and every index-map operation downstream without a trace.
          throw new BoundaryError(
            `index map from ${nodeId} contains ${value} at (${x}, ${y}), which does not fit a u16 palette index`,
          );
        }
        indices[outStart + x] = value;
      }
    }
  } finally {
    buffer.unmap();
    staging.release(buffer);
  }

  const crossing: BoundaryCrossing = {
    nodeId,
    direction: "readback",
    bytes: wireBytes,
    ms: round2(performance.now() - started),
  };
  log.info("boundary readback", {
    node: nodeId,
    surface: "index",
    width,
    height,
    bytes: crossing.bytes,
    payloadBytes: width * height * INDEX_BYTES_PER_TEXEL,
    ms: crossing.ms,
  });
  return { indices, crossing };
}

// --- upload -------------------------------------------------------------

/**
 * Log a queued transfer's real completion without stalling the caller.
 *
 * `onSubmittedWorkDone` resolves when the GPU has consumed the write. Awaiting
 * it inline would add a stall the renderer does not otherwise have; attaching
 * to it keeps the true duration in the log and the CPU free to encode the next
 * batch.
 */
function reportCompletion(ctx: GpuContext, what: string, nodeId: string, bytes: number): void {
  const queued = performance.now();
  ctx.device.queue
    .onSubmittedWorkDone()
    .then(() => {
      log.debug("boundary upload settled", {
        node: nodeId,
        surface: what,
        bytes,
        ms: round2(performance.now() - queued),
      });
    })
    .catch((error: unknown) => {
      log.error("queue fence rejected after upload", {
        node: nodeId,
        surface: what,
        error: String(error),
      });
    });
}

/** Push a planar `f32` surface back into an `rgba16float` texture. */
export function writeColorSurface(
  ctx: GpuContext,
  texture: GPUTexture,
  surface: CpuColorSurface,
  width: number,
  height: number,
  nodeId: string,
): BoundaryCrossing {
  ctx.assertUsable("writeColorSurface");
  const started = performance.now();

  const pixels = width * height;
  if (
    surface.r.length !== pixels ||
    surface.g.length !== pixels ||
    surface.b.length !== pixels ||
    surface.a.length !== pixels
  ) {
    throw new BoundaryError(
      `upload for ${nodeId}: planes are ${surface.r.length}/${surface.g.length}/${surface.b.length}/${surface.a.length} long, expected ${pixels}`,
    );
  }

  // queue.writeTexture takes its own data layout and has no 256-byte row
  // requirement — that applies to buffer-to-texture copies — so the staging
  // array is tightly packed.
  const interleaved = new Uint16Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    interleaved[at] = floatToHalf(surface.r[i] ?? 0);
    interleaved[at + 1] = floatToHalf(surface.g[i] ?? 0);
    interleaved[at + 2] = floatToHalf(surface.b[i] ?? 0);
    interleaved[at + 3] = floatToHalf(surface.a[i] ?? 0);
  }

  const bytes = pixels * COLOR_BYTES_PER_TEXEL;
  ctx.device.queue.writeTexture(
    { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
    interleaved,
    { offset: 0, bytesPerRow: width * COLOR_BYTES_PER_TEXEL, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );

  const crossing: BoundaryCrossing = {
    nodeId,
    direction: "upload",
    bytes,
    ms: round2(performance.now() - started),
  };
  log.info("boundary upload", {
    node: nodeId,
    surface: "color",
    width,
    height,
    bytes,
    ms: crossing.ms,
  });
  reportCompletion(ctx, "color", nodeId, bytes);
  return crossing;
}

/** Push a `u16` index map back into an `r32uint` texture. */
export function writeIndexSurface(
  ctx: GpuContext,
  texture: GPUTexture,
  indices: Uint16Array,
  width: number,
  height: number,
  nodeId: string,
): BoundaryCrossing {
  ctx.assertUsable("writeIndexSurface");
  const started = performance.now();

  const pixels = width * height;
  if (indices.length !== pixels) {
    throw new BoundaryError(
      `index upload for ${nodeId}: ${indices.length} entries, expected ${pixels}`,
    );
  }

  const widened = new Uint32Array(pixels);
  for (let i = 0; i < pixels; i += 1) widened[i] = indices[i] ?? 0;

  const bytes = pixels * INDEX_BYTES_PER_TEXEL;
  ctx.device.queue.writeTexture(
    { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
    widened,
    { offset: 0, bytesPerRow: width * INDEX_BYTES_PER_TEXEL, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );

  const crossing: BoundaryCrossing = {
    nodeId,
    direction: "upload",
    bytes,
    ms: round2(performance.now() - started),
  };
  log.info("boundary upload", {
    node: nodeId,
    surface: "index",
    width,
    height,
    bytes,
    ms: crossing.ms,
  });
  reportCompletion(ctx, "index", nodeId, bytes);
  return crossing;
}
