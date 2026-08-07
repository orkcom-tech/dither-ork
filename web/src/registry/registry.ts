/**
 * The node registry.
 *
 * The single source of truth about effects: the stack editor lists from it, the
 * graph schedules from it, the properties panel builds its controls from it,
 * and Surprise Me generates from it. There is no second list anywhere, and
 * there is no per-effect logic in here — everything an effect needs to say, it
 * says in its descriptor.
 *
 * Building a registry is two phases on purpose. Descriptors are collected into
 * a builder, and only `seal()` produces something queryable, after validation.
 * A registry that failed validation therefore cannot be read from at all, which
 * is what turns "an effect forgot its surprise metadata" into a startup failure
 * instead of Surprise Me quietly never touching that parameter (see
 * docs/ARCHITECTURE.md, "Surprise generator").
 */

import { logger } from "../lib/log";
import type { NodeSlot } from "../types/document";
import {
  validateRegistry,
  type EffectDescriptor,
  type EffectFamily,
  type ExecutionKind,
  type RegistryIssue,
} from "../types/registry";
import type { DiscoveredEffect } from "./discovery";
import {
  matchesFilter,
  searchCatalogue,
  searchEffects,
  type CatalogueSearch,
  type EffectFilter,
  type EffectSearchResult,
} from "./search";

const log = logger("app");

/**
 * The read side. Everything downstream of startup holds one of these and can
 * assume every descriptor in it passed validation.
 */
export interface EffectRegistry {
  readonly size: number;
  has(id: string): boolean;
  get(id: string): EffectDescriptor | undefined;
  /**
   * Look up an effect that must exist. Throws — a document naming an effect the
   * build does not have is a real error and rendering an incomplete stack
   * instead would be a silent wrong answer.
   */
  require(id: string): EffectDescriptor;
  /** Every effect, in registration order. */
  all(): readonly EffectDescriptor[];
  bySlot(slot: NodeSlot): readonly EffectDescriptor[];
  byExecution(kind: ExecutionKind): readonly EffectDescriptor[];
  byFamily(family: EffectFamily): readonly EffectDescriptor[];
  /** Structural narrowing with no text query. */
  filter(filter: EffectFilter): readonly EffectDescriptor[];
  /**
   * Ranked search over the whole catalogue (F-ST-08).
   *
   * Returns the list alone. Prefer {@link EffectRegistry.searchWithMiss} in any
   * surface a person reads: this one answers an empty query with an empty array
   * and no way to tell "you spelled it wrong" from "that does not exist".
   */
  search(query: string, filter?: EffectFilter): readonly EffectSearchResult[];
  /**
   * The same search, plus an explanation when it finds nothing (F-ST-08,
   * F-UI-15).
   */
  searchWithMiss(query: string, filter?: EffectFilter): CatalogueSearch;
  /** Module an effect was discovered in. Diagnostics only. */
  origin(id: string): string | undefined;
}

/** Thrown by {@link EffectRegistryBuilder.seal} when any descriptor is invalid. */
export class RegistryValidationError extends Error {
  readonly issues: readonly RegistryIssue[];

  constructor(issues: readonly RegistryIssue[]) {
    const summary = issues
      .map((i) => `${i.effect}${i.param === undefined ? "" : `.${i.param}`}: ${i.code}`)
      .join("; ");
    super(`node registry validation failed (${issues.length} issue(s)) — ${summary}`);
    this.name = "RegistryValidationError";
    this.issues = issues;
  }
}

/** Thrown by {@link EffectRegistry.require} for an unregistered id. */
export class UnknownEffectError extends Error {
  readonly effectId: string;

  constructor(effectId: string) {
    super(`no effect registered under id "${effectId}"`);
    this.name = "UnknownEffectError";
    this.effectId = effectId;
  }
}

function groupBy<K>(
  effects: readonly EffectDescriptor[],
  key: (effect: EffectDescriptor) => K,
): ReadonlyMap<K, readonly EffectDescriptor[]> {
  const groups = new Map<K, EffectDescriptor[]>();
  for (const effect of effects) {
    const k = key(effect);
    const existing = groups.get(k);
    if (existing === undefined) groups.set(k, [effect]);
    else existing.push(effect);
  }
  return groups;
}

/**
 * Collects descriptors and validates them as one set.
 *
 * Uniqueness and exclusion targets are cross-effect rules, so they can only be
 * checked once everything has been registered — which is the other reason the
 * queryable registry is a separate object from the thing you register into.
 */
export class EffectRegistryBuilder {
  private readonly entries: DiscoveredEffect[] = [];

  /**
   * Add one descriptor. Duplicates are accepted here and rejected by
   * {@link seal}, so that the error names both offending modules rather than
   * whichever one happened to lose a `Map.set` race.
   */
  register(descriptor: EffectDescriptor, module: string): this {
    this.entries.push({ descriptor, module });
    log.debug("effect registered", {
      effect: descriptor.id,
      slot: descriptor.slot,
      execution: descriptor.execution,
      module,
    });
    return this;
  }

  registerAll(entries: Iterable<DiscoveredEffect>): this {
    for (const entry of entries) this.register(entry.descriptor, entry.module);
    return this;
  }

  /**
   * Validate everything registered and return the read-only registry.
   *
   * Logs one line per issue, each naming the offending effect id and the module
   * it came from, then throws. Nothing is repaired and nothing is dropped: a
   * catalogue that is 62 effects because one was quietly discarded is worse
   * than a catalogue that refuses to start.
   */
  seal(): EffectRegistry {
    const descriptors = this.entries.map((e) => e.descriptor);
    const origins = new Map<string, string>();
    for (const entry of this.entries) {
      const previous = origins.get(entry.descriptor.id);
      origins.set(
        entry.descriptor.id,
        previous === undefined ? entry.module : `${previous}, ${entry.module}`,
      );
    }

    const validation = validateRegistry(descriptors);
    if (!validation.ok) {
      for (const problem of validation.issues) {
        log.error("registry validation failed", {
          effect: problem.effect,
          param: problem.param,
          code: problem.code,
          message: problem.message,
          module: origins.get(problem.effect),
        });
      }
      log.error("node registry rejected", {
        issues: validation.issues.length,
        effects: descriptors.length,
      });
      throw new RegistryValidationError(validation.issues);
    }

    const byId = new Map<string, EffectDescriptor>();
    for (const effect of descriptors) byId.set(effect.id, effect);
    const bySlot = groupBy(descriptors, (e) => e.slot);
    const byExecution = groupBy(descriptors, (e) => e.execution);
    const byFamily = groupBy(descriptors, (e) => e.family);

    log.info("node registry sealed", {
      effects: descriptors.length,
      preprocess: (bySlot.get("preprocess") ?? []).length,
      dither: (bySlot.get("dither") ?? []).length,
      postprocess: (bySlot.get("postprocess") ?? []).length,
      wasm: (byExecution.get("wasm") ?? []).length,
      gpu: (byExecution.get("gpu") ?? []).length,
    });

    // A closure rather than a class: the UI destructures these off the registry
    // into hooks and callbacks, and a method that loses `this` on the way is a
    // failure mode worth designing out.
    return {
      size: descriptors.length,
      has: (id) => byId.has(id),
      get: (id) => byId.get(id),
      require: (id) => {
        const effect = byId.get(id);
        if (effect === undefined) {
          log.error("unknown effect id", { effect: id, registered: byId.size });
          throw new UnknownEffectError(id);
        }
        return effect;
      },
      all: () => descriptors,
      bySlot: (slot) => bySlot.get(slot) ?? [],
      byExecution: (kind) => byExecution.get(kind) ?? [],
      byFamily: (family) => byFamily.get(family) ?? [],
      filter: (f) => descriptors.filter((e) => matchesFilter(e, f)),
      search: (query, f) => {
        const results = searchEffects(descriptors, query, f ?? {});
        log.debug("effect search", {
          query,
          slot: f?.slot,
          family: f?.family,
          execution: f?.execution,
          matched: results.length,
          of: descriptors.length,
        });
        return results;
      },
      searchWithMiss: (query, f) => {
        const search = searchCatalogue(descriptors, query, f ?? {});
        // A miss is logged at info rather than debug. It is the event that cost
        // the owner time — the search box coming back empty with no reason —
        // and a support question about it should be answerable from the log
        // without asking anyone to turn verbose logging on and reproduce.
        if (search.miss === null) {
          log.debug("effect search", {
            query,
            slot: f?.slot,
            family: f?.family,
            execution: f?.execution,
            matched: search.results.length,
            of: descriptors.length,
          });
        } else {
          log.info("effect search found nothing", {
            query,
            slot: f?.slot,
            family: f?.family,
            execution: f?.execution,
            miss: search.miss.kind,
            requirement:
              search.miss.kind === "unbuilt" ? search.miss.feature.requirement : undefined,
            of: descriptors.length,
          });
        }
        return search;
      },
      origin: (id) => origins.get(id),
    };
  }
}

/** Build and seal in one step. */
export function createEffectRegistry(
  entries: Iterable<DiscoveredEffect>,
): EffectRegistry {
  return new EffectRegistryBuilder().registerAll(entries).seal();
}
