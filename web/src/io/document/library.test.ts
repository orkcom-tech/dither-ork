/**
 * The preset library — F-DO-03's browse, apply, rename, delete and F-DO-05's
 * import and export.
 *
 * The storage below is a real implementation of {@link PresetStorage}, not a
 * mock: it holds the text it was given and hands it back, which is the entire
 * contract, and the OPFS implementation is the same behaviour over a file. The
 * failing variant is also real — a store that rejects is what a full disk does,
 * and the property being checked is that the library does not claim a save that
 * did not happen.
 */

import { describe, expect, it } from "vitest";

import { setLevel } from "../../lib/log";
import { createDocument } from "../../state/document";
import { addNode, setSource } from "../../state/mutations";
import { testRegistry } from "../../state/fixture";
import type { DitherDocument } from "../../types/document";
import { DocumentFileError } from "./errors";
import { PresetLibrary, type PresetStorage } from "./library";
import { encodePresetFile, presetFromDocument, type Preset } from "./preset";

setLevel("error");

const registry = testRegistry();

interface MemoryStorage extends PresetStorage {
  /** What is currently stored, for asserting on the file rather than the list. */
  text(): string | null;
}

/** A store in memory. Reads back exactly what was written, and nothing else. */
function memoryStorage(initial: string | null = null): MemoryStorage {
  let stored = initial;
  return {
    read: async () => stored,
    write: async (next: string) => {
      stored = next;
    },
    text: () => stored,
  };
}

/** A store that refuses to write, the way a full disk does. */
function failingStorage(initial: string | null = null): PresetStorage {
  return {
    read: async () => initial,
    write: async () => {
      throw new Error("quota exceeded");
    },
  };
}

const BUILTIN: Preset = {
  id: "starter/test",
  name: "Starter",
  createdAt: "2026-01-01T00:00:00.000Z",
  note: "ships with the build",
  builtin: true,
  document: createDocument(),
};

function sample(): DitherDocument {
  const first = addNode(createDocument(), registry, "test-levels");
  const second = addNode(first.document, registry, "test-diffusion");
  return setSource(second.document, { name: "photo.png", width: 8, height: 8 });
}

async function open(storage: PresetStorage): Promise<PresetLibrary> {
  return PresetLibrary.open({
    storage,
    registry,
    builtins: [BUILTIN],
    now: () => new Date("2026-08-07T12:00:00.000Z"),
  });
}

describe("opening", () => {
  it("lists the built-in set on a fresh origin", async () => {
    const library = await open(memoryStorage());
    expect(library.list().map((preset) => preset.id)).toEqual(["starter/test"]);
    expect(library.saved()).toEqual([]);
  });

  it("does not store the built-in set", async () => {
    // Seeding would mean a starter preset somebody deleted comes back on the
    // next reload, or does not, depending on a flag that is itself a thing to
    // get wrong.
    const storage = memoryStorage();
    await open(storage);
    expect(storage.text()).toBeNull();
  });

  it("reads presets saved earlier", async () => {
    const saved = presetFromDocument(sample(), {
      id: "p1",
      name: "Earlier",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const library = await open(memoryStorage(encodePresetFile([saved])));
    expect(library.list().map((preset) => preset.name)).toEqual(["Starter", "Earlier"]);
  });

  it("refuses a stored library it cannot read, and leaves it alone", async () => {
    // Opening empty would destroy the file on the next save, which is the one
    // outcome that loses work.
    const storage = memoryStorage("{ not json");
    await expect(open(storage)).rejects.toBeInstanceOf(DocumentFileError);
    expect(storage.text()).toBe("{ not json");
  });
});

describe("saving (F-DO-03)", () => {
  it("saves the recipe without the picture", async () => {
    const library = await open(memoryStorage());
    const preset = await library.save("Chunky", sample());
    expect(preset.document.source).toBeNull();
    expect(preset.name).toBe("Chunky");
    expect(preset.createdAt).toBe("2026-08-07T12:00:00.000Z");
  });

  it("puts the newest first, where somebody looks for it", async () => {
    const library = await open(memoryStorage());
    await library.save("First", sample());
    await library.save("Second", sample());
    expect(library.saved().map((preset) => preset.name)).toEqual(["Second", "First"]);
  });

  it("writes a file the next session can read", async () => {
    const storage = memoryStorage();
    const library = await open(storage);
    await library.save("Chunky", sample());

    const text = storage.text();
    expect(text).not.toBeNull();
    const reopened = await open(memoryStorage(text));
    expect(reopened.saved().map((preset) => preset.name)).toEqual(["Chunky"]);
  });

  it("refuses a name that is empty once trimmed", async () => {
    const library = await open(memoryStorage());
    await expect(library.save("  ", sample())).rejects.toBeInstanceOf(DocumentFileError);
    expect(library.saved()).toEqual([]);
  });

  it("does not claim a save the store refused", async () => {
    const library = await open(failingStorage());
    await expect(library.save("Chunky", sample())).rejects.toThrow("quota exceeded");
    // The list must not show a preset that is not saved: the next reload would
    // silently take it away again.
    expect(library.saved()).toEqual([]);
  });
});

describe("rename and delete", () => {
  it("renames a saved preset", async () => {
    const library = await open(memoryStorage());
    const preset = await library.save("Chunky", sample());
    await library.rename(preset.id, "Chunkier");
    expect(library.get(preset.id)?.name).toBe("Chunkier");
  });

  it("deletes a saved preset", async () => {
    const library = await open(memoryStorage());
    const preset = await library.save("Chunky", sample());
    await library.remove(preset.id);
    expect(library.get(preset.id)).toBeUndefined();
    expect(library.saved()).toEqual([]);
  });

  it("refuses to rename or delete one the build ships", async () => {
    const library = await open(memoryStorage());
    await expect(library.rename(BUILTIN.id, "Mine")).rejects.toBeInstanceOf(
      DocumentFileError,
    );
    await expect(library.remove(BUILTIN.id)).rejects.toBeInstanceOf(DocumentFileError);
    expect(library.get(BUILTIN.id)?.name).toBe("Starter");
  });

  it("refuses an id it does not hold", async () => {
    const library = await open(memoryStorage());
    await expect(library.remove("p99")).rejects.toBeInstanceOf(DocumentFileError);
  });

  it("tells its subscribers when the list moves", async () => {
    const library = await open(memoryStorage());
    let calls = 0;
    const off = library.subscribe(() => {
      calls += 1;
    });
    await library.save("Chunky", sample());
    expect(calls).toBe(1);
    off();
    await library.save("Another", sample());
    expect(calls).toBe(1);
  });

  it("hands out a stable list until something changes", async () => {
    const library = await open(memoryStorage());
    const before = library.list();
    expect(library.list()).toBe(before);
    await library.save("Chunky", sample());
    expect(library.list()).not.toBe(before);
  });
});

describe("import and export (F-DO-05)", () => {
  it("exports what was saved and not what the build ships", async () => {
    // A file carrying this build's starter set would import six duplicates on
    // the next machine.
    const library = await open(memoryStorage());
    await library.save("Chunky", sample());
    const exported = await open(memoryStorage(library.exportFile()));
    expect(exported.saved().map((preset) => preset.name)).toEqual(["Chunky"]);
  });

  it("exports a built-in when it is asked for by id", async () => {
    const library = await open(memoryStorage());
    const text = library.exportFile([BUILTIN.id]);
    const reimported = await open(memoryStorage(text));
    expect(reimported.saved().map((preset) => preset.name)).toEqual(["Starter"]);
  });

  it("refuses to export an id it does not hold", async () => {
    const library = await open(memoryStorage());
    expect(() => library.exportFile(["p99"])).toThrow(DocumentFileError);
  });

  it("imports, keeping the names and reassigning colliding ids", async () => {
    const library = await open(memoryStorage());
    const mine = await library.save("Mine", sample());
    expect(mine.id).toBe("p1");

    // A file from another machine, whose first preset is also "p1".
    const incoming = encodePresetFile([
      presetFromDocument(sample(), {
        id: "p1",
        name: "Theirs",
        createdAt: "2026-05-05T00:00:00.000Z",
      }),
    ]);
    const added = await library.importPresets(incoming);

    expect(added.map((preset) => preset.name)).toEqual(["Theirs"]);
    expect(added[0]?.id).not.toBe("p1");
    expect(library.saved().map((preset) => preset.name)).toEqual(["Theirs", "Mine"]);
  });

  it("refuses a file with one unreadable preset in it, whole", async () => {
    // Importing the ones that decoded would leave somebody believing they had
    // all of them.
    const good = presetFromDocument(sample(), {
      id: "p1",
      name: "Good",
      createdAt: "2026-05-05T00:00:00.000Z",
    });
    const raw = JSON.parse(encodePresetFile([good, { ...good, id: "p2" }])) as Record<
      string,
      unknown
    >;
    const presets = raw["presets"] as Record<string, unknown>[];
    const second = presets[1];
    if (second !== undefined) {
      const document = second["document"] as Record<string, unknown>;
      const stack = document["stack"] as Record<string, unknown>[];
      const node = stack[0];
      if (node !== undefined) node["effect"] = "gone-in-this-build";
    }

    const library = await open(memoryStorage());
    await expect(library.importPresets(JSON.stringify(raw))).rejects.toThrow();
    expect(library.saved()).toEqual([]);
  });

  it("refuses a file with no presets in it", async () => {
    const library = await open(memoryStorage());
    await expect(library.importPresets(encodePresetFile([]))).rejects.toBeInstanceOf(
      DocumentFileError,
    );
  });
});
