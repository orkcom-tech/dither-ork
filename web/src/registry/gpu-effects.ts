/**
 * From an effect id to its compute passes.
 *
 * This is the lookup a document loader needs first and the one the repository
 * did not have. `discovery.ts` next door globs *descriptors*, and a descriptor
 * says an effect runs on the GPU without saying where its passes are; every
 * effect module used to export its `GpuEffect` under a name of its own
 * (`INVERT_GPU`, `blurGpuEffect`, `halftoneEffect()`), so the only way to reach
 * them was to name all of them by hand — which is exactly what
 * `web/src/main.ts` did, and exactly what a loader holding an id out of a
 * `.dork` file cannot do.
 *
 * **The convention is one named export.** An effect module whose descriptor
 * declares `execution: "gpu"` also exports `const gpu: GpuEffectSource`, built
 * with `staticGpuEffect` or `thresholdMatrixGpuEffect` from
 * `web/src/types/registry.ts`. This module collects those with the same glob
 * that collects the descriptors.
 *
 * **Not every effect is constructible from nothing**, which is why the
 * convention is a source rather than a `GpuEffect`. The five ordered dithers
 * need a threshold tile from `dither-core` before their passes can be named at
 * all, so `GpuEffectSource.requires` states what an effect is waiting for and
 * the caller fetches it *before* asking for passes. A design that assumed every
 * effect could be built from nothing would have worked for forty-three of the
 * forty-eight and quietly excluded the family the dither slot is named after.
 *
 * Coverage is checked against the registry rather than assumed: a `gpu`
 * descriptor with no source, or a source with no descriptor, fails the whole
 * catalogue the way a missing surprise range does. A resolver that is silently
 * one effect short renders a document with one node missing, and that is a
 * picture nobody can tell is wrong.
 *
 * The logging channel is `app` rather than `gpu`: nothing here touches a device
 * or compiles a shader. It resolves declarations, which is application
 * structure, and it happens once at startup rather than inside a render.
 */

import { logger } from "../lib/log";
import type { GpuEffect } from "../types/gpu";
import type {
  EffectDescriptor,
  GpuBuildData,
  GpuBuildRequirement,
  GpuEffectSource,
} from "../types/registry";
import { loadEffectRegistry } from "./load";
import type { EffectRegistry } from "./registry";

const log = logger("app");

/** A GPU source together with the module it came from. */
export interface DiscoveredGpuEffect {
  readonly source: GpuEffectSource;
  /** Module path exactly as the glob reports it. Used in every diagnostic. */
  readonly module: string;
}

/**
 * A module under the effects directory whose `gpu` export is not a
 * {@link GpuEffectSource}.
 *
 * Separate from the coverage failure below because the failures are different
 * in kind: this one means the export exists and is the wrong thing, which no
 * amount of cross-checking against the registry would explain.
 */
export class GpuEffectSourceError extends Error {
  readonly modules: readonly string[];

  constructor(message: string, modules: readonly string[]) {
    super(message);
    this.name = "GpuEffectSourceError";
    this.modules = modules;
  }
}

/** Thrown by {@link GpuEffectResolver.resolve} for an id with no source. */
export class UnknownGpuEffectError extends Error {
  readonly effectId: string;

  constructor(effectId: string) {
    super(`no GPU effect registered under id "${effectId}"`);
    this.name = "UnknownGpuEffectError";
    this.effectId = effectId;
  }
}

/** Thrown when a source builds passes for an effect other than its own. */
export class GpuEffectMismatchError extends Error {
  constructor(declared: string, built: string) {
    super(
      `the GPU source for "${declared}" built passes labelled "${built}"; the pass compiler keys on the effect id and would bind the wrong descriptor`,
    );
    this.name = "GpuEffectMismatchError";
  }
}

export type GpuCoverageIssueCode =
  /** A `gpu` descriptor whose module exports no `gpu` source. */
  | "missing-source"
  /** A source whose id is not a registered effect. */
  | "unregistered-source"
  /** A `wasm` descriptor whose module exports a `gpu` source anyway. */
  | "source-on-serial-effect"
  /** Two modules exporting a source for the same effect id. */
  | "duplicate-source";

export interface GpuCoverageIssue {
  readonly effect: string;
  readonly code: GpuCoverageIssueCode;
  readonly message: string;
  /** Module the source came from, when there is one. */
  readonly module?: string;
}

/** Thrown by {@link loadGpuEffects} when the catalogue and the sources disagree. */
export class GpuCoverageError extends Error {
  readonly issues: readonly GpuCoverageIssue[];

  constructor(issues: readonly GpuCoverageIssue[]) {
    const summary = issues.map((i) => `${i.effect}: ${i.code}`).join("; ");
    super(
      `GPU effect resolution is incomplete (${issues.length} issue(s)) — ${summary}`,
    );
    this.name = "GpuCoverageError";
    this.issues = issues;
  }
}

/**
 * The read side. Given an effect id it answers two questions, in this order:
 * what does this effect need before it can be built, and — once that has been
 * fetched — what are its passes.
 */
export interface GpuEffectResolver {
  readonly size: number;
  has(effectId: string): boolean;
  /** Every id with a source, in module order. */
  ids(): readonly string[];
  /**
   * What must be handed to {@link resolve}. Asked *before* the data is
   * available, which is the whole reason it is separate from `resolve`.
   *
   * @throws UnknownGpuEffectError
   */
  requirementOf(effectId: string): GpuBuildRequirement;
  /**
   * The compute passes for one effect.
   *
   * @throws UnknownGpuEffectError when nothing declares this id.
   * @throws GpuBuildDataError when `data` is not what `requirementOf` asked for.
   * @throws GpuEffectMismatchError when the built passes name another effect.
   */
  resolve(effectId: string, data: GpuBuildData): GpuEffect;
  /** Module a source was discovered in. Diagnostics only. */
  origin(effectId: string): string | undefined;
}

/**
 * Whether a module's `gpu` export is shaped enough to use.
 *
 * Shallow on purpose, like `discovery.ts`'s descriptor guard: what it rules out
 * is the export that would throw a bare `TypeError` somewhere far away — a
 * missing `build`, a `requires` that names no kind. Everything a source claims
 * beyond that is checked against the registry by {@link validateGpuCoverage}.
 */
function isSourceShaped(value: unknown): value is GpuEffectSource {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    effect?: unknown;
    requires?: unknown;
    build?: unknown;
  };
  if (typeof candidate.effect !== "string" || candidate.effect.length === 0) {
    return false;
  }
  if (typeof candidate.build !== "function") return false;
  const requires = candidate.requires;
  if (typeof requires !== "object" || requires === null) return false;
  const kind = (requires as { kind?: unknown }).kind;
  if (kind === "none") return true;
  if (kind !== "threshold-matrix") return false;
  const size = (requires as { size?: unknown }).size;
  return typeof size === "number" && Number.isInteger(size) && size >= 2;
}

/**
 * Collect every `gpu` export under the effects directory.
 *
 * A module without one is not an error here — the fourteen error-diffusion
 * kernels run in WASM and have no passes to export. Whether an *absence* is
 * legitimate is a question about the descriptor beside it, and that is
 * {@link validateGpuCoverage}'s to answer.
 *
 * @throws GpuEffectSourceError when a `gpu` export is present and malformed, or
 * when it names an effect other than the descriptor in the same module.
 */
export function discoverGpuEffects(): readonly DiscoveredGpuEffect[] {
  // Literal at the call site, as Vite requires. Same pattern as
  // `discovery.ts`; the two see the same module objects.
  const modules: Record<string, unknown> = import.meta.glob(
    "../effects/**/*.effect.ts",
    { eager: true },
  );

  const paths = Object.keys(modules).sort();
  const discovered: DiscoveredGpuEffect[] = [];
  const malformed: string[] = [];

  for (const path of paths) {
    const module = modules[path];
    if (typeof module !== "object" || module === null) continue;
    const exported = (module as { gpu?: unknown }).gpu;
    if (exported === undefined) continue;

    if (!isSourceShaped(exported)) {
      log.error("effect module exports a malformed gpu source", {
        module: path,
        exported: typeof exported,
      });
      malformed.push(path);
      continue;
    }

    // The descriptor is in the same module, so a typo in the source's id is
    // caught here — naming one file — rather than as a coverage issue that
    // reports an unregistered id and a missing one and leaves the reader to
    // notice they are the same mistake.
    const descriptor = (module as { default?: unknown }).default;
    const declaredId =
      typeof descriptor === "object" && descriptor !== null
        ? (descriptor as { id?: unknown }).id
        : undefined;
    if (typeof declaredId === "string" && declaredId !== exported.effect) {
      log.error("gpu source names a different effect than its descriptor", {
        module: path,
        descriptor: declaredId,
        source: exported.effect,
      });
      malformed.push(path);
      continue;
    }

    discovered.push({ source: exported, module: path });
  }

  if (malformed.length > 0) {
    throw new GpuEffectSourceError(
      `${malformed.length} effect module(s) export a gpu value that is not a GpuEffectSource for their own effect: ${malformed.join(", ")}`,
      malformed,
    );
  }

  log.debug("gpu effect sources discovered", { sources: discovered.length });
  return discovered;
}

/**
 * Build the resolver.
 *
 * Passes for an effect requiring nothing are built once and remembered: several
 * effects assemble a table before they can name their passes, and a stack that
 * uses one effect three times should pay for that once. Nothing is memoized for
 * an effect that takes build-time data — its passes are a function of the data,
 * and caching them under the id alone would hand out a tile the caller did not
 * ask for.
 */
export function createGpuEffectResolver(
  entries: Iterable<DiscoveredGpuEffect>,
): GpuEffectResolver {
  const sources = new Map<string, GpuEffectSource>();
  const origins = new Map<string, string>();
  const order: string[] = [];
  const built = new Map<string, GpuEffect>();

  for (const entry of entries) {
    const id = entry.source.effect;
    if (!sources.has(id)) order.push(id);
    sources.set(id, entry.source);
    const previous = origins.get(id);
    origins.set(id, previous === undefined ? entry.module : `${previous}, ${entry.module}`);
  }

  const require = (effectId: string): GpuEffectSource => {
    const source = sources.get(effectId);
    if (source === undefined) {
      log.error("unknown gpu effect id", { effect: effectId, registered: sources.size });
      throw new UnknownGpuEffectError(effectId);
    }
    return source;
  };

  return {
    size: sources.size,
    has: (id) => sources.has(id),
    ids: () => order,
    requirementOf: (id) => require(id).requires,
    resolve: (id, data) => {
      const source = require(id);
      const cached = built.get(id);
      if (cached !== undefined && data.kind === "none") return cached;

      const effect = source.build(data);
      if (effect.effect !== id) {
        throw new GpuEffectMismatchError(id, effect.effect);
      }
      if (data.kind === "none") built.set(id, effect);
      log.debug("gpu effect built", {
        effect: id,
        passes: effect.passes.length,
        requires: source.requires.kind,
      });
      return effect;
    },
    origin: (id) => origins.get(id),
  };
}

/**
 * Cross-check the sources against the sealed catalogue.
 *
 * Reports rather than throws, so a test can name every gap at once;
 * {@link loadGpuEffects} is the caller that makes it terminal.
 */
export function validateGpuCoverage(
  registry: EffectRegistry,
  entries: readonly DiscoveredGpuEffect[],
): readonly GpuCoverageIssue[] {
  const issues: GpuCoverageIssue[] = [];
  const byId = new Map<string, DiscoveredGpuEffect[]>();

  for (const entry of entries) {
    const id = entry.source.effect;
    const existing = byId.get(id);
    if (existing === undefined) byId.set(id, [entry]);
    else existing.push(entry);
  }

  for (const [id, found] of byId) {
    if (found.length > 1) {
      issues.push({
        effect: id,
        code: "duplicate-source",
        message: `${found.length} modules export a gpu source for "${id}": ${found.map((f) => f.module).join(", ")}`,
      });
    }
    const descriptor: EffectDescriptor | undefined = registry.get(id);
    const module = found[0]?.module;
    if (descriptor === undefined) {
      issues.push({
        effect: id,
        code: "unregistered-source",
        message: `a gpu source declares "${id}", which no descriptor registers`,
        ...(module === undefined ? {} : { module }),
      });
      continue;
    }
    if (descriptor.execution !== "gpu") {
      issues.push({
        effect: id,
        code: "source-on-serial-effect",
        message: `"${id}" declares execution "${descriptor.execution}" but exports compute passes; one of the two is wrong`,
        ...(module === undefined ? {} : { module }),
      });
    }
  }

  for (const descriptor of registry.all()) {
    if (descriptor.execution !== "gpu") continue;
    if (byId.has(descriptor.id)) continue;
    const origin = registry.origin(descriptor.id);
    issues.push({
      effect: descriptor.id,
      code: "missing-source",
      message: `"${descriptor.id}" declares execution "gpu" but its module exports no \`gpu\` source, so nothing can turn its id into passes — see web/src/registry/README.md`,
      ...(origin === undefined ? {} : { module: origin }),
    });
  }

  return issues;
}

type LoadResult =
  | { readonly kind: "ok"; readonly resolver: GpuEffectResolver }
  | { readonly kind: "failed"; readonly error: unknown };

// Memoized including the failure, for the same reason `loadEffectRegistry` is:
// discovery is pure over the module graph, so a second attempt cannot produce a
// different answer, and re-running it would bury the first and truest report.
let loaded: LoadResult | undefined;

/**
 * Discover every GPU source, check it against the sealed catalogue, and return
 * the resolver. Idempotent.
 *
 * @throws EffectDiscoveryError or RegistryValidationError from the registry it
 * validates against.
 * @throws GpuEffectSourceError when a `gpu` export is malformed.
 * @throws GpuCoverageError when the catalogue and the sources disagree — a
 * `gpu` effect with no passes, or passes for an effect nobody registered.
 */
export function loadGpuEffects(): GpuEffectResolver {
  if (loaded !== undefined) {
    if (loaded.kind === "ok") return loaded.resolver;
    throw loaded.error;
  }

  try {
    const registry = loadEffectRegistry();
    const discovered = discoverGpuEffects();
    const issues = validateGpuCoverage(registry, discovered);
    if (issues.length > 0) {
      for (const issue of issues) {
        log.error("gpu effect resolution failed", {
          effect: issue.effect,
          code: issue.code,
          message: issue.message,
          module: issue.module,
        });
      }
      throw new GpuCoverageError(issues);
    }
    const resolver = createGpuEffectResolver(discovered);
    log.info("gpu effect resolution sealed", { sources: resolver.size });
    loaded = { kind: "ok", resolver };
    return resolver;
  } catch (error) {
    // Not swallowed: logged with its cause, remembered, and rethrown.
    log.error("gpu effect resolution failed to load", { error: String(error) });
    loaded = { kind: "failed", error };
    throw error;
  }
}
