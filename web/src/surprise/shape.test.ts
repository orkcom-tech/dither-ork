/**
 * Which shape a surprise is, and what chaos does to that.
 *
 * The decision is three coin flips, so the tests that matter are about the
 * *rates* rather than about any one draw — and one rate carries the whole
 * feature: **at the tame end a surprise is a chain**. A graph generator that
 * quietly made everything a graph would be exactly the regression
 * `docs/dither-ork-node-graph.md` names as the sleeper risk, and the number
 * below is what stops it being possible to introduce without a red test.
 */

import { describe, expect, it } from "vitest";

import {
  PLAIN_CHAIN,
  SHAPE_CHAOS,
  decideShape,
  describeShape,
  lerp,
  shapeLoops,
} from "./shape";
import { streamFor } from "./rng";

const RUNS = 4_000;

interface Rates {
  readonly generator: number;
  readonly feedback: number;
  readonly branch: number;
  /** Documents that are a plain chain over the image — no shape at all. */
  readonly plain: number;
}

function rates(
  chaos: number,
  options: { graph?: boolean; carried?: boolean; blank?: boolean } = {},
): Rates {
  let generator = 0;
  let feedback = 0;
  let branch = 0;
  let plain = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const shape = decideShape(streamFor(BigInt(i) * 0x9e37_79b9n + 1n, "surprise/shape"), {
      chaos,
      graph: options.graph ?? true,
      carriedGenerator: options.carried ?? false,
      blankCanvas: options.blank ?? false,
    });
    if (shape.generator) generator += 1;
    if (shape.feedback) feedback += 1;
    if (shape.branch) branch += 1;
    if (!shape.generator && !shape.feedback && !shape.branch) plain += 1;
  }
  return {
    generator: generator / RUNS,
    feedback: feedback / RUNS,
    branch: branch / RUNS,
    plain: plain / RUNS,
  };
}

describe("chaos governs the shape (F-SM-07)", () => {
  it("is nearly always a plain chain at the tame end", () => {
    const tame = rates(0);
    // The number that protects the feature. A tame surprise is the ordinary
    // thing: the picture you opened, done differently.
    expect(tame.plain).toBeGreaterThan(0.9);
    expect(tame.branch).toBeLessThan(0.1);
  });

  it("never produces feedback at the tame end, so a tame document loops", () => {
    // Exactly zero, not merely rare. A document that will not close a loop is
    // not the predictable thing somebody at this end of the slider asked for.
    expect(rates(0).feedback).toBe(0);
    expect(SHAPE_CHAOS.feedback[0]).toBe(0);
  });

  it("reaches every shape at the wild end", () => {
    const wild = rates(1);
    expect(wild.generator).toBeGreaterThan(0.2);
    expect(wild.feedback).toBeGreaterThan(0.3);
    expect(wild.branch).toBeGreaterThan(0.35);
    // And is still not always a graph — complexity is not quality, so even the
    // wild end leaves plain chains on the table.
    expect(wild.plain).toBeGreaterThan(0.15);
  });

  it("rises monotonically between the two, within sampling noise", () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map((chaos) => rates(chaos));
    for (let i = 1; i < steps.length; i += 1) {
      const before = steps[i - 1];
      const after = steps[i];
      if (before === undefined || after === undefined) continue;
      expect(after.branch).toBeGreaterThan(before.branch - 0.02);
      expect(after.feedback).toBeGreaterThan(before.feedback - 0.02);
      expect(after.plain).toBeLessThan(before.plain + 0.02);
    }
  });

  it("tracks the declared ends", () => {
    for (const chaos of [0, 0.5, 1]) {
      const measured = rates(chaos);
      expect(measured.branch).toBeCloseTo(lerp(SHAPE_CHAOS.branch, chaos), 1);
      expect(measured.feedback).toBeCloseTo(lerp(SHAPE_CHAOS.feedback, chaos), 1);
    }
  });
});

describe("the off switch", () => {
  it("makes a plain chain at every chaos setting", () => {
    for (const chaos of [0, 0.25, 0.5, 0.75, 1]) {
      const measured = rates(chaos, { graph: false });
      expect(measured.plain, `chaos ${chaos}`).toBe(1);
    }
  });

  it("still lets a carried generator through, because it does not stop a loop", () => {
    const measured = rates(1, { graph: false, carried: true });
    expect(measured.generator).toBe(1);
    expect(measured.feedback).toBe(0);
    expect(measured.branch).toBe(0);
  });

  it("is an off switch rather than a low probability", () => {
    // The distinction the exclude exists for: at chaos 1 a feedback document is
    // two in five, and "off" has to mean none rather than fewer.
    expect(rates(1).feedback).toBeGreaterThan(0.3);
    expect(rates(1, { graph: false }).feedback).toBe(0);
  });
});

describe("a blank canvas", () => {
  it("always gets a generator, at every chaos setting", () => {
    // Not a probability. A blank canvas is transparent black, so a document
    // with no generator in it renders the checkerboard and a dither of zeroes —
    // the button would appear to do nothing.
    for (const chaos of [0, 0.5, 1]) {
      expect(rates(chaos, { blank: true }).generator, `chaos ${chaos}`).toBe(1);
    }
  });

  it("gets one even with graph shape turned off", () => {
    // "Make a plain chain" is a request about shape, and a chain with a
    // generator at its head is still a plain chain. Honouring the exclude by
    // handing back an empty picture would be honouring the letter of it.
    const measured = rates(1, { blank: true, graph: false });
    expect(measured.generator).toBe(1);
    expect(measured.feedback).toBe(0);
    expect(measured.branch).toBe(0);
  });
});

describe("a carried generator", () => {
  it("counts as the generator and suppresses the drawn one", () => {
    for (let i = 0; i < 200; i += 1) {
      const shape = decideShape(streamFor(BigInt(i), "surprise/shape"), {
        chaos: 1,
        graph: true,
        carriedGenerator: true,
        blankCanvas: false,
      });
      expect(shape.generator).toBe(true);
      expect(shape.newGenerator).toBe(false);
    }
  });

  it("consumes the same draws either way, so the rest of the surprise does not move", () => {
    // `Pcg32.nextBool` draws whatever the probability is, for exactly this
    // reason: a setting that turns one decision off must not re-roll every
    // decision after it.
    const withCarry = streamFor(42n, "surprise/shape");
    const without = streamFor(42n, "surprise/shape");
    decideShape(withCarry, { chaos: 0.5, graph: true, carriedGenerator: true, blankCanvas: false });
    decideShape(without, { chaos: 0.5, graph: true, carriedGenerator: false, blankCanvas: false });
    expect(withCarry.nextU32()).toBe(without.nextU32());
  });
});

describe("what a shape means downstream", () => {
  it("loops exactly when there is no feedback", () => {
    expect(shapeLoops(PLAIN_CHAIN)).toBe(true);
    expect(shapeLoops({ ...PLAIN_CHAIN, generator: true })).toBe(true);
    expect(shapeLoops({ ...PLAIN_CHAIN, branch: true })).toBe(true);
    expect(shapeLoops({ ...PLAIN_CHAIN, feedback: true })).toBe(false);
  });

  it("describes itself in words a person could read off a panel", () => {
    expect(describeShape(PLAIN_CHAIN)).toBe("chain");
    expect(describeShape({ ...PLAIN_CHAIN, branch: true })).toBe("masked branch");
    expect(
      describeShape({ generator: true, newGenerator: true, feedback: true, branch: true }),
    ).toBe("generated + masked branch + feedback");
  });
});
