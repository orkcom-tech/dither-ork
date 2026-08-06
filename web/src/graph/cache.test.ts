/**
 * The node output cache.
 *
 * Two properties are load-bearing and neither is visible from the outside once
 * it goes wrong: the byte budget is actually respected, and the entry that gets
 * dropped is the one worth least. Get the first wrong and a tab dies at export
 * resolution; get the second wrong and the cache technically works while the
 * preview re-runs the whole stack on every drag.
 *
 * `SurfaceOwner` is supplied here as a recorder rather than a real releaser.
 * That is not a stand-in for the code under test — it is the injection point the
 * cache is built around, because a GPU texture and a WASM allocation are freed
 * differently and neither is the graph's business. Recording what it was handed
 * is the only way to assert the ownership rule the module's comment states: the
 * cache is the one thing that frees a buffer, and it frees each one once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Palette } from "../types/document";
import type { ContentHash, FrameBuffer, NodeCacheEntry } from "../types/graph";
import { logger, setLevel } from "../lib/log";
import { NodeCache, frameBufferBytes, type SurfaceOwner } from "./cache";
import { GraphError } from "./errors";

setLevel("error");

// Constructing a `GraphError` logs it, deliberately. Several tests here provoke
// one, so the console is silenced rather than the logger: what is under test is
// that the throw happens.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const log = logger("graph");

const PALETTE: Palette = {
  id: "dmg",
  name: "Game Boy DMG",
  colors: [15, 56, 15, 48, 98, 48, 139, 172, 15, 155, 188, 15],
  metric: "oklab",
};

/** Records what the cache released, so double frees and leaks are both visible. */
class Surfaces implements SurfaceOwner {
  readonly released: FrameBuffer[] = [];

  release(buffer: FrameBuffer): void {
    this.released.push(buffer);
  }
}

/**
 * A real CPU-resident buffer of `pixels` texels.
 *
 * Planar `f32` throughout, so the byte count is exactly what the cache will
 * charge: four channels times four bytes, plus two more per texel when indexed.
 */
function cpuBuffer(hash: string, pixels: number, indexed = false): FrameBuffer {
  return {
    width: pixels,
    height: 1,
    color: {
      residency: "cpu",
      r: new Float32Array(pixels),
      g: new Float32Array(pixels),
      b: new Float32Array(pixels),
      a: new Float32Array(pixels),
    },
    quantization: indexed
      ? {
          kind: "indexed",
          indices: { residency: "cpu", data: new Uint16Array(pixels) },
          palette: PALETTE,
        }
      : { kind: "continuous" },
    hash: hash as ContentHash,
  };
}

const KIB = 1024;

/** Exactly one kibibyte: 64 texels at 16 bytes each. */
function oneKiB(hash: string): FrameBuffer {
  return cpuBuffer(hash, 64);
}

function cache(maxBytes: number, surfaces: SurfaceOwner): NodeCache {
  return new NodeCache({ budget: { maxBytes }, surfaces, log });
}

const h = (name: string): ContentHash => name as ContentHash;

describe("frameBufferBytes", () => {
  it("counts every colour plane", () => {
    // 64 texels, four planar f32 channels.
    expect(frameBufferBytes(cpuBuffer("a", 64))).toBe(64 * 4 * 4);
  });

  it("adds the index map when the buffer is quantized", () => {
    // One u16 index per texel on top of the colour. Carrying both is the
    // deliberate memory cost that makes recolour and outline lossless.
    expect(frameBufferBytes(cpuBuffer("a", 64, true))).toBe(64 * 4 * 4 + 64 * 2);
  });

  it("does not charge for the palette carried beside the index map", () => {
    // The budget is about pixel buffers; a palette is a few dozen numbers.
    const base = cpuBuffer("a", 64, true);
    const withWidePalette: FrameBuffer = {
      ...base,
      quantization: {
        kind: "indexed",
        indices: { residency: "cpu", data: new Uint16Array(64) },
        palette: { ...PALETTE, colors: new Array<number>(768).fill(7) },
      },
    };
    expect(frameBufferBytes(withWidePalette)).toBe(frameBufferBytes(base));
  });

  it("counts a smaller buffer as smaller", () => {
    // A detail-crush node emits below the working resolution. Charging it the
    // full size would make the budget a fiction in the case the aesthetic
    // reaches for most.
    expect(frameBufferBytes(cpuBuffer("a", 16))).toBeLessThan(
      frameBufferBytes(cpuBuffer("b", 64)),
    );
  });
});

describe("NodeCache budget", () => {
  it("refuses a budget that cannot hold anything", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        cache(bad, new Surfaces());
        expect.unreachable(`budget ${bad} must be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(GraphError);
        expect((error as GraphError).code).toBe("invalid-budget");
      }
    }
  });

  it("refuses a single buffer larger than the whole budget", () => {
    const surfaces = new Surfaces();
    const node = cache(1 * KIB, surfaces);
    try {
      node.offer(h("big"), cpuBuffer("big", 256), false);
      expect.unreachable("an oversized buffer must not be cached");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphError);
      expect((error as GraphError).code).toBe("buffer-exceeds-budget");
    }
    // Nothing was stored and nothing already resident was disturbed.
    expect(node.size).toBe(0);
    expect(node.bytes).toBe(0);
  });

  it("never exceeds the budget", () => {
    const node = cache(4 * KIB, new Surfaces());
    for (let i = 0; i < 20; i += 1) {
      node.offer(h(`n${i}`), oneKiB(`n${i}`), false);
      expect(node.bytes).toBeLessThanOrEqual(4 * KIB);
    }
    expect(node.size).toBe(4);
    expect(node.bytes).toBe(4 * KIB);
  });

  it("evicts as many entries as one large buffer needs", () => {
    const surfaces = new Surfaces();
    const node = cache(4 * KIB, surfaces);
    for (const name of ["a", "b", "c", "d"]) node.offer(h(name), oneKiB(name), false);

    node.offer(h("big"), cpuBuffer("big", 128), false); // 2 KiB

    expect(surfaces.released.map((b) => b.hash)).toEqual(["a", "b"]);
    expect(node.has(h("c"))).toBe(true);
    expect(node.has(h("d"))).toBe(true);
    expect(node.bytes).toBe(4 * KIB);
  });
});

describe("NodeCache storage", () => {
  it("returns what it was given and counts hits and misses", () => {
    const node = cache(4 * KIB, new Surfaces());
    const buffer = oneKiB("a");

    expect(node.get(h("a"))).toBeUndefined();
    expect(node.offer(h("a"), buffer, false)).toBe(buffer);
    expect(node.get(h("a"))).toBe(buffer);

    const stats = node.stats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(KIB);
    expect(stats.maxBytes).toBe(4 * KIB);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.evictions).toBe(0);
  });

  it("converges two identical nodes onto one buffer", () => {
    // Two identical nodes in different branches are legal under F-ST-07 and
    // produce byte-identical output under one hash. Keeping both would charge
    // the budget twice for one image, so the second is released and the first
    // returned — which is why the caller must use the return value.
    const surfaces = new Surfaces();
    const node = cache(4 * KIB, surfaces);
    const first = oneKiB("a");
    const second = oneKiB("a");

    expect(node.offer(h("a"), first, false)).toBe(first);
    expect(node.offer(h("a"), second, false)).toBe(first);

    expect(surfaces.released).toEqual([second]);
    expect(node.size).toBe(1);
    expect(node.bytes).toBe(KIB);
  });
});

describe("NodeCache eviction order", () => {
  it("evicts least-recently-used first", () => {
    const surfaces = new Surfaces();
    const node = cache(2 * KIB, surfaces);
    node.offer(h("a"), oneKiB("a"), false);
    node.offer(h("b"), oneKiB("b"), false);
    node.offer(h("c"), oneKiB("c"), false);

    expect(surfaces.released.map((b) => b.hash)).toEqual(["a"]);
    expect(node.has(h("a"))).toBe(false);
    expect(node.stats().evictions).toBe(1);
  });

  it("counts a read as a use", () => {
    const surfaces = new Surfaces();
    const node = cache(2 * KIB, surfaces);
    node.offer(h("a"), oneKiB("a"), false);
    node.offer(h("b"), oneKiB("b"), false);

    node.get(h("a"));
    node.offer(h("c"), oneKiB("c"), false);

    expect(surfaces.released.map((b) => b.hash)).toEqual(["b"]);
  });

  it("does not count a residency probe as a use", () => {
    // The planner asks `has` about every node in the graph. If that counted,
    // planning alone would reorder the LRU and evict the wrong thing.
    const surfaces = new Surfaces();
    const node = cache(2 * KIB, surfaces);
    node.offer(h("a"), oneKiB("a"), false);
    node.offer(h("b"), oneKiB("b"), false);

    node.has(h("a"));
    node.offer(h("c"), oneKiB("c"), false);

    expect(surfaces.released.map((b) => b.hash)).toEqual(["a"]);
  });

  it("evicts transient entries before resident ones, however recent", () => {
    // An animated export produces a full set of intermediates per frame and asks
    // for none of them again. Marking them transient keeps them from pushing the
    // frame-invariant prefix out of the budget.
    const surfaces = new Surfaces();
    const node = cache(2 * KIB, surfaces);
    node.offer(h("keep"), oneKiB("keep"), false);
    node.offer(h("frame"), oneKiB("frame"), true);

    node.offer(h("next"), oneKiB("next"), false);

    expect(surfaces.released.map((b) => b.hash)).toEqual(["frame"]);
    expect(node.has(h("keep"))).toBe(true);
  });

  it("evicts the least recently used transient before an older one is refreshed", () => {
    const surfaces = new Surfaces();
    const node = cache(2 * KIB, surfaces);
    node.offer(h("t1"), oneKiB("t1"), true);
    node.offer(h("t2"), oneKiB("t2"), true);
    node.get(h("t1"));

    node.offer(h("t3"), oneKiB("t3"), true);

    expect(surfaces.released.map((b) => b.hash)).toEqual(["t2"]);
  });
});

describe("NodeCache pinning", () => {
  it("never evicts a pinned entry", () => {
    const surfaces = new Surfaces();
    const node = cache(2 * KIB, surfaces);
    node.offer(h("a"), oneKiB("a"), false);
    node.offer(h("b"), oneKiB("b"), false);
    node.pin(h("a"));

    node.offer(h("c"), oneKiB("c"), false);

    // `a` is older but pinned by the render in flight, so `b` goes instead.
    expect(surfaces.released.map((b) => b.hash)).toEqual(["b"]);
    expect(node.has(h("a"))).toBe(true);
    expect(node.isPinned(h("a"))).toBe(true);
  });

  it("refcounts pins", () => {
    // A buffer can be pinned as an animation invariant and as a live input at
    // once; the first unpin must not release it.
    const surfaces = new Surfaces();
    const node = cache(2 * KIB, surfaces);
    node.offer(h("a"), oneKiB("a"), false);
    node.pin(h("a"));
    node.pin(h("a"));
    expect(node.stats().pinned).toBe(1);

    node.unpin(h("a"));
    expect(node.isPinned(h("a"))).toBe(true);
    node.unpin(h("a"));
    expect(node.isPinned(h("a"))).toBe(false);
  });

  it("reports pinning a hash it does not hold", () => {
    const node = cache(2 * KIB, new Surfaces());
    try {
      node.pin(h("absent"));
      expect.unreachable("pinning a non-resident hash must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphError);
      expect((error as GraphError).code).toBe("invariant");
    }
  });

  it("reports unpinning something that was never pinned", () => {
    const node = cache(2 * KIB, new Surfaces());
    node.offer(h("a"), oneKiB("a"), false);
    expect(() => node.unpin(h("a"))).toThrowError(GraphError);
  });

  it("names the numbers when everything resident is pinned", () => {
    // The out-of-memory crash the architecture forbids, caught and named: the
    // stack is too long or the resolution too high for this budget.
    const node = cache(2 * KIB, new Surfaces());
    node.offer(h("a"), oneKiB("a"), false);
    node.pin(h("a"));
    node.offer(h("b"), oneKiB("b"), false);
    node.pin(h("b"));

    try {
      node.offer(h("c"), oneKiB("c"), false);
      expect.unreachable("a fully pinned cache cannot make room");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphError);
      expect((error as GraphError).code).toBe("pinned-over-budget");
      expect((error as GraphError).detail["pinnedBytes"]).toBe(2 * KIB);
      expect((error as GraphError).detail["needed"]).toBe(KIB);
    }
  });
});

describe("NodeCache invalidation", () => {
  it("drops everything outside the live set", () => {
    const surfaces = new Surfaces();
    const node = cache(8 * KIB, surfaces);
    for (const name of ["a", "b", "c"]) node.offer(h(name), oneKiB(name), false);

    node.retain([h("b")]);

    expect(node.has(h("b"))).toBe(true);
    expect(node.size).toBe(1);
    expect(node.bytes).toBe(KIB);
    expect(surfaces.released.map((b) => b.hash).sort()).toEqual(["a", "c"]);
  });

  it("keeps a pinned entry even when it is not live", () => {
    const surfaces = new Surfaces();
    const node = cache(8 * KIB, surfaces);
    node.offer(h("a"), oneKiB("a"), false);
    node.pin(h("a"));

    node.retain([]);

    expect(node.has(h("a"))).toBe(true);
    expect(surfaces.released).toEqual([]);
  });

  it("releases everything on clear", () => {
    const surfaces = new Surfaces();
    const node = cache(8 * KIB, surfaces);
    for (const name of ["a", "b"]) node.offer(h(name), oneKiB(name), false);

    node.clear();

    expect(node.size).toBe(0);
    expect(node.bytes).toBe(0);
    expect(surfaces.released).toHaveLength(2);
  });

  it("refuses to clear while something is pinned", () => {
    // A pinned entry at clear time is a leak in the caller, not a state to
    // absorb quietly.
    const surfaces = new Surfaces();
    const node = cache(8 * KIB, surfaces);
    node.offer(h("a"), oneKiB("a"), false);
    node.pin(h("a"));

    expect(() => node.clear()).toThrowError(GraphError);
    expect(node.has(h("a"))).toBe(true);
    expect(surfaces.released).toEqual([]);
  });
});

describe("NodeCache diagnostics", () => {
  it("snapshots every resident entry with its size and last use", () => {
    const node = cache(8 * KIB, new Surfaces());
    node.offer(h("a"), oneKiB("a"), false);
    node.offer(h("b"), oneKiB("b"), false);

    const snapshot = node.snapshot();
    expect(snapshot.map((entry) => entry.hash).sort()).toEqual(["a", "b"]);
    expect(snapshot.every((entry) => entry.bytes === KIB)).toBe(true);

    // Monotonic ticks, not clock readings — an LRU that read a wall clock would
    // make eviction order depend on how long the user paused between edits.
    const ticks = snapshot.map((entry) => entry.lastUsed);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks.every((tick) => Number.isInteger(tick))).toBe(true);
  });

  it("hands out a snapshot that cannot be used to mutate the cache", () => {
    const node = cache(8 * KIB, new Surfaces());
    node.offer(h("a"), oneKiB("a"), false);

    const snapshot = node.snapshot() as NodeCacheEntry[];
    snapshot.length = 0;

    expect(node.size).toBe(1);
    expect(node.snapshot()).toHaveLength(1);
  });
});
