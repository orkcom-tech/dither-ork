/**
 * Node registry entry point.
 *
 * `loadEffectRegistry()` is the one call the application makes: it discovers
 * every effect module, validates the whole catalogue, and returns the sealed
 * registry. Everything else in this directory is the machinery behind it, and
 * is exported so it can be exercised directly.
 *
 * Failure is loud and terminal. A registry that cannot be validated throws, and
 * startup is expected to surface that rather than continue — a build whose
 * catalogue is wrong renders wrong documents, and it does it convincingly.
 */

import { correlationId, logger } from "../lib/log";
import { discoverEffects } from "./discovery";
import { EffectRegistryBuilder, type EffectRegistry } from "./registry";

export {
  discoverEffects,
  EffectDiscoveryError,
  type DiscoveredEffect,
} from "./discovery";
export {
  createEffectRegistry,
  EffectRegistryBuilder,
  RegistryValidationError,
  UnknownEffectError,
  type EffectRegistry,
} from "./registry";
export {
  matchesFilter,
  searchEffects,
  type EffectFilter,
  type EffectSearchResult,
} from "./search";
export {
  coerceParams,
  defaultParams,
  validateParams,
  type EffectParams,
  type EffectParamValue,
  type ParamAdjustment,
  type ParamAdjustmentKind,
  type ParamCoercion,
  type ParamIssue,
  type ParamIssueCode,
  type ParamSetValidation,
} from "./params";

type LoadResult =
  | { readonly kind: "ok"; readonly registry: EffectRegistry }
  | { readonly kind: "failed"; readonly error: unknown };

// Memoized including the failure. Discovery and validation are pure over the
// module graph, so a second attempt cannot produce a different answer — and
// re-running it would emit the same wall of error lines again for every caller
// that asks, burying the first and truest report.
let loaded: LoadResult | undefined;

/**
 * Discover, validate and seal the catalogue. Idempotent.
 *
 * @throws EffectDiscoveryError when a module under `web/src/effects/` is not an
 * effect module, or when the glob matches nothing at all.
 * @throws RegistryValidationError when any descriptor is invalid — a missing
 * surprise range, a duplicate id, a default outside its own legal range. Every
 * issue is logged with the offending effect id before the throw.
 */
export function loadEffectRegistry(): EffectRegistry {
  if (loaded !== undefined) {
    if (loaded.kind === "ok") return loaded.registry;
    throw loaded.error;
  }

  const log = logger("app", correlationId());
  try {
    const discovered = discoverEffects();
    const registry = new EffectRegistryBuilder().registerAll(discovered).seal();
    loaded = { kind: "ok", registry };
    return registry;
  } catch (error) {
    // Not swallowed: logged with its cause, remembered, and rethrown.
    log.error("node registry failed to load", { error: String(error) });
    loaded = { kind: "failed", error };
    throw error;
  }
}
