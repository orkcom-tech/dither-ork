/**
 * Content hashing.
 *
 * The cache, the earliest-changed-position re-render (F-ST-01) and the reuse of
 * unbound nodes across an animation are all consequences of one property: a
 * node's hash covers exactly what changes its pixels, and nothing else. Every
 * assertion here is about that property, because a hash that is subtly wrong
 * does not fail — it serves a stale image, and the graph has no way to notice.
 *
 * Two families of assertion, and the difference matters:
 *
 * - **Distinctness.** Anything that changes the output must change the hash.
 *   These catch a field dropped from the byte stream.
 * - **Stability.** Anything that does *not* change the output must not change
 *   the hash — object key order, `-0` versus `0`, an edit to an unrelated node.
 *   These catch a cache that is technically correct and useless, re-running the
 *   whole stack on every keystroke.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Palette, ParameterValue } from "../types/document";
import type {
  ContentHash,
  ContentHashInput,
  GraphNode,
  RenderGraph,
} from "../types/graph";
import type { EffectDescriptor } from "../types/registry";
import { setLevel } from "../lib/log";
import { PALETTE_PARAM_KEY, contentHash, hashBytes, paletteDigest } from "./hash";
import { GraphError } from "./errors";
import { prepareGraph } from "./plan";

setLevel("error");

// Constructing a `GraphError` logs it — deliberately, so no error path is
// silent. Several tests here provoke one on purpose, so the sink is silenced
// rather than the logger: the production behaviour under test is that the throw
// happens, not that the console stays clean.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const SOURCE_HASH = "source-image-hash" as ContentHash;

function baseInput(
  params: Readonly<Record<string, ParameterValue>> = {},
): ContentHashInput {
  return {
    effect: "bayer-4",
    params,
    seed: 7,
    opacity: 1,
    blend: "normal",
    inputs: [SOURCE_HASH],
    width: 640,
    height: 480,
  };
}

describe("contentHash", () => {
  it("is stable across repeated calls on equal input", () => {
    const first = contentHash(baseInput({ spread: 1, serpentine: true, mode: "rgb" }));
    const second = contentHash(baseInput({ spread: 1, serpentine: true, mode: "rgb" }));
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across parameter key insertion order", () => {
    // Equal sets built in opposite orders — which is exactly what happens when
    // one comes out of a `.dork` file and the other out of the properties panel.
    const ascending: Record<string, ParameterValue> = {};
    ascending["alpha"] = 1;
    ascending["beta"] = 2;
    ascending["gamma"] = 3;

    const descending: Record<string, ParameterValue> = {};
    descending["gamma"] = 3;
    descending["beta"] = 2;
    descending["alpha"] = 1;

    expect(contentHash(baseInput(ascending))).toBe(contentHash(baseInput(descending)));
  });

  it("sorts keys by code unit, not by locale", () => {
    // A locale-aware comparator puts "a" before "B"; code-unit order does not.
    // Either way both spellings of one set must agree with each other.
    expect(contentHash(baseInput({ B: 1, a: 2 }))).toBe(
      contentHash(baseInput({ a: 2, B: 1 })),
    );
  });

  it("changes when a parameter value changes", () => {
    expect(contentHash(baseInput({ spread: 1.0000001 }))).not.toBe(
      contentHash(baseInput({ spread: 1 })),
    );
  });

  it("changes when a parameter is renamed, added or removed", () => {
    const base = contentHash(baseInput({ spread: 1 }));
    expect(contentHash(baseInput({ spred: 1 }))).not.toBe(base);
    expect(contentHash(baseInput({ spread: 1, contrast: 1 }))).not.toBe(base);
    expect(contentHash(baseInput({}))).not.toBe(base);
  });

  it("distinguishes a string from the number that prints the same", () => {
    // Why the stream is tagged rather than JSON: once two values are in a
    // record, `JSON.stringify` cannot tell "1" from 1, so a numeric-looking enum
    // would collide with a float.
    expect(contentHash(baseInput({ mode: "1" }))).not.toBe(
      contentHash(baseInput({ mode: 1 })),
    );
    expect(contentHash(baseInput({ flag: true }))).not.toBe(
      contentHash(baseInput({ flag: "true" })),
    );
    expect(contentHash(baseInput({ flag: true }))).not.toBe(
      contentHash(baseInput({ flag: 1 })),
    );
  });

  it("collapses -0 onto 0", () => {
    // Same pixels, so it must be the same hash. IEEE-754 gives the two zeroes
    // different bits, which is why the writer special-cases zero.
    expect(contentHash(baseInput({ offsetX: -0 }))).toBe(
      contentHash(baseInput({ offsetX: 0 })),
    );
  });

  it("length-prefixes strings rather than delimiting them", () => {
    // Two sets whose concatenations are ambiguous under any separator scheme.
    expect(contentHash(baseInput({ ab: "c", d: "e" }))).not.toBe(
      contentHash(baseInput({ a: "bc", de: "" })),
    );
  });

  it("covers the effect id, seed, opacity, blend and resolution", () => {
    const params = { spread: 1 };
    const base = contentHash(baseInput(params));
    expect(contentHash({ ...baseInput(params), effect: "bayer-8" })).not.toBe(base);
    expect(contentHash({ ...baseInput(params), seed: 8 })).not.toBe(base);
    // Opacity and blend change the pixels the node emits; leaving either out
    // would let an opacity drag show a stale frame.
    expect(contentHash({ ...baseInput(params), opacity: 0.5 })).not.toBe(base);
    expect(contentHash({ ...baseInput(params), blend: "multiply" })).not.toBe(base);
    expect(contentHash({ ...baseInput(params), width: 641 })).not.toBe(base);
    expect(contentHash({ ...baseInput(params), height: 481 })).not.toBe(base);
  });

  it("covers the input hashes, in order and in number", () => {
    const a = "aaa" as ContentHash;
    const b = "bbb" as ContentHash;
    const base = contentHash({ ...baseInput(), inputs: [a] });
    expect(contentHash({ ...baseInput(), inputs: [b] })).not.toBe(base);
    expect(contentHash({ ...baseInput(), inputs: [a, b] })).not.toBe(base);
    // `in` then `mask` is a fixed order, so swapping them is a different graph.
    expect(contentHash({ ...baseInput(), inputs: [a, b] })).not.toBe(
      contentHash({ ...baseInput(), inputs: [b, a] }),
    );
    // The count is written before the elements, so one input named "ab" cannot
    // be confused with two named "a" and "b".
    expect(contentHash({ ...baseInput(), inputs: ["ab" as ContentHash] })).not.toBe(
      contentHash({
        ...baseInput(),
        inputs: ["a" as ContentHash, "b" as ContentHash],
      }),
    );
  });

  it("refuses a non-finite parameter rather than hashing it", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => contentHash(baseInput({ spread: bad }))).toThrowError(GraphError);
    }
    try {
      contentHash(baseInput({ spread: Number.NaN }));
      expect.unreachable("a NaN parameter must not hash");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphError);
      expect((error as GraphError).code).toBe("non-finite-parameter");
    }
  });

  it("refuses a non-finite seed, opacity or resolution", () => {
    expect(() => contentHash({ ...baseInput(), seed: Number.NaN })).toThrowError(
      GraphError,
    );
    expect(() => contentHash({ ...baseInput(), opacity: Number.NaN })).toThrowError(
      GraphError,
    );
    expect(() =>
      contentHash({ ...baseInput(), width: Number.POSITIVE_INFINITY }),
    ).toThrowError(GraphError);
  });

  it("refuses a parameter that is not a ParameterValue", () => {
    // `ParameterValue` forbids these at compile time. The guard is for values
    // that arrive from a `.dork` file, which the type system never saw.
    const rejected: readonly unknown[] = [
      { r: 1, g: 2, b: 3 }, // a plain object is not any ParameterValue member
      [1, 2], // a numeric array that is not a triplet
      [1, 2, 3, 4],
      [{ x: 0, y: 0 }, 4], // half a curve
      [{ x: 0 }], // a control point missing a coordinate
    ];
    for (const value of rejected) {
      const params = { bad: value } as unknown as Readonly<
        Record<string, ParameterValue>
      >;
      try {
        contentHash(baseInput(params));
        expect.unreachable(`${JSON.stringify(value)} must not hash`);
      } catch (error) {
        expect(error).toBeInstanceOf(GraphError);
        expect((error as GraphError).code).toBe("unsupported-parameter");
      }
    }
  });

  // F-CO-07's per-node palette override and F-PP-05's transfer curve are both
  // `ParameterValue` members and both change the pixels a node emits. Until
  // they hashed, an effect that declared one could not be cached at all — the
  // hash threw. These pin that they are covered and that they are covered
  // *distinctly*.
  it("covers a colour triplet, component by component", () => {
    const base = contentHash(baseInput({ tint: [10, 20, 30] }));
    expect(contentHash(baseInput({ tint: [10, 20, 30] }))).toBe(base);
    expect(contentHash(baseInput({ tint: [11, 20, 30] }))).not.toBe(base);
    expect(contentHash(baseInput({ tint: [10, 20, 31] }))).not.toBe(base);
    // Order is part of the value: swapping two components is another colour.
    expect(contentHash(baseInput({ tint: [30, 20, 10] }))).not.toBe(base);
  });

  it("covers a curve's control points, both coordinates and their count", () => {
    const linear = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    const base = contentHash(baseInput({ curve: linear }));
    expect(contentHash(baseInput({ curve: [...linear] }))).toBe(base);
    // A moved control point is a different transfer function.
    expect(
      contentHash(baseInput({ curve: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] })),
    ).not.toBe(base);
    expect(
      contentHash(baseInput({ curve: [{ x: 0.1, y: 0 }, { x: 1, y: 1 }] })),
    ).not.toBe(base);
    // An added point is too, even one that sits on the line.
    expect(
      contentHash(
        baseInput({ curve: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }] }),
      ),
    ).not.toBe(base);
  });

  it("does not confuse a colour with a curve, or either with its own numbers", () => {
    // Distinct tags and a length prefix are what make this true. Without them a
    // three-entry colour and a three-point curve are two lists of numbers.
    const triplet = contentHash(baseInput({ v: [0, 1, 2] }));
    const curve = contentHash(
      baseInput({ v: [{ x: 0, y: 1 }, { x: 2, y: 0 }] }),
    );
    expect(triplet).not.toBe(curve);
    expect(triplet).not.toBe(contentHash(baseInput({ v: 12 })));
    expect(triplet).not.toBe(contentHash(baseInput({ v: "0,1,2" })));
  });

  it("produces the encoding this build committed to", () => {
    // A golden digest, pinning the byte stream itself — which the relational
    // assertions above cannot. An encoding change that is merely
    // self-consistent satisfies every one of them and still makes two builds of
    // the app disagree about what a node's output is called.
    //
    // Update this literal only together with `HASH_FORMAT_VERSION` in hash.ts;
    // that constant exists so a deliberate change cannot collide with this one.
    expect(
      contentHash({
        effect: "floyd-steinberg",
        params: { serpentine: true, strength: 0.75, channels: "rgb" },
        seed: 42,
        opacity: 1,
        blend: "normal",
        inputs: ["0".repeat(64) as ContentHash],
        width: 1920,
        height: 1080,
      }),
    ).toBe("64af6fd9966b87de21652a5a1bfdabe6c6ac5d91ecb219067230fbcf81f0ab91");
  });
});

describe("hashBytes", () => {
  const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it("is stable for the same label and bytes", () => {
    expect(hashBytes("source", pixels)).toBe(hashBytes("source", pixels));
  });

  it("separates the label from the content", () => {
    expect(hashBytes("source", pixels)).not.toBe(hashBytes("mask", pixels));
    expect(hashBytes("source", pixels)).not.toBe(
      hashBytes("source", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9])),
    );
  });

  it("does not collide with a node hash", () => {
    // Both streams open with the same version byte, so the "bytes"/"node" tag is
    // the only thing keeping a decoded image from being mistaken for a node's
    // output. That is worth an assertion of its own.
    expect(hashBytes("bayer-4", pixels)).not.toBe(contentHash(baseInput()));
  });
});

describe("paletteDigest", () => {
  const palette: Palette = {
    id: "dmg",
    name: "Game Boy DMG",
    colors: [15, 56, 15, 48, 98, 48, 139, 172, 15, 155, 188, 15],
    metric: "oklab",
  };

  it("ignores the id and the name", () => {
    // Renaming a palette changes no pixel. Folding the name in would invalidate
    // the whole stack on every keystroke in the palette editor.
    expect(paletteDigest({ ...palette, id: "other", name: "Renamed" })).toBe(
      paletteDigest(palette),
    );
  });

  it("covers the colours and the matching metric", () => {
    expect(paletteDigest({ ...palette, colors: [...palette.colors, 0, 0, 0] })).not.toBe(
      paletteDigest(palette),
    );
    expect(
      paletteDigest({
        ...palette,
        colors: [0, 56, 15, 48, 98, 48, 139, 172, 15, 155, 188, 15],
      }),
    ).not.toBe(paletteDigest(palette));
    expect(paletteDigest({ ...palette, metric: "srgb" })).not.toBe(
      paletteDigest(palette),
    );
  });

  it("produces the encoding this build committed to", () => {
    expect(paletteDigest(palette)).toBe(
      "c8a929e503f1ea42811ee1e3e118ceadea2c9e0b839a9e191698ee52d2738d23",
    );
  });
});

// --- hashing a whole graph ----------------------------------------------

function descriptor(
  overrides: Partial<EffectDescriptor> & Pick<EffectDescriptor, "id">,
): EffectDescriptor {
  return {
    name: overrides.id,
    requirement: "F-PP-01",
    slot: "preprocess",
    family: "preprocess",
    execution: "gpu",
    params: [],
    surpriseWeight: 1,
    producesIndexMap: false,
    requiresIndexMap: false,
    ...overrides,
  };
}

const EFFECTS: ReadonlyMap<string, EffectDescriptor> = new Map([
  ["levels", descriptor({ id: "levels" })],
  [
    "bayer-4",
    descriptor({
      id: "bayer-4",
      slot: "dither",
      family: "ordered",
      requirement: "F-OD-02",
      producesIndexMap: true,
    }),
  ],
  [
    "grain",
    descriptor({
      id: "grain",
      slot: "postprocess",
      family: "special",
      requirement: "F-PO-01",
    }),
  ],
]);

const PALETTE: Palette = {
  id: "dmg",
  name: "Game Boy DMG",
  colors: [15, 56, 15, 48, 98, 48, 139, 172, 15, 155, 188, 15],
  metric: "oklab",
};

function node(
  id: string,
  effect: string,
  params: Readonly<Record<string, ParameterValue>>,
  from: string | null,
  enabled = true,
): GraphNode {
  return {
    id,
    effect,
    enabled,
    opacity: 1,
    blend: "normal",
    params,
    seed: 1,
    inputs: from === null ? [] : [{ port: "in", from: { nodeId: from, port: "out" } }],
  };
}

interface StackOverrides {
  readonly levels?: Readonly<Record<string, ParameterValue>>;
  readonly dither?: Readonly<Record<string, ParameterValue>>;
  readonly grain?: Readonly<Record<string, ParameterValue>>;
  readonly ditherEnabled?: boolean;
}

/** A linear stack: levels -> bayer-4 -> grain, the shape of a real document. */
function stack(overrides: StackOverrides = {}): RenderGraph {
  return {
    nodes: [
      node("n1", "levels", overrides.levels ?? { gamma: 1 }, null),
      node(
        "n2",
        "bayer-4",
        overrides.dither ?? { spread: 1 },
        "n1",
        overrides.ditherEnabled ?? true,
      ),
      node("n3", "grain", overrides.grain ?? { amount: 0.2 }, "n2"),
    ],
    output: { nodeId: "n3", port: "out" },
    width: 800,
    height: 600,
    quality: "preview",
    frame: 0,
  };
}

/** Every node's hash, as a plain record so whole graphs can be compared. */
function hashesOf(
  graph: RenderGraph,
  palette: Palette = PALETTE,
): Readonly<Record<string, ContentHash>> {
  const prepared = prepareGraph(graph, SOURCE_HASH, palette, EFFECTS);
  const out: Record<string, ContentHash> = {};
  for (const [nodeId, hash] of prepared.hashes) out[nodeId] = hash;
  return out;
}

/** One node's hash. Throws rather than returning undefined, so no test passes vacuously. */
function hashOf(
  graph: RenderGraph,
  nodeId: string,
  palette: Palette = PALETTE,
): ContentHash {
  const hash = hashesOf(graph, palette)[nodeId];
  if (hash === undefined) throw new Error(`node ${nodeId} produced no hash`);
  return hash;
}

describe("prepareGraph hashing", () => {
  it("hashes the same graph the same way every time", () => {
    expect(hashesOf(stack())).toEqual(hashesOf(stack()));
  });

  it("leaves upstream nodes alone when a downstream node changes", () => {
    // The whole point of F-ST-01: re-render begins at the earliest changed
    // position and everything before it is read from the cache.
    const edited = stack({ grain: { amount: 0.9 } });
    expect(hashOf(edited, "n1")).toBe(hashOf(stack(), "n1"));
    expect(hashOf(edited, "n2")).toBe(hashOf(stack(), "n2"));
    expect(hashOf(edited, "n3")).not.toBe(hashOf(stack(), "n3"));
  });

  it("invalidates everything downstream when an upstream node changes", () => {
    const edited = stack({ levels: { gamma: 2.2 } });
    expect(hashOf(edited, "n1")).not.toBe(hashOf(stack(), "n1"));
    expect(hashOf(edited, "n2")).not.toBe(hashOf(stack(), "n2"));
    expect(hashOf(edited, "n3")).not.toBe(hashOf(stack(), "n3"));
  });

  it("invalidates from the edited node, not from the top", () => {
    const edited = stack({ dither: { spread: 0.4 } });
    expect(hashOf(edited, "n1")).toBe(hashOf(stack(), "n1"));
    expect(hashOf(edited, "n2")).not.toBe(hashOf(stack(), "n2"));
    expect(hashOf(edited, "n3")).not.toBe(hashOf(stack(), "n3"));
  });

  it("folds the palette into palette-consuming nodes only", () => {
    const recoloured: Palette = { ...PALETTE, colors: [0, 0, 0, 255, 255, 255] };
    // `levels` neither produces nor reads an index map, so a palette edit must
    // not re-run it — that is what keeps a palette drag from re-running a blur.
    expect(hashOf(stack(), "n1", recoloured)).toBe(hashOf(stack(), "n1"));
    // The quantizer consumes it directly; `grain` picks the change up through
    // its input hash rather than through the palette.
    expect(hashOf(stack(), "n2", recoloured)).not.toBe(hashOf(stack(), "n2"));
    expect(hashOf(stack(), "n3", recoloured)).not.toBe(hashOf(stack(), "n3"));
  });

  it("gives a disabled node its input's hash", () => {
    // A disabled node is wired out of the graph rather than executed as a copy,
    // so toggling it costs nothing in either direction.
    const off = stack({ ditherEnabled: false });
    expect(hashOf(off, "n2")).toBe(hashOf(off, "n1"));
    expect(hashOf(off, "n2")).not.toBe(hashOf(stack(), "n2"));
    // And toggling it back reproduces the hash it had before, so the buffers
    // cached under it are still valid.
    expect(hashOf(stack({ ditherEnabled: true }), "n2")).toBe(hashOf(stack(), "n2"));
  });

  it("reports the output hash of the node the output names", () => {
    const prepared = prepareGraph(stack(), SOURCE_HASH, PALETTE, EFFECTS);
    expect(prepared.outputHash).toBe(prepared.hashes.get("n3"));
    expect(prepared.outputOrigin).toEqual({ kind: "step", nodeId: "n3" });
  });

  it("re-hashes everything when the working resolution changes", () => {
    // The same stack at two sizes is two different results, so an export must
    // not read the preview's buffers.
    const exported: RenderGraph = { ...stack(), width: 3840, height: 2160 };
    expect(hashOf(exported, "n1")).not.toBe(hashOf(stack(), "n1"));
    expect(hashOf(exported, "n3")).not.toBe(hashOf(stack(), "n3"));
  });

  it("does not depend on the frame index", () => {
    // Bound parameters are resolved to concrete values before hashing, so a node
    // that does not move is computed once for a whole animation. That is the
    // entire reason an N-frame export is cheaper than N renders.
    expect(hashesOf({ ...stack(), frame: 0 })).toEqual(
      hashesOf({ ...stack(), frame: 137 }),
    );
  });

  it("re-hashes when the source image changes", () => {
    const prepared = prepareGraph(
      stack(),
      "another-image" as ContentHash,
      PALETTE,
      EFFECTS,
    );
    expect(prepared.hashes.get("n1")).not.toBe(hashOf(stack(), "n1"));
  });

  it("reserves the palette key so no real parameter can collide with it", () => {
    // `@` is not legal in a registry parameter key, which is what makes the
    // digest safe to smuggle in as one.
    expect(PALETTE_PARAM_KEY.startsWith("@")).toBe(true);
    expect(/^[a-zA-Z][a-zA-Z0-9]*$/.test(PALETTE_PARAM_KEY)).toBe(false);
  });
});
