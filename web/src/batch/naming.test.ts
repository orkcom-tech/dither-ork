import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPLATE,
  NAME_TOKENS,
  UNTITLED_OUTPUT,
  applyTemplate,
  collisionsIn,
  indexWidth,
  outputFileName,
  sanitiseName,
  templateRefusal,
  templateUsesExtent,
  unknownTokensIn,
  type NameContext,
} from "./naming";

function context(overrides: Partial<NameContext> = {}): NameContext {
  return {
    sourceName: "beach.png",
    index: 0,
    total: 1,
    presetName: "seaside",
    width: 640,
    height: 480,
    format: "png",
    ...overrides,
  };
}

describe("tokens", () => {
  it("expands every token it advertises", () => {
    for (const token of NAME_TOKENS) {
      const out = applyTemplate(`{${token.id}}`, context());
      expect(out.length, `{${token.id}} expanded to nothing`).toBeGreaterThan(0);
      expect(out, `{${token.id}} was left unexpanded`).not.toContain("{");
    }
  });

  it("takes the stem of the source name, not the whole file name", () => {
    expect(applyTemplate("{name}", context({ sourceName: "holiday/beach.png" }))).toBe(
      "beach",
    );
    expect(applyTemplate("{name}", context({ sourceName: "portrait.v2.png" }))).toBe(
      "portrait.v2",
    );
  });

  it("shows the index from one, padded to the queue's width", () => {
    expect(applyTemplate("{index}", context({ index: 0, total: 9 }))).toBe("1");
    expect(applyTemplate("{index}", context({ index: 0, total: 10 }))).toBe("01");
    expect(applyTemplate("{index}", context({ index: 99, total: 200 }))).toBe("100");
  });

  it("pads so that ten sorts after nine and before one hundred", () => {
    const names = [0, 9, 99].map((index) =>
      applyTemplate("{index}", context({ index, total: 100 })),
    );
    expect([...names].sort()).toEqual(names);
  });

  it("uses the output extent it is given", () => {
    expect(
      applyTemplate("{width}x{height}", context({ width: 1920, height: 1080 })),
    ).toBe("1920x1080");
  });

  it("leaves an unknown token visibly wrong rather than blank", () => {
    // A blank would produce a plausible name for a template with a typo in it.
    expect(applyTemplate("{naem}", context())).toContain("naem");
  });
});

describe("indexWidth", () => {
  it("is at least one, so a queue of one still produces a digit", () => {
    expect(indexWidth(0)).toBe(1);
    expect(indexWidth(1)).toBe(1);
    expect(indexWidth(9)).toBe(1);
    expect(indexWidth(10)).toBe(2);
    expect(indexWidth(1000)).toBe(4);
  });
});

describe("sanitiseName", () => {
  it("drops what a filesystem will not take", () => {
    expect(sanitiseName('a<b>c:d"e/f\\g|h?i*j')).toBe("abcdefghij");
  });

  it("drops control characters without eating the printable range", () => {
    // The failure this pins: a character class written from a space rather than
    // from NUL removes every printable character up to the next bound.
    expect(sanitiseName("a\u0007b\u001fc\u007fd")).toBe("abcd");
    expect(sanitiseName("keep me")).toBe("keep me");
  });

  it("refuses to produce a hidden file", () => {
    expect(sanitiseName("...dither")).toBe("dither");
  });

  it("falls back rather than returning an empty stem", () => {
    expect(sanitiseName("///")).toBe(UNTITLED_OUTPUT);
    expect(sanitiseName("   ")).toBe(UNTITLED_OUTPUT);
  });

  it("keeps names bounded", () => {
    expect(sanitiseName("x".repeat(400)).length).toBeLessThanOrEqual(120);
  });
});

describe("outputFileName", () => {
  it("appends the format's own extension", () => {
    expect(outputFileName("{name}", context({ format: "jpeg" }))).toBe("beach.jpg");
    expect(outputFileName("{name}", context({ format: "svg" }))).toBe("beach.svg");
  });

  it("never produces the input's own name under the default template", () => {
    // The whole point of the `-dither` marker: a batch written back into the
    // folder it read must not overwrite the originals.
    const name = outputFileName(DEFAULT_TEMPLATE, context({ sourceName: "beach.png" }));
    expect(name).not.toBe("beach.png");
    expect(name).toBe("beach-dither.png");
  });
});

describe("templateRefusal", () => {
  it("accepts the default", () => {
    expect(templateRefusal(DEFAULT_TEMPLATE)).toBeNull();
  });

  it("refuses an empty template", () => {
    expect(templateRefusal("   ")).toContain("empty");
  });

  it("names every unknown token, and the ones that exist", () => {
    const refusal = templateRefusal("{naem}-{indx}");
    expect(refusal).toContain("{naem}");
    expect(refusal).toContain("{indx}");
    expect(refusal).toContain("{name}");
  });

  it("finds each unknown token once", () => {
    expect(unknownTokensIn("{q}{q}{q}")).toEqual(["q"]);
  });
});

describe("templateUsesExtent", () => {
  it("is true only for the two tokens that need a rendered frame", () => {
    expect(templateUsesExtent("{name}-{index}")).toBe(false);
    expect(templateUsesExtent("{name}-{width}")).toBe(true);
    expect(templateUsesExtent("{height}")).toBe(true);
  });
});

describe("collisionsIn", () => {
  it("reports a name produced twice, once", () => {
    expect(collisionsIn(["a", "b", "a", "a"])).toEqual(["a"]);
  });

  it("compares case-insensitively, because Windows and macOS do", () => {
    expect(collisionsIn(["Beach.png", "beach.png"])).toEqual(["beach.png"]);
  });

  it("is empty when every name is distinct", () => {
    expect(collisionsIn(["a", "b", "c"])).toEqual([]);
  });

  it("is empty when {index} is in play", () => {
    const names = ["holiday/beach.png", "work/beach.png"].map((sourceName, index) =>
      outputFileName("{name}-{index}", context({ sourceName, index, total: 2 })),
    );
    expect(collisionsIn(names)).toEqual([]);
  });

  it("catches the collision {index} would have prevented", () => {
    const names = ["holiday/beach.png", "work/beach.png"].map((sourceName, index) =>
      outputFileName("{name}", context({ sourceName, index, total: 2 })),
    );
    expect(collisionsIn(names)).toEqual(["beach.png"]);
  });
});
