/**
 * The wiring mutations schema 2 made possible (F-PP-08, multi-input).
 *
 * Two properties run through the file, and they are the same two the rest of
 * `mutations.test.ts` holds: the document handed in is never touched, and an
 * edit that cannot be carried out says so rather than quietly doing nothing.
 *
 * A third is specific to these five: **every rule they enforce belongs to
 * `graph/edit.ts`**, so what is checked here is that the document-shaped wrapper
 * carries the answer through — not the rule itself, which has its own tests.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { MASK_INPUT_PORT } from "../types/registry";
import type { NodeMask } from "../types/document";
import { createDocument } from "./document";
import { testRegistry } from "./fixture";
import {
  addNode,
  connectNodes,
  disconnectPort,
  maskNodeWith,
  setNodeMask,
  setOutputNode,
} from "./mutations";

setLevel("error");

const registry = testRegistry();

const IMAGE_MASK: NodeMask = {
  source: { kind: "image", channel: "luminance" },
  invert: false,
};

const LUMINANCE_MASK: NodeMask = {
  source: { kind: "luminance", low: 0.2, high: 0.8, feather: 0.1 },
  invert: false,
};

/** Three nodes wired as a chain, which is what `addNode` builds. */
function withThree() {
  const a = addNode(createDocument(), registry, "test-levels");
  const b = addNode(a.document, registry, "test-diffusion");
  const c = addNode(b.document, registry, "test-invert");
  return { document: c.document, ids: [a.nodeId, b.nodeId, c.nodeId] as const };
}

describe("connectNodes", () => {
  it("replaces what the port held, in one step", () => {
    const { document, ids } = withThree();
    const [a, b, c] = ids;
    // c reads b; rewire it to read a instead.
    const next = connectNodes(document, registry, a, c, "in");
    const into = next.edges.filter((edge) => edge.to === c);
    expect(into).toHaveLength(1);
    expect(into[0]?.from).toBe(a);
    // And b is still there, now feeding nothing.
    expect(next.stack.some((node) => node.id === b)).toBe(true);
  });

  it("does not touch the document it was given", () => {
    const { document, ids } = withThree();
    const before = JSON.stringify(document);
    connectNodes(document, registry, ids[0], ids[2], "in");
    expect(JSON.stringify(document)).toBe(before);
  });

  it("throws the refusal rather than dropping the edit", () => {
    const { document, ids } = withThree();
    // a already feeds c through b, so this would close a loop.
    expect(() => connectNodes(document, registry, ids[2], ids[0], "in")).toThrow(
      /close a loop/,
    );
  });

  it("refuses a mask edge on a node that is not reading a picture as coverage", () => {
    const { document, ids } = withThree();
    expect(() => connectNodes(document, registry, ids[0], ids[2], MASK_INPUT_PORT)).toThrow(
      /coverage from a picture/,
    );
  });
});

describe("disconnectPort", () => {
  it("clears one port and leaves the node in the document", () => {
    const { document, ids } = withThree();
    const next = disconnectPort(document, ids[2], "in");
    expect(next.edges.some((edge) => edge.to === ids[2])).toBe(false);
    expect(next.stack).toHaveLength(3);
  });

  it("is not an error on a port with nothing wired to it", () => {
    const { document, ids } = withThree();
    expect(disconnectPort(document, ids[0], "in")).toBe(document);
  });
});

describe("setOutputNode", () => {
  it("points the picture at another node without moving anything else", () => {
    const { document, ids } = withThree();
    const next = setOutputNode(document, ids[0]);
    expect(next.output).toBe(ids[0]);
    expect(next.edges).toEqual(document.edges);
    expect(next.stack).toEqual(document.stack);
  });

  it("refuses a node that is not in the document", () => {
    const { document } = withThree();
    expect(() => setOutputNode(document, "not-a-node")).toThrow(/not in this document/);
  });
});

describe("setNodeMask", () => {
  it("sets a mask, and unmasking leaves no `mask` key behind", () => {
    // `mask: undefined` and no `mask` are the same value in TypeScript and
    // different bytes to the canonical encoder, so unmasking has to be
    // byte-identical to never having masked.
    const { document, ids } = withThree();
    const masked = setNodeMask(document, ids[1], LUMINANCE_MASK);
    expect(masked.stack[1]?.mask).toEqual(LUMINANCE_MASK);

    const cleared = setNodeMask(masked, ids[1], null);
    expect(Object.prototype.hasOwnProperty.call(cleared.stack[1] ?? {}, "mask")).toBe(false);
  });

  it("drops the mask edge when the mask stops reading a picture", () => {
    // Leaving it would be an edge read by nothing, which `graph/plan.ts`
    // refuses — a document that will not render until a second gesture.
    const { document, ids } = withThree();
    const wired = maskNodeWith(document, registry, ids[0], ids[2], IMAGE_MASK);
    expect(wired.edges.some((edge) => edge.port === MASK_INPUT_PORT)).toBe(true);

    const swapped = setNodeMask(wired, ids[2], LUMINANCE_MASK);
    expect(swapped.edges.some((edge) => edge.port === MASK_INPUT_PORT)).toBe(false);
  });
});

describe("maskNodeWith", () => {
  it("sets the coverage and wires the picture as one mutation", () => {
    // Either half on its own is a document that will not render, so committing
    // them separately would put an unrenderable state in the undo history.
    const { document, ids } = withThree();
    const next = maskNodeWith(document, registry, ids[0], ids[2], IMAGE_MASK);

    expect(next.stack[2]?.mask).toEqual(IMAGE_MASK);
    expect(
      next.edges.some(
        (edge) => edge.to === ids[2] && edge.port === MASK_INPUT_PORT && edge.from === ids[0],
      ),
    ).toBe(true);
  });

  it("leaves the document untouched when the connection is refused", () => {
    // The mask must not be set by a gesture whose second half throws.
    const { document, ids } = withThree();
    const before = JSON.stringify(document);
    // A node cannot mask itself: that is a self-edge within one frame.
    expect(() => maskNodeWith(document, registry, ids[2], ids[2], IMAGE_MASK)).toThrow();
    expect(JSON.stringify(document)).toBe(before);
  });

  it("keeps the rest of the wiring exactly as it was", () => {
    const { document, ids } = withThree();
    const next = maskNodeWith(document, registry, ids[0], ids[2], IMAGE_MASK);
    for (const edge of document.edges) {
      expect(next.edges).toContainEqual(edge);
    }
  });
});
