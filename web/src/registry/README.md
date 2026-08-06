# Node registry

The single source of truth about effects. The stack editor lists from it, the
graph schedules from it, the properties panel builds its controls from it, and
Surprise Me generates from it. There is no second list anywhere, and there is no
per-effect logic in this directory — everything an effect needs to say, it says
in its descriptor.

| File | What it does |
| --- | --- |
| `discovery.ts` | Finds effect modules with `import.meta.glob` |
| `registry.ts` | Builds, validates, seals; lookup by id, slot, kind, family |
| `load.ts` | `loadEffectRegistry()` — discover, validate, seal, once |
| `gpu-effects.ts` | `loadGpuEffects()` — from an effect id to its compute passes |
| `stack.ts` | `validateStack()` — the grammar rules that are about a combination |
| `search.ts` | Ranked search and structural filtering (F-ST-08) |
| `params.ts` | Defaults, validation and coercion for parameter sets |
| `index.ts` | The barrel; `loadEffectRegistry()` and `loadGpuEffects()` are the two calls startup makes |

## Adding an effect

**One effect is one file. Nothing central is edited.**

Create `web/src/effects/<id>.effect.ts` — nested folders are fine, e.g.
`web/src/effects/glitch/pixel-sort.effect.ts` — and default-export a descriptor:

```ts
import { defineEffect } from "../types/registry";

export default defineEffect({
  id: "pixel-sort",
  name: "Pixel Sort",
  requirement: "F-GL-01",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
  params: [ /* ... */ ],
});
```

That is the whole procedure. No registration call, no import into a list. The
catalogue is 63 effects arriving as 63 independent contributions, and a central
array would put every one of them on the same line of the same file.

Rules the glob enforces:

- The file name must end in **`.effect.ts`**. Helper modules may live beside
  descriptors without being mistaken for one.
- The **default export** must be the descriptor. A module without one is a
  startup error naming the file, not a silently missing effect.
- The **file name is not the id.** The id lives in the descriptor and is what
  documents reference.

### A parallel effect exports one more thing

An effect that declares `execution: "gpu"` also exports its compute passes under
**one name, `gpu`**:

```ts
import { defineEffect, staticGpuEffect } from "../types/registry";

const PIXEL_SORT_GPU: GpuEffect = { effect: "pixel-sort", passes: [ /* ... */ ] };

export default defineEffect({ id: "pixel-sort", execution: "gpu", /* ... */ });

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("pixel-sort", () => PIXEL_SORT_GPU);
```

That export is what turns an effect id out of a `.dork` file into something the
pass compiler can schedule. Without it the effect is listed in the stack panel,
validates, and cannot be rendered — so `loadGpuEffects()` refuses the whole
catalogue and names the module, exactly as a missing surprise range does.

**`build` is a thunk, not a value.** Several effects assemble a table before they
can name their passes — the glyph sheet (F-PT-08), the clustered-dot screens
(F-PT-03) — and building those at import time makes every effect in the
catalogue cost something whether or not the document uses it. It also means the
export can sit anywhere in the file instead of after everything it mentions.

**Some effects cannot be built from nothing.** The five ordered dithers carry a
threshold tile from `dither-core` as a `table` binding, and nothing on this side
fabricates one, so they declare what they are waiting for:

```ts
export const gpu = thresholdMatrixGpuEffect(spec.effectId, spec.tile, (matrix) =>
  orderedDitherEffect(spec, matrix),
);
```

A caller asks `resolver.requirementOf(id)` first, fetches what it names, and only
then asks for passes. `GpuBuildRequirement` is a closed union — `none` and
`threshold-matrix` today — so an effect that needs a new kind of build-time data
adds a member to it in `web/src/types/registry.ts` rather than improvising.

### Stack rules are not descriptor rules

`validateEffect` checks one effect. Some of the grammar is only about a
*combination*, and that is `validateStack(registry, stack)`:

- **the index map** — `requiresIndexMap` nodes (outline F-SP-10, dilate/erode
  F-SP-11, and later hue-targeted recolour F-CO-09, index remap F-CO-10, the SVG
  tracer F-EX-08) need a live quantizer in front of them. CMYK halftone (F-PT-02)
  is the one dither-slot node that emits no index map, because its output colours
  are ink overprints rather than palette entries, so it is the one that can leave
  a stack unrenderable. That combination is refused up front, naming both nodes,
  instead of throwing a `ScheduleError` after the user has built it.
- **exclusions** — `excludes` pairs are refused by the grammar rather than
  filtered after generation (F-SM-03).

Both the stack editor and Surprise Me call it, so neither keeps a copy of the
rule. Disabled nodes are skipped by every rule, because a disabled node is not in
the render (F-ST-02) and counting one either way describes a pipeline that does
not run.

**Read `web/src/effects/error-diffusion.ts` before writing a new descriptor.**
The reasoning about *why* each surprise range is where it is matters far more
than the numbers, and that file is where it is written out in full. It is also
the pattern for a family: fourteen kernels share one control set, so the set
lives in one non-`.effect.ts` helper beside them and each kernel's own file
carries only what is distinctive about that kernel. The same arrangement, in
mirror image, is why the ordered dithers' descriptors are built in
`web/src/gpu/effects/ordered.ts` — they sit next to the uniform layout that
reads their parameter keys — and their `.effect.ts` files are one-line
re-exports.

## Validation fails the startup, not the render

`loadEffectRegistry()` validates the whole catalogue and throws. Every issue is
logged first, on the `app` channel, naming the offending effect id, the
parameter and the module. Checked, among other things:

- ids are unique, kebab-case, and every `excludes` target exists;
- every effect declares a slot, a family and an execution kind;
- every parameter declares a surprise range, a distribution and a weight;
- surprise ranges sit **inside** legal ranges, defaults sit inside legal ranges,
  `log` distributions have a positive range, `normal` has a mean inside its range.

Missing surprise metadata is a validation failure, not a runtime surprise. The
generator has no per-effect logic, so a parameter nobody described is a
parameter Surprise Me silently never touches — which is a bug that shows up
months later as "the random results all look the same".

## Parameter helpers

- `defaultParams(effect)` — the set a freshly added node starts with.
- `validateParams(effect, params)` — reports, does not repair. For load.
- `coerceParams(effect, params)` — always returns something legal, and **logs a
  warning for every adjustment**. Its output always passes `validateParams`.

Coercion clamps numbers to their legal range, rounds integers, wraps seeds,
replaces unknown enum options and malformed colours or curves with the
descriptor default, and drops keys the effect does not declare. It never does
any of that quietly.
