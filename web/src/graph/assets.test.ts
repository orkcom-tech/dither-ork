/**
 * Per-node bulk data, on the graph's side.
 *
 * The store itself is a map. What is worth pinning is the property it exists
 * for: an asset that changes must change the node's content hash, and one that
 * does not must leave it alone. Without the first, replacing an uploaded
 * threshold image renders the frame from before the upload and nothing anywhere
 * reports a problem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Palette } from "../types/document";
import type { ContentHash, RenderGraph } from "../types/graph";
import type { EffectDescriptor } from "../types/registry";
import { setLevel } from "../lib/log";
import { NodeAssetStore } from "./assets";
import { GraphError } from "./errors";
import { prepareGraph } from "./plan";

setLevel("error");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const SOURCE_HASH = "source-image-hash" as ContentHash;

const PALETTE: Palette = {
  id: "gameboy-dmg",
  name: "Game Boy DMG",
  colors: [15, 56, 15, 155, 188, 15],
  metric: "oklab",
};

const THRESHOLD_MAP: EffectDescriptor = {
  id: "threshold-map",
  name: "Threshold map",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
  keywords: ["fixture", "test"],
  requirement: "F-PP-07",
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: [],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
};

const EFFECTS: ReadonlyMap<string, EffectDescriptor> = new Map([
  [THRESHOLD_MAP.id, THRESHOLD_MAP],
]);

const GRAPH: RenderGraph = {
  nodes: [
    {
      id: "n1",
      effect: "threshold-map",
      enabled: true,
      opacity: 1,
      blend: "normal",
      params: {},
      seed: 3,
      inputs: [],
    },
  ],
  output: { nodeId: "n1", port: "out" },
  width: 640,
  height: 480,
  quality: "preview",
  frame: 0,
};

function hashOf(store?: NodeAssetStore): ContentHash {
  return prepareGraph(GRAPH, SOURCE_HASH, PALETTE, EFFECTS, store).outputHash;
}

describe("NodeAssetStore", () => {
  it("digests bytes once, at registration", () => {
    const store = new NodeAssetStore();
    const asset = store.set("n1", "threshold-map", "noise.png", new Uint8Array([1, 2, 3]));
    expect(asset.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(store.assetsOf("n1")[0]?.digest).toBe(asset.digest);
  });

  it("reports nothing for a node with no assets", () => {
    const store = new NodeAssetStore();
    expect(store.digestOf("n1")).toBeNull();
    expect(store.slotsFor("n1")).toBeUndefined();
  });

  it("hands bytes back by slot", () => {
    const store = new NodeAssetStore();
    const bytes = new Uint8Array([4, 5, 6, 7]);
    store.set("n1", "threshold-map", "tile.png", bytes);
    expect(store.slotsFor("n1")?.get("threshold-map")).toBe(bytes);
  });

  it("does not depend on the order slots were registered in", () => {
    // The same rule, and the same reason, as the parameter-key sort in hash.ts:
    // two stores holding the same assets must agree, however they were filled.
    const a = new NodeAssetStore();
    a.set("n1", "alpha", "a", new Uint8Array([1]));
    a.set("n1", "beta", "b", new Uint8Array([2]));
    const b = new NodeAssetStore();
    b.set("n1", "beta", "b", new Uint8Array([2]));
    b.set("n1", "alpha", "a", new Uint8Array([1]));
    expect(a.digestOf("n1")).toBe(b.digestOf("n1"));
  });

  it("separates the slot from the bytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const a = new NodeAssetStore();
    a.set("n1", "threshold-map", "x", bytes);
    const b = new NodeAssetStore();
    b.set("n1", "mask", "x", bytes);
    expect(a.digestOf("n1")).not.toBe(b.digestOf("n1"));
  });

  it("drops a slot and a node", () => {
    const store = new NodeAssetStore();
    store.set("n1", "threshold-map", "x", new Uint8Array([1]));
    expect(store.delete("n1", "absent")).toBe(false);
    expect(store.delete("n1", "threshold-map")).toBe(true);
    expect(store.digestOf("n1")).toBeNull();

    store.set("n2", "threshold-map", "x", new Uint8Array([1]));
    expect(store.deleteNode("n2")).toBe(true);
    expect(store.deleteNode("n2")).toBe(false);
  });

  it("counts what it holds", () => {
    const store = new NodeAssetStore();
    store.set("n1", "a", "x", new Uint8Array(10));
    store.set("n1", "b", "y", new Uint8Array(6));
    store.set("n2", "a", "z", new Uint8Array(4));
    expect(store.nodeCount).toBe(2);
    expect(store.bytes).toBe(20);
    store.clear();
    expect(store.nodeCount).toBe(0);
    expect(store.bytes).toBe(0);
  });

  it("refuses an empty asset and one with no node or slot", () => {
    const store = new NodeAssetStore();
    expect(() => store.set("n1", "s", "x", new Uint8Array(0))).toThrowError(GraphError);
    expect(() => store.set("", "s", "x", new Uint8Array(1))).toThrowError(GraphError);
    expect(() => store.set("n1", "", "x", new Uint8Array(1))).toThrowError(GraphError);
  });
});

describe("assets in the content hash", () => {
  it("leaves a document with no assets hashing exactly as before", () => {
    // The overwhelmingly common case, and the one that must not have paid for
    // this: no node in the catalogue carries an asset today.
    expect(hashOf(new NodeAssetStore())).toBe(hashOf());
  });

  it("changes a node's hash when its asset arrives", () => {
    const store = new NodeAssetStore();
    store.set("n1", "threshold-map", "noise.png", new Uint8Array([1, 2, 3, 4]));
    expect(hashOf(store)).not.toBe(hashOf());
  });

  it("changes a node's hash when its asset is replaced", () => {
    // The failure this exists to prevent: a different image under the same
    // parameters, showing the frame from before the upload.
    const before = new NodeAssetStore();
    before.set("n1", "threshold-map", "a.png", new Uint8Array([1, 2, 3, 4]));
    const after = new NodeAssetStore();
    after.set("n1", "threshold-map", "a.png", new Uint8Array([1, 2, 3, 5]));
    expect(hashOf(after)).not.toBe(hashOf(before));
  });

  it("leaves the hash alone when the same bytes are re-registered", () => {
    const store = new NodeAssetStore();
    store.set("n1", "threshold-map", "a.png", new Uint8Array([1, 2, 3, 4]));
    const first = hashOf(store);
    store.set("n1", "threshold-map", "a.png", new Uint8Array([1, 2, 3, 4]));
    expect(hashOf(store)).toBe(first);
  });

  it("does not disturb a node the asset does not belong to", () => {
    const store = new NodeAssetStore();
    store.set("someone-else", "threshold-map", "a.png", new Uint8Array([1, 2, 3, 4]));
    expect(hashOf(store)).toBe(hashOf());
  });
});
