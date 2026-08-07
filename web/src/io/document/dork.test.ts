/**
 * The `.dork` file — F-DO-01, F-DO-02, and the refusals that are about the file
 * rather than the document.
 *
 * **The round trip is the thing tested hardest**, and it is tested as
 * *byte-identity* rather than as deep equality. A document format that loses a
 * parameter is worse than none, and the failure is invisible in a `toEqual`
 * over two objects that were both built by the same coercion: comparing the
 * bytes compares what was actually written down.
 *
 * The document under test carries one of every parameter kind the schema can
 * hold — a float, a bool, an enum, a colour and a curve — because the composite
 * two are the ones a naive `JSON.stringify`/`JSON.parse` pair round trips while
 * the *decoder* quietly replaces them with descriptor defaults.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import type { EffectDescriptor } from "../../types/registry";
import { createEffectRegistry } from "../../registry";
import { DocumentError } from "../../state/errors";
import { createDocument } from "../../state/document";
import { addNode, setNodeParam, setPalette, setSource } from "../../state/mutations";
import { TEST_DIFFUSION, TEST_INVERT, TEST_LEVELS } from "../../state/fixture";
import type { DitherDocument } from "../../types/document";
import { DocumentFileError } from "./errors";
import {
  documentFileName,
  encodeDorkFile,
  isSelfContained,
  parseDorkFile,
  safeFileStem,
  withEmbeddedSource,
  withoutEmbeddedSource,
} from "./dork";
import { encodePresetFile } from "./preset";

setLevel("error");

/**
 * The state fixture plus an effect carrying a colour and a curve.
 *
 * Those two kinds exist in the registry and therefore in documents, and they are
 * the round trip's hard case: both are composite JSON values that the parameter
 * coercion has to recognise as themselves rather than fall back on.
 */
const TEST_COMPOSITE: EffectDescriptor = {
  id: "test-composite",
  name: "Test Composite",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
  keywords: ["fixture", "test"],
  requirement: "F-PP-05",
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: [
    {
      key: "tint",
      label: "Tint",
      description:
        "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
      type: "color",
      animatable: false,
      default: [255, 128, 0],
      surprise: {
        lightness: [0.3, 0.8],
        chroma: [0.05, 0.2],
        hue: [0, 359],
        weight: 1,
      },
    },
    {
      key: "shape",
      label: "Shape",
      description:
        "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
      type: "curve",
      animatable: false,
      default: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      surprise: {
        archetypes: [
          { value: "linear", weight: 1 },
          { value: "s-curve", weight: 1 },
        ],
        jitter: 0.1,
        weight: 1,
      },
    },
  ],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
};

const registry = createEffectRegistry([
  { descriptor: TEST_LEVELS, module: "test/levels" },
  { descriptor: TEST_DIFFUSION, module: "test/diffusion" },
  { descriptor: TEST_INVERT, module: "test/invert" },
  { descriptor: TEST_COMPOSITE, module: "test/composite" },
]);

function sample(): DitherDocument {
  const levels = addNode(createDocument(), registry, "test-levels");
  const composite = addNode(levels.document, registry, "test-composite");
  const diffusion = addNode(composite.document, registry, "test-diffusion");

  let document = diffusion.document;
  document = setNodeParam(document, registry, levels.nodeId, "mode", "log");
  document = setNodeParam(document, registry, levels.nodeId, "amount", 0.375);
  document = setNodeParam(document, registry, composite.nodeId, "tint", [12, 200, 34]);
  document = setNodeParam(document, registry, composite.nodeId, "shape", [
    { x: 0, y: 0.25 },
    { x: 0.5, y: 0.75 },
    { x: 1, y: 1 },
  ]);
  document = setPalette(document, {
    id: "duo",
    name: "Duo",
    colors: [0, 0, 0, 255, 128, 0],
    metric: "srgb",
  });
  return setSource(document, { name: "photo.jpg", width: 1600, height: 1200 });
}

describe("round trip", () => {
  it("save, load and save again is byte-identical", () => {
    const document = sample();
    const once = encodeDorkFile(document);
    const twice = encodeDorkFile(parseDorkFile(once, registry));
    expect(twice).toBe(once);
  });

  it("returns a document equal in every field", () => {
    const document = sample();
    expect(parseDorkFile(encodeDorkFile(document), registry)).toEqual(document);
  });

  it("keeps a colour parameter as three integers, not a default", () => {
    const document = sample();
    const back = parseDorkFile(encodeDorkFile(document), registry);
    const node = back.stack.find((entry) => entry.effect === "test-composite");
    expect(node?.params["tint"]).toEqual([12, 200, 34]);
  });

  it("keeps every point of a curve parameter", () => {
    const document = sample();
    const back = parseDorkFile(encodeDorkFile(document), registry);
    const node = back.stack.find((entry) => entry.effect === "test-composite");
    expect(node?.params["shape"]).toEqual([
      { x: 0, y: 0.25 },
      { x: 0.5, y: 0.75 },
      { x: 1, y: 1 },
    ]);
  });

  it("survives a document with no source and no nodes", () => {
    const empty = createDocument();
    expect(parseDorkFile(encodeDorkFile(empty), registry)).toEqual(empty);
  });
});

describe("canonical bytes", () => {
  it("do not depend on the order the fields were assigned", () => {
    const document = sample();
    // The same values, built in a different order. `JSON.stringify` would write
    // these two differently; the canonical encoder must not.
    const shuffled: DitherDocument = {
      bindings: document.bindings,
      clock: document.clock,
      palette: document.palette,
      stack: document.stack,
      source: document.source,
      schema: document.schema,
    };
    expect(encodeDorkFile(shuffled)).toBe(encodeDorkFile(document));
  });

  it("do not depend on the order a node's parameters were set", () => {
    const a = setNodeParam(
      setNodeParam(sample(), registry, "n1", "amount", 0.5),
      registry,
      "n1",
      "invert",
      true,
    );
    const b = setNodeParam(
      setNodeParam(sample(), registry, "n1", "invert", true),
      registry,
      "n1",
      "amount",
      0.5,
    );
    expect(encodeDorkFile(a)).toBe(encodeDorkFile(b));
  });

  it("write the fields in the order docs/API.md documents", () => {
    const keys = Object.keys(JSON.parse(encodeDorkFile(sample())) as object);
    expect(keys).toEqual(["schema", "source", "palette", "clock", "stack", "bindings"]);
  });
});

describe("the self-contained variant (F-DO-02)", () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";

  it("carries the image and comes back with it", () => {
    const embedded = withEmbeddedSource(sample(), dataUrl);
    expect(isSelfContained(embedded)).toBe(true);
    const back = parseDorkFile(encodeDorkFile(embedded), registry);
    expect(back.source?.dataUrl).toBe(dataUrl);
    expect(encodeDorkFile(back)).toBe(encodeDorkFile(embedded));
  });

  it("is the same document once the image is taken back out", () => {
    const document = sample();
    expect(withoutEmbeddedSource(withEmbeddedSource(document, dataUrl))).toEqual(document);
    expect(isSelfContained(document)).toBe(false);
  });

  it("refuses to embed into a document with nothing open", () => {
    // The alternative is inventing a zero-sized source so the call can succeed.
    expect(() => withEmbeddedSource(createDocument(), dataUrl)).toThrow(DocumentFileError);
  });
});

describe("refusals", () => {
  it("refuses bytes that are not JSON, and says what they start with", () => {
    try {
      parseDorkFile("<!doctype html><html>", registry, "stack.dork");
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentFileError);
      expect((error as DocumentFileError).code).toBe("not-json");
      expect((error as Error).message).toContain("<!doctype");
    }
  });

  it("refuses a preset file opened as a document, by name", () => {
    const text = encodePresetFile([]);
    try {
      parseDorkFile(text, registry, "library.dorkpresets");
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentFileError);
      expect((error as DocumentFileError).code).toBe("unrecognised-file");
      expect((error as Error).message).toContain("preset file");
    }
  });

  it("refuses JSON that is neither", () => {
    expect(() => parseDorkFile('{"hello":"world"}', registry)).toThrow(DocumentFileError);
  });

  it("passes a newer schema through to the document decoder's refusal (F-DO-08)", () => {
    // The refusal is `state/serialize.ts`'s and must not be re-implemented here;
    // this asserts it is still the one that fires.
    const raw = JSON.parse(encodeDorkFile(sample())) as Record<string, unknown>;
    raw["schema"] = 99;
    try {
      parseDorkFile(JSON.stringify(raw), registry);
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentError);
      expect((error as DocumentError).code).toBe("future-schema");
    }
  });

  it("passes an unknown effect through to the document decoder's refusal", () => {
    const raw = JSON.parse(encodeDorkFile(sample())) as Record<string, unknown>;
    const stack = raw["stack"] as Record<string, unknown>[];
    const node = stack[0];
    if (node !== undefined) node["effect"] = "gone-in-this-build";
    try {
      parseDorkFile(JSON.stringify(raw), registry);
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentError);
      expect((error as DocumentError).code).toBe("unknown-effect");
    }
  });
});

describe("naming", () => {
  it("names the file after the image", () => {
    expect(documentFileName(sample())).toBe("photo.dork");
  });

  it("marks the self-contained variant, which is an order of magnitude larger", () => {
    expect(documentFileName(sample(), { selfContained: true })).toBe("photo-embedded.dork");
  });

  it("falls back rather than producing a file called \".dork\"", () => {
    expect(documentFileName(createDocument())).toBe("untitled.dork");
    expect(safeFileStem("///", "untitled")).toBe("untitled");
  });

  it("removes the characters a path or a Windows filesystem would refuse", () => {
    expect(safeFileStem('a/b\\c:d*e?f"g<h>i|j.png', "untitled")).toBe("a b c d e f g h i j");
  });

  it("keeps a name that is already fine", () => {
    expect(safeFileStem("Sunset over the pier.png", "untitled")).toBe("Sunset over the pier");
  });
});
