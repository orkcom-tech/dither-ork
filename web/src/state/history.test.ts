/**
 * F-ST-04 — unlimited undo/redo.
 *
 * "Unlimited" is a claim about behaviour, so it is tested as one: ten thousand
 * commits, undone back to the beginning, with every step landing where it was
 * put. A history with a cap of a hundred passes every other test in this file.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { History } from "./history";

setLevel("error");

describe("the basics", () => {
  it("starts with nowhere to go", () => {
    const history = new History("a");
    expect(history.present).toBe("a");
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });

  it("walks back and forward through what happened", () => {
    const history = new History("a");
    history.commit("b", "to b");
    history.commit("c", "to c");

    expect(history.present).toBe("c");
    expect(history.undo()).toBe("b");
    expect(history.undo()).toBe("a");
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toBe("b");
    expect(history.redo()).toBe("c");
    expect(history.canRedo).toBe(false);
  });

  it("labels what undo and redo would do", () => {
    const history = new History("a");
    history.commit("b", "Add Bayer 8×8");
    expect(history.undoLabel).toBe("Add Bayer 8×8");
    expect(history.redoLabel).toBeNull();
    history.undo();
    expect(history.undoLabel).toBeNull();
    expect(history.redoLabel).toBe("Add Bayer 8×8");
  });
});

describe("unlimited", () => {
  it("keeps ten thousand steps and walks all of them back", () => {
    const history = new History(0);
    for (let i = 1; i <= 10_000; i += 1) history.commit(i, `step ${i}`);

    expect(history.present).toBe(10_000);
    expect(history.depth).toBe(10_001);

    for (let i = 9_999; i >= 0; i -= 1) expect(history.undo()).toBe(i);
    expect(history.canUndo).toBe(false);
    expect(history.present).toBe(0);
  });
});

describe("branching", () => {
  it("drops the abandoned future when a new edit lands", () => {
    const history = new History("a");
    history.commit("b", "to b");
    history.commit("c", "to c");
    history.undo();
    expect(history.canRedo).toBe(true);

    history.commit("d", "to d");
    expect(history.canRedo).toBe(false);
    expect(history.present).toBe("d");
    expect(history.undo()).toBe("b");
  });
});

describe("coalescing", () => {
  it("makes one drag one step", () => {
    const history = new History(0);
    history.commit(1, "opacity", "param:n1.opacity");
    history.commit(2, "opacity", "param:n1.opacity");
    history.commit(3, "opacity", "param:n1.opacity");

    // Three moves, one entry, and undo lands where the drag began.
    expect(history.depth).toBe(2);
    expect(history.present).toBe(3);
    expect(history.undo()).toBe(0);
  });

  it("starts a new step for a different control", () => {
    const history = new History(0);
    history.commit(1, "a", "param:n1.a");
    history.commit(2, "b", "param:n1.b");
    expect(history.depth).toBe(3);
    expect(history.undo()).toBe(1);
  });

  it("does not absorb a discrete edit that follows a drag", () => {
    const history = new History(0);
    history.commit(1, "drag", "param:n1.a");
    history.commit(2, "add node", null);
    expect(history.depth).toBe(3);
  });

  it("does not continue a drag across an undo", () => {
    // Undo, then move the same slider again. Replacing the entry the undo just
    // walked out of would rewrite history that has already been visited.
    const history = new History(0);
    history.commit(1, "drag", "param:n1.a");
    history.undo();
    history.commit(5, "drag", "param:n1.a");
    expect(history.present).toBe(5);
    expect(history.undo()).toBe(0);
  });
});

describe("rewrite", () => {
  it("maps every entry and leaves the position alone", () => {
    // What opening a second image does: every reachable state has to name the
    // image that is actually loaded.
    const history = new History({ src: "a", n: 0 });
    history.commit({ src: "a", n: 1 }, "one");
    history.commit({ src: "a", n: 2 }, "two");
    history.undo();

    history.rewrite((state) => ({ ...state, src: "b" }));

    expect(history.present).toEqual({ src: "b", n: 1 });
    expect(history.undo()).toEqual({ src: "b", n: 0 });
    expect(history.redo()).toEqual({ src: "b", n: 1 });
    expect(history.redo()).toEqual({ src: "b", n: 2 });
  });
});
