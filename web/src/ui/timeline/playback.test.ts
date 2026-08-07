import { describe, expect, it } from "vitest";

import {
  IDLE_REPORT,
  KEEPING_UP,
  METER_WINDOW_MS,
  PlaybackMeter,
  describePlayback,
  frameAtElapsed,
  loopsElapsed,
} from "./playback";

describe("frameAtElapsed", () => {
  it("advances one frame per 1/fps of a second", () => {
    expect(frameAtElapsed(0, 0, 30, 60)).toBe(0);
    expect(frameAtElapsed(0, 33.2, 30, 60)).toBe(0);
    expect(frameAtElapsed(0, 33.4, 30, 60)).toBe(1);
    expect(frameAtElapsed(0, 1000, 30, 60)).toBe(30);
  });

  it("does not drift, because it is computed from the origin rather than accumulated", () => {
    const fps = 24;
    const frames = 48;
    // Two seconds at 24 fps is exactly two loops of a 48-frame document.
    expect(frameAtElapsed(0, 2000, fps, frames)).toBe(0);
    // And a thousand loops later it is still exactly frame 0.
    expect(frameAtElapsed(0, 2000 * 1000, fps, frames)).toBe(0);
  });

  it("skips the frames a stall took, rather than falling behind by them", () => {
    // Playback started at frame 0; 500 ms later, whatever happened in between,
    // the frame to show is the one that belongs to 500 ms.
    expect(frameAtElapsed(0, 500, 30, 60)).toBe(15);
  });

  it("wraps, and collapses -0 the way the clock does", () => {
    expect(frameAtElapsed(50, 500, 30, 60)).toBe(5);
    expect(Object.is(frameAtElapsed(0, 2000, 30, 60), 0)).toBe(true);
  });

  it("holds at the start frame for a clock that has not moved or went backwards", () => {
    expect(frameAtElapsed(7, 0, 30, 60)).toBe(7);
    expect(frameAtElapsed(7, -10, 30, 60)).toBe(7);
    expect(frameAtElapsed(7, Number.NaN, 30, 60)).toBe(7);
  });
});

describe("loopsElapsed", () => {
  it("counts completed repeats", () => {
    expect(loopsElapsed(0, 0, 24, 48)).toBe(0);
    expect(loopsElapsed(0, 1999, 24, 48)).toBe(0);
    expect(loopsElapsed(0, 2000, 24, 48)).toBe(1);
    expect(loopsElapsed(0, 4000, 24, 48)).toBe(2);
  });
});

describe("PlaybackMeter", () => {
  it("counts what the last second managed", () => {
    const meter = new PlaybackMeter(METER_WINDOW_MS);
    for (let i = 0; i < 24; i += 1) meter.note(true, i * 40);
    const report = meter.report(960, 24);
    expect(report.presented).toBe(24);
    expect(report.dropped).toBe(0);
    expect(report.effectiveFps).toBe(24);
    expect(report.behind).toBe(false);
  });

  it("forgets events that fell out of the window", () => {
    const meter = new PlaybackMeter(1000);
    meter.note(true, 0);
    meter.note(true, 100);
    // At 1050 the event at 0 is 1050 ms old and gone; the one at 100 is not.
    expect(meter.report(1050, 24).presented).toBe(1);
    expect(meter.report(3000, 24).presented).toBe(0);
  });

  it("calls playback behind when it falls short of the document's own rate", () => {
    const meter = new PlaybackMeter(1000);
    // Ten frames in a second against a target of 24.
    for (let i = 0; i < 10; i += 1) meter.note(true, i * 100);
    const report = meter.report(1000, 24);
    expect(report.effectiveFps).toBeLessThan(24 * KEEPING_UP);
    expect(report.behind).toBe(true);
  });

  it("does not call one dropped frame a failure", () => {
    const meter = new PlaybackMeter(1000);
    for (let i = 0; i < 24; i += 1) meter.note(true, i * 40);
    meter.note(false, 500);
    const report = meter.report(960, 24);
    expect(report.dropped).toBe(1);
    expect(report.behind).toBe(false);
  });

  it("resets", () => {
    const meter = new PlaybackMeter(1000);
    meter.note(true, 0);
    meter.reset();
    expect(meter.report(0, 24).presented).toBe(0);
  });
});

describe("describePlayback", () => {
  it("says nothing when there is nothing to say", () => {
    expect(describePlayback(IDLE_REPORT, 24, 1)).toBe("");
  });

  it("states the reduction, the shortfall and the drops — each only when real", () => {
    expect(describePlayback({ ...IDLE_REPORT, dropped: 3 }, 24, 1)).toBe("3 dropped");
    expect(describePlayback(IDLE_REPORT, 24, 0.5)).toBe("50% resolution");
    expect(
      describePlayback({ presented: 9, dropped: 2, effectiveFps: 9, behind: true }, 24, 0.5),
    ).toBe("9/24 fps · 2 dropped · 50% resolution");
  });
});
