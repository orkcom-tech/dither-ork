/**
 * The guide's effect catalogue, generated from the registry (F-UI-14, F-UI-15).
 *
 * **No effect is named in this directory.** Every heading, every summary, every
 * paragraph and every control line below is read off the descriptors, so an
 * effect added tomorrow is documented tomorrow, with the text its author wrote
 * and not with a second copy of it that somebody has to remember to update. That
 * is the whole of F-UI-15: the properties panel's tooltips, the hover help and
 * this catalogue are three views of one field.
 *
 * ## Why it is organised by concept rather than by family
 *
 * `EffectFamily` says which requirement group an effect came from — it is a
 * filing decision, and the add-node picker is right to use it, because that is
 * where you go knowing roughly what you want. A reader arrives instead knowing
 * nothing, and what they need is the idea several effects share. That is
 * `EffectConcept`, which exists for exactly this (`types/registry.ts`): posterize
 * and levels are filed under different families and are the same idea, and the
 * `special` family holds four unrelated ideas at once.
 *
 * The section order is the declaration order of `EFFECT_CONCEPTS` rather than a
 * list kept here, so a concept added there appears here with no edit. An effect
 * whose descriptor names no concept is not dropped — it lands in a final section
 * that says so and logs a warning, because a catalogue that silently omits an
 * effect is worse than one with an untidy heading.
 */

import { logger } from "../../lib/log";
import type { EffectRegistry, SearchMiss } from "../../registry";
import type { NodeSlot, SrgbTriplet } from "../../types/document";
import {
  EFFECT_CONCEPTS,
  type EffectConcept,
  type EffectDescriptor,
  type EffectFamily,
  type ExecutionKind,
  type ParamDescriptor,
} from "../../types/registry";

const log = logger("app");

/** One control, as the catalogue prints it. */
export interface GuideControl {
  readonly key: string;
  readonly label: string;
  /** The descriptor's own sentence about what it does to the picture. */
  readonly description: string;
  /** Its bounds and default, on one line. */
  readonly detail: string;
  /** Whether a modulator or a keyframe track may drive it. */
  readonly animatable: boolean;
}

/** One effect, as the catalogue prints it. */
export interface GuideEffect {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly requirement: string;
  readonly slot: NodeSlot;
  readonly family: EffectFamily;
  readonly execution: ExecutionKind;
  readonly producesIndexMap: boolean;
  readonly requiresIndexMap: boolean;
  readonly controls: readonly GuideControl[];
}

/**
 * One chapter of the catalogue: an idea, and the effects that share it.
 *
 * `concept` is null only for the section that collects effects whose descriptor
 * names no concept. Nothing in the shipped catalogue lands there — a test in
 * `registry/catalogue.test.ts` asserts every effect declares one — and it exists
 * so that an effect added without one is visible rather than missing.
 */
export interface GuideSection {
  readonly concept: EffectConcept | null;
  /** Stable anchor for the contents rail. */
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly effects: readonly GuideEffect[];
}

export interface GuideCatalogue {
  readonly sections: readonly GuideSection[];
  /** Effects in this catalogue — the whole registry, or what a query matched. */
  readonly effects: number;
  /** Controls across those effects. */
  readonly controls: number;
}

/** What the catalogue view shows, for a query or for none. */
export interface CatalogueView {
  readonly catalogue: GuideCatalogue;
  /** The query as typed. Empty means the whole catalogue. */
  readonly query: string;
  /** Why a query matched nothing. Null when it matched, or when there is none. */
  readonly miss: SearchMiss | null;
  /** Effects in the build, which is the denominator a filtered count is read against. */
  readonly total: number;
}

const UNFILED: Omit<GuideSection, "effects"> = {
  concept: null,
  id: "unfiled",
  title: "Not filed under an idea",
  summary: "These effects declare no concept, so nothing here explains what they have in common.",
  description:
    "Every effect is supposed to name the idea it belongs to, and the build refuses a catalogue where one does not. Anything appearing here is a defect in the effect's own descriptor rather than a category — it is printed so that the catalogue is complete, not because the grouping means anything.",
};

/** `#rrggbb` for a colour default. */
function hex(triplet: SrgbTriplet): string {
  return `#${triplet.map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * A control's bounds and default, on one line.
 *
 * Deliberately only the facts the descriptor states. What the control *does* is
 * `param.description`, written once by the effect's author, and restating it in
 * different words here would be the second copy this whole arrangement exists to
 * avoid.
 */
export function describeControl(param: ParamDescriptor): string {
  switch (param.type) {
    case "float":
    case "int":
      return `${param.legal[0]} to ${param.legal[1]}, default ${param.default}`;
    case "bool":
      return `on or off, default ${param.default ? "on" : "off"}`;
    case "enum": {
      const chosen = param.values.find((option) => option.value === param.default);
      const options = param.values.map((option) => option.label).join(" · ");
      return `${options} — default ${chosen === undefined ? param.default : chosen.label}`;
    }
    case "color":
      return `a colour, default ${hex(param.default)}`;
    case "seed":
      return `a seed, default ${param.default} — any value is as good as any other`;
    case "curve":
      return `a curve, ${param.default.length} points by default`;
  }
}

function describeEffect(effect: EffectDescriptor): GuideEffect {
  return {
    id: effect.id,
    name: effect.name,
    summary: effect.summary,
    description: effect.description,
    requirement: effect.requirement,
    slot: effect.slot,
    family: effect.family,
    execution: effect.execution,
    producesIndexMap: effect.producesIndexMap,
    requiresIndexMap: effect.requiresIndexMap,
    controls: effect.params.map((param) => ({
      key: param.key,
      label: param.label,
      description: param.description,
      detail: describeControl(param),
      animatable: param.animatable,
    })),
  };
}

/**
 * Group descriptors into the catalogue.
 *
 * Takes descriptors rather than the registry so the same function serves the
 * whole catalogue and a search result, and so it can be tested against the real
 * shipped set without a browser.
 *
 * Order within a section is the order it was handed: registry order with no
 * query — the same order the add-node picker shows — and search rank with one.
 */
export function buildCatalogue(effects: readonly EffectDescriptor[]): GuideCatalogue {
  const byConcept = new Map<EffectConcept, GuideEffect[]>();
  const unfiled: GuideEffect[] = [];
  let controls = 0;

  for (const effect of effects) {
    const entry = describeEffect(effect);
    controls += entry.controls.length;
    const concept = effect.concept;
    if (concept === undefined) {
      unfiled.push(entry);
      continue;
    }
    const existing = byConcept.get(concept);
    if (existing === undefined) byConcept.set(concept, [entry]);
    else existing.push(entry);
  }

  const sections: GuideSection[] = [];
  for (const concept of Object.values(EFFECT_CONCEPTS)) {
    const found = byConcept.get(concept.id);
    if (found === undefined || found.length === 0) continue;
    sections.push({
      concept: concept.id,
      id: concept.id,
      title: concept.title,
      summary: concept.summary,
      description: concept.description,
      effects: found,
    });
  }

  if (unfiled.length > 0) {
    // Loud rather than silent: the registry validator cannot catch this — a
    // concept is optional on the descriptor — and a missing chapter heading is
    // how an effect goes undocumented while appearing to be documented.
    log.warn("effects in the guide declare no concept", {
      effects: unfiled.map((effect) => effect.id).join(","),
    });
    sections.push({ ...UNFILED, effects: unfiled });
  }

  return { sections, effects: effects.length, controls };
}

/**
 * The catalogue for a query, or the whole of it when there is none.
 *
 * An empty query is handled separately rather than passed through the search:
 * `searchWithMiss("")` correctly reports that nothing matched nothing, and the
 * resting state of a reference is the whole reference.
 */
export function catalogueFor(registry: EffectRegistry, query: string): CatalogueView {
  if (query.trim().length === 0) {
    return {
      catalogue: buildCatalogue(registry.all()),
      query,
      miss: null,
      total: registry.size,
    };
  }
  const search = registry.searchWithMiss(query);
  return {
    catalogue: buildCatalogue(search.results.map((result) => result.effect)),
    query,
    miss: search.miss,
    total: registry.size,
  };
}
