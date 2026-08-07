/**
 * The documents panel's pure half.
 *
 * The search and the suggested name are the two that carry a real decision:
 * searching the *contents* rather than only the name, and proposing the last
 * dither rather than the first node. Both are easy to write the other way and
 * neither failure is visible without trying it.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import { createDocument } from "../../state/document";
import { addNode } from "../../state/mutations";
import { testRegistry } from "../../state/fixture";
import { presetFromDocument, type Preset } from "../../io/document";
import { formatBytes, presetSummary, searchPresets, suggestPresetName } from "./model";

setLevel("error");

const registry = testRegistry();

function documentWith(...effects: readonly string[]) {
  let document = createDocument();
  for (const effect of effects) document = addNode(document, registry, effect).document;
  return document;
}

function preset(name: string, effects: readonly string[], note: string | null = null): Preset {
  return presetFromDocument(documentWith(...effects), {
    id: name,
    name,
    createdAt: "2026-08-07T00:00:00.000Z",
    note,
  });
}

describe("formatBytes", () => {
  it("uses the units a download shelf uses", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_500)).toBe("1.5 kB");
    expect(formatBytes(13_400_000)).toBe("13.4 MB");
    expect(formatBytes(2_500_000_000)).toBe("2.50 GB");
  });

  it("says so rather than printing NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("unknown size");
    expect(formatBytes(-1)).toBe("unknown size");
  });
});

describe("searchPresets", () => {
  const library: readonly Preset[] = [
    preset("Chunky", ["test-levels", "test-diffusion"], "crushed then diffused"),
    preset("Flat", ["test-invert"]),
    preset("Plain", []),
  ];

  it("returns the library untouched for an empty query", () => {
    expect(searchPresets(library, "   ", registry)).toBe(library);
  });

  it("matches the name", () => {
    expect(searchPresets(library, "chunk", registry).map((p) => p.name)).toEqual(["Chunky"]);
  });

  it("matches the note", () => {
    expect(searchPresets(library, "diffused", registry).map((p) => p.name)).toEqual([
      "Chunky",
    ]);
  });

  it("matches an effect inside the preset, which is what people remember", () => {
    expect(searchPresets(library, "Test Invert", registry).map((p) => p.name)).toEqual([
      "Flat",
    ]);
  });

  it("narrows on every term rather than widening", () => {
    expect(searchPresets(library, "chunky invert", registry)).toEqual([]);
  });
});

describe("presetSummary", () => {
  it("names the chain in stack order", () => {
    expect(presetSummary(preset("x", ["test-levels", "test-diffusion"]), registry)).toBe(
      "2 nodes · Test Levels → Test Diffusion · 2 colours",
    );
  });

  it("counts the rest rather than running off the row", () => {
    const long = preset("x", [
      "test-levels",
      "test-levels",
      "test-levels",
      "test-diffusion",
      "test-invert",
    ]);
    expect(presetSummary(long, registry)).toContain("→ +2");
  });

  it("says so when there is nothing in it", () => {
    expect(presetSummary(preset("x", []), registry)).toBe("empty stack");
  });
});

describe("suggestPresetName", () => {
  it("proposes the dither, which is what the look is called", () => {
    expect(suggestPresetName(documentWith("test-levels", "test-diffusion"), registry)).toBe(
      "Test Diffusion",
    );
  });

  it("proposes the last dither, since that is the one the picture ends up looking like", () => {
    const twice = documentWith("test-diffusion", "test-levels", "test-diffusion");
    expect(suggestPresetName(twice, registry)).toBe("Test Diffusion");
  });

  it("falls back to the first node when nothing quantizes", () => {
    expect(suggestPresetName(documentWith("test-levels", "test-invert"), registry)).toBe(
      "Test Levels",
    );
  });

  it("proposes nothing for an empty stack rather than inventing a name", () => {
    expect(suggestPresetName(createDocument(), registry)).toBe("");
  });
});
