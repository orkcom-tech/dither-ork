import { describe, expect, it } from "vitest";

import { clampComponent, fromHex, toHex, withComponent } from "./color";

describe("clampComponent", () => {
  it("holds a channel in the 8-bit range and rounds it", () => {
    expect(clampComponent(-4)).toBe(0);
    expect(clampComponent(300)).toBe(255);
    expect(clampComponent(127.6)).toBe(128);
  });

  it("turns a non-number into black rather than into NaN", () => {
    expect(clampComponent(Number.NaN)).toBe(0);
  });
});

describe("toHex", () => {
  it("pads every channel to two digits", () => {
    expect(toHex([0, 0, 0])).toBe("#000000");
    expect(toHex([255, 255, 255])).toBe("#ffffff");
    expect(toHex([1, 2, 3])).toBe("#010203");
  });
});

describe("fromHex", () => {
  it("reads six digits, with or without the hash", () => {
    expect(fromHex("#8ee06a")).toEqual([142, 224, 106]);
    expect(fromHex("8EE06A")).toEqual([142, 224, 106]);
  });

  it("expands the three-digit form", () => {
    expect(fromHex("#f0a")).toEqual([255, 0, 170]);
  });

  it("rejects anything that is not a colour", () => {
    expect(fromHex("")).toBeNull();
    expect(fromHex("#12345")).toBeNull();
    expect(fromHex("#zzzzzz")).toBeNull();
    expect(fromHex("rgb(1,2,3)")).toBeNull();
  });

  it("round-trips through toHex", () => {
    const triplet = [12, 240, 7] as const;
    expect(fromHex(toHex(triplet))).toEqual([12, 240, 7]);
  });
});

describe("withComponent", () => {
  it("replaces one channel and leaves the others", () => {
    expect(withComponent([1, 2, 3], 1, 200)).toEqual([1, 200, 3]);
  });

  it("clamps the replacement", () => {
    expect(withComponent([1, 2, 3], 2, 999)).toEqual([1, 2, 255]);
  });
});
