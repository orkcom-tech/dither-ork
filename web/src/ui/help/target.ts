/**
 * What a piece of contextual help is *about* — F-UI-13.
 *
 * Help is attached to a control with one attribute holding one token:
 *
 * ```tsx
 * <button {...helpFor({ kind: "effect", effect: descriptor.id })}>…</button>
 * <div data-help="param:blur.radius">…</div>
 * <h2 data-help="concept:stack">Stack</h2>
 * ```
 *
 * A string rather than a React context or a wrapper component, for three
 * reasons that all turned out to be the same reason.
 *
 * - **The controller is one listener on the document.** Hover help has to know
 *   when the pointer moves from one control to an adjacent one, and a per-
 *   control listener learns that as a leave followed by an enter with a gap in
 *   between — which is the flicker F-UI-13 asks not to have. Delegation sees it
 *   as a single event, so the panel can change its content without ever closing.
 * - **A control does not have to be a React element.** The token survives
 *   `dangerouslySetInnerHTML`, a canvas overlay, or a element rendered by a
 *   library that does not forward props.
 * - **Adoption is one attribute.** Nothing has to be wrapped, no ref has to be
 *   threaded, and a control that has not been annotated behaves exactly as it
 *   does today.
 *
 * The token is parsed rather than trusted. A `data-help` naming an effect that
 * does not exist, or a concept nobody wrote, is a defect in the call site, and
 * {@link parseHelpToken} reports it as one so it lands in the log instead of
 * opening a blank panel.
 */

import { EFFECT_CONCEPTS, type EffectConcept } from "../../types/registry";
import { isUiConceptId, type UiConceptId } from "./concepts";

/** The attribute a control carries. */
export const HELP_ATTRIBUTE = "data-help";

/** The selector the controller delegates on. */
export const HELP_SELECTOR = `[${HELP_ATTRIBUTE}]`;

/**
 * The four things help can be about.
 *
 * Two read from the registry and two from a written concept. There is no fifth
 * kind and no free-text kind: help whose text is passed in at the call site is
 * the third hand-written copy F-UI-15 exists to prevent.
 */
export type HelpTarget =
  /** One effect, read from its descriptor. */
  | { readonly kind: "effect"; readonly effect: string }
  /** One parameter of one effect, read from its descriptor. */
  | { readonly kind: "param"; readonly effect: string; readonly param: string }
  /** An interface idea, from `./concepts.ts`. */
  | { readonly kind: "concept"; readonly concept: UiConceptId }
  /** A family idea, from `EFFECT_CONCEPTS` in the registry. */
  | { readonly kind: "effect-concept"; readonly concept: EffectConcept };

export type HelpTargetKind = HelpTarget["kind"];

export type HelpTokenIssue =
  /** No attribute value at all. */
  | "empty"
  /** The part before the colon is not one of the four kinds. */
  | "unknown-kind"
  /** A kind with nothing after the colon. */
  | "missing-id"
  /** `param:` without the `<effect>.<key>` shape. */
  | "malformed-param"
  /** A concept id nobody has written. */
  | "unknown-concept";

export type HelpTokenParse =
  | { readonly ok: true; readonly target: HelpTarget }
  | { readonly ok: false; readonly code: HelpTokenIssue; readonly token: string };

function bad(code: HelpTokenIssue, token: string): HelpTokenParse {
  return { ok: false, code, token };
}

/** Whether a string names one of the registry's family concepts. */
export function isEffectConceptId(value: string): value is EffectConcept {
  return Object.prototype.hasOwnProperty.call(EFFECT_CONCEPTS, value);
}

/**
 * Read a `data-help` value.
 *
 * Effect ids are *not* checked here — the registry is not in scope at parse
 * time, and an id that no longer exists is a different failure with a different
 * message (`article.ts` reports it against the sealed catalogue). What is
 * checked is everything that can be known from the string alone.
 */
export function parseHelpToken(token: string): HelpTokenParse {
  const trimmed = token.trim();
  if (trimmed.length === 0) return bad("empty", token);

  const colon = trimmed.indexOf(":");
  if (colon === -1) return bad("unknown-kind", token);

  const kind = trimmed.slice(0, colon);
  const rest = trimmed.slice(colon + 1);

  switch (kind) {
    case "effect":
      if (rest.length === 0) return bad("missing-id", token);
      return { ok: true, target: { kind: "effect", effect: rest } };

    case "param": {
      if (rest.length === 0) return bad("missing-id", token);
      // The effect id is kebab-case and a parameter key is camelCase; neither
      // contains a dot, so the first one separates them.
      const dot = rest.indexOf(".");
      if (dot <= 0 || dot === rest.length - 1) return bad("malformed-param", token);
      return {
        ok: true,
        target: { kind: "param", effect: rest.slice(0, dot), param: rest.slice(dot + 1) },
      };
    }

    case "concept":
      if (rest.length === 0) return bad("missing-id", token);
      if (!isUiConceptId(rest)) return bad("unknown-concept", token);
      return { ok: true, target: { kind: "concept", concept: rest } };

    case "effect-concept":
      if (rest.length === 0) return bad("missing-id", token);
      if (!isEffectConceptId(rest)) return bad("unknown-concept", token);
      return { ok: true, target: { kind: "effect-concept", concept: rest } };

    default:
      return bad("unknown-kind", token);
  }
}

/** The token for a target. Inverse of {@link parseHelpToken}. */
export function helpToken(target: HelpTarget): string {
  switch (target.kind) {
    case "effect":
      return `effect:${target.effect}`;
    case "param":
      return `param:${target.effect}.${target.param}`;
    case "concept":
      return `concept:${target.concept}`;
    case "effect-concept":
      return `effect-concept:${target.concept}`;
  }
}

/**
 * The attribute, ready to spread onto a JSX element.
 *
 * ```tsx
 * <button {...helpFor({ kind: "effect", effect: effect.id })} />
 * ```
 *
 * Typed as an exact one-key object so a typo in the attribute name is a compile
 * error at this one site rather than a control that silently has no help.
 */
export function helpFor(target: HelpTarget): { readonly "data-help": string } {
  return { "data-help": helpToken(target) };
}
