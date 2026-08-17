import { describe, expect, it } from "vitest";

import { NO_EXCLUDES, NO_LOCKS } from "../../surprise";
import { UI_CONCEPTS, isUiConceptId } from "../help";
import {
  ASPECT_KEYS,
  CHAOS_STEP,
  DEFAULT_CHAOS,
  EXCLUDABLE_KEYS,
  LOCKABLE_KEYS,
  aspectLabel,
  aspectMode,
  chaosLabel,
  clampChaos,
  describeStack,
  isExcludable,
  isLockable,
  keptCount,
  modeConcept,
  modeHint,
  modeLabel,
  modesFor,
  readiness,
  withAspectMode,
  type AspectKey,
  type AspectState,
} from "./model";

const FRESH: AspectState = { locks: NO_LOCKS, excludes: NO_EXCLUDES };

describe("aspects (F-SM-06, and the excludes beside them)", () => {
  it("names the four the spec lists, and graph shape beside them", () => {
    expect([...ASPECT_KEYS].sort()).toEqual(
      ["animation", "palette", "params", "shape", "stack"].sort(),
    );
  });

  it("starts every aspect at reroll", () => {
    for (const key of ASPECT_KEYS) expect(aspectMode(FRESH, key)).toBe("reroll");
  });

  it("sets one aspect without touching the others", () => {
    const next = withAspectMode(FRESH, "palette", "keep");
    expect(aspectMode(next, "palette")).toBe("keep");
    for (const key of ASPECT_KEYS) {
      if (key === "palette") continue;
      expect(aspectMode(next, key)).toBe("reroll");
    }
  });

  it("comes back to reroll", () => {
    const kept = withAspectMode(FRESH, "stack", "keep");
    expect(aspectMode(withAspectMode(kept, "stack", "reroll"), "stack")).toBe("reroll");
  });

  it("counts what the next press will leave alone", () => {
    expect(keptCount(NO_LOCKS)).toBe(0);
    expect(keptCount({ palette: true, stack: true, params: false, animation: false })).toBe(2);
  });

  it("gives every aspect a label, and every mode it offers a label and a hint", () => {
    for (const key of ASPECT_KEYS) {
      expect(aspectLabel(key).length).toBeGreaterThan(0);
      for (const mode of modesFor(key)) {
        expect(modeLabel(mode).length).toBeGreaterThan(0);
        expect(modeHint(key, mode).length).toBeGreaterThan(0);
      }
    }
  });

  /**
   * The owner's complaint was "it is not clear what the locks mean". A hint that
   * is the same sentence for two different states of the same control is that
   * complaint with more words in it.
   */
  it("says something different for each mode of one aspect", () => {
    for (const key of ASPECT_KEYS) {
      const hints = modesFor(key).map((mode) => modeHint(key, mode));
      expect(new Set(hints).size, key).toBe(hints.length);
    }
  });
});

/**
 * Lock and exclude are mutually exclusive, and the design is that this is
 * *unrepresentable* rather than checked: an aspect carries one mode, and setting
 * it writes the lock and the exclude together. These tests are the proof that no
 * sequence of calls gets around it.
 */
describe("keep and off cannot both be true", () => {
  it("clears the lock when an aspect is turned off", () => {
    const kept = withAspectMode(FRESH, "animation", "keep");
    expect(kept.locks.animation).toBe(true);

    const off = withAspectMode(kept, "animation", "off");
    expect(off.excludes.animation).toBe(true);
    expect(off.locks.animation).toBe(false);
    expect(aspectMode(off, "animation")).toBe("off");
  });

  it("clears the exclude when an aspect is kept again", () => {
    const off = withAspectMode(FRESH, "animation", "off");
    const kept = withAspectMode(off, "animation", "keep");
    expect(kept.locks.animation).toBe(true);
    expect(kept.excludes.animation).toBe(false);
    expect(aspectMode(kept, "animation")).toBe("keep");
  });

  it("clears the exclude when an aspect goes back to reroll", () => {
    const back = withAspectMode(withAspectMode(FRESH, "animation", "off"), "animation", "reroll");
    expect(back).toEqual(FRESH);
  });

  it("never produces a state that is both, however the modes are cycled", () => {
    const modes = ["reroll", "keep", "off", "keep", "reroll", "off"] as const;
    let state = FRESH;
    for (const mode of modes) {
      state = withAspectMode(state, "animation", mode);
      expect(state.locks.animation && state.excludes.animation).toBe(false);
      expect(aspectMode(state, "animation")).toBe(mode);
    }
  });
});

/**
 * An `off` is only offered where the absence is a state a document can hold, and
 * `SurpriseExcludes` in `surprise/generate.ts` is where that is argued. Here it
 * is pinned: three of the four aspects have no third button, and asking for one
 * is a defect that says so rather than a no-op.
 */
describe("which aspects have an off", () => {
  it("offers it for animation and graph shape, and for nothing else", () => {
    expect([...EXCLUDABLE_KEYS].sort()).toEqual(["animation", "shape"]);
    expect(modesFor("animation")).toEqual(["reroll", "keep", "off"]);
    // Graph shape is the one aspect with an off and no keep: locking the stack
    // already keeps the wiring, so a keep here would be a second control for
    // one idea.
    expect(modesFor("shape")).toEqual(["reroll", "off"]);
    for (const key of ASPECT_KEYS) {
      if (isExcludable(key)) continue;
      expect(modesFor(key), key).toEqual(["reroll", "keep"]);
    }
  });

  it("refuses to turn off an aspect a document cannot be without", () => {
    for (const key of ["palette", "stack", "params"] as const) {
      expect(() => withAspectMode(FRESH, key, "off"), key).toThrow(/cannot be turned off/);
      expect(() => modeHint(key, "off"), key).toThrow(/cannot be turned off/);
    }
  });

  it("refuses to keep an aspect that has no keep", () => {
    expect(() => modeHint("shape", "keep")).toThrow(/has no keep/);
  });

  it("offers a mode list every aspect's own label agrees with", () => {
    // `modesFor` is what the panel maps over, so a mode it lists that
    // `withAspectMode` would refuse is a button that throws on click.
    for (const key of ASPECT_KEYS) {
      for (const mode of modesFor(key)) {
        expect(() => withAspectMode(FRESH, key, mode)).not.toThrow();
      }
    }
  });
});

describe("chaos (F-SM-07)", () => {
  it("clamps and snaps to the slider's quantum", () => {
    expect(clampChaos(0.5)).toBe(0.5);
    expect(clampChaos(2)).toBe(1);
    expect(clampChaos(-1)).toBe(0);
    expect(clampChaos(0.51)).toBeCloseTo(0.5, 10);
    expect(clampChaos(0.53)).toBeCloseTo(0.55, 10);
  });

  it("falls back to the default for a value that is not a number", () => {
    expect(clampChaos(Number.NaN)).toBe(DEFAULT_CHAOS);
    expect(clampChaos(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CHAOS);
  });

  it("starts somewhere on the grid", () => {
    expect(clampChaos(DEFAULT_CHAOS)).toBeCloseTo(DEFAULT_CHAOS, 10);
    expect(CHAOS_STEP).toBeGreaterThan(0);
  });

  it("gives the number a word, across the whole range", () => {
    const words = new Set<string>();
    for (let c = 0; c <= 1.0001; c += CHAOS_STEP) words.add(chaosLabel(c));
    expect(words.size).toBeGreaterThanOrEqual(4);
    expect(chaosLabel(0)).toBe("tame");
    expect(chaosLabel(1)).toBe("feral");
  });
});

describe("readiness", () => {
  it("is ready when the image and the library are both there", () => {
    expect(
      readiness({ hasSource: true, libraryReady: true, libraryFailure: null }),
    ).toEqual({ ready: true });
  });

  it("names the missing image first, because that is what a person fixes", () => {
    const verdict = readiness({ hasSource: false, libraryReady: true, libraryFailure: null });
    expect(verdict.ready).toBe(false);
    if (verdict.ready) return;
    expect(verdict.reason).toContain("image");
  });

  /**
   * The library is not optional and this is why: F-SM-05 draws the palette mode
   * from three, and a mode drawn and then found unavailable would have to fall
   * back — making one seed mean two palettes depending on whether the library
   * had finished loading, which is the one promise F-SM-02 makes.
   */
  it("waits for the palette library rather than using two of the three modes", () => {
    const verdict = readiness({ hasSource: true, libraryReady: false, libraryFailure: null });
    expect(verdict.ready).toBe(false);
    if (verdict.ready) return;
    expect(verdict.reason).toContain("library");
  });

  it("reports a library failure rather than saying it is still loading", () => {
    const verdict = readiness({
      hasSource: true,
      libraryReady: false,
      libraryFailure: "the core would not load",
    });
    expect(verdict.ready).toBe(false);
    if (verdict.ready) return;
    expect(verdict.reason).toContain("the core would not load");
  });
});

describe("describeStack", () => {
  it("reads as a pipeline", () => {
    expect(describeStack(["Blur", "Atkinson"])).toBe("Blur → Atkinson");
  });

  it("says so when there is nothing rather than showing an empty string", () => {
    expect(describeStack([])).toBe("empty stack");
  });
});

describe("the aspect keys the panel iterates", () => {
  it("is `SurpriseLocks`'s list for the aspects that lock, plus the ones that only turn off", () => {
    const lockable: readonly AspectKey[] = LOCKABLE_KEYS;
    expect([...lockable].sort()).toEqual(Object.keys(NO_LOCKS).sort());
    // Every aspect the panel iterates either locks or excludes; one that did
    // neither would render a radiogroup with a single button in it.
    for (const key of ASPECT_KEYS) {
      expect(isLockable(key) || isExcludable(key), key).toBe(true);
    }
  });

  it("is the same list `SurpriseExcludes` carries, for the ones that turn off", () => {
    const excludable: readonly AspectKey[] = EXCLUDABLE_KEYS;
    expect([...excludable].sort()).toEqual(Object.keys(NO_EXCLUDES).sort());
  });
});

/**
 * The panel puts a `data-help` token on every mode button, and a token naming a
 * concept nobody wrote opens nothing — `parseHelpToken` would only find out at
 * hover time, on the control whose whole job is to explain itself. So every mode
 * the panel can render is resolved here against the written concepts.
 */
describe("the help each mode points at (F-UI-13)", () => {
  it("names a concept that exists, for every mode of every aspect", () => {
    for (const key of ASPECT_KEYS) {
      for (const mode of modesFor(key)) {
        const concept = modeConcept(mode);
        expect(isUiConceptId(concept), `${key}/${mode} -> ${concept}`).toBe(true);
        expect(UI_CONCEPTS[concept].summary.length).toBeGreaterThan(0);
      }
    }
  });

  it("gives keep and off different articles, because they are opposites", () => {
    expect(modeConcept("keep")).not.toBe(modeConcept("off"));
    expect(UI_CONCEPTS[modeConcept("off")].description).toMatch(/opposite of keep/i);
  });
});
