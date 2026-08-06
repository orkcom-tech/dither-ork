import { describe, expect, it } from "vitest";

import {
  GREY_LEVEL_RANGE,
  OutputModeError,
  derivedColors,
  describeMode,
  entryCount,
  levelValues,
  modeOfKind,
} from "./modes";

describe("levelValues", () => {
  it("spans the full range with both ends included", () => {
    expect(levelValues(2)).toEqual([0, 255]);
    expect(levelValues(3)).toEqual([0, 128, 255]);
    expect(levelValues(5)).toEqual([0, 64, 128, 191, 255]);
  });

  it("spaces levels in sRGB code value, not in linear light", () => {
    // A 4-level device shows four evenly spaced code values. Spacing them
    // linearly instead would put the second level near code 100 and produce a
    // ramp that is visually almost all black.
    expect(levelValues(4)).toEqual([0, 85, 170, 255]);
  });

  it("refuses a level count below two", () => {
    expect(() => levelValues(1)).toThrow(OutputModeError);
  });
});

describe("derivedColors", () => {
  it("makes 1-bit mono two entries", () => {
    expect(derivedColors({ kind: "mono" })).toEqual([
      [0, 0, 0],
      [255, 255, 255],
    ]);
  });

  it("makes N-level greyscale N neutral entries", () => {
    const colors = derivedColors({ kind: "greyscale", levels: 4 });
    expect(colors).toEqual([
      [0, 0, 0],
      [85, 85, 85],
      [170, 170, 170],
      [255, 255, 255],
    ]);
  });

  it("makes per-channel RGB the cross product, red-major", () => {
    const colors = derivedColors({ kind: "rgb", red: 2, green: 2, blue: 2 });
    expect(colors).toEqual([
      [0, 0, 0],
      [0, 0, 255],
      [0, 255, 0],
      [0, 255, 255],
      [255, 0, 0],
      [255, 0, 255],
      [255, 255, 0],
      [255, 255, 255],
    ]);
  });

  it("honours independent level counts per channel", () => {
    const colors = derivedColors({ kind: "rgb", red: 3, green: 2, blue: 4 });
    expect(colors).toHaveLength(3 * 2 * 4);
  });

  it("generates nothing for the indexed mode", () => {
    expect(derivedColors({ kind: "indexed" })).toBeNull();
  });

  it("refuses a level count outside its range", () => {
    expect(() =>
      derivedColors({ kind: "greyscale", levels: GREY_LEVEL_RANGE.max + 1 }),
    ).toThrow(OutputModeError);
    expect(() => derivedColors({ kind: "rgb", red: 17, green: 2, blue: 2 })).toThrow(
      OutputModeError,
    );
  });
});

describe("entryCount", () => {
  it("agrees with what derivedColors produces", () => {
    for (const mode of [
      { kind: "mono" },
      { kind: "greyscale", levels: 7 },
      { kind: "rgb", red: 4, green: 3, blue: 2 },
    ] as const) {
      expect(entryCount(mode, 0)).toBe(derivedColors(mode)?.length);
    }
  });

  it("reports the palette's own length for the indexed mode", () => {
    expect(entryCount({ kind: "indexed" }, 11)).toBe(11);
  });
});

describe("describeMode", () => {
  it("keeps generated ids out of the built-in library's namespace", () => {
    // The core ships a hardware 1-bit palette under the id "mono"; two
    // provenances sharing one id is a document that cannot say where its
    // colours came from.
    expect(describeMode({ kind: "mono" }).id).toBe("output-mono");
    expect(describeMode({ kind: "greyscale", levels: 4 }).id).toBe("output-grey-4");
    expect(describeMode({ kind: "rgb", red: 2, green: 3, blue: 4 }).id).toBe(
      "output-rgb-2-3-4",
    );
  });

  it("refuses to name a palette for the indexed mode, which generates none", () => {
    expect(() => describeMode({ kind: "indexed" })).toThrow(OutputModeError);
  });
});

describe("modeOfKind", () => {
  it("carries level counts across a switch away and back", () => {
    const rgb = { kind: "rgb", red: 4, green: 4, blue: 4 } as const;
    expect(modeOfKind("rgb", rgb)).toEqual(rgb);
    expect(modeOfKind("greyscale", { kind: "greyscale", levels: 9 })).toEqual({
      kind: "greyscale",
      levels: 9,
    });
  });

  it("opens on a sane default coming from another kind", () => {
    expect(modeOfKind("greyscale", { kind: "mono" })).toEqual({
      kind: "greyscale",
      levels: 4,
    });
    expect(modeOfKind("rgb", { kind: "mono" })).toEqual({
      kind: "rgb",
      red: 2,
      green: 2,
      blue: 2,
    });
  });
});
