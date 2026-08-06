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
| `search.ts` | Ranked search and structural filtering (F-ST-08) |
| `params.ts` | Defaults, validation and coercion for parameter sets |
| `index.ts` | `loadEffectRegistry()` — the one call startup makes |

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
