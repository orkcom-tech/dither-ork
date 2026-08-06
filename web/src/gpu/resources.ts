/**
 * Textures and buffers for the working format.
 *
 * Two things drive everything here.
 *
 * **The working format is fixed.** Colour is `rgba16float` in linear light —
 * eight bits cannot survive a dozen nodes without banding in the shadows, and
 * thirty-two doubles the bandwidth for precision nothing downstream can see.
 * After a quantizing node the pipeline carries an `r32uint` **index map**
 * alongside it; that pairing is what makes outline, dilate/erode, hue-targeted
 * recolour and the tracer lossless and cheap (docs/ARCHITECTURE.md, "Data
 * layout"). `r32uint` rather than `r16uint` because WebGPU has no 16-bit single
 * channel storage format — the wasted width is bought to keep the map
 * addressable from a compute pass.
 *
 * **Nothing is allocated per frame.** A slider drag re-runs the whole stack many
 * times a second; creating and destroying textures at that rate is how a
 * renderer ends up spending its time in the allocator. Textures come from a
 * pool keyed by shape, uniform and scratch buffers are kept per node, and
 * read-only tables are uploaded once when the pipeline is compiled.
 */

import type { ColorMetric, Palette } from "../types/document";
import type { ScratchSize } from "../types/gpu";
import { logger } from "../lib/log";
import type { GpuContext } from "./device";

const log = logger("gpu");

/** The only two texture formats the pipeline carries between nodes. */
export type SurfaceFormat = "rgba16float" | "r32uint";

const BYTES_PER_TEXEL: Readonly<Record<SurfaceFormat, number>> = {
  rgba16float: 8,
  r32uint: 4,
};

export function bytesPerTexel(format: SurfaceFormat): number {
  return BYTES_PER_TEXEL[format];
}

/**
 * Every working texture carries the same usage set.
 *
 * Varying usage per texture would fragment the pool into shapes that cannot be
 * reused for each other, which costs more memory than the extra usage flags do.
 * `COPY_SRC`/`COPY_DST` are always present because any node may turn out to be
 * the one before a serial WASM kernel, and that is decided by the document, not
 * at allocation time.
 */
const SURFACE_USAGE =
  GPUTextureUsage.TEXTURE_BINDING |
  GPUTextureUsage.STORAGE_BINDING |
  GPUTextureUsage.COPY_SRC |
  GPUTextureUsage.COPY_DST;

export class GpuResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuResourceError";
  }
}

export interface TexturePoolStats {
  readonly live: number;
  readonly idle: number;
  readonly residentBytes: number;
  readonly created: number;
  readonly reused: number;
}

function shapeKey(format: SurfaceFormat, width: number, height: number): string {
  return `${format}:${width}x${height}`;
}

/**
 * Pool of working textures, keyed by exact shape.
 *
 * Exact shape rather than "big enough": a compute pass writes with
 * `textureStore` at integer coordinates and reads its extent from the uniform
 * block, so an oversized texture would leave a border of stale pixels from a
 * previous node — visible, intermittent, and hard to attribute.
 */
export class TexturePool {
  readonly #ctx: GpuContext;
  readonly #idle = new Map<string, GPUTexture[]>();
  readonly #shapes = new Map<GPUTexture, string>();
  #live = 0;
  #idleCount = 0;
  #residentBytes = 0;
  #created = 0;
  #reused = 0;

  constructor(ctx: GpuContext) {
    this.#ctx = ctx;
  }

  acquire(
    format: SurfaceFormat,
    width: number,
    height: number,
    label: string,
  ): GPUTexture {
    this.#ctx.assertUsable("TexturePool.acquire");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new GpuResourceError(`texture ${label}: ${width}x${height} is not a valid size`);
    }
    const max = this.#ctx.limits.maxTextureDimension2D;
    if (width > max || height > max) {
      throw new GpuResourceError(
        `texture ${label}: ${width}x${height} exceeds maxTextureDimension2D ${max}`,
      );
    }

    const key = shapeKey(format, width, height);
    const free = this.#idle.get(key);
    const recycled = free?.pop();
    if (recycled !== undefined) {
      this.#idleCount -= 1;
      this.#live += 1;
      this.#reused += 1;
      log.debug("texture reused", { label, shape: key });
      return recycled;
    }

    const texture = this.#ctx.device.createTexture({
      label,
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: SURFACE_USAGE,
      dimension: "2d",
    });
    this.#shapes.set(texture, key);
    this.#live += 1;
    this.#created += 1;
    this.#residentBytes += width * height * BYTES_PER_TEXEL[format];
    log.debug("texture created", {
      label,
      shape: key,
      residentBytes: this.#residentBytes,
    });
    return texture;
  }

  /** Return a texture to the pool. Double release is an error, not a no-op. */
  release(texture: GPUTexture): void {
    const key = this.#shapes.get(texture);
    if (key === undefined) {
      log.error("released a texture this pool does not own", { label: texture.label });
      throw new GpuResourceError(
        `texture ${texture.label} was not allocated by this pool`,
      );
    }
    const free = this.#idle.get(key);
    if (free === undefined) {
      this.#idle.set(key, [texture]);
    } else {
      if (free.includes(texture)) {
        log.error("texture released twice", { label: texture.label, shape: key });
        throw new GpuResourceError(`texture ${texture.label} released twice`);
      }
      free.push(texture);
    }
    this.#live -= 1;
    this.#idleCount += 1;
  }

  stats(): TexturePoolStats {
    return {
      live: this.#live,
      idle: this.#idleCount,
      residentBytes: this.#residentBytes,
      created: this.#created,
      reused: this.#reused,
    };
  }

  destroy(): void {
    for (const texture of this.#shapes.keys()) texture.destroy();
    log.info("texture pool destroyed", { ...this.stats() });
    this.#shapes.clear();
    this.#idle.clear();
    this.#live = 0;
    this.#idleCount = 0;
    this.#residentBytes = 0;
  }
}

/**
 * Ping-pong for a chain of passes over one surface.
 *
 * The obvious alternative — letting a `pointwise` pass read and write the same
 * texture, which `PassAccess` explicitly permits — is not reachable in WebGPU:
 * binding one texture as both `texture_2d<f32>` and a writable
 * `texture_storage_2d` inside a single dispatch violates the usage-scope rules,
 * and `rgba16float` has no read-write storage access (only `r32uint`,
 * `r32sint` and `r32float` do). So a chain of N passes ping-pongs, and the
 * latitude in the descriptor is spent elsewhere — fusing consecutive pointwise
 * passes into one shader is the way to take it, and that is a later step.
 *
 * The texture the chain starts from is **not** owned. It is a cached node
 * output, and writing over it would corrupt the cache for every downstream
 * frame that still expects it.
 */
export class SurfaceChain {
  readonly #pool: TexturePool;
  readonly #format: SurfaceFormat;
  readonly #width: number;
  readonly #height: number;
  readonly #label: string;
  readonly #owned: GPUTexture[] = [];
  #current: GPUTexture | null;
  #spare: GPUTexture | null = null;

  /**
   * `initial` is `null` for a surface nothing has produced yet — the index map
   * before the first quantizing node. Reading such a chain is an error naming
   * the chain rather than a texture full of whatever was in that memory, which
   * for an index map means every pixel claiming palette entry 0.
   */
  constructor(
    pool: TexturePool,
    format: SurfaceFormat,
    initial: GPUTexture | null,
    width: number,
    height: number,
    label: string,
  ) {
    this.#pool = pool;
    this.#format = format;
    this.#current = initial;
    this.#width = width;
    this.#height = height;
    this.#label = label;
  }

  /** Whether anything has written to this chain yet. */
  get hasContent(): boolean {
    return this.#current !== null;
  }

  /** The texture holding live content — what the next pass reads. */
  get current(): GPUTexture {
    const current = this.#current;
    if (current === null) {
      log.error("read from an empty surface chain", { chain: this.#label });
      throw new GpuResourceError(
        `surface chain ${this.#label} has no content yet; nothing upstream has written it`,
      );
    }
    return current;
  }

  /** A write target guaranteed distinct from {@link current}. */
  target(): GPUTexture {
    const spare = this.#spare;
    if (spare !== null) {
      this.#spare = null;
      return spare;
    }
    const texture = this.#pool.acquire(
      this.#format,
      this.#width,
      this.#height,
      `${this.#label}/pong`,
    );
    this.#owned.push(texture);
    return texture;
  }

  /**
   * Promote a written texture to current. The displaced one becomes the spare
   * if this chain owns it, which is what keeps a chain of any length down to
   * two allocations.
   */
  commit(written: GPUTexture): void {
    const previous = this.#current;
    this.#current = written;
    if (previous !== null && this.#owned.includes(previous)) {
      this.#spare = previous;
    }
  }

  /** Hand every texture this chain allocated back to the pool. */
  release(): void {
    for (const texture of this.#owned) {
      // The one still holding the result is the caller's to keep until they are
      // done with it; releasing it here would let the next node overwrite it.
      if (texture !== this.#current) this.#pool.release(texture);
    }
    this.#owned.length = 0;
    this.#spare = null;
  }
}

// --- buffers ------------------------------------------------------------

/** Bytes a scratch binding needs at a given working resolution. */
export function scratchBytes(size: ScratchSize, width: number, height: number): number {
  const raw =
    size.kind === "fixed"
      ? size.bytes
      : size.kind === "per-pixel"
        ? size.bytesPerPixel * width * height
        : size.bytesPerRow * height;
  // Storage buffer bindings are 4-byte addressed; rounding up here rather than
  // at every call site keeps the size the shader sees and the size we allocate
  // the same number.
  return Math.ceil(raw / 4) * 4;
}

interface CachedBuffer {
  readonly buffer: GPUBuffer;
  readonly sizeBytes: number;
}

/**
 * Long-lived buffers, keyed by what they belong to rather than by shape.
 *
 * A uniform buffer is rewritten every frame with `queue.writeBuffer` and never
 * reallocated; that is the difference between a slider drag that stays live and
 * one that stutters. Growth reallocates and says so.
 */
export class BufferCache {
  readonly #ctx: GpuContext;
  readonly #buffers = new Map<string, CachedBuffer>();
  readonly #tables = new Map<Uint8Array, GPUBuffer>();
  #uploadedTableBytes = 0;

  constructor(ctx: GpuContext) {
    this.#ctx = ctx;
  }

  #ensure(key: string, sizeBytes: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
    const existing = this.#buffers.get(key);
    if (existing !== undefined && existing.sizeBytes >= sizeBytes) return existing.buffer;
    if (existing !== undefined) {
      log.debug("buffer grown", { label, from: existing.sizeBytes, to: sizeBytes });
      existing.buffer.destroy();
    }
    const buffer = this.#ctx.device.createBuffer({ label, size: sizeBytes, usage });
    this.#buffers.set(key, { buffer, sizeBytes });
    log.debug("buffer created", { label, bytes: sizeBytes });
    return buffer;
  }

  /** One uniform buffer per (node, pass), rewritten in place every frame. */
  uniform(key: string, sizeBytes: number): GPUBuffer {
    this.#ctx.assertUsable("BufferCache.uniform");
    const max = this.#ctx.limits.maxUniformBufferBindingSize;
    if (sizeBytes > max) {
      throw new GpuResourceError(
        `uniform block for ${key} is ${sizeBytes} bytes, over the ${max}-byte limit`,
      );
    }
    return this.#ensure(
      `uniform:${key}`,
      sizeBytes,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      `uniform ${key}`,
    );
  }

  /**
   * Working storage, keyed by `slot` so successive passes of one effect share
   * it — a histogram written by pass 0 and read by pass 1 is one buffer.
   */
  scratch(key: string, sizeBytes: number): GPUBuffer {
    this.#ctx.assertUsable("BufferCache.scratch");
    const max = this.#ctx.limits.maxStorageBufferBindingSize;
    if (sizeBytes > max) {
      throw new GpuResourceError(
        `scratch buffer ${key} is ${sizeBytes} bytes, over the ${max}-byte limit`,
      );
    }
    return this.#ensure(
      `scratch:${key}`,
      sizeBytes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      `scratch ${key}`,
    );
  }

  /**
   * A read-only table the effect ships — a threshold matrix, a glyph sheet.
   *
   * Keyed on the array itself, not on a hash of its contents: two blue-noise
   * tiles generated from different seeds are different data behind the same
   * effect id, and a content hash would have to be recomputed to tell them
   * apart. Identity is exact and free.
   */
  table(data: Uint8Array, label: string): GPUBuffer {
    this.#ctx.assertUsable("BufferCache.table");
    const cached = this.#tables.get(data);
    if (cached !== undefined) return cached;

    if (data.byteLength === 0) {
      throw new GpuResourceError(`table ${label} is empty`);
    }
    if (data.byteLength % 4 !== 0) {
      // Tables are typed data read as u32/vec4 in WGSL. Padding to a multiple
      // of four would change what `arrayLength` reports, so a misaligned table
      // is a mistake at the source rather than something to paper over.
      throw new GpuResourceError(
        `table ${label} is ${data.byteLength} bytes, which is not a multiple of 4`,
      );
    }

    const buffer = this.#ctx.device.createBuffer({
      label: `table ${label}`,
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const started = performance.now();
    // Copied into a buffer this function owns. A table generated in Rust is a
    // view into WASM linear memory, which is a SharedArrayBuffer once the
    // thread pool is on, and `writeBuffer` does not take a view over shared
    // memory. The copy is one-time at compile and tables are small.
    this.#ctx.device.queue.writeBuffer(buffer, 0, new Uint8Array(data));
    this.#tables.set(data, buffer);
    this.#uploadedTableBytes += data.byteLength;
    // Table uploads are a GPU/CPU crossing like any other, but a one-off at
    // compile time rather than a per-frame cost. Logged at the same level so
    // the console shows the whole picture.
    log.info("table uploaded", {
      label,
      bytes: data.byteLength,
      ms: Math.round((performance.now() - started) * 100) / 100,
      totalTableBytes: this.#uploadedTableBytes,
    });
    return buffer;
  }

  destroy(): void {
    for (const entry of this.#buffers.values()) entry.buffer.destroy();
    for (const buffer of this.#tables.values()) buffer.destroy();
    log.info("buffer cache destroyed", {
      buffers: this.#buffers.size,
      tables: this.#tables.size,
    });
    this.#buffers.clear();
    this.#tables.clear();
    this.#uploadedTableBytes = 0;
  }
}

// --- palette ------------------------------------------------------------

/**
 * Metric ordinals as the shaders read them.
 *
 * The metric travels inside the palette buffer rather than in the uniform
 * block, because it is a property of the palette (`Palette.metric`) and not of
 * the node. That keeps it out of every effect's uniform layout and means a
 * palette swap cannot leave a stale metric behind.
 */
export const PALETTE_METRIC_OKLAB = 0;
export const PALETTE_METRIC_SRGB = 1;

/** `count`, `metric`, and two words of padding before an array of 16-byte-aligned entries. */
const PALETTE_HEADER_BYTES = 16;
/** `linear: vec4f` then `match: vec4f`. */
const PALETTE_ENTRY_BYTES = 32;

export interface GpuPalette {
  readonly buffer: GPUBuffer;
  readonly count: number;
  readonly metric: ColorMetric;
  readonly bytes: number;
}

/** sRGB electro-optical transfer function. Matches `core/.../color.rs` exactly. */
export function srgbToLinear(c: number): number {
  return c <= 0.040448237 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Inverse of {@link srgbToLinear}. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Linear-light sRGB primaries to OKLab. Coefficients match `color.rs`; they
 * have to, or the CPU and GPU halves of the same stack pick different palette
 * entries at the boundaries and the seam is visible.
 */
export function linearToOklab(
  r: number,
  g: number,
  b: number,
): readonly [number, number, number] {
  const l = 0.41222146 * r + 0.53633255 * g + 0.051445995 * b;
  const m = 0.2119035 * r + 0.6806995 * g + 0.10739696 * b;
  const s = 0.08830246 * r + 0.28171884 * g + 0.6299785 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.21045426 * l_ + 0.7936178 * m_ - 0.004072047 * s_,
    1.9779985 * l_ - 2.4285922 * m_ + 0.4505937 * s_,
    0.025904037 * l_ + 0.78277177 * m_ - 0.80867577 * s_,
  ];
}

/**
 * Upload a document palette in the form the shaders consume.
 *
 * Two coordinates per entry. `linear` is what gets written to the output
 * texture — the pipeline is linear light end to end. `match` is where distance
 * is measured, precomputed on the CPU so the shader converts only the *pixel*
 * per invocation instead of the pixel and every palette entry.
 */
export function uploadPalette(
  ctx: GpuContext,
  palette: Palette,
  cache: BufferCache,
  key: string,
): GpuPalette {
  ctx.assertUsable("uploadPalette");

  if (palette.colors.length === 0 || palette.colors.length % 3 !== 0) {
    throw new GpuResourceError(
      `palette ${palette.id} has ${palette.colors.length} components; expected a non-empty multiple of 3`,
    );
  }
  const count = palette.colors.length / 3;
  const bytes = PALETTE_HEADER_BYTES + count * PALETTE_ENTRY_BYTES;
  const buffer = cache.scratch(`palette:${key}`, bytes);

  const staging = new ArrayBuffer(bytes);
  const view = new DataView(staging);
  view.setUint32(0, count, true);
  view.setUint32(
    4,
    palette.metric === "srgb" ? PALETTE_METRIC_SRGB : PALETTE_METRIC_OKLAB,
    true,
  );

  for (let i = 0; i < count; i += 1) {
    const r8 = palette.colors[i * 3];
    const g8 = palette.colors[i * 3 + 1];
    const b8 = palette.colors[i * 3 + 2];
    if (r8 === undefined || g8 === undefined || b8 === undefined) {
      throw new GpuResourceError(`palette ${palette.id}: entry ${i} is incomplete`);
    }
    const r = srgbToLinear(r8 / 255);
    const g = srgbToLinear(g8 / 255);
    const b = srgbToLinear(b8 / 255);

    const at = PALETTE_HEADER_BYTES + i * PALETTE_ENTRY_BYTES;
    view.setFloat32(at, r, true);
    view.setFloat32(at + 4, g, true);
    view.setFloat32(at + 8, b, true);
    view.setFloat32(at + 12, 1, true);

    // sRGB Euclidean is a look control, not a fallback: it reproduces what
    // period-accurate tools did by doing the maths in gamma space.
    const match =
      palette.metric === "srgb"
        ? ([r8 / 255, g8 / 255, b8 / 255] as const)
        : linearToOklab(r, g, b);
    view.setFloat32(at + 16, match[0], true);
    view.setFloat32(at + 20, match[1], true);
    view.setFloat32(at + 24, match[2], true);
    view.setFloat32(at + 28, 0, true);
  }

  const started = performance.now();
  ctx.device.queue.writeBuffer(buffer, 0, staging);
  log.info("palette uploaded", {
    palette: palette.id,
    count,
    metric: palette.metric,
    bytes,
    ms: Math.round((performance.now() - started) * 100) / 100,
  });

  return { buffer, count, metric: palette.metric, bytes };
}
