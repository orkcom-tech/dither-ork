/**
 * The live document.
 *
 * The two things worth testing here are the ones a panel depends on and cannot
 * check for itself: that the snapshot's identity changes exactly when the state
 * does, and that undo covers every mutation including a reorder and a palette
 * edit (F-ST-04).
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import type { ContentHash } from "../types/graph";
import type { SourceImage } from "../io";
import { DocumentStore } from "./store";
import { testRegistry } from "./fixture";

setLevel("error");

const registry = testRegistry();

function store(): DocumentStore {
  return new DocumentStore({ registry });
}

function testImage(name: string, width = 4, height = 4): SourceImage {
  const pixels = width * height;
  return {
    name,
    format: "png",
    width,
    height,
    surface: {
      residency: "cpu",
      r: new Float32Array(pixels),
      g: new Float32Array(pixels),
      b: new Float32Array(pixels),
      a: new Float32Array(pixels).fill(1),
    },
    hash: `hash-${name}` as ContentHash,
    byteLength: 128,
  };
}

describe("the snapshot", () => {
  it("is stable until something changes", () => {
    const s = store();
    const first = s.getSnapshot();
    expect(s.getSnapshot()).toBe(first);

    s.addNode("test-levels");
    const second = s.getSnapshot();
    expect(second).not.toBe(first);
    // React compares by reference; a store that rebuilt this on every read
    // would re-render forever.
    expect(s.getSnapshot()).toBe(second);
  });

  it("tells subscribers once per change and stops when unsubscribed", () => {
    const s = store();
    let calls = 0;
    const off = s.subscribe(() => {
      calls += 1;
    });
    s.addNode("test-levels");
    s.addNode("test-invert");
    expect(calls).toBe(2);
    off();
    s.addNode("test-invert");
    expect(calls).toBe(2);
  });
});

describe("undo and redo (F-ST-04)", () => {
  it("covers adds, parameter edits, reorders and palette edits", () => {
    const s = store();
    const a = s.addNode("test-levels");
    const b = s.addNode("test-diffusion");
    s.setNodeParam(a, "amount", 0.5);
    s.moveNode(b, 0);
    s.setPalette({ id: "duo", name: "Duo", colors: [0, 0, 0, 9, 9, 9], metric: "srgb" });

    expect(s.getSnapshot().document.palette.id).toBe("duo");

    s.undo();
    expect(s.getSnapshot().document.palette.id).toBe("black-white");

    s.undo();
    expect(s.getSnapshot().document.stack.map((node) => node.id)).toEqual([a, b]);

    s.undo();
    expect(s.getSnapshot().document.stack[0]?.params["amount"]).toBe(1);

    s.undo();
    expect(s.getSnapshot().document.stack).toHaveLength(1);

    s.undo();
    expect(s.getSnapshot().document.stack).toHaveLength(0);
    expect(s.getSnapshot().canUndo).toBe(false);

    // And all the way forward again.
    for (let i = 0; i < 5; i += 1) s.redo();
    expect(s.getSnapshot().document.palette.id).toBe("duo");
    expect(s.getSnapshot().canRedo).toBe(false);
  });

  it("makes a continuous edit one step", () => {
    const s = store();
    const id = s.addNode("test-levels");
    for (const value of [0.9, 0.8, 0.7, 0.6]) {
      s.setNodeParam(id, "amount", value, { continuous: true });
    }
    expect(s.getSnapshot().document.stack[0]?.params["amount"]).toBe(0.6);
    s.undo();
    expect(s.getSnapshot().document.stack[0]?.params["amount"]).toBe(1);
  });

  it("labels what undo would undo, using the effect's display name", () => {
    const s = store();
    s.addNode("test-levels");
    expect(s.getSnapshot().undoLabel).toBe("Add Test Levels");
  });

  it("drops a selection undo has removed from the stack", () => {
    const s = store();
    const id = s.addNode("test-levels");
    expect(s.getSnapshot().selectedNodeId).toBe(id);
    s.undo();
    expect(s.getSnapshot().selectedNodeId).toBeNull();
  });
});

describe("selection", () => {
  it("follows what was just added, and survives an unrelated edit", () => {
    const s = store();
    s.addNode("test-levels");
    const second = s.addNode("test-invert");
    expect(s.getSnapshot().selectedNodeId).toBe(second);
    s.selectNode(null);
    expect(s.getSnapshot().selectedNodeId).toBeNull();
  });

  it("moves to a neighbour when the selected node is removed", () => {
    const s = store();
    const a = s.addNode("test-levels");
    const b = s.addNode("test-invert");
    s.selectNode(b);
    s.removeNode(b);
    expect(s.getSnapshot().selectedNodeId).toBe(a);
  });

  it("is not an undo step", () => {
    const s = store();
    const id = s.addNode("test-levels");
    const depth = s.getSnapshot().historyDepth;
    s.selectNode(null);
    s.selectNode(id);
    expect(s.getSnapshot().historyDepth).toBe(depth);
  });
});

describe("opening an image", () => {
  it("keeps the stack and points the document at the new source", () => {
    const s = store();
    s.addNode("test-levels");
    s.openSource(testImage("photo.png", 8, 6));

    expect(s.getSnapshot().document.source).toEqual({
      name: "photo.png",
      width: 8,
      height: 6,
    });
    expect(s.getSnapshot().document.stack).toHaveLength(1);
    expect(s.getSnapshot().source?.name).toBe("photo.png");
  });

  it("leaves no reachable state naming an image that is not loaded", () => {
    // Undo after opening a second image must not produce a document pointed at
    // the first one: the pixels are not in the history and cannot be.
    const s = store();
    s.openSource(testImage("first.png"));
    s.addNode("test-levels");
    s.openSource(testImage("second.png", 12, 12));

    s.undo();
    expect(s.getSnapshot().document.source?.name).toBe("second.png");
    s.undo();
    expect(s.getSnapshot().document.source?.name).toBe("second.png");
    expect(s.getSnapshot().canUndo).toBe(false);
  });
});

describe("the restore notice (F-DO-07)", () => {
  it("is carried until it is dismissed", () => {
    const s = new DocumentStore({
      registry,
      restored: {
        savedAt: new Date("2026-01-01T10:00:00Z"),
        sourceName: "photo.png",
        message: "Restored…",
      },
    });
    expect(s.getSnapshot().restored).not.toBeNull();
    s.dismissRestoreNotice();
    expect(s.getSnapshot().restored).toBeNull();
  });
});

describe("solo (F-ST-02)", () => {
  it("is view state: it moves the picture without touching the document", () => {
    const s = store();
    const dither = s.addNode("test-diffusion");
    s.addNode("test-invert");
    const before = s.getSnapshot();

    s.setSolo(dither);
    const after = s.getSnapshot();
    expect(after.soloNodeId).toBe(dither);
    // The same document, by identity: solo is not an edit, so nothing about it
    // is saved, undone, or hashed into a cache key.
    expect(after.document).toBe(before.document);
    expect(after.canUndo).toBe(before.canUndo);
    // It still has to reach the renderer, which watches the revision.
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it("refuses a node that is not in the stack", () => {
    const s = store();
    expect(() => s.setSolo("n99")).toThrow(/n99/);
  });

  it("clears itself when its node is removed", () => {
    const s = store();
    const first = s.addNode("test-levels");
    s.addNode("test-diffusion");
    s.setSolo(first);
    s.removeNode(first);
    // Left set, every later render would throw from `buildRenderGraph` rather
    // than merely look wrong.
    expect(s.getSnapshot().soloNodeId).toBeNull();
  });

  it("clears itself when undo takes its node out of the stack", () => {
    const s = store();
    s.addNode("test-levels");
    const second = s.addNode("test-diffusion");
    s.setSolo(second);
    s.undo();
    expect(s.getSnapshot().document.stack).toHaveLength(1);
    expect(s.getSnapshot().soloNodeId).toBeNull();
  });
});

describe("the node seed (F-SM-02)", () => {
  it("is an undoable edit of the document", () => {
    const s = store();
    const node = s.addNode("test-diffusion");
    s.setNodeSeed(node, 12345);
    expect(s.getSnapshot().document.stack[0]?.seed).toBe(12345);
    expect(s.getSnapshot().undoLabel).toBe("Test Diffusion: seed");

    s.undo();
    expect(s.getSnapshot().document.stack[0]?.seed).not.toBe(12345);
  });

  it("refuses a value a u32 uniform could not carry", () => {
    const s = store();
    const node = s.addNode("test-diffusion");
    // Truncating silently would change the picture and say nothing.
    expect(() => s.setNodeSeed(node, -1)).toThrow(/seed/);
    expect(() => s.setNodeSeed(node, 2 ** 32)).toThrow(/seed/);
    expect(() => s.setNodeSeed(node, 1.5)).toThrow(/seed/);
  });
});
