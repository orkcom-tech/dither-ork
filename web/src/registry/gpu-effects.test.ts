/**
 * Resolving an effect id to its compute passes.
 *
 * The interesting half of this file is the last block, which runs against the
 * real catalogue. Everything above it is the contract: that a source refuses
 * build-time data it did not ask for, that the resolver refuses to hand back
 * passes labelled for another effect, and that coverage failures are reported
 * one per gap rather than as a single "something is missing".
 *
 * The catalogue block is what actually protects the document loader. A `gpu`
 * effect whose module forgot the `gpu` export is invisible in every other way:
 * the registry seals, the app starts, the stack panel lists the effect, and the
 * failure arrives when someone puts it in a document.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLevel } from "../lib/log";
import { thresholdMatrix } from "../gpu/matrices";
import type { GpuEffect } from "../types/gpu";
import {
  GpuBuildDataError,
  NO_GPU_BUILD_DATA,
  staticGpuEffect,
  thresholdMatrixGpuEffect,
  type EffectDescriptor,
  type GpuBuildData,
} from "../types/registry";
import { discoverEffects } from "./discovery";
import {
  GpuEffectMismatchError,
  UnknownGpuEffectError,
  createGpuEffectResolver,
  discoverGpuEffects,
  validateGpuCoverage,
  type DiscoveredGpuEffect,
} from "./gpu-effects";
import { createEffectRegistry } from "./registry";

setLevel("error");

// Every refusal here logs before it throws, deliberately, so the failure names
// the offending module. Silence the console rather than the logger.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// --- fixtures ------------------------------------------------------------

function passesFor(effect: string): GpuEffect {
  return {
    effect,
    passes: [
      {
        id: `${effect}/main`,
        label: effect,
        wgsl: "@compute @workgroup_size(8, 8, 1) fn main() {}",
        entryPoint: "main",
        workgroupSize: [8, 8, 1],
        dispatch: { kind: "per-pixel" },
        access: "pointwise",
        bindings: [
          { role: "input-color", binding: 0 },
          { role: "output-color", binding: 1 },
        ],
        uniforms: { sizeBytes: 16, fields: [] },
      },
    ],
  };
}

function descriptorFor(
  id: string,
  execution: EffectDescriptor["execution"],
): EffectDescriptor {
  return {
    id,
    name: id,
    requirement: "F-SP-08",
    slot: "preprocess",
    family: "special",
    execution,
    params: [],
    surpriseWeight: 1,
    producesIndexMap: false,
    requiresIndexMap: false,
  };
}

function registryOf(...descriptors: readonly EffectDescriptor[]) {
  return createEffectRegistry(
    descriptors.map((descriptor) => ({
      descriptor,
      module: `../effects/${descriptor.id}.effect.ts`,
    })),
  );
}

function entry(source: DiscoveredGpuEffect["source"], module?: string): DiscoveredGpuEffect {
  return { source, module: module ?? `../effects/${source.effect}.effect.ts` };
}

/**
 * A tile that is a valid permutation and a useless dither.
 *
 * Nothing in the shipped build fabricates a threshold matrix — the ranks come
 * from `dither-core`, because two implementations of one recursion put a seam
 * between the CPU preview and the GPU export. This is not a shipped build: the
 * identity permutation is here to prove that a source which *needs* a tile is
 * handed one and builds, and its ordering never reaches a pixel.
 */
function identityTile(id: string, size: number) {
  const ranks = new Uint32Array(size * size);
  for (let i = 0; i < ranks.length; i += 1) ranks[i] = i;
  return thresholdMatrix(id, size, ranks);
}

// --- the source contract -------------------------------------------------

describe("a GPU effect source", () => {
  it("builds passes for an effect that needs nothing", () => {
    const source = staticGpuEffect("invert", () => passesFor("invert"));
    expect(source.requires).toEqual({ kind: "none" });
    expect(source.build(NO_GPU_BUILD_DATA).passes).toHaveLength(1);
  });

  it("refuses build-time data it did not ask for", () => {
    const source = staticGpuEffect("invert", () => passesFor("invert"));
    const data: GpuBuildData = {
      kind: "threshold-matrix",
      matrix: identityTile("bayer-4", 4),
    };
    expect(() => source.build(data)).toThrowError(GpuBuildDataError);
  });

  it("states the tile it needs before anything has been fetched", () => {
    const source = thresholdMatrixGpuEffect("bayer-4", 4, (matrix) => ({
      ...passesFor("bayer-4"),
      passes: passesFor(`bayer-4-${matrix.size}`).passes,
    }));
    // The point of the requirement being separate from `build`: a caller can
    // ask what to fetch while holding nothing to build with.
    expect(source.requires).toEqual({ kind: "threshold-matrix", size: 4 });
  });

  it("refuses to build a tiled effect from nothing", () => {
    const source = thresholdMatrixGpuEffect("bayer-4", 4, () => passesFor("bayer-4"));
    expect(() => source.build(NO_GPU_BUILD_DATA)).toThrowError(GpuBuildDataError);
  });

  it("hands the tile straight through", () => {
    let seen = 0;
    const source = thresholdMatrixGpuEffect("bayer-4", 4, (matrix) => {
      seen = matrix.size;
      return passesFor("bayer-4");
    });
    source.build({ kind: "threshold-matrix", matrix: identityTile("bayer-4", 4) });
    expect(seen).toBe(4);
  });
});

// --- the resolver --------------------------------------------------------

describe("the resolver", () => {
  it("answers with the passes the source builds", () => {
    const resolver = createGpuEffectResolver([
      entry(staticGpuEffect("invert", () => passesFor("invert"))),
    ]);
    expect(resolver.size).toBe(1);
    expect(resolver.has("invert")).toBe(true);
    expect(resolver.ids()).toEqual(["invert"]);
    expect(resolver.requirementOf("invert")).toEqual({ kind: "none" });
    expect(resolver.resolve("invert", NO_GPU_BUILD_DATA).passes[0]?.id).toBe(
      "invert/main",
    );
    expect(resolver.origin("invert")).toBe("../effects/invert.effect.ts");
  });

  it("throws on an id nothing declares", () => {
    const resolver = createGpuEffectResolver([]);
    expect(() => resolver.resolve("invert", NO_GPU_BUILD_DATA)).toThrowError(
      UnknownGpuEffectError,
    );
    expect(() => resolver.requirementOf("invert")).toThrowError(UnknownGpuEffectError);
  });

  it("refuses passes labelled for another effect", () => {
    // The pass compiler pairs a `GpuEffect` with the descriptor of the same id,
    // so a source that builds someone else's passes would bind the wrong
    // parameter set and render a plausible wrong picture.
    const resolver = createGpuEffectResolver([
      entry(staticGpuEffect("invert", () => passesFor("posterize"))),
    ]);
    expect(() => resolver.resolve("invert", NO_GPU_BUILD_DATA)).toThrowError(
      GpuEffectMismatchError,
    );
  });

  it("builds an effect that needs nothing exactly once", () => {
    let builds = 0;
    const resolver = createGpuEffectResolver([
      entry(
        staticGpuEffect("glyph-tile", () => {
          builds += 1;
          return passesFor("glyph-tile");
        }),
      ),
    ]);
    resolver.resolve("glyph-tile", NO_GPU_BUILD_DATA);
    resolver.resolve("glyph-tile", NO_GPU_BUILD_DATA);
    // A stack may use one effect three times; the glyph sheet is assembled once.
    expect(builds).toBe(1);
  });

  it("rebuilds a tiled effect for every tile it is given", () => {
    let builds = 0;
    const resolver = createGpuEffectResolver([
      entry(
        thresholdMatrixGpuEffect("bayer-4", 4, () => {
          builds += 1;
          return passesFor("bayer-4");
        }),
      ),
    ]);
    const data: GpuBuildData = {
      kind: "threshold-matrix",
      matrix: identityTile("bayer-4", 4),
    };
    resolver.resolve("bayer-4", data);
    resolver.resolve("bayer-4", data);
    // Caching under the id alone would hand the second caller a tile it never
    // asked for.
    expect(builds).toBe(2);
  });
});

// --- coverage ------------------------------------------------------------

describe("coverage against the catalogue", () => {
  it("passes when every gpu effect has a source", () => {
    const registry = registryOf(descriptorFor("invert", "gpu"));
    const issues = validateGpuCoverage(registry, [
      entry(staticGpuEffect("invert", () => passesFor("invert"))),
    ]);
    expect(issues).toEqual([]);
  });

  it("names a gpu effect whose module exports no source", () => {
    const registry = registryOf(descriptorFor("invert", "gpu"));
    const issues = validateGpuCoverage(registry, []);
    expect(issues.map((i) => i.code)).toEqual(["missing-source"]);
    expect(issues[0]?.effect).toBe("invert");
  });

  it("names a source no descriptor registers", () => {
    const registry = registryOf(descriptorFor("invert", "gpu"));
    const issues = validateGpuCoverage(registry, [
      entry(staticGpuEffect("invert", () => passesFor("invert"))),
      entry(staticGpuEffect("ghost", () => passesFor("ghost"))),
    ]);
    expect(issues.map((i) => i.code)).toEqual(["unregistered-source"]);
    expect(issues[0]?.effect).toBe("ghost");
  });

  it("names a serial effect that exports compute passes", () => {
    const registry = registryOf(descriptorFor("floyd-steinberg", "wasm"));
    const issues = validateGpuCoverage(registry, [
      entry(staticGpuEffect("floyd-steinberg", () => passesFor("floyd-steinberg"))),
    ]);
    expect(issues.map((i) => i.code)).toEqual(["source-on-serial-effect"]);
  });

  it("names two modules claiming one effect", () => {
    const registry = registryOf(descriptorFor("invert", "gpu"));
    const issues = validateGpuCoverage(registry, [
      entry(staticGpuEffect("invert", () => passesFor("invert")), "../effects/a.effect.ts"),
      entry(staticGpuEffect("invert", () => passesFor("invert")), "../effects/b.effect.ts"),
    ]);
    expect(issues.map((i) => i.code)).toEqual(["duplicate-source"]);
    expect(issues[0]?.message).toContain("a.effect.ts");
    expect(issues[0]?.message).toContain("b.effect.ts");
  });
});

// --- the shipped catalogue ----------------------------------------------

describe("the shipped catalogue", () => {
  const discovered = discoverEffects();
  const registry = createEffectRegistry(discovered);
  const sources = discoverGpuEffects();

  it("resolves every effect that declares gpu execution", () => {
    const issues = validateGpuCoverage(registry, sources).map(
      (issue) => `${issue.effect}: ${issue.code} — ${issue.message}`,
    );
    // Named individually: "expected 0, got 3" over a catalogue this size is not
    // a message anybody can act on. This is the assertion an effect added
    // tomorrow has to satisfy — and the message it fails with says what to add.
    expect(issues).toEqual([]);
  });

  it("builds passes for every effect that needs nothing", () => {
    const resolver = createGpuEffectResolver(sources);
    const wrong: string[] = [];
    for (const id of resolver.ids()) {
      if (resolver.requirementOf(id).kind !== "none") continue;
      const built = resolver.resolve(id, NO_GPU_BUILD_DATA);
      if (built.passes.length === 0) wrong.push(`${id}: no passes`);
    }
    // Every one of them really is constructible from nothing — which is the
    // claim the convention makes, and the one a thunk could quietly break by
    // depending on something not yet loaded.
    expect(wrong).toEqual([]);
  });

  it("says which effects cannot be built until the core has run", () => {
    const resolver = createGpuEffectResolver(sources);
    const tiled = resolver
      .ids()
      .filter((id) => resolver.requirementOf(id).kind === "threshold-matrix")
      .sort();
    // The five ordered dithers, and only those: their passes carry the tile as
    // a `table` binding, and nothing on this side fabricates one (F-OD-01..05).
    expect(tiled).toEqual(["bayer-16", "bayer-2", "bayer-4", "bayer-8", "blue-noise"]);
  });

  it("builds an ordered dither once it is handed its tile", () => {
    const resolver = createGpuEffectResolver(sources);
    const requirement = resolver.requirementOf("bayer-4");
    if (requirement.kind !== "threshold-matrix") {
      expect.unreachable("bayer-4 needs a threshold matrix");
      return;
    }
    const built = resolver.resolve("bayer-4", {
      kind: "threshold-matrix",
      matrix: identityTile("bayer-4", requirement.size),
    });
    expect(built.effect).toBe("bayer-4");
    expect(built.passes).toHaveLength(1);
    expect(
      built.passes[0]?.bindings.some((binding) => binding.role === "table"),
    ).toBe(true);
  });
});
