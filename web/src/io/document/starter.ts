/**
 * The starter preset set — F-DO-04, honestly scoped.
 *
 * ## What this is, and what it is not
 *
 * F-DO-04 asks for a **curated** library demonstrating every effect family.
 * Curating one means putting the application in front of a person and looking at
 * pictures, and nothing in a repository can stand in for that. So what ships is
 * a **starter set**: six presets, one per family that can be demonstrated with a
 * stack alone, each named for what it shows. It is a small honest floor, not the
 * curated library, and the moment somebody sits with the app and a photograph it
 * should be replaced by one.
 *
 * ## Why they carry no parameter values of their own
 *
 * Every node is materialised at its effect's **declared defaults**. That is not
 * laziness, it is the one choice that cannot be wrong: the catalogue's defaults
 * are the values its authors chose as an opening position, and they took care
 * that none of them is the identity — `internal-resolution` opens at factor 2
 * precisely because "a node that does nothing when it is added looks broken".
 * Hand-written values here would be a second opinion about every effect,
 * written by someone who has not seen the output, and they would drift from the
 * descriptor silently.
 *
 * What the set therefore demonstrates is **combination and order**, which is the
 * thing a preset is actually for.
 *
 * ## Why they carry no palette of their own
 *
 * The two-entry black and white the application opens with. The fifteen
 * interesting palettes are hardware facts that live in `core/…/palette.rs` and
 * reach this side through `builtinPalettes()`; copying their numbers into this
 * file would be a second set to keep true, and `ui/palette/library.ts` records
 * why that is the one thing not to do. A preset saved by a person after choosing
 * a palette carries it, which is the path that should carry it.
 *
 * ## They are checked, not asserted
 *
 * `starter.test.ts` builds this set against the **real catalogue** and runs
 * `validateStack` over every one. An effect id that disappears, or an order that
 * leaves a node reading an index map nothing produced, fails the build rather
 * than shipping a library entry that refuses to render when it is clicked.
 */

import type { DitherDocument, StackNode } from "../../types/document";
import { DOCUMENT_SCHEMA_VERSION } from "../../types/document";
// Deep imports rather than the `state` barrel — see the note in `dork.ts`.
import { DEFAULT_CLOCK, DEFAULT_PALETTE, createStackNode } from "../../state/document";
import type { EffectRegistry } from "../../registry";
import { defaultParams } from "../../registry";
import { chainOf } from "../../graph/edit";
import { logger } from "../../lib/log";
import type { Preset } from "./preset";

const log = logger("io");

/**
 * When the set was written.
 *
 * A constant rather than `new Date()`: these are not created when the library
 * opens, and a clock read here would give every one of them a different
 * `createdAt` on every load and make the library's own tests non-reproducible.
 */
const STARTER_CREATED_AT = "2026-08-07T00:00:00.000Z";

export interface StarterPresetSpec {
  readonly id: string;
  readonly name: string;
  /** What it demonstrates. Shown in the library, so it is written for a reader. */
  readonly note: string;
  /** Effect ids, in stack order. Materialised at their declared defaults. */
  readonly effects: readonly string[];
}

/**
 * Six stacks, one per family the stack alone can show.
 *
 * The two families with no entry are named rather than quietly missing:
 * **preprocess** appears inside "Chunky pixels" rather than alone, because a
 * tone or resolution node with no dither after it is a picture of nothing in
 * particular; and there is no glitch-only entry, because the glitch family reads
 * as damage to a dither rather than as an effect in its own right — "CRT" is
 * where it is shown.
 */
export const STARTER_PRESETS: readonly StarterPresetSpec[] = [
  {
    id: "starter/floyd-steinberg",
    name: "Floyd–Steinberg",
    note: "Error diffusion, on its own. The reference dither, and the thing every other family is compared against.",
    effects: ["floyd-steinberg"],
  },
  {
    id: "starter/bayer-8",
    name: "Bayer 8×8",
    note: "An ordered dither: one repeating 64-value tile, so the texture is regular where diffusion's is not.",
    effects: ["bayer-8"],
  },
  {
    id: "starter/halftone",
    name: "Halftone dots",
    note: "The pattern family — a screen of growing dots rather than a grid of thresholds.",
    effects: ["halftone"],
  },
  {
    id: "starter/chunky",
    name: "Chunky pixels",
    note: "Crush the working resolution, dither at that size, then blow it back up with hard edges. The F-PP-01 pair, which is what most low-fi looks actually are.",
    effects: ["internal-resolution", "floyd-steinberg", "nn-upscale"],
  },
  {
    id: "starter/outlined",
    name: "Outlined flats",
    note: "A quantizer followed by a node that reads its index map: the outline falls on palette boundaries, not on colour differences.",
    effects: ["bayer-8", "outline"],
  },
  {
    id: "starter/crt",
    name: "CRT",
    note: "A dither seen through a shadow mask and scanlines — the glitch family applied to an image that has already been quantized.",
    effects: ["bayer-4", "scanlines", "crt-mask"],
  },
];

function stackFor(registry: EffectRegistry, effects: readonly string[]): readonly StackNode[] {
  return effects.map((effect, index) => {
    // `require` rather than `get`: a starter preset naming an effect the build
    // does not have is a defect in this file, and it is caught at the moment the
    // library opens rather than when somebody clicks the entry.
    const descriptor = registry.require(effect);
    return createStackNode(`n${index + 1}`, descriptor.id, defaultParams(descriptor));
  });
}

function documentFor(registry: EffectRegistry, spec: StarterPresetSpec): DitherDocument {
  // The starter set is a set of chains, which is what a starter preset is: a
  // recipe you read top to bottom. `chainOf` is the one place that turns a list
  // into wiring, so these are wired exactly as a migrated schema-1 document is.
  const stack = stackFor(registry, spec.effects);
  const chain = chainOf(stack);
  return {
    schema: DOCUMENT_SCHEMA_VERSION,
    source: null,
    stack,
    edges: chain.edges,
    output: chain.output,
    palette: DEFAULT_PALETTE,
    clock: DEFAULT_CLOCK,
    bindings: [],
  };
}

/** The starter set, materialised against this build's catalogue. */
export function buildStarterPresets(registry: EffectRegistry): readonly Preset[] {
  const presets = STARTER_PRESETS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    createdAt: STARTER_CREATED_AT,
    note: spec.note,
    builtin: true,
    document: documentFor(registry, spec),
  }));
  log.debug("starter presets built", { presets: presets.length });
  return presets;
}
