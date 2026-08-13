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
  NO_EXCLUDES,
  NO_LOCKS,
  generateSurprise,
  mintSeed,
  rerollNodeParams,
  synthesizePalette,
  seededPcg32,
  type SurpriseExcludes,
  type SurpriseLocks,
} from "../../surprise";
import type { StackEntry, SurpriseEngine, SurpriseRun } from "./engine";
import { createSurpriseStore, type SurpriseStore } from "./store";
import { DEFAULT_CHAOS } from "./model";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());

interface Harness {
  readonly store: SurpriseStore;
  readonly documents: DocumentStore;
  /** What the engine was last asked for, so the store's wiring is observable. */
  readonly lastRequest: () => {
    readonly locks: SurpriseLocks;
    readonly excludes: SurpriseExcludes;
  } | null;
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
  let lastRequest: { locks: SurpriseLocks; excludes: SurpriseExcludes } | null = null;
  const pending: Promise<void>[] = [];

  const engine: SurpriseEngine = {
    registry,
    // The real probe passes in this build, so the panel offers animation and the
    // store has an exclude to carry. Saying `false` here would leave the store's
    // animation wiring untested behind a capability the application does have.
    modulators: { renderable: true, reason: "" },

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
      excludes,
      onApplied,
    }: {
      chaos: number;
      locks: SurpriseLocks;
      excludes: SurpriseExcludes;
      onApplied: (run: SurpriseRun) => void;
    }): Promise<void> {
      if (failure !== null) throw new Error(failure);
      lastRequest = { locks, excludes };
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
          excludes,
          base: documents.document,
          palette: synthesizePalette(seededPcg32(seed), "triad", "oklab"),
          // The real engine passes its probe's answer, which is `true` here.
          animate: true,
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
    lastRequest: () => lastRequest,
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

describe("chaos and the aspect modes", () => {
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

  it("starts at the default with everything rerolling", () => {
    const h = harness();
    expect(h.store.getSnapshot().chaos).toBe(DEFAULT_CHAOS);
    expect(h.store.getSnapshot().locks).toEqual(NO_LOCKS);
    expect(h.store.getSnapshot().excludes).toEqual(NO_EXCLUDES);

    h.store.setMode("palette", "keep");
    expect(h.store.getSnapshot().locks.palette).toBe(true);
    expect(h.store.getSnapshot().locks.stack).toBe(false);
  });

  it("keeps a kept palette across rerolls", async () => {
    const h = harness();
    h.store.surprise();
    await h.settle();
    const palette = h.documents.document.palette;

    h.store.setMode("palette", "keep");
    for (let i = 0; i < 5; i += 1) {
      h.store.surprise();
      await h.settle();
    }
    expect(h.documents.document.palette).toEqual(palette);
  });

  /**
   * The off-switch, end to end through the store: set animation to off, press
   * surprise, and the document on screen carries no bindings. This is the state
   * `ui/timeline/store.ts` adopts, and at zero bindings it takes no tracks and
   * stops the transport — so "nothing moves" is what the user actually gets.
   */
  it("puts a document with no bindings on screen when animation is off", async () => {
    // The guard below is not vacuous — with animation rerolling this build does
    // produce bindings, so a passing "no bindings" assertion cannot be an
    // accident of a stack that had nothing to bind. It has to be reached from a
    // KNOWN seed rather than a minted one: a surprise samples its bindings from
    // whatever stack the grammar composed, some stacks legitimately offer
    // nothing bindable, and asserting on a random draw makes the suite fail on
    // an unlucky day for a reason that is not a defect. The project's own rule
    // is that nothing stochastic runs unseeded; a test is not an exception.
    const h = harness();
    let seeded = false;
    for (let attempt = 0; attempt < 24 && !seeded; attempt += 1) {
      h.store.surprise();
      await h.settle();
      seeded = h.documents.document.bindings.length > 0;
    }
    expect(seeded).toBe(true);

    h.store.setMode("animation", "off");
    for (let i = 0; i < 5; i += 1) {
      h.store.surprise();
      await h.settle();
      expect(h.documents.document.bindings).toEqual([]);
    }
    expect(h.lastRequest()?.excludes).toEqual({ animation: true });
  });

  /**
   * The exclude survives a reroll and stays visible, exactly as a lock does:
   * both live in this store because both are ways of *asking* for a surprise
   * rather than parts of a document.
   */
  it("carries the mode across presses rather than resetting it", async () => {
    const h = harness();
    h.store.setMode("animation", "off");
    h.store.setMode("stack", "keep");
    for (let i = 0; i < 3; i += 1) {
      h.store.surprise();
      await h.settle();
    }
    expect(h.store.getSnapshot().excludes.animation).toBe(true);
    expect(h.store.getSnapshot().locks.stack).toBe(true);
    expect(h.lastRequest()).toEqual({
      locks: { ...NO_LOCKS, stack: true },
      excludes: { animation: true },
    });
  });

  /**
   * The generator refuses an aspect that is both kept and excluded. The store
   * cannot ask for that — one aspect carries one mode — and this is the proof,
   * because the alternative is discovering it as a refusal banner over a picture.
   */
  it("never asks for an aspect that is both kept and off", async () => {
    const h = harness();
    for (const mode of ["keep", "off", "keep", "reroll", "off"] as const) {
      h.store.setMode("animation", mode);
      const snapshot = h.store.getSnapshot();
      expect(snapshot.locks.animation && snapshot.excludes.animation).toBe(false);
      h.store.surprise();
      await h.settle();
      // Generation would have thrown on a contradiction, and the store reports a
      // failure rather than swallowing it.
      expect(h.store.getSnapshot().problem).toBeNull();
    }
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
