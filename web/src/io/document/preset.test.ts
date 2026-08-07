/**
 * Presets — F-DO-03 and F-DO-05.
 *
 * The two properties worth more than the round trip:
 *
 * - **A preset has no picture in it.** Both directions: writing one drops the
 *   source, and reading one that has a source refuses the file rather than
 *   emptying it.
 * - **Every document refusal still fires.** A preset is decoded through
 *   `decodeDocument`, so a preset file is exactly as hard to smuggle a broken
 *   stack through as a `.dork` is. A second validator over here would be a
 *   second opinion, and the two would disagree the first time the schema moved.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import { DocumentError } from "../../state/errors";
import { createDocument } from "../../state/document";
import { addNode, setNodeParam, setPalette, setSource } from "../../state/mutations";
import { testRegistry } from "../../state/fixture";
import type { DitherDocument } from "../../types/document";
import { encodeDorkFile } from "./dork";
import { DocumentFileError } from "./errors";
import {
  PRESET_FILE_SCHEMA_VERSION,
  applyPreset,
  decodePresetFile,
  encodePresetFile,
  nextPresetId,
  presetFromDocument,
  requireName,
  type Preset,
} from "./preset";

setLevel("error");

const registry = testRegistry();

const IDENTITY = {
  id: "p1",
  name: "Chunky",
  createdAt: "2026-08-07T12:00:00.000Z",
  note: "a note",
} as const;

function sample(): DitherDocument {
  const levels = addNode(createDocument(), registry, "test-levels");
  const diffusion = addNode(levels.document, registry, "test-diffusion");
  const tuned = setNodeParam(diffusion.document, registry, levels.nodeId, "mode", "log");
  const palette = setPalette(tuned, {
    id: "duo",
    name: "Duo",
    colors: [0, 0, 0, 255, 128, 0],
    metric: "srgb",
  });
  return setSource(palette, { name: "photo.png", width: 800, height: 600 });
}

function preset(): Preset {
  return presetFromDocument(sample(), IDENTITY);
}

describe("a preset is a document with no picture", () => {
  it("drops the source when one is made", () => {
    expect(sample().source).not.toBeNull();
    expect(preset().document.source).toBeNull();
  });

  it("keeps everything else the document had", () => {
    const from = sample();
    const made = preset().document;
    expect(made.stack).toEqual(from.stack);
    expect(made.palette).toEqual(from.palette);
    expect(made.clock).toEqual(from.clock);
    expect(made.bindings).toEqual(from.bindings);
  });

  it("keeps the picture that is open when it is applied", () => {
    const open = setSource(createDocument(), {
      name: "other.png",
      width: 100,
      height: 50,
    });
    const applied = applyPreset(preset(), open);
    expect(applied.source).toEqual(open.source);
    expect(applied.stack).toEqual(preset().document.stack);
    expect(applied.palette).toEqual(preset().document.palette);
  });
});

describe("the file (F-DO-05)", () => {
  it("round trips one preset", () => {
    const [back] = decodePresetFile(encodePresetFile([preset()]), registry);
    expect(back).toEqual(preset());
  });

  it("round trips many, and is byte-identical the second time", () => {
    const many = [
      preset(),
      { ...preset(), id: "p2", name: "Second", note: null },
      { ...preset(), id: "p3", name: "Third" },
    ];
    const once = encodePresetFile(many);
    const twice = encodePresetFile(decodePresetFile(once, registry));
    expect(twice).toBe(once);
  });

  it("round trips the documents inside byte-for-byte", () => {
    const [back] = decodePresetFile(encodePresetFile([preset()]), registry);
    expect(back).toBeDefined();
    if (back === undefined) return;
    expect(encodeDorkFile(back.document)).toBe(encodeDorkFile(preset().document));
  });

  it("writes an empty library rather than refusing to", () => {
    // Deleting the last saved preset has to produce a file, or the store still
    // holds the one that was deleted.
    expect(decodePresetFile(encodePresetFile([]), registry)).toEqual([]);
  });

  it("does not write the built-in flag", () => {
    // It is a fact about where this build got the preset, not about the preset;
    // a stored library that carried it would come back claiming a deleted
    // starter preset is still built in.
    const builtin: Preset = { ...preset(), builtin: true };
    const [back] = decodePresetFile(encodePresetFile([builtin]), registry);
    expect(back?.builtin).toBe(false);
  });
});

describe("refusals", () => {
  function refuse(mutate: (raw: Record<string, unknown>) => void): unknown {
    const raw = JSON.parse(encodePresetFile([preset()])) as Record<string, unknown>;
    mutate(raw);
    try {
      decodePresetFile(JSON.stringify(raw), registry);
    } catch (error) {
      return error;
    }
    throw new Error("the file was accepted; expected a refusal");
  }

  it("refuses a preset file from a newer build (F-DO-08)", () => {
    const error = refuse((raw) => {
      raw["schema"] = PRESET_FILE_SCHEMA_VERSION + 1;
    });
    expect(error).toBeInstanceOf(DocumentFileError);
    expect((error as DocumentFileError).code).toBe("future-schema");
    expect((error as Error).message).toContain(String(PRESET_FILE_SCHEMA_VERSION));
  });

  it("refuses a schema it has no migration from", () => {
    const error = refuse((raw) => {
      raw["schema"] = 0;
    });
    expect((error as DocumentFileError).code).toBe("malformed-preset");
  });

  it("refuses a preset carrying an image reference rather than emptying it", () => {
    const error = refuse((raw) => {
      const presets = raw["presets"] as Record<string, unknown>[];
      const first = presets[0];
      if (first === undefined) return;
      const document = first["document"] as Record<string, unknown>;
      document["source"] = { name: "photo.png", width: 800, height: 600 };
    });
    expect((error as DocumentFileError).code).toBe("preset-carries-a-source");
    expect((error as Error).message).toContain("photo.png");
  });

  it("refuses an effect this build does not have, through the document decoder", () => {
    const error = refuse((raw) => {
      const presets = raw["presets"] as Record<string, unknown>[];
      const first = presets[0];
      if (first === undefined) return;
      const document = first["document"] as Record<string, unknown>;
      const stack = document["stack"] as Record<string, unknown>[];
      const node = stack[0];
      if (node !== undefined) node["effect"] = "gone-in-this-build";
    });
    expect(error).toBeInstanceOf(DocumentError);
    expect((error as DocumentError).code).toBe("unknown-effect");
  });

  it("refuses two presets sharing an id", () => {
    const error = refuse((raw) => {
      const presets = raw["presets"] as Record<string, unknown>[];
      const first = presets[0];
      if (first !== undefined) presets.push({ ...first });
    });
    expect((error as DocumentFileError).code).toBe("malformed-preset");
  });

  it("refuses a preset with no readable timestamp", () => {
    const error = refuse((raw) => {
      const presets = raw["presets"] as Record<string, unknown>[];
      const first = presets[0];
      if (first !== undefined) first["createdAt"] = "whenever";
    });
    expect((error as DocumentFileError).code).toBe("malformed-preset");
  });

  it("refuses a document opened as a preset file, by name", () => {
    const error = (() => {
      try {
        decodePresetFile(encodeDorkFile(sample()), registry, "photo.dork");
      } catch (thrown) {
        return thrown;
      }
      throw new Error("accepted");
    })();
    expect((error as DocumentFileError).code).toBe("unrecognised-file");
    expect((error as Error).message).toContain(".dork document");
  });
});

describe("names and ids", () => {
  it("refuses a name that is empty once trimmed", () => {
    expect(() => requireName("   ")).toThrow(DocumentFileError);
  });

  it("collapses whitespace and clips a name to something a row can show", () => {
    expect(requireName("  two   words  ")).toBe("two words");
    expect(requireName("x".repeat(200)).length).toBe(80);
  });

  it("hands out an id no existing preset holds", () => {
    expect(nextPresetId([])).toBe("p1");
    expect(nextPresetId(["p1", "p2"])).toBe("p3");
    // Ids that are not this build's shape are ignored rather than counted, so an
    // imported library cannot make the counter jump or collide.
    expect(nextPresetId(["starter/crt", "p4", "anything"])).toBe("p5");
  });
});
