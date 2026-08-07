/**
 * Every way a document changes (F-ST-01, F-ST-02).
 *
 * Two properties run through the whole file: the document handed in is never
 * touched, and a mutation that cannot be carried out says so rather than
 * quietly doing nothing.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { createDocument, seedForNodeId } from "./document";
import { DocumentError } from "./errors";
import { testRegistry } from "./fixture";
import {
  addNode,
  duplicateNode,
  moveNode,
  removeNode,
  setBindings,
  setClock,
  setNodeBlend,
  setNodeEnabled,
  setNodeOpacity,
  setNodeParam,
  setPalette,
} from "./mutations";

setLevel("error");

const registry = testRegistry();

function withThree() {
  const a = addNode(createDocument(), registry, "test-levels");
  const b = addNode(a.document, registry, "test-diffusion");
  const c = addNode(b.document, registry, "test-invert");
  return { document: c.document, ids: [a.nodeId, b.nodeId, c.nodeId] as const };
}

describe("addNode", () => {
  it("opens the node at its declared defaults", () => {
    const { document, nodeId } = addNode(createDocument(), registry, "test-levels");
    const node = document.stack[0];
    expect(node?.id).toBe(nodeId);
    expect(node?.params).toEqual({ amount: 1, invert: false, mode: "linear" });
    expect(node?.enabled).toBe(true);
    expect(node?.opacity).toBe(1);
    expect(node?.blend).toBe("normal");
  });

  it("seeds every node, deterministically and not identically", () => {
    // No node reads an unseeded RNG, and two nodes must not draw the same
    // noise field — a stack of two grain effects with one seed is one effect.
    const { document } = withThree();
    const seeds = document.stack.map((node) => node.seed);
    expect(new Set(seeds).size).toBe(3);
    for (const node of document.stack) expect(node.seed).toBe(seedForNodeId(node.id));
  });

  it("does not touch the document it was given", () => {
    const before = createDocument();
    addNode(before, registry, "test-levels");
    expect(before.stack).toHaveLength(0);
  });

  it("inserts where it is told", () => {
    const { document, ids } = withThree();
    const { document: next, nodeId } = addNode(document, registry, "test-invert", 1);
    expect(next.stack.map((node) => node.id)).toEqual([ids[0], nodeId, ids[1], ids[2]]);
  });

  it("refuses an effect the catalogue does not have", () => {
    expect(() => addNode(createDocument(), registry, "nope")).toThrow(DocumentError);
  });

  it("refuses an index outside the stack", () => {
    expect(() => addNode(createDocument(), registry, "test-levels", 3)).toThrow(/insert at 3/);
  });
});

describe("removeNode", () => {
  it("removes the node and the bindings that pointed at it", () => {
    const { document, ids } = withThree();
    const bound = setBindings(document, [
      {
        nodeId: ids[1],
        param: "strength",
        shape: "sine",
        amount: 0.2,
        cyclesPerLoop: 2,
        phase: 0,
        bipolar: true,
      },
    ]);
    const next = removeNode(bound, ids[1]);
    expect(next.stack.map((node) => node.id)).toEqual([ids[0], ids[2]]);
    // A modulator pointed at a node that is gone is invisible until the
    // animation path resolves it, and then it is reported against an id nobody
    // can find.
    expect(next.bindings).toHaveLength(0);
  });

  it("refuses an id that is not in the stack", () => {
    expect(() => removeNode(createDocument(), "n9")).toThrow(DocumentError);
  });
});

describe("duplicateNode", () => {
  it("puts the copy directly after the original, with a new id", () => {
    const { document, ids } = withThree();
    const { document: next, nodeId } = duplicateNode(document, ids[0]);
    expect(next.stack.map((node) => node.id)).toEqual([ids[0], nodeId, ids[1], ids[2]]);
    expect(nodeId).not.toBe(ids[0]);
  });

  it("keeps the seed, so the copy renders as the original does", () => {
    const { document, ids } = withThree();
    const source = document.stack[0];
    const { document: next, nodeId } = duplicateNode(document, ids[0]);
    const copy = next.stack.find((node) => node.id === nodeId);
    expect(copy?.seed).toBe(source?.seed);
    expect(copy?.params).toEqual(source?.params);
  });

  it("copies the bindings onto the copy", () => {
    const { document, ids } = withThree();
    const bound = setBindings(document, [
      {
        nodeId: ids[1],
        param: "strength",
        shape: "saw",
        amount: 0.5,
        cyclesPerLoop: 1,
        phase: 0,
        bipolar: false,
      },
    ]);
    const { document: next, nodeId } = duplicateNode(bound, ids[1]);
    expect(next.bindings).toHaveLength(2);
    expect(next.bindings.some((binding) => binding.nodeId === nodeId)).toBe(true);
  });
});

describe("moveNode", () => {
  it("moves to the index the node ends up at", () => {
    const { document, ids } = withThree();
    expect(moveNode(document, ids[0], 2).stack.map((node) => node.id)).toEqual([
      ids[1],
      ids[2],
      ids[0],
    ]);
    expect(moveNode(document, ids[2], 0).stack.map((node) => node.id)).toEqual([
      ids[2],
      ids[0],
      ids[1],
    ]);
  });

  it("is a no-op that returns the same document when nothing moves", () => {
    const { document, ids } = withThree();
    expect(moveNode(document, ids[1], 1)).toBe(document);
  });

  it("refuses a destination outside the stack", () => {
    const { document, ids } = withThree();
    expect(() => moveNode(document, ids[0], 3)).toThrow(/move/);
  });
});

describe("setNodeEnabled and setNodeParam", () => {
  it("toggles enable", () => {
    const { document, ids } = withThree();
    const off = setNodeEnabled(document, ids[0], false);
    expect(off.stack[0]?.enabled).toBe(false);
    expect(setNodeEnabled(off, ids[0], false)).toBe(off);
  });

  it("clamps a value to the descriptor's legal range", () => {
    const { document, ids } = withThree();
    const next = setNodeParam(document, registry, ids[0], "amount", 99);
    expect(next.stack[0]?.params["amount"]).toBe(2);
  });

  it("leaves the other parameters where they were", () => {
    const { document, ids } = withThree();
    const once = setNodeParam(document, registry, ids[0], "mode", "log");
    const twice = setNodeParam(once, registry, ids[0], "amount", 0.25);
    expect(twice.stack[0]?.params).toEqual({ amount: 0.25, invert: false, mode: "log" });
  });

  it("refuses a key the effect does not declare", () => {
    const { document, ids } = withThree();
    expect(() => setNodeParam(document, registry, ids[0], "nope", 1)).toThrow(
      /declares no parameter/,
    );
  });
});

describe("setNodeOpacity and setNodeBlend (F-ST-03)", () => {
  it("sets opacity and returns the same document when nothing moves", () => {
    const { document, ids } = withThree();
    const half = setNodeOpacity(document, ids[0], 0.5);
    expect(half.stack[0]?.opacity).toBe(0.5);
    // Identity rather than a new object: an unchanged document must not become
    // an undo step or invalidate a cached node.
    expect(setNodeOpacity(half, ids[0], 0.5)).toBe(half);
    expect(document.stack[0]?.opacity).toBe(1);
  });

  it("refuses an opacity outside [0, 1] rather than clamping it", () => {
    // Opacity has no registry descriptor, so there is no legal range for
    // `coerceParams` to clamp against; the bound is stated here as a refusal so
    // it is never a silent correction the caller does not learn about.
    const { document, ids } = withThree();
    for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => setNodeOpacity(document, ids[0], bad)).toThrow(DocumentError);
    }
  });

  it("sets a blend mode and leaves the rest of the node alone", () => {
    const { document, ids } = withThree();
    const next = setNodeBlend(document, ids[1], "multiply");
    expect(next.stack[1]?.blend).toBe("multiply");
    expect(next.stack[1]?.params).toEqual(document.stack[1]?.params);
    expect(next.stack[1]?.opacity).toBe(1);
    expect(setNodeBlend(next, ids[1], "multiply")).toBe(next);
    expect(document.stack[1]?.blend).toBe("normal");
  });

  it("refuses both on a node that is not in the stack", () => {
    const { document } = withThree();
    expect(() => setNodeOpacity(document, "n99", 0.5)).toThrow(DocumentError);
    expect(() => setNodeBlend(document, "n99", "screen")).toThrow(DocumentError);
  });
});

describe("palette, clock, bindings", () => {
  it("takes a palette and refuses a malformed one", () => {
    const document = createDocument();
    const next = setPalette(document, {
      id: "duo",
      name: "Duo",
      colors: [0, 0, 0, 255, 0, 0],
      metric: "srgb",
    });
    expect(next.palette.colors).toHaveLength(6);

    expect(() =>
      setPalette(document, { id: "x", name: "X", colors: [0, 0], metric: "oklab" }),
    ).toThrow(/multiple of 3/);
    expect(() =>
      setPalette(document, { id: "x", name: "X", colors: [0, 0, 300], metric: "oklab" }),
    ).toThrow(/0\.\.255/);
  });

  it("refuses a clock that would break normalized time", () => {
    const document = createDocument();
    expect(() => setClock(document, { frames: 0, fps: 24 })).toThrow(/positive integer/);
    expect(() => setClock(document, { frames: 24.5, fps: 24 })).toThrow(/positive integer/);
    expect(() => setClock(document, { frames: 24, fps: 0 })).toThrow(/positive/);
    expect(setClock(document, { frames: 12, fps: 12 }).clock.frames).toBe(12);
  });

  it("refuses a non-integer cyclesPerLoop, which is what closes the loop", () => {
    const { document, ids } = withThree();
    expect(() =>
      setBindings(document, [
        {
          nodeId: ids[0],
          param: "amount",
          shape: "sine",
          amount: 1,
          cyclesPerLoop: 1.5,
          phase: 0,
          bipolar: true,
        },
      ]),
    ).toThrow(/cyclesPerLoop/);
  });
});
