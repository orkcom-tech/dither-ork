/**
 * Effect discovery.
 *
 * Effects are **found, never listed**. One effect is one module under
 * `web/src/effects/` whose file name ends in `.effect.ts` and whose default
 * export is a descriptor built with `defineEffect`. This module collects them
 * with Vite's `import.meta.glob`, eagerly, at startup.
 *
 * The reason is contention, not elegance. The catalogue is 63 effects that
 * arrive as 63 independent contributions; a central array would put every one
 * of them on the same line of the same file, so any two of them written in
 * parallel conflict. A glob makes adding an effect exactly one new file and
 * removing one exactly one deletion — nothing shared is edited either way.
 *
 * Eager, not lazy: the registry has to be complete before the first stack panel
 * renders or the first document loads, and validation (see `registry.ts`) can
 * only fail loudly at startup if every descriptor is present at startup.
 *
 * The convention in full:
 *
 * ```ts
 * // web/src/effects/floyd-steinberg.effect.ts
 * import { defineEffect } from "../types/registry";
 *
 * export default defineEffect({ id: "floyd-steinberg", ... });
 * ```
 *
 * - The path may nest (`web/src/effects/glitch/pixel-sort.effect.ts`); the glob
 *   is recursive, so effects may be grouped by family in folders or not at all.
 * - The `.effect.ts` suffix, rather than every `.ts` under the directory, is
 *   what lets shared helper modules live beside the descriptors without being
 *   mistaken for one.
 * - The file name is not the id. The id is in the descriptor, and it is what
 *   documents reference.
 */

import { logger } from "../lib/log";
import type { EffectDescriptor } from "../types/registry";

// The registry is application structure rather than part of a render, so it
// logs on `app` and carries no correlation id — nothing here belongs to one
// frame.
const log = logger("app");

/** A descriptor together with the module it came from. */
export interface DiscoveredEffect {
  readonly descriptor: EffectDescriptor;
  /** Module path exactly as the glob reports it. Used in every diagnostic. */
  readonly module: string;
}

/**
 * A module under the effects directory that is not an effect module.
 *
 * Separate from {@link RegistryValidationError} because the failures are
 * different in kind: this one means the file does not have a descriptor to
 * check at all, so descriptor-level validation cannot even run on it.
 */
export class EffectDiscoveryError extends Error {
  /** Offending module paths, or empty when the glob itself matched nothing. */
  readonly modules: readonly string[];

  constructor(message: string, modules: readonly string[]) {
    super(message);
    this.name = "EffectDiscoveryError";
    this.modules = modules;
  }
}

/**
 * Whether a module's default export is shaped enough to be handed to
 * descriptor validation.
 *
 * Deliberately shallow. Everything else — ranges, surprise metadata, id format
 * — is `validateEffect`'s job, and it produces far better messages than a type
 * guard would. The only fields checked here are the two whose absence would
 * make validation itself throw a bare `TypeError` instead of reporting an
 * issue: the descriptor object, and the `params` array it iterates.
 */
function isDescriptorShaped(value: unknown): value is EffectDescriptor {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { params?: unknown }).params);
}

/**
 * Load every effect module.
 *
 * Throws {@link EffectDiscoveryError} rather than skipping a bad module. A
 * skipped effect is invisible: the stack panel is simply missing a row, and
 * documents that reference it fail much later with an unrelated-looking error.
 *
 * @returns descriptors ordered by module path — a stable order that does not
 * depend on how the bundler or the filesystem enumerated the directory, so the
 * effect list and every weighted draw over it are reproducible.
 */
export function discoverEffects(): readonly DiscoveredEffect[] {
  // Vite requires the pattern to be a literal at the call site, so it cannot be
  // hoisted into a named constant without being a second thing to keep in sync.
  const modules: Record<string, unknown> = import.meta.glob(
    "../effects/**/*.effect.ts",
    { eager: true },
  );

  const paths = Object.keys(modules).sort();

  if (paths.length === 0) {
    // An empty catalogue is never a legitimate state, and it is exactly what a
    // renamed directory or a dropped `.effect` suffix produces. Failing here
    // makes that a startup error instead of an app with no effects in it.
    const message =
      "no effect modules matched ../effects/**/*.effect.ts; the glob and the effects directory have diverged";
    log.error(message);
    throw new EffectDiscoveryError(message, []);
  }

  const discovered: DiscoveredEffect[] = [];
  const malformed: string[] = [];

  for (const path of paths) {
    const module = modules[path];
    const descriptor =
      typeof module === "object" && module !== null
        ? (module as { default?: unknown }).default
        : undefined;

    if (!isDescriptorShaped(descriptor)) {
      log.error("effect module does not default-export a descriptor", {
        module: path,
        exported: descriptor === undefined ? "nothing" : typeof descriptor,
      });
      malformed.push(path);
      continue;
    }

    discovered.push({ descriptor, module: path });
  }

  if (malformed.length > 0) {
    throw new EffectDiscoveryError(
      `${malformed.length} effect module(s) do not default-export a descriptor: ${malformed.join(", ")}`,
      malformed,
    );
  }

  log.debug("effect modules discovered", { modules: discovered.length });
  return discovered;
}
