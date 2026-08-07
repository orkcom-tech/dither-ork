/**
 * The surprise store.
 *
 * Everything here is real except the renderer. The document store is the real
 * `DocumentStore` over the real catalogue, the palette store is the real
 * `createPaletteStore()`, and the surprises are produced by the real
 * `generateSurprise` — so the history holds documents that would actually
 * render, and `current` is tracked against real revision numbers.
 *
 * The engine is a local implementation of `SurpriseEngine` rather than the one
 * from `engine.ts`, because that one holds an `EditorSession`, which owns the
 * render worker and a WebGPU device. **It is not a stub**: `surprise` really
 * generates and really applies, `reroll` really rerolls, `restore` really loads.
 * The one method that cannot be real is `thumbnail`, which needs a GPU, and it
 * reports exactly that — which is also the path the application takes when a
 * thumbnail render fails, so the "no preview" branch is covered by the truth
 * rather than by a pretence.
 */

import { describe, expect, it } from "vitest";

import type { DitherDocument } from "../../types/document";
import { discoverEffects } from "../../registry/discovery";
import { createEffectRegistry, type EffectRegistry } from "../../registry/registry";
import { DocumentStore } from "../../state/store";
import { createPaletteStore } from "../palette/store";
import {
  NO_LOCKS,
  generateSurprise,
  mintSeed,
  rerollNodeParams,
  synthesizePalette,
  seededPcg32,
  type SurpriseLocks,
} from "../../surprise";
import type { StackEntry, SurpriseEngine, SurpriseRun } from "./engine";
import { createSurpriseStore, type SurpriseStore } from "./store";
import { DEFAULT_CHAOS } from "./model";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());

interface Harness {
  readonly store: SurpriseStore;
  readonly documents: DocumentStore;
  /** Flip to make `ready()` refuse, as an unopened image would. */
  setReady(reason: string | null): void;
  /** Flip to make generation throw, as an unrenderable locked stack would. */
  setFailure(message: string | null): void;
  /** How many surprises one call applies — the engine's coalescing, made explicit. */
  setRunsPerCall(runs: number): void;
  readonly thumbnails: () => number;
  /** Resolve every thumbnail promise that is outstanding. */
  settle(): Promise<void>;
}

function harness(): Harness {
  const documents = new DocumentStore({ registry, autosave: null });
  const palette = createPaletteStore();
  let refusal: string | null = null;
  let failure: string | null = null;
  let runsPerCall = 1;
  let thumbnails = 0;
  const pending: Promise<void>[] = [];

  const engine: SurpriseEngine = {
    registry,
    modulators: { renderable: false, reason: "no modulator in this build" },

    ready: () => (refusal === null ? { ready: true } : { ready: false, reason: refusal }),

    stack: () =>
      documents.document.stack.map(
        (node): StackEntry => ({
          id: node.id,
          effect: node.effect,
          name: registry.get(node.effect)?.name ?? node.effect,
        }),
      ),

    async surprise({
      chaos,
      locks,
      onApplied,
    }: {
      chaos: number;
      locks: SurpriseLocks;
      onApplied: (run: SurpriseRun) => void;
    }): Promise<void> {
      if (failure !== null) throw new Error(failure);
      // Two runs per call, which is what the real engine does when presses
      // arrive while one is in flight. It is here so the store's "record each
      // one as it lands" path is the path under test.
      for (let i = 0; i < runsPerCall; i += 1) {
        const seed = mintSeed();
        const result = generateSurprise({
          seed,
          registry,
          chaos,
          locks,
          base: documents.document,
          palette: synthesizePalette(seededPcg32(seed), "triad", "oklab"),
          animate: false,
        });
        documents.loadDocument(result.document, "Surprise");
        onApplied({
          result,
          palette: { mode: "synthesized", palette: result.document.palette, scheme: "triad" },
        });
      }
    },

    reroll(nodeId: string, chaos: number): void {
      documents.loadDocument(
        rerollNodeParams({
          document: documents.document,
          registry,
          nodeId,
          seed: mintSeed(),
          chaos,
        }),
        "Reroll",
      );
    },

    restore(document: DitherDocument, label: string): void {
      documents.loadDocument(document, label);
    },

    thumbnail() {
      thumbnails += 1;
      // The truth: there is no GPU in this process. It is also the exact shape
      // the application produces when a thumbnail render fails.
      const outcome = Promise.resolve({
        url: null as null,
        problem: "no renderer in this process",
      });
      pending.push(outcome.then(() => undefined));
      return outcome;
    },
  };

  const store = createSurpriseStore({ engine, documents, palette });

  return {
    store,
    documents,
    setReady: (reason) => {
      refusal = reason;
    },
    setFailure: (message) => {
      failure = message;
    },
    setRunsPerCall: (runs) => {
      runsPerCall = runs;
    },
    thumbnails: () => thumbnails,
    async settle(): Promise<void> {
      await Promise.all(pending);
      // One more turn, so the `.then` inside the store has run.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("surprise (F-SM-01)", () => {
  it("applies a document and records it in the history", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();

    const snapshot = h.store.getSnapshot();
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.busy).toBe(false);
    expect(snapshot.current).toBe(snapshot.history[0]?.id);
    expect(h.documents.document.stack.length).toBeGreaterThan(0);
    expect(h.documents.document.surpriseSeed).toBe(snapshot.history[0]?.seed);
  });

  it("is one undo step", async () => {
    const h = harness();
    const before = h.documents.getSnapshot().historyDepth;
    h.store.surprise();
    await h.settle();
    expect(h.documents.getSnapshot().historyDepth).toBe(before + 1);
    expect(h.documents.getSnapshot().canUndo).toBe(true);
  });

  it("can be hammered, and keeps only the last twelve", async () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) {
      h.store.surprise();
      await h.settle();
    }
    expect(h.store.getSnapshot().history).toHaveLength(12);
    // Newest first.
    expect(h.store.getSnapshot().history[0]?.id).toBe("s20");
  });

  /**
   * A hammered shortcut coalesces several presses into fewer runs, and each run
   * still puts a document on screen. Recording only the last would leave a
   * picture that was shown missing from the history — the one thing a history is
   * for.
   */
  it("records every surprise that reached the screen, not only the last of a burst", async () => {
    const h = harness();
    h.setRunsPerCall(3);
    h.store.surprise();
    await h.settle();

    const snapshot = h.store.getSnapshot();
    expect(snapshot.history).toHaveLength(3);
    expect(new Set(snapshot.history.map((entry) => entry.seed)).size).toBe(3);
    // The last one applied is the one on screen.
    expect(snapshot.current).toBe(snapshot.history[0]?.id);
    expect(h.documents.document.surpriseSeed).toBe(snapshot.history[0]?.seed);
    // And each got its own thumbnail request.
    expect(h.thumbnails()).toBe(3);
    expect(snapshot.busy).toBe(false);
  });

  it("refuses with the reason when it is not ready, and does not touch the document", async () => {
    const h = harness();
    h.setReady("Open an image first.");
    const before = JSON.stringify(h.documents.document);
    h.store.surprise();
    await h.settle();

    expect(h.store.getSnapshot().problem).toBe("Open an image first.");
    expect(h.store.getSnapshot().busy).toBe(false);
    expect(h.store.getSnapshot().history).toHaveLength(0);
    expect(JSON.stringify(h.documents.document)).toBe(before);
  });

  it("reports a generation failure and clears busy", async () => {
    const h = harness();
    h.setFailure("this stack is one the registry rejects");
    h.store.surprise();
    await h.settle();
    expect(h.store.getSnapshot().problem).toContain("registry rejects");
    expect(h.store.getSnapshot().busy).toBe(false);
  });

  it("clears the problem on the next attempt", async () => {
    const h = harness();
    h.setFailure("nope");
    h.store.surprise();
    await h.settle();
    expect(h.store.getSnapshot().problem).not.toBeNull();

    h.setFailure(null);
    h.store.surprise();
    await h.settle();
    expect(h.store.getSnapshot().problem).toBeNull();
  });

  it("can have its problem dismissed", async () => {
    const h = harness();
    h.setReady("nope");
    h.store.surprise();
    await h.settle();
    h.store.dismissProblem();
    expect(h.store.getSnapshot().problem).toBeNull();
  });
});

describe("thumbnails (F-SM-10)", () => {
  it("asks for one per surprise and records why there is none", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();

    expect(h.thumbnails()).toBe(1);
    const entry = h.store.getSnapshot().history[0];
    expect(entry?.thumbnail).toBeNull();
    // Not a placeholder picture: the reason, so the strip can say it.
    expect(entry?.thumbnailProblem).toBe("no renderer in this process");
  });
});

describe("current (which history entry is on screen)", () => {
  it("points at the surprise that was just applied", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();
    expect(h.store.getSnapshot().current).toBe("s1");
  });

  /**
   * A document revision this store did not cause means the surprise on screen
   * has been edited. Showing its seed afterwards would be a lie: that seed no
   * longer reproduces what is on screen.
   */
  it("lets go the moment the document is edited by anything else", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();
    expect(h.store.getSnapshot().current).toBe("s1");

    const node = h.documents.document.stack[0];
    expect(node).toBeDefined();
    if (node === undefined) return;
    h.documents.setNodeEnabled(node.id, false);

    expect(h.store.getSnapshot().current).toBeNull();
  });

  it("lets go on a per-node reroll, which the seed no longer describes", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();
    const node = h.documents.document.stack[0];
    expect(node).toBeDefined();
    if (node === undefined) return;

    h.store.reroll(node.id);
    expect(h.store.getSnapshot().current).toBeNull();
    expect(h.documents.document.surpriseSeed).toBeUndefined();
  });
});

describe("restore (F-SM-10)", () => {
  it("puts an old surprise back on screen and moves it to the front", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();
    const first = h.store.getSnapshot().history[0];
    h.store.surprise();
    await h.settle();
    expect(h.store.getSnapshot().history[0]?.id).toBe("s2");

    expect(first).toBeDefined();
    if (first === undefined) return;
    h.store.restore(first.id);

    expect(h.documents.document.surpriseSeed).toBe(first.seed);
    expect(h.store.getSnapshot().current).toBe(first.id);
    expect(h.store.getSnapshot().history[0]?.id).toBe(first.id);
    // Moved, not duplicated.
    expect(h.store.getSnapshot().history).toHaveLength(2);
  });

  it("says so when the entry is gone rather than doing nothing", () => {
    const h = harness();
    h.store.restore("s99");
    expect(h.store.getSnapshot().problem).toContain("no longer in the history");
  });
});

describe("chaos and locks", () => {
  it("snaps the chaos slider and notifies", () => {
    const h = harness();
    let notifications = 0;
    h.store.subscribe(() => {
      notifications += 1;
    });
    h.store.setChaos(0.73);
    expect(h.store.getSnapshot().chaos).toBeCloseTo(0.75, 10);
    expect(notifications).toBe(1);

    // A setting that does not move must not notify: a snapshot identity that
    // changes for nothing re-renders every subscriber.
    h.store.setChaos(0.75);
    expect(notifications).toBe(1);
  });

  it("starts at the default and toggles locks independently", () => {
    const h = harness();
    expect(h.store.getSnapshot().chaos).toBe(DEFAULT_CHAOS);
    expect(h.store.getSnapshot().locks).toEqual(NO_LOCKS);

    h.store.toggle("palette");
    expect(h.store.getSnapshot().locks.palette).toBe(true);
    expect(h.store.getSnapshot().locks.stack).toBe(false);
  });

  it("keeps a locked palette across rerolls", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();
    const palette = h.documents.document.palette;

    h.store.toggle("palette");
    for (let i = 0; i < 5; i += 1) {
      h.store.surprise();
      await h.settle();
    }
    expect(h.documents.document.palette).toEqual(palette);
  });
});

describe("the stack list (F-SM-08)", () => {
  it("names every node in the document", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();
    const listed = h.store.getSnapshot().stack;
    expect(listed.map((entry) => entry.id)).toEqual(
      h.documents.document.stack.map((node) => node.id),
    );
    for (const entry of listed) expect(entry.name.length).toBeGreaterThan(0);
  });

  it("rerolls one node and leaves the rest alone", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();
    const before = h.documents.document.stack;
    const node = before[0];
    expect(node).toBeDefined();
    if (node === undefined) return;

    h.store.reroll(node.id);
    const after = h.documents.document.stack;
    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after.slice(1))).toBe(JSON.stringify(before.slice(1)));
  });

  it("reports a reroll of a node that is not there", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();
    h.store.reroll("n99");
    expect(h.store.getSnapshot().problem).toContain("n99");
  });
});

describe("dispose", () => {
  it("stops listening to the document", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();
    let notifications = 0;
    h.store.subscribe(() => {
      notifications += 1;
    });
    h.store.dispose();

    const node = h.documents.document.stack[0];
    if (node !== undefined) h.documents.setNodeEnabled(node.id, false);
    expect(notifications).toBe(0);
  });
});
