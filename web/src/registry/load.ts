/**
 * Loading the catalogue, once.
 *
 * `loadEffectRegistry()` is the one call the application makes: it discovers
 * every effect module, validates the whole catalogue, and returns the sealed
 * registry.
 *
 * Failure is loud and terminal. A registry that cannot be validated throws, and
 * startup is expected to surface that rather than continue — a build whose
 * catalogue is wrong renders wrong documents, and it does it convincingly.
 *
 * It lives here rather than in `index.ts` so that `gpu-effects.ts` can validate
 * its coverage against the sealed registry without importing the barrel that
 * re-exports it, which would be a cycle. The barrel still re-exports this, so
 * every caller keeps importing it from `../registry`.
 */

import { correlationId, logger } from "../lib/log";
import { discoverEffects } from "./discovery";
import { EffectRegistryBuilder, type EffectRegistry } from "./registry";

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
