/**
 * Contextual help on hover — F-UI-13.
 *
 * Two calls and one attribute are the whole of the public surface.
 *
 * ```ts
 * // once, at startup, beside the other panel registrations
 * const removeHelp = installHelp({ registry });
 * ```
 *
 * ```tsx
 * // at any control that should describe itself
 * <button {...helpFor({ kind: "effect", effect: descriptor.id })}>…</button>
 * <div {...helpFor({ kind: "param", effect: effect.id, param: param.key })}>…</div>
 * <h2 {...helpFor({ kind: "concept", concept: "stack" })}>Stack</h2>
 * ```
 *
 * Nothing here writes descriptive text about an effect or a parameter — F-UI-15
 * puts that in the descriptor, and `article.ts` reads it. The one kind of prose
 * this directory owns is in `concepts.ts`: the interface ideas no descriptor is
 * about, such as what a node is or what the colour metric changes. The registry's
 * own `EFFECT_CONCEPTS` covers the family ideas, including the index map, and is
 * reached with `{ kind: "effect-concept", concept: … }`.
 *
 * A control that has not been annotated behaves exactly as it did before, and
 * nothing at all is drawn until one is dwelt on — so this feature has no
 * half-built state on screen.
 */

export {
  UI_CONCEPTS,
  UI_CONCEPT_IDS,
  isUiConceptId,
  type UiConcept,
  type UiConceptId,
} from "./concepts";

export {
  HELP_ATTRIBUTE,
  HELP_SELECTOR,
  helpFor,
  helpToken,
  isEffectConceptId,
  parseHelpToken,
  type HelpTarget,
  type HelpTargetKind,
  type HelpTokenIssue,
  type HelpTokenParse,
} from "./target";

export {
  resolveHelp,
  type HelpArticle,
  type HelpFact,
  type HelpFamily,
  type HelpLookup,
  type HelpMissCode,
} from "./article";

export {
  CLOSE_GRACE_MS,
  DEFAULT_TIMING,
  DWELL_MS,
  IDLE_DWELL,
  isHelpOpen,
  nextDeadline,
  reduceDwell,
  shownToken,
  type DwellEvent,
  type DwellPhase,
  type DwellState,
  type DwellTiming,
} from "./dwell";

export {
  HELP_GAP,
  HELP_MARGIN,
  HELP_SIDE_ORDER,
  intersects,
  placeHelp,
  type HelpPlacement,
  type HelpSide,
  type PlaceHelpInput,
  type Rect,
  type Size,
} from "./placement";

export {
  HELP_KEY,
  HELP_PANEL_CLASS,
  HELP_PANEL_ID,
  createHelpController,
  type HelpController,
  type HelpControllerOptions,
  type HelpView,
} from "./controller";

export { HelpLayer } from "./HelpLayer";
export { HelpPanel, type HelpPanelProps } from "./HelpPanel";
export { bindHelp, installHelp, type InstallHelpOptions } from "./install";
