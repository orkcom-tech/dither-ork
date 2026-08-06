/**
 * `.dork` out and back (F-DO-01), and the refusals (F-DO-08).
 *
 * The round trip is the easy half. The half that matters is what happens to a
 * document that is *not* what it says it is, because every one of those cases
 * has a repair that looks reasonable and produces a document nobody asked for.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../lib/log";
import { DOCUMENT_SCHEMA_VERSION, type DitherDocument } from "../types/document";
import { createDocument } from "./document";
import { DocumentError } from "./errors";
import { testRegistry } from "./fixture";
import { addNode, setNodeParam, setPalette } from "./mutations";
import { decodeDocument, encodeDocument } from "./serialize";

setLevel("error");

const registry = testRegistry();

function sample(): DitherDocument {
  const first = addNode(createDocument(), registry, "test-levels");
  const second = addNode(first.document, registry, "test-diffusion");
  const tuned = setNodeParam(second.document, registry, first.nodeId, "mode", "log");
  return setPalette(tuned, {
    id: "duo",
    name: "Duo",
    colors: [0, 0, 0, 255, 128, 0],
    metric: "srgb",
  });
}

function roundTrip(document: DitherDocument): DitherDocument {
  return decodeDocument(JSON.parse(encodeDocument(document)), registry);
}

describe("round trip", () => {
  it("returns the same document", () => {
    const document = sample();
    expect(roundTrip(document)).toEqual(document);
  });

  it("keeps a source reference and survives having none", () => {
    const withSource: DitherDocument = {
      ...sample(),
      source: { name: "photo.png", width: 800, height: 600 },
    };
    expect(roundTrip(withSource).source).toEqual({
      name: "photo.png",
      width: 800,
      height: 600,
    });
    expect(roundTrip(sample()).source).toBeNull();
  });
});

describe("refusals", () => {
  function refuse(mutate: (raw: Record<string, unknown>) => void): DocumentError {
    const raw = JSON.parse(encodeDocument(sample())) as Record<string, unknown>;
    mutate(raw);
    try {
      decodeDocument(raw, registry);
    } catch (error) {
      if (error instanceof DocumentError) return error;
      throw error;
    }
    throw new Error("the document was accepted; expected a refusal");
  }

  it("refuses a newer schema rather than reading what it recognises", () => {
    const error = refuse((raw) => {
      raw["schema"] = DOCUMENT_SCHEMA_VERSION + 1;
    });
    expect(error.code).toBe("future-schema");
    expect(error.message).toContain(String(DOCUMENT_SCHEMA_VERSION));
  });

  it("refuses an effect this build does not have", () => {
    // The alternative is a plausible picture with one node missing, which is
    // the failure nobody can see.
    const error = refuse((raw) => {
      const stack = raw["stack"] as Record<string, unknown>[];
      const node = stack[0];
      if (node !== undefined) node["effect"] = "gone-in-this-build";
    });
    expect(error.code).toBe("unknown-effect");
  });

  it("refuses two nodes sharing an id", () => {
    const error = refuse((raw) => {
      const stack = raw["stack"] as Record<string, unknown>[];
      const first = stack[0];
      const second = stack[1];
      if (first !== undefined && second !== undefined) second["id"] = first["id"];
    });
    expect(error.code).toBe("malformed-document");
  });

  it("refuses a binding pointing at no node", () => {
    const error = refuse((raw) => {
      raw["bindings"] = [
        {
          nodeId: "n99",
          param: "amount",
          shape: "sine",
          amount: 1,
          cyclesPerLoop: 2,
          phase: 0,
          bipolar: true,
        },
      ];
    });
    expect(error.code).toBe("unknown-node");
  });

  it("refuses a non-integer cyclesPerLoop", () => {
    const error = refuse((raw) => {
      raw["bindings"] = [
        {
          nodeId: (raw["stack"] as Record<string, unknown>[])[0]?.["id"],
          param: "amount",
          shape: "sine",
          amount: 1,
          cyclesPerLoop: 0.5,
          phase: 0,
          bipolar: true,
        },
      ];
    });
    expect(error.message).toContain("cyclesPerLoop");
  });

  it("refuses a malformed palette, clock and blend mode", () => {
    expect(
      refuse((raw) => {
        (raw["palette"] as Record<string, unknown>)["colors"] = [1, 2];
      }).code,
    ).toBe("malformed-document");
    expect(
      refuse((raw) => {
        (raw["clock"] as Record<string, unknown>)["frames"] = 0;
      }).code,
    ).toBe("malformed-document");
    expect(
      refuse((raw) => {
        const node = (raw["stack"] as Record<string, unknown>[])[0];
        if (node !== undefined) node["blend"] = "burn";
      }).code,
    ).toBe("malformed-document");
  });

  it("refuses something that is not a document at all", () => {
    expect(() => decodeDocument([], registry)).toThrow(DocumentError);
    expect(() => decodeDocument(null, registry)).toThrow(DocumentError);
    expect(() => decodeDocument({ schema: 1 }, registry)).toThrow(/no "source"/);
  });
});

describe("parameter coercion on load", () => {
  it("clamps a stored value that is outside the range the effect now declares", () => {
    // A document written by an older build whose legal range was wider. The
    // value is moved to the bound and the registry logs the adjustment; it is
    // not passed through to a kernel that would read it as-is.
    const raw = JSON.parse(encodeDocument(sample())) as Record<string, unknown>;
    const node = (raw["stack"] as Record<string, unknown>[])[0];
    if (node !== undefined) node["params"] = { amount: 40, invert: false, mode: "log" };
    const decoded = decodeDocument(raw, registry);
    expect(decoded.stack[0]?.params["amount"]).toBe(2);
  });

  it("fills in a parameter the document does not carry", () => {
    const raw = JSON.parse(encodeDocument(sample())) as Record<string, unknown>;
    const node = (raw["stack"] as Record<string, unknown>[])[0];
    if (node !== undefined) node["params"] = {};
    const decoded = decodeDocument(raw, registry);
    expect(decoded.stack[0]?.params).toEqual({ amount: 1, invert: false, mode: "linear" });
  });
});
