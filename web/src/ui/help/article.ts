/**
 * Turning a {@link HelpTarget} into the thing the panel prints.
 *
 * **No sentence in this file describes an effect or a parameter.** Every word of
 * that comes off the descriptor — `summary`, `description`, and for a family the
 * registry's own `EFFECT_CONCEPTS` — which is F-UI-15 in the one place it is
 * easiest to break. What this file adds is structure: a title, a handful of
 * facts already declared elsewhere in the descriptor (slot, execution, legal
 * range, default), and the family line.
 *
 * A missing description is reported, never invented. `validateRegistry` already
 * refuses a catalogue with one, so reaching {@link HelpLookup} with
 * `missing-description` means the sealed registry disagrees with its own
 * validator — that is a defect to be seen, and the panel stays shut rather than
 * opening with a title and nothing under it.
 *
 * Pure, and therefore tested against the real catalogue with no DOM.
 */

import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import type { SrgbTriplet } from "../../types/document";
import {
  EFFECT_CONCEPTS,
  type EffectDescriptor,
  type ParamDescriptor,
  type ParamType,
} from "../../types/registry";
import { EXECUTION_LABEL, SLOT_LABEL } from "../stack/model";
import { UI_CONCEPTS } from "./concepts";
import { helpToken, type HelpTarget, type HelpTargetKind } from "./target";

const log = logger("app");

/** One declared fact, printed as a label/value pair under the prose. */
export interface HelpFact {
  readonly label: string;
  readonly value: string;
}

/** The family idea an effect belongs to, named and summarised in one line. */
export interface HelpFamily {
  readonly title: string;
  readonly summary: string;
  /** The token that opens the family's own article. */
  readonly token: string;
}

export interface HelpArticle {
  /** The token this was resolved from; also the panel's identity across moves. */
  readonly token: string;
  readonly kind: HelpTargetKind;
  readonly title: string;
  /** A parameter has only one descriptive field, so this is null for one. */
  readonly summary: string | null;
  readonly description: string;
  readonly facts: readonly HelpFact[];
  readonly family: HelpFamily | null;
}

export type HelpMissCode =
  /** The token names an effect the sealed catalogue does not have. */
  | "unknown-effect"
  /** The effect exists; the parameter key is not one of its declared ones. */
  | "unknown-param"
  /** The descriptor carries no text. A registry defect, not a state to render. */
  | "missing-description";

export type HelpLookup =
  | { readonly ok: true; readonly article: HelpArticle }
  | {
      readonly ok: false;
      readonly code: HelpMissCode;
      readonly token: string;
      /** Written to be logged as it stands. */
      readonly detail: string;
    };

/** What a parameter kind is called on screen. Structure, not description. */
const PARAM_TYPE_LABEL: Record<ParamType, string> = {
  float: "number",
  int: "whole number",
  bool: "toggle",
  enum: "choice",
  color: "colour",
  seed: "seed",
  curve: "curve",
};

/**
 * Six significant figures, then trailing zeros dropped.
 *
 * Descriptor defaults are written as literals and arrive as doubles, so a
 * legal range of `[0, 0.3]` prints as `0.3` rather than as the binary
 * expansion of it.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}

function formatTriplet(rgb: SrgbTriplet): string {
  return `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`;
}

/** The default, in the same words the control shows. */
function formatDefault(param: ParamDescriptor): string {
  switch (param.type) {
    case "float":
    case "int":
    case "seed":
      return formatNumber(param.default);
    case "bool":
      return param.default ? "on" : "off";
    case "enum": {
      const option = param.values.find((value) => value.value === param.default);
      return option?.label ?? param.default;
    }
    case "color":
      return formatTriplet(param.default);
    case "curve":
      return `${param.default.length} points`;
  }
}

function paramFacts(param: ParamDescriptor): readonly HelpFact[] {
  const facts: HelpFact[] = [
    { label: "Kind", value: PARAM_TYPE_LABEL[param.type] },
    { label: "Default", value: formatDefault(param) },
  ];
  if (param.type === "float" || param.type === "int") {
    facts.push({
      label: "Range",
      value: `${formatNumber(param.legal[0])} to ${formatNumber(param.legal[1])}`,
    });
  }
  if (param.type === "enum") {
    facts.push({
      label: "Options",
      value: param.values.map((value) => value.label).join(", "),
    });
  }
  // Only worth a line when it is true: "animatable: no" on the majority of
  // parameters is noise, and the timeline already refuses to bind one.
  if (param.animatable) facts.push({ label: "Animatable", value: "yes" });
  return facts;
}

function effectFacts(effect: EffectDescriptor): readonly HelpFact[] {
  const facts: HelpFact[] = [
    { label: "Slot", value: SLOT_LABEL[effect.slot] },
    { label: "Runs on", value: EXECUTION_LABEL[effect.execution] },
    { label: "Requirement", value: effect.requirement },
  ];
  // The two grammar properties, stated only when they constrain where the node
  // may go. Both are the reason the picker refuses a placement, so the help
  // that explains a refusal has to carry them.
  if (effect.producesIndexMap) facts.push({ label: "Index map", value: "produces one" });
  if (effect.requiresIndexMap) {
    facts.push({ label: "Index map", value: "needs one in front of it" });
  }
  if (effect.resamples === true) {
    facts.push({ label: "Extent", value: "writes a different size than it reads" });
  }
  return facts;
}

function familyOf(effect: EffectDescriptor): HelpFamily | null {
  if (effect.concept === undefined) return null;
  const concept = EFFECT_CONCEPTS[effect.concept];
  return {
    title: concept.title,
    summary: concept.summary,
    token: helpToken({ kind: "effect-concept", concept: concept.id }),
  };
}

function miss(code: HelpMissCode, token: string, detail: string): HelpLookup {
  // Warn rather than debug: every one of these is a call site pointing at
  // something that does not exist, or a descriptor that got past validation
  // without text. Both are defects, and neither is visible on screen because
  // the panel does not open.
  log.warn("contextual help has nothing to show", { token, code, detail });
  return { ok: false, code, token, detail };
}

/**
 * Resolve a target against the sealed registry.
 *
 * Takes the registry as an argument rather than reaching for a module-level one:
 * there is exactly one in the application, but a test wants its own, and a
 * second document window would want its own too.
 */
export function resolveHelp(registry: EffectRegistry, target: HelpTarget): HelpLookup {
  const token = helpToken(target);

  switch (target.kind) {
    case "concept": {
      const concept = UI_CONCEPTS[target.concept];
      return {
        ok: true,
        article: {
          token,
          kind: "concept",
          title: concept.title,
          summary: concept.summary,
          description: concept.description,
          facts: [],
          family: null,
        },
      };
    }

    case "effect-concept": {
      const concept = EFFECT_CONCEPTS[target.concept];
      return {
        ok: true,
        article: {
          token,
          kind: "effect-concept",
          title: concept.title,
          summary: concept.summary,
          description: concept.description,
          facts: [],
          family: null,
        },
      };
    }

    case "effect": {
      const effect = registry.get(target.effect);
      if (effect === undefined) {
        return miss(
          "unknown-effect",
          token,
          `no effect is registered under id "${target.effect}"`,
        );
      }
      if (effect.description.trim().length === 0) {
        return miss(
          "missing-description",
          token,
          `effect "${effect.id}" carries no description`,
        );
      }
      return {
        ok: true,
        article: {
          token,
          kind: "effect",
          title: effect.name,
          summary: effect.summary.trim().length === 0 ? null : effect.summary,
          description: effect.description,
          facts: effectFacts(effect),
          family: familyOf(effect),
        },
      };
    }

    case "param": {
      const effect = registry.get(target.effect);
      if (effect === undefined) {
        return miss(
          "unknown-effect",
          token,
          `no effect is registered under id "${target.effect}"`,
        );
      }
      const param = effect.params.find((candidate) => candidate.key === target.param);
      if (param === undefined) {
        return miss(
          "unknown-param",
          token,
          `effect "${effect.id}" declares no parameter "${target.param}"`,
        );
      }
      if (param.description.trim().length === 0) {
        return miss(
          "missing-description",
          token,
          `parameter "${effect.id}.${param.key}" carries no description`,
        );
      }
      return {
        ok: true,
        article: {
          token,
          kind: "param",
          title: param.label,
          // A parameter has one descriptive field. Printing it twice, once as a
          // lead and once as the body, would be the drift F-UI-15 names showing
          // up inside a single panel.
          summary: null,
          description: param.description,
          facts: paramFacts(param),
          family: null,
        },
      };
    }
  }
}
