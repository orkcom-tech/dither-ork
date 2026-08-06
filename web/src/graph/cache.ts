/**
 * The node output cache.
 *
 * Keyed on content hash, with an explicit byte budget and LRU eviction. The
 * architecture is emphatic about why: float buffers plus index maps plus a
 * cache at export resolution will exhaust memory if left alone, and the
 * failure mode that has to be avoided is a browser tab dying rather than a
 * logged eviction.
 *
 * **Ownership.** Everything offered here belongs to the cache from that moment
 * on, and the cache is the only thing that frees it — through the `release`
 * callback the owner supplies, since a GPU texture and a WASM allocation are
 * freed differently and neither is the graph's business. The renderer never
 * releases a buffer it put in; it pins one it is still reading and unpins it
 * when the last consumer has run. That single rule is what keeps a long stack
 * at export resolution from evicting a buffer that a later node in the same
 * render is about to read.
 *
 * **Failure is loud.** Two situations cannot be worked around and are thrown
 * rather than absorbed: a single buffer bigger than the whole budget, and a set
 * of pinned buffers that does not fit. Both mean the budget is wrong for the
 * resolution, both are actionable, and both are far better as a message naming
 * the numbers than as an allocation failure somewhere else.
 */

import type {
  CacheEviction,
  ContentHash,
  FrameBuffer,
  NodeCacheBudget,
  NodeCacheEntry,
} from "../types/graph";
import type { Logger } from "../lib/log";
import { GraphError, expect } from "./errors";

/** `rgba16float`: four channels, two bytes each. */
const RGBA16F_BYTES_PER_TEXEL = 8;

/**
 * `r32uint`: four bytes per texel for a value that needs two. WebGPU has no
 * `r16uint` storage format, so the width is memory bought to keep the index map
 * addressable from a compute pass — see the note on `GpuIndexSurface`.
 */
const R32UINT_BYTES_PER_TEXEL = 4;

/**
 * Resident bytes of one frame buffer.
 *
 * Counted from the surfaces themselves rather than from the nominal width and
 * height, because a buffer produced by the detail-crush node is smaller than
 * the graph's working resolution and charging it the full size would make the
 * budget a fiction in exactly the case the aesthetic reaches for most.
 *
 * The palette carried alongside an index map is a few dozen numbers and is not
 * counted; this budget is about pixel buffers.
 */
export function frameBufferBytes(buffer: FrameBuffer): number {
  let bytes = 0;

  const color = buffer.color;
  if (color.residency === "gpu") {
    bytes += color.texture.width * color.texture.height * RGBA16F_BYTES_PER_TEXEL;
  } else {
    bytes +=
      color.r.byteLength + color.g.byteLength + color.b.byteLength + color.a.byteLength;
  }

  if (buffer.quantization.kind === "indexed") {
    const indices = buffer.quantization.indices;
    if (indices.residency === "gpu") {
      bytes += indices.texture.width * indices.texture.height * R32UINT_BYTES_PER_TEXEL;
    } else {
      bytes += indices.data.byteLength;
    }
  }

  return bytes;
}

/** Frees the GPU texture or WASM allocation behind a buffer. */
export interface SurfaceOwner {
  /** Called exactly once per buffer, by whoever owns it at the time. */
  release(buffer: FrameBuffer): void;
}

interface Entry {
  readonly hash: ContentHash;
  readonly buffer: FrameBuffer;
  readonly bytes: number;
  /**
   * Monotonic tick, not a clock reading. Nothing inside the graph reads a wall
   * clock, and an LRU that did would make eviction order depend on how long the
   * user paused between edits.
   */
  lastUsed: number;
  /**
   * Evicted before anything else.
   *
   * An animated export produces a full set of intermediates per frame and asks
   * for none of them again; a preview session asks for every one of them on the
   * next parameter drag. Marking the export's intermediates transient keeps
   * them from pushing the frame-invariant prefix — the thing that makes an
   * N-frame export cheaper than N renders — out of the budget.
   */
  transient: boolean;
}

export interface NodeCacheOptions {
  readonly budget: NodeCacheBudget;
  readonly surfaces: SurfaceOwner;
  readonly log: Logger;
}

export interface NodeCacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly pinned: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

export class NodeCache {
  private readonly entries = new Map<ContentHash, Entry>();
  /** Refcounted: a buffer can be pinned as an animation invariant and as a live input at once. */
  private readonly pins = new Map<ContentHash, number>();
  private readonly maxBytes: number;
  private readonly surfaces: SurfaceOwner;
  private readonly log: Logger;

  private residentBytes = 0;
  private tick = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: NodeCacheOptions) {
    const maxBytes = options.budget.maxBytes;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new GraphError(
        "invalid-budget",
        `cache budget ${String(maxBytes)} is not a positive number of bytes`,
        { maxBytes: String(maxBytes) },
      );
    }
    this.maxBytes = maxBytes;
    this.surfaces = options.surfaces;
    this.log = options.log;
    this.log.info("cache ready", { maxBytes });
  }

  get bytes(): number {
    return this.residentBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): NodeCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.residentBytes,
      maxBytes: this.maxBytes,
      pinned: this.pins.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  /**
   * Whether a hash is resident, without touching its LRU position.
   *
   * The planner asks this about every node in the graph; if that counted as a
   * use, planning alone would reorder the LRU and evict the wrong thing.
   */
  has(hash: ContentHash): boolean {
    return this.entries.has(hash);
  }

  /** Read a buffer and mark it used. The cache keeps ownership. */
  get(hash: ContentHash): FrameBuffer | undefined {
    const entry = this.entries.get(hash);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.tick += 1;
    entry.lastUsed = this.tick;
    return entry.buffer;
  }

  /**
   * Hand a freshly produced buffer to the cache.
   *
   * Returns the buffer the cache now holds for that hash, which is not always
   * the one passed in: two identical nodes in different branches — legal under
   * F-ST-07 — produce byte-identical output under one hash, and keeping both
   * would charge the budget twice for one image. The second is released and the
   * first returned, so the caller must use the return value and not the
   * argument.
   */
  offer(hash: ContentHash, buffer: FrameBuffer, transient: boolean): FrameBuffer {
    const existing = this.entries.get(hash);
    if (existing !== undefined) {
      this.log.debug("cache converge", {
        hash,
        bytes: existing.bytes,
        reason: "an equal-content buffer was already resident",
      });
      this.surfaces.release(buffer);
      this.tick += 1;
      existing.lastUsed = this.tick;
      return existing.buffer;
    }

    const bytes = frameBufferBytes(buffer);
    if (bytes > this.maxBytes) {
      // Not cacheable at any LRU depth. Failing here names the two numbers that
      // have to change; the alternative is a cache that quietly holds nothing
      // and a preview that re-runs the whole stack on every keystroke.
      throw new GraphError(
        "buffer-exceeds-budget",
        `a single ${bytes} byte buffer does not fit the ${this.maxBytes} byte cache budget; lower the working resolution or raise the budget`,
        { hash, bytes, maxBytes: this.maxBytes },
      );
    }

    this.evictFor(bytes);

    this.tick += 1;
    this.entries.set(hash, { hash, buffer, bytes, lastUsed: this.tick, transient });
    this.residentBytes += bytes;
    this.log.debug("cache store", {
      hash,
      bytes,
      transient,
      resident: this.residentBytes,
      entries: this.entries.size,
    });
    return buffer;
  }

  /** Hold a buffer against eviction. Refcounted; pair with {@link unpin}. */
  pin(hash: ContentHash): void {
    expect(
      this.entries.get(hash),
      "invariant",
      `cannot pin ${hash}; it is not resident`,
      { hash },
    );
    this.pins.set(hash, (this.pins.get(hash) ?? 0) + 1);
  }

  unpin(hash: ContentHash): void {
    const count = expect(
      this.pins.get(hash),
      "invariant",
      `cannot unpin ${hash}; it is not pinned`,
      { hash },
    );
    if (count <= 1) this.pins.delete(hash);
    else this.pins.set(hash, count - 1);
  }

  isPinned(hash: ContentHash): boolean {
    return this.pins.has(hash);
  }

  /**
   * Drop everything not in `live`, as an upstream edit rather than as budget
   * pressure.
   *
   * Not called after every render on purpose. Unlimited undo (F-ST-04) means
   * the state the user just left is the state they are most likely to return
   * to, so stale entries earn their space until the budget actually needs it.
   * This exists for the moments where they cannot: closing a document, loading
   * another image, changing the working resolution.
   */
  retain(live: Iterable<ContentHash>): void {
    const keep = new Set<ContentHash>(live);
    for (const entry of [...this.entries.values()]) {
      if (keep.has(entry.hash)) continue;
      if (this.pins.has(entry.hash)) {
        this.log.warn("cache retain skipped a pinned entry", {
          hash: entry.hash,
          bytes: entry.bytes,
        });
        continue;
      }
      this.evict(entry, "invalidated");
    }
  }

  /** Release everything. Throws if anything is still pinned, which would be a leak in the caller. */
  clear(): void {
    if (this.pins.size > 0) {
      throw new GraphError(
        "invariant",
        `cannot clear the cache while ${this.pins.size} entr(ies) are pinned`,
        { pinned: this.pins.size },
      );
    }
    const entries = this.entries.size;
    const bytes = this.residentBytes;
    for (const entry of [...this.entries.values()]) {
      this.evict(entry, "invalidated");
    }
    this.log.info("cache cleared", { entries, bytes });
  }

  /**
   * Make room for `bytes`, transient entries first and least-recently-used
   * within each class.
   *
   * The scan is linear per eviction. A cache holding a few dozen node outputs
   * makes that cheaper than the bookkeeping an intrusive LRU list would need,
   * and eviction is not on the path of a cache hit.
   */
  private evictFor(bytes: number): void {
    while (this.residentBytes + bytes > this.maxBytes) {
      const victim = this.leastValuable();
      if (victim === null) {
        // Everything left is pinned by the render in flight, so there is
        // nothing to give back. This is the out-of-memory crash the
        // architecture forbids, caught and named instead.
        const pinnedBytes = this.pinnedBytes();
        throw new GraphError(
          "pinned-over-budget",
          `${pinnedBytes} bytes are pinned by the render in flight and ${bytes} more are needed, against a ${this.maxBytes} byte budget; the stack is too long or the resolution too high for this budget`,
          { pinnedBytes, needed: bytes, maxBytes: this.maxBytes },
        );
      }
      this.evict(victim, "budget");
    }
  }

  private leastValuable(): Entry | null {
    let transientVictim: Entry | null = null;
    let victim: Entry | null = null;
    for (const entry of this.entries.values()) {
      if (this.pins.has(entry.hash)) continue;
      if (entry.transient) {
        if (transientVictim === null || entry.lastUsed < transientVictim.lastUsed) {
          transientVictim = entry;
        }
      } else if (victim === null || entry.lastUsed < victim.lastUsed) {
        victim = entry;
      }
    }
    return transientVictim ?? victim;
  }

  private pinnedBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (this.pins.has(entry.hash)) total += entry.bytes;
    }
    return total;
  }

  private evict(entry: Entry, reason: CacheEviction["reason"]): void {
    this.entries.delete(entry.hash);
    this.residentBytes -= entry.bytes;
    this.evictions += 1;
    const eviction: CacheEviction = {
      hash: entry.hash,
      bytes: entry.bytes,
      reason,
    };
    // Logged rather than silent: an eviction storm is the readable symptom of a
    // budget set too low, and it is invisible without this line.
    this.log.info("cache eviction", {
      ...eviction,
      transient: entry.transient,
      resident: this.residentBytes,
      maxBytes: this.maxBytes,
    });
    this.surfaces.release(entry.buffer);
  }

  /** Every resident entry, for diagnostics. Snapshot; mutating it does nothing. */
  snapshot(): readonly NodeCacheEntry[] {
    return [...this.entries.values()].map((entry) => ({
      hash: entry.hash,
      buffer: entry.buffer,
      bytes: entry.bytes,
      lastUsed: entry.lastUsed,
    }));
  }
}
