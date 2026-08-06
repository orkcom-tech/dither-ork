import { describe, expect, it } from "vitest";

import type { PaletteSource } from "./extract";
import type { PaletteChange } from "./model";
import { createPaletteStore } from "./store";

function source(name: string, width: number, height: number, plane = width * height): PaletteSource {
  return {
    name,
    width,
    height,
    surface: {
      residency: "cpu",
      r: new Float32Array(plane),
      g: new Float32Array(plane),
      b: new Float32Array(plane),
      a: new Float32Array(plane).fill(1),
    },
  };
}

function collect(store: ReturnType<typeof createPaletteStore>): {
  readonly changes: (PaletteChange | null)[];
  readonly off: () => void;
} {
  const changes: (PaletteChange | null)[] = [];
  const off = store.subscribe((change) => changes.push(change));
  return { changes, off };
}

describe("createPaletteStore", () => {
  it("opens on a usable palette rather than an empty one", () => {
    const store = createPaletteStore();
    expect(store.palette.colors).toHaveLength(6);
    expect(store.palette.metric).toBe("oklab");
    expect(store.getSnapshot().source).toBeNull();
  });

  it("hands out a snapshot that is stable by identity until something changes", () => {
    // `useSyncExternalStore` compares snapshots with Object.is; a getter that
    // rebuilt its result would re-render forever.
    const store = createPaletteStore();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    const before = store.getSnapshot();
    store.dispatch({ kind: "add", rgb: [1, 2, 3] });
    expect(store.getSnapshot()).not.toBe(before);
  });

  it("announces every applied edit and notifies on a refusal too", () => {
    const store = createPaletteStore();
    const { changes, off } = collect(store);

    expect(store.dispatch({ kind: "add", rgb: [1, 2, 3] })).not.toBeNull();
    // Refused: the palette is already that colour.
    expect(store.dispatch({ kind: "set", index: 0, rgb: [0, 0, 0] })).toBeNull();

    expect(changes).toHaveLength(2);
    expect(changes[0]?.reason).toBe("add");
    expect(changes[1]).toBeNull();
    expect(store.getSnapshot().refusal).toContain("already");
    off();
  });

  it("clears the refusal once an edit lands", () => {
    const store = createPaletteStore();
    store.dispatch({ kind: "remove", index: 0 });
    expect(store.getSnapshot().refusal).not.toBeNull();
    store.dispatch({ kind: "add", rgb: [4, 4, 4] });
    expect(store.getSnapshot().refusal).toBeNull();
  });

  it("stops listening after unsubscribe", () => {
    const store = createPaletteStore();
    const { changes, off } = collect(store);
    off();
    store.dispatch({ kind: "add", rgb: [1, 2, 3] });
    expect(changes).toHaveLength(0);
  });

  it("puts the document palette out in the layout .dork takes", () => {
    const store = createPaletteStore();
    store.dispatch({
      kind: "load",
      palette: {
        id: "gameboy-dmg",
        name: "Game Boy DMG",
        colors: [8, 24, 32, 52, 104, 86, 136, 192, 112, 224, 248, 208],
        metric: "oklab",
      },
    });
    expect(store.palette.id).toBe("gameboy-dmg");
    expect(store.palette.colors).toEqual([
      8, 24, 32, 52, 104, 86, 136, 192, 112, 224, 248, 208,
    ]);
  });

  it("carries the permutation on a reorder and nothing else", () => {
    const store = createPaletteStore();
    store.dispatch({ kind: "add", rgb: [255, 0, 0] });
    const moved = store.dispatch({ kind: "move", from: 0, to: 2 });
    expect(moved?.permutation).toEqual([1, 2, 0]);
    const added = store.dispatch({ kind: "add", rgb: [0, 255, 0] });
    expect(added?.permutation).toBeNull();
  });

  it("refuses a source whose planes do not match its dimensions", () => {
    // Stored anyway, this surfaces as an encoder error naming the buffer rather
    // than whoever handed it over.
    const store = createPaletteStore();
    store.setSource(source("bad.png", 4, 4, 10));
    expect(store.getSnapshot().source).toBeNull();
    expect(store.getSnapshot().refusal).toContain("planes");
  });

  it("takes a well-formed source and lets it go again", () => {
    const store = createPaletteStore();
    const image = source("photo.png", 2, 2);
    const { changes, off } = collect(store);
    store.setSource(image);
    expect(store.getSnapshot().source).toBe(image);
    store.setSource(null);
    expect(store.getSnapshot().source).toBeNull();
    // A source arriving changes no colour, so it announces no palette change.
    expect(changes).toEqual([null, null]);
    off();
  });

  it("refuses extraction with no source, without reaching the core", async () => {
    const store = createPaletteStore();
    await store.extract();
    expect(store.getSnapshot().refusal).toContain("image");
    expect(store.getSnapshot().extracting).toBe(false);
  });

  it("refuses extraction when the locks already fill k", async () => {
    const store = createPaletteStore();
    store.setSource(source("x.png", 2, 2));
    store.dispatch({ kind: "lock", index: 0, locked: true });
    store.dispatch({ kind: "lock", index: 1, locked: true });
    store.dispatch({
      kind: "extract-settings",
      settings: { ...store.getSnapshot().editor.extract, k: 2 },
    });
    await store.extract();
    expect(store.getSnapshot().refusal).toContain("locked");
  });

  it("keeps its stores independent, so one panel's state is not another's", () => {
    const a = createPaletteStore();
    const b = createPaletteStore();
    a.dispatch({ kind: "add", rgb: [9, 9, 9] });
    expect(a.palette.colors).toHaveLength(9);
    expect(b.palette.colors).toHaveLength(6);
  });
});
