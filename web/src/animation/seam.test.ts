/**
 * F-AN-06 — loop seam validation.
 *
 * The report has to be worth reading, which means two things it would be easy
 * to get wrong:
 *
 * - **It must not be vacuous.** Every value this module produces wraps `frame
 *   mod N` first, so comparing the wrapped evaluation at frame `N` with frame
 *   `0` would check the wrap and nothing else. The per-binding check evaluates
 *   the *unwrapped* extension instead, so the test below can build a modulator
 *   that does not close — by casting past the constructor, the only route such a
 *   value could ever take — and watch the report name it.
 * - **It must distinguish "does not close" from "closes badly".** A hold that
 *   does not divide the frame count still loops; it hitches. That is a warning
 *   and leaves `ok` true, because refusing an export over it would be refusing a
 *   choice the person may have made on purpose.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { binding, patternNode, plainNode, seededNode, testDocument, testRegistry } from "./fixture";
import type { CyclesPerLoop } from "./cycles";
import { planAnimation } from "./plan";
import { PATTERN_ROTATION } from "./temporal";
import { SEAM_PHASE_TOLERANCE, phaseDistance, validateLoopSeam } from "./seam";

beforeAll(() => setLevel("error"));

const registry = testRegistry();

function planWith(
  bindings: Parameters<typeof testDocument>[1] = [],
  options: Parameters<typeof planAnimation>[2] = {},
  clock = { frames: 60, fps: 30 },
) {
  return planAnimation(
    testDocument([plainNode(), patternNode(), seededNode()], bindings, clock),
    registry,
    options,
  );
}

describe("phaseDistance", () => {
  it("measures on the circle, so 0.99 and 0.01 are close", () => {
    expect(phaseDistance(0.25, 0.25)).toBe(0);
    expect(phaseDistance(0.99, 0.01)).toBeCloseTo(0.02, 12);
    expect(phaseDistance(0, 0.5)).toBe(0.5);
  });
});

describe("a document that closes", () => {
  it("reports ok with no issues", () => {
    const report = validateLoopSeam(
      planWith([binding({ nodeId: "pattern", param: "spread", cyclesPerLoop: 3 })]),
    );
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.frames).toBe(60);
    expect(report.hashes).toBeNull();
  });

  it("stays ok for every shape and every integer cycle count", () => {
    for (const shape of ["sine", "triangle", "saw", "square", "smooth-noise", "stepped-random"] as const) {
      for (const cyclesPerLoop of [1, 2, 5]) {
        const report = validateLoopSeam(
          planWith([binding({ nodeId: "pattern", param: "spread", shape, cyclesPerLoop })]),
        );
        expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
      }
    }
  });

  it("stays ok for every temporal mode whose period divides the loop", () => {
    for (const variation of [
      { nodeId: "pattern", mode: "static" },
      { nodeId: "pattern", mode: "blue-noise-cycle", hold: 4, cellPeriod: 64 },
      { nodeId: "pattern", mode: "bayer-offset-scroll", cellsPerLoop: [8, 4], cellPeriod: 4 },
      { nodeId: "pattern", mode: "bayer-rotation", turnsPerLoop: 2 },
      { nodeId: "pattern", mode: "ign-scroll", cellPeriod: 8 },
      { nodeId: "pattern", mode: "golden-ratio-rotation" },
      { nodeId: "seeded", mode: "per-frame-reseed" },
      { nodeId: "seeded", mode: "hold-k-frames", hold: 5 },
      { nodeId: "seeded", mode: "ping-pong", hold: 6 },
    ] as const) {
      const report = validateLoopSeam(planWith([], { variations: [variation] }));
      expect(report.issues).toEqual([]);
      expect(report.ok).toBe(true);
    }
  });
});

describe("a modulator that does not close", () => {
  it("is named, with the cycle count that caused it", () => {
    const plan = planWith([binding({ nodeId: "pattern", param: "spread" })]);
    // The constructor refuses 2.5, so the only way one could reach a render is a
    // cast. This is the case the report has to catch.
    const first = plan.bindings[0];
    if (first === undefined) throw new Error("fixture produced no binding");
    const broken = {
      ...plan,
      bindings: [{ ...first, spec: { ...first.spec, cycles: 2.5 as CyclesPerLoop } }],
    };

    const report = validateLoopSeam(broken);
    expect(report.ok).toBe(false);
    const issue = report.issues.find((candidate) => candidate.code === "phase-not-periodic");
    expect(issue).toBeDefined();
    expect(issue?.nodeId).toBe("pattern");
    expect(issue?.param).toBe("spread");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("F-AN-03");
    expect(issue?.detail.cycles).toBe(2.5);
  });

  it("tolerates rounding but not a real drift", () => {
    expect(SEAM_PHASE_TOLERANCE).toBeLessThan(1e-6);
    expect(phaseDistance(0.3, 0.3 + 1e-15)).toBeLessThan(SEAM_PHASE_TOLERANCE);
    expect(phaseDistance(0.3, 0.3 + 1e-6)).toBeGreaterThan(SEAM_PHASE_TOLERANCE);
  });
});

describe("warnings, which do not stop an export", () => {
  it("reports a hold that does not divide the frame count", () => {
    const report = validateLoopSeam(
      planWith([], { variations: [{ nodeId: "seeded", mode: "hold-k-frames", hold: 7 }] }),
    );
    expect(report.ok).toBe(true);
    const issue = report.issues.find((i) => i.code === "hold-does-not-divide");
    expect(issue?.severity).toBe("warning");
    expect(issue?.detail.lastHold).toBe(60 % 7);
    expect(issue?.message).toContain("the loop closes");
  });

  it("reports a scroll that is not a whole number of pattern periods", () => {
    const report = validateLoopSeam(
      planWith([], {
        variations: [
          {
            nodeId: "pattern",
            mode: "bayer-offset-scroll",
            cellsPerLoop: [6, 8],
            cellPeriod: 4,
          },
        ],
      }),
    );
    expect(report.ok).toBe(true);
    const issue = report.issues.find((i) => i.code === "scroll-not-period-aligned");
    expect(issue?.detail.residualX).toBe(2);
    expect(issue?.detail.residualY).toBe(0);
    expect(issue?.message).toContain("Use a multiple of 4");
  });

  it("reports a negative scroll's residual on the same circle", () => {
    const report = validateLoopSeam(
      planWith([], {
        variations: [
          {
            nodeId: "pattern",
            mode: "bayer-offset-scroll",
            cellsPerLoop: [-8, -6],
            cellPeriod: 4,
          },
        ],
      }),
    );
    const issue = report.issues.find((i) => i.code === "scroll-not-period-aligned");
    expect(issue?.detail.residualX).toBe(0);
    expect(issue?.detail.residualY).toBe(2);
  });

  it("reports a modulator sampled below its own Nyquist limit", () => {
    // stepped-random has 16 steps per cycle, so 4 cycles over 24 frames is 64
    // features in 24 frames: it loops and it renders an alias.
    const report = validateLoopSeam(
      planWith(
        [
          binding({
            nodeId: "pattern",
            param: "spread",
            shape: "stepped-random",
            cyclesPerLoop: 4,
          }),
        ],
        {},
        { frames: 24, fps: 24 },
      ),
    );
    expect(report.ok).toBe(true);
    const issue = report.issues.find((i) => i.code === "sampled-below-nyquist");
    expect(issue?.detail.features).toBe(64);
    expect(issue?.message).toContain("alias");
  });

  it("does not report Nyquist for a shape sampled comfortably", () => {
    const report = validateLoopSeam(
      planWith([binding({ nodeId: "pattern", param: "spread", shape: "sine", cyclesPerLoop: 2 })]),
    );
    expect(report.issues.some((i) => i.code === "sampled-below-nyquist")).toBe(false);
  });

  it("reports a binding whose swing runs past the parameter's legal range", () => {
    const report = validateLoopSeam(
      planWith([binding({ nodeId: "pattern", param: "spread", amount: 5 })]),
    );
    expect(report.ok).toBe(true);
    const issue = report.issues.find((i) => i.code === "binding-clips");
    expect(issue?.detail.legalMin).toBe(0);
    expect(issue?.detail.legalMax).toBe(2);
    expect(issue?.detail.swingMax).toBeGreaterThan(2);
    expect(issue?.message).toContain("flattens the shape");
  });

  it("does not report clipping for a swing that fits", () => {
    const report = validateLoopSeam(
      planWith([binding({ nodeId: "pattern", param: PATTERN_ROTATION, amount: 0.25 })]),
    );
    expect(report.issues.some((i) => i.code === "binding-clips")).toBe(false);
  });
});

describe("the frame hash comparison — the ground truth", () => {
  it("passes when frame N hashes the same as frame 0", () => {
    const report = validateLoopSeam(
      planWith([binding({ nodeId: "pattern", param: "spread", cyclesPerLoop: 3 })]),
      { hashForFrame: () => "same-hash" },
    );
    expect(report.ok).toBe(true);
    expect(report.hashes).toEqual({ frame0: "same-hash", frameN: "same-hash" });
  });

  it("fails, and says nothing in the document explains it, when no binding is at fault", () => {
    const report = validateLoopSeam(
      planWith([binding({ nodeId: "pattern", param: "spread", cyclesPerLoop: 3 })]),
      { hashForFrame: (frame) => `hash-${String(frame)}` },
    );
    expect(report.ok).toBe(false);
    const issue = report.issues.find((i) => i.code === "frame-hash-mismatch");
    expect(issue?.severity).toBe("error");
    expect(issue?.detail.explainedBy).toBe(0);
    expect(issue?.message).toContain("no binding in this document explains it");
    expect(issue?.message).toContain("unseeded draw");
  });

  it("points at the bindings when there are some", () => {
    const plan = planWith([binding({ nodeId: "pattern", param: "spread" })]);
    const first = plan.bindings[0];
    if (first === undefined) throw new Error("fixture produced no binding");
    const broken = {
      ...plan,
      bindings: [{ ...first, spec: { ...first.spec, cycles: 2.5 as CyclesPerLoop } }],
    };
    const report = validateLoopSeam(broken, {
      hashForFrame: (frame) => `hash-${String(frame)}`,
    });
    const issue = report.issues.find((i) => i.code === "frame-hash-mismatch");
    expect(issue?.detail.explainedBy).toBe(1);
    expect(issue?.message).toContain("reported above are the cause");
  });

  it("asks for exactly frame 0 and frame N, and nothing else", () => {
    const asked: number[] = [];
    validateLoopSeam(planWith(), {
      hashForFrame: (frame) => {
        asked.push(frame);
        return "h";
      },
    });
    expect(asked).toEqual([0, 60]);
  });
});

describe("the report never throws", () => {
  it("survives a document with nothing animated at all", () => {
    const report = validateLoopSeam(planWith());
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("survives a one-frame loop", () => {
    const report = validateLoopSeam(
      planWith([binding({ nodeId: "pattern", param: "spread" })], {}, { frames: 1, fps: 1 }),
    );
    // One frame cannot render a sine, and the report says so rather than
    // refusing: a single-frame loop is a still, which is a legitimate document.
    expect(report.ok).toBe(true);
    expect(report.issues.some((i) => i.code === "sampled-below-nyquist")).toBe(true);
  });
});
