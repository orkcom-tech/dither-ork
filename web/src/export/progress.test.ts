/**
 * F-EX-13's arithmetic. A progress bar that jumps, goes backwards or stops
 * short is a defect a person sees before any other, and all three are decided
 * by the stage weights and the clamp.
 */

import { describe, expect, it } from "vitest";

import {
  EXPORT_STAGES,
  ExportCancelledError,
  STAGE_WEIGHTS,
  isCancellation,
  overallProgress,
  stageReporter,
  throwIfCancelled,
} from "./progress";

describe("stage weights", () => {
  it("sum to exactly one, so the bar reaches its end", () => {
    const total = EXPORT_STAGES.reduce((sum, stage) => sum + STAGE_WEIGHTS[stage], 0);
    expect(total).toBeCloseTo(1, 12);
  });
});

describe("overallProgress", () => {
  it("starts each stage where the previous one ended", () => {
    let previous = 0;
    for (const stage of EXPORT_STAGES) {
      expect(overallProgress(stage, 0)).toBeCloseTo(previous, 12);
      previous = overallProgress(stage, 1);
    }
    expect(previous).toBeCloseTo(1, 12);
  });

  it("is monotonic across a whole job", () => {
    let last = -1;
    for (const stage of EXPORT_STAGES) {
      for (const within of [0, 0.25, 0.5, 0.75, 1]) {
        const value = overallProgress(stage, within);
        expect(value).toBeGreaterThanOrEqual(last);
        last = value;
      }
    }
  });

  it("clamps a fraction that overshoots its own stage", () => {
    // A caller dividing by a row count can produce 1.0000001, and a bar past the
    // end of its track is a visible defect for an invisible cause.
    expect(overallProgress("scaling", 2)).toBe(overallProgress("scaling", 1));
    expect(overallProgress("scaling", -1)).toBe(overallProgress("scaling", 0));
  });
});

describe("cancellation", () => {
  it("throws only once the signal has aborted", () => {
    const controller = new AbortController();
    expect(() => throwIfCancelled(controller.signal)).not.toThrow();
    expect(() => throwIfCancelled(undefined)).not.toThrow();
    controller.abort();
    expect(() => throwIfCancelled(controller.signal)).toThrow(ExportCancelledError);
  });

  it("treats a dismissed picker as a cancellation and not as a failure", () => {
    // showSaveFilePicker and the clipboard both reject with an AbortError when
    // the person closes the dialog. That is the same event as pressing cancel.
    const dismissed = new Error("user dismissed");
    dismissed.name = "AbortError";
    expect(isCancellation(dismissed)).toBe(true);
    expect(isCancellation(new ExportCancelledError())).toBe(true);
    expect(isCancellation(new Error("out of memory"))).toBe(false);
  });
});

describe("stageReporter", () => {
  it("maps a stage-local fraction onto the whole job", () => {
    const seen: number[] = [];
    const report = stageReporter("encoding", "encoding PNG", (progress) => {
      expect(progress.stage).toBe("encoding");
      expect(progress.detail).toBe("encoding PNG");
      seen.push(progress.completed);
    });
    report(0);
    report(1);
    expect(seen).toEqual([overallProgress("encoding", 0), overallProgress("encoding", 1)]);
  });

  it("is a no-op when nobody is listening", () => {
    expect(() => stageReporter("encoding", "x", undefined)(0.5)).not.toThrow();
  });
});
