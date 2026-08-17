/**
 * The schema-1 migration, and the round trip that is the whole point of it.
 *
 * "Every existing document, preset and share link is a linear stack and must
 * load as a chain." The assertion that means something is not that the fields
 * appear — it is that **the picture does not change**, and the picture is
 * decided by the content hash of the graph's output: two documents with the
 * same output hash render the same pixels by construction, because the hash is
 * what the cache is keyed on and what the renderer's determinism guarantee
 * rests on. So the tests below load an old document, save it, load it again,
 * prepare both graphs, and compare hashes node by node.
 *
 * A GPU is not involved and does not need to be. Comparing rendered bytes would
 * test the WebGPU device; comparing prepared hashes tests the thing a format
 * can actually break.
 */

import { describe, expect, it } from "vitest";

import { createEffectRegistry, discoverEffects } from "../../registry";
import type { EffectRegistry } from "../../registry";
import { decodeDocument } from "../../state/serialize";
import { buildRenderGraph } from "../../state/render/graph";
import { prepareGraph } from "../../graph/plan";
import type { ContentHash } from "../../types/graph";
import { DOCUMENT_SCHEMA_VERSION } from "../../types/document";
import type { DitherDocument } from "../../types/document";
import { DEFAULT_PALETTE } from "../../state/document";
import { encodeDorkFile } from "./dork";
import { migrateDocument } from "./migrate";

const registry: EffectRegistry = createEffectRegistry(discoverEffects());
const effects = new Map(registry.all().map((effect) => [effect.id, effect]));

/** A schema-1 document, written by hand the way the shipped build wrote them. */
function schemaOneDocument(): Record<string, unknown> {
  return {
    schema: 1,
    source: { name: "photo.png", width: 640, height: 480 },
    palette: DEFAULT_PALETTE,
    clock: { frames: 48, fps: 24 },
    stack: [
      {
        id: "n1",
        effect: "blur",
        enabled: true,
        opacity: 1,
        blend: "normal",
        params: { radius: 3 },
        seed: 11,
      },
      {
        id: "n2",
        effect: "bayer-4",
        enabled: true,
        opacity: 0.6,
        blend: "multiply",
        params: {},
        seed: 22,
      },
      {
        id: "n3",
        effect: "outline",
        enabled: false,
        opacity: 1,
        blend: "normal",
        params: {},
        seed: 33,
      },
    ],
    bindings: [],
  };
}

/** Every node's content hash, which is what decides the picture. */
function hashesOf(document: DitherDocument): ReadonlyMap<string, ContentHash> {
  const graph = buildRenderGraph(document, {
    width: 640,
    height: 480,
    quality: "full",
    frame: 0,
  });
  expect(graph, "the document compiled to no graph").not.toBeNull();
  if (graph === null) throw new Error("unreachable");
  const source = "source-hash" as ContentHash;
  return prepareGraph(graph, source, document.palette, effects).hashes;
}

describe("schema 1 to schema 2", () => {
  it("writes down the chain the array order implied", () => {
    const migrated = migrateDocument(schemaOneDocument(), 1);

    expect(migrated["schema"]).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(migrated["edges"]).toEqual([
      { from: "n1", to: "n2", port: "in" },
      { from: "n2", to: "n3", port: "in" },
    ]);
    expect(migrated["output"]).toBe("n3");
  });

  it("wires a disabled node like any other", () => {
    // `prepareGraph` resolves a disabled node's edge past it, so the chain
    // stays intact and re-enabling one puts it back where it was. Dropping it
    // here would change what the toggle does.
    const migrated = migrateDocument(schemaOneDocument(), 1);
    const edges = migrated["edges"] as readonly { to: string }[];
    expect(edges.some((edge) => edge.to === "n3")).toBe(true);
  });

  it("changes nothing else", () => {
    const before = schemaOneDocument();
    const after = migrateDocument(schemaOneDocument(), 1);
    for (const key of ["source", "palette", "clock", "stack", "bindings"]) {
      expect(after[key]).toEqual(before[key]);
    }
  });

  it("migrates an empty document to no wiring and no output", () => {
    const migrated = migrateDocument({ ...schemaOneDocument(), stack: [] }, 1);
    expect(migrated["edges"]).toEqual([]);
    expect(migrated["output"]).toBeNull();
  });

  it("refuses a version it has no path from", () => {
    expect(() => migrateDocument(schemaOneDocument(), 0)).toThrow(/no migration from it/);
  });
});

describe("the round trip that matters", () => {
  it("load, save, load again gives the same graph and the same hashes", () => {
    const first = decodeDocument(schemaOneDocument(), registry);
    const text = encodeDorkFile(first);
    const second = decodeDocument(JSON.parse(text) as unknown, registry);

    // The document itself, field for field.
    expect(second).toEqual(first);
    // And the bytes, so a third save is the same file as the second.
    expect(encodeDorkFile(second)).toBe(text);

    // The picture. Every node's hash, including the output's — two graphs with
    // the same hashes cannot render differently.
    const before = hashesOf(first);
    const after = hashesOf(second);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  it("loses no parameter on the way through", () => {
    const loaded = decodeDocument(schemaOneDocument(), registry);
    const reloaded = decodeDocument(
      JSON.parse(encodeDorkFile(loaded)) as unknown,
      registry,
    );
    for (const [index, node] of reloaded.stack.entries()) {
      expect(node.params).toEqual(loaded.stack[index]?.params);
      expect(node.seed).toBe(loaded.stack[index]?.seed);
      expect(node.opacity).toBe(loaded.stack[index]?.opacity);
      expect(node.blend).toBe(loaded.stack[index]?.blend);
      expect(node.enabled).toBe(loaded.stack[index]?.enabled);
    }
  });

  it("renders the chain the old build rendered", () => {
    const loaded = decodeDocument(schemaOneDocument(), registry);
    const graph = buildRenderGraph(loaded, {
      width: 640,
      height: 480,
      quality: "full",
      frame: 0,
    });
    expect(graph?.nodes.map((node) => node.id)).toEqual(["n1", "n2", "n3"]);
    // The first node is a root: no edge, which `prepareGraph` reads as "takes
    // the decoded source".
    expect(graph?.nodes[0]?.inputs).toEqual([]);
    expect(graph?.nodes[1]?.inputs).toEqual([
      { port: "in", from: { nodeId: "n1", port: "out" } },
    ]);
    expect(graph?.output).toEqual({ nodeId: "n3", port: "out" });
  });
});

describe("a schema-2 document", () => {
  it("is passed through untouched", () => {
    const raw = { schema: DOCUMENT_SCHEMA_VERSION, stack: [] };
    expect(migrateDocument(raw, DOCUMENT_SCHEMA_VERSION)).toBe(raw);
  });

  it("is refused when an edge names a node that is not in it", () => {
    const raw = {
      ...schemaOneDocument(),
      schema: DOCUMENT_SCHEMA_VERSION,
      edges: [{ from: "n1", to: "gone", port: "in" }],
      output: "n1",
    };
    expect(() => decodeDocument(raw, registry)).toThrow(/not a node in this document/);
  });

  it("is refused when its output is not in it", () => {
    const raw = {
      ...schemaOneDocument(),
      schema: DOCUMENT_SCHEMA_VERSION,
      edges: [],
      output: "gone",
    };
    expect(() => decodeDocument(raw, registry)).toThrow(/not a node in this document/);
  });
});
