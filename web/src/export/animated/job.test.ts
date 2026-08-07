/**
 * The job: F-AN-06's gate, F-EX-13's per-frame progress and cancel, and
 * F-EX-14's measured estimate.
 *
 * The source is a double, because `web/src/export/` is not allowed to know that
 * a renderer exists — that is the whole point of `source.ts`. What is under test
 * is the order things happen in and what stops them: a loop that does not close
 * must not render a single frame, and a cancel must stop the render rather than
 * stop the reporting.
 */

import { describe, expect, it, vi } from "vitest";

import type { SeamIssue, SeamReport } from "../../animation";
import { setLevel } from "../../lib/log";
import type { ExportFrame } from "../types";
import {
  ESTIMATE_EXACT_FRAMES,
  estimateAnimatedSize,
  estimateSampleFrames,
} from "./estimate";
import { animatedFileName, encodeAnimation } from "./job";
import { ExportCancelledError, type AnimatedProgress } from "./progress";
import { DEFAULT_ANIMATED_SETTINGS } from "./settings";
import { LoopSeamError, type AnimatedFrameSource, type AnimatedSubject } from "./source";
import type { AnimatedSettings } from "./types";

setLevel("error");

const SETTINGS: AnimatedSettings = { ...DEFAULT_ANIMATED_SETTINGS, format: "apng" };

function issue(overrides: Partial<SeamIssue> = {}): SeamIssue {
  return {
    code: "phase-not-periodic",
    severity: "error",
    nodeId: "node-3",
    param: "angle",
    source: "node-3.angle (sine)",
    message: "node-3.angle (sine) is 0.5 turns away from where it started after one loop.",
    detail: {},
    ...overrides,
  };
}

function report(overrides: Partial<SeamReport> = {}): SeamReport {
  return { ok: true, frames: 12, issues: [], hashes: null, ...overrides };
}

interface FakeSourceOptions {
  readonly seam?: SeamReport;
  readonly frames?: number;
  readonly extent?: number;
  readonly onRender?: (index: number) => void;
}

function fakeSource(options: FakeSourceOptions = {}): {
  source: AnimatedFrameSource;
  rendered: number[];
} {
  const frames = options.frames ?? 12;
  const extent = options.extent ?? 4;
  const rendered: number[] = [];

  const subject: AnimatedSubject = {
    name: "portrait.png",
    width: extent,
    height: extent,
    frames,
    fps: 12,
    soloNodeName: null,
    revision: 1,
  };

  const source: AnimatedFrameSource = {
    subject: () => subject,
    validateLoop: () => Promise.resolve(options.seam ?? report({ frames })),
    subscribe: () => () => undefined,
    async renderFrames(request) {
      const indices =
        request.only ?? Array.from({ length: frames }, (_, index) => index);
      for (const index of indices) {
        if (request.signal?.aborted === true) throw new ExportCancelledError();
        options.onRender?.(index);
        rendered.push(index);
        const data = new Uint8ClampedArray(extent * extent * 4);
        for (let i = 0; i < extent * extent; i += 1) {
          data[i * 4] = (index * 8 + i) % 256;
          data[i * 4 + 3] = 255;
        }
        const frame: ExportFrame = { width: extent, height: extent, data };
        await request.onFrame(index, frame);
      }
    },
  };
  return { source, rendered };
}

describe("the loop seam gate — F-AN-06", () => {
  it("refuses before a single frame is rendered, naming the binding", async () => {
    const { source, rendered } = fakeSource({
      seam: report({ ok: false, issues: [issue()] }),
    });

    const failure = await encodeAnimation({ source, settings: SETTINGS }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(LoopSeamError);
    // The requirement's second half: report *which binding* broke periodicity.
    expect((failure as LoopSeamError).message).toContain("node-3.angle (sine)");
    expect((failure as LoopSeamError).report.issues).toHaveLength(1);
    // Nothing rendered. A sixty-frame render before the refusal would make the
    // check worthless.
    expect(rendered).toEqual([]);
  });

  it("does not refuse for a warning, and carries it into the result", async () => {
    // A hold that does not divide the frame count is a loop that closes and
    // hitches. That may well be what somebody chose; it is reported, not
    // enforced.
    const { source, rendered } = fakeSource({
      frames: 3,
      seam: report({
        frames: 3,
        issues: [
          issue({
            severity: "warning",
            code: "hold-does-not-divide",
            message: "node-3 holds each pattern 2 frames, which does not divide the 3-frame loop.",
          }),
        ],
      }),
    });

    const result = await encodeAnimation({ source, settings: SETTINGS });
    expect(rendered).toEqual([0, 1, 2]);
    expect(result.notes.some((note) => note.includes("does not divide"))).toBe(true);
  });
});

describe("progress — F-EX-13", () => {
  it("reports every frame, with the two numbers a person reads", async () => {
    const { source } = fakeSource({ frames: 4 });
    const seen: AnimatedProgress[] = [];
    await encodeAnimation({
      source,
      settings: SETTINGS,
      onProgress: (progress) => seen.push(progress),
    });

    const rendering = seen.filter((entry) => entry.stage === "rendering");
    expect(rendering).toHaveLength(4);
    expect(rendering.map((entry) => entry.frame)).toEqual([1, 2, 3, 4]);
    expect(rendering.every((entry) => entry.frames === 4)).toBe(true);
    expect(rendering[2]?.detail).toBe("frame 3 of 4");

    // The stages happen in order and the fraction never goes backwards.
    expect(seen[0]?.stage).toBe("validating");
    let previous = -1;
    for (const entry of seen) {
      expect(entry.completed).toBeGreaterThanOrEqual(previous);
      previous = entry.completed;
    }
    expect(seen[seen.length - 1]?.stage).toBe("encoding");
    expect(seen[seen.length - 1]?.completed).toBeCloseTo(1 - 0.02, 6);
  });
});

describe("cancellation — F-EX-13", () => {
  it("stops the render rather than stopping the reporting", async () => {
    const controller = new AbortController();
    const { source, rendered } = fakeSource({
      frames: 20,
      onRender: (index) => {
        if (index === 3) controller.abort();
      },
    });

    await expect(
      encodeAnimation({ source, settings: SETTINGS, signal: controller.signal }),
    ).rejects.toBeInstanceOf(ExportCancelledError);
    // Frames 0..3 were produced; the abort landed inside the loop rather than
    // after it. The exact count is the source's business — what matters is that
    // it is nothing like twenty.
    expect(rendered.length).toBeLessThan(6);
  });

  it("refuses before validating when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const validateLoop = vi.fn();
    const { source } = fakeSource();
    const guarded: AnimatedFrameSource = { ...source, validateLoop };

    await expect(
      encodeAnimation({ source: guarded, settings: SETTINGS, signal: controller.signal }),
    ).rejects.toBeInstanceOf(ExportCancelledError);
    expect(validateLoop).not.toHaveBeenCalled();
  });
});

describe("wiring mistakes", () => {
  it("says so when a GIF is asked for without the core's encoder", async () => {
    const { source } = fakeSource({ frames: 2 });
    await expect(
      encodeAnimation({ source, settings: { ...SETTINGS, format: "gif" } }),
    ).rejects.toThrow(/needs the core's encoder/);
  });

  it("says so when nothing is open", async () => {
    const { source } = fakeSource();
    const empty: AnimatedFrameSource = { ...source, subject: () => null };
    await expect(encodeAnimation({ source: empty, settings: SETTINGS })).rejects.toThrow(
      /nothing to export/,
    );
  });
});

describe("the file name", () => {
  it("never offers the source image's own name back", () => {
    // A picker pre-filled with `portrait.png`, in the folder the person opened
    // `portrait.png` from, is one Enter key away from overwriting the original.
    expect(animatedFileName("portrait.png", SETTINGS, 60)).toBe("portrait-dither-60f.png");
  });

  it("carries the frame count and the multiplier", () => {
    expect(animatedFileName("a.png", { ...SETTINGS, format: "gif", scale: 4 }, 24)).toBe(
      "a-dither-24f@4x.gif",
    );
    expect(animatedFileName(null, { ...SETTINGS, format: "webm" }, 12)).toBe(
      "untitled-dither-12f.webm",
    );
  });

  it("marks a sheet as one, because it is not a loop", () => {
    expect(animatedFileName("a.png", { ...SETTINGS, format: "sprite-sheet" }, 9)).toBe(
      "a-dither-9f-sheet.png",
    );
  });
});

describe("the size estimate — F-EX-14", () => {
  it("encodes a short loop in full and says the answer is exact", async () => {
    const { source, rendered } = fakeSource({ frames: 4 });
    const estimate = await estimateAnimatedSize({ source, settings: SETTINGS });
    expect(estimate.exact).toBe(true);
    expect(estimate.sampledFrames).toBe(4);
    expect(rendered).toEqual([0, 1, 2, 3]);
    expect(estimate.bytes).toBeGreaterThan(0);
  });

  it("samples a long loop and scales, rendering only the sample", async () => {
    const { source, rendered } = fakeSource({ frames: 60 });
    const estimate = await estimateAnimatedSize({ source, settings: SETTINGS });
    expect(estimate.exact).toBe(false);
    expect(estimate.totalFrames).toBe(60);
    // Three real frames through the real encoder, not sixty.
    expect(rendered).toHaveLength(3);
    expect(estimate.bytes).toBeGreaterThan(estimate.bytesPerFrame * 50);
  });

  it("does not run the seam check, because a panel needs an answer while editing", async () => {
    const validateLoop = vi.fn(() => Promise.resolve(report({ ok: false, issues: [issue()] })));
    const { source } = fakeSource({ frames: 4 });
    const guarded: AnimatedFrameSource = { ...source, validateLoop };
    await expect(
      estimateAnimatedSize({ source: guarded, settings: SETTINGS }),
    ).resolves.toBeDefined();
    expect(validateLoop).not.toHaveBeenCalled();
  });

  it("spreads the sample across the loop and always includes frame 0", () => {
    // Frame 0 is the one every format writes in full; a sample without it would
    // miss the keyframe every later frame is a delta against. And the first
    // frames of an animation are frequently its quietest.
    expect(estimateSampleFrames(60, 3)).toEqual([0, 20, 40]);
    expect(estimateSampleFrames(10, 3)).toEqual([0, 3, 6]);
    expect(estimateSampleFrames(2, 3)).toEqual([0, 1]);
    expect(estimateSampleFrames(1, 3)).toEqual([0]);
  });

  it("draws the exact/sampled line where it says it does", async () => {
    const exact = fakeSource({ frames: ESTIMATE_EXACT_FRAMES });
    const sampled = fakeSource({ frames: ESTIMATE_EXACT_FRAMES + 1 });
    expect((await estimateAnimatedSize({ source: exact.source, settings: SETTINGS })).exact).toBe(
      true,
    );
    expect(
      (await estimateAnimatedSize({ source: sampled.source, settings: SETTINGS })).exact,
    ).toBe(false);
  });
});
