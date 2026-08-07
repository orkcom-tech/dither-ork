/**
 * The user guide, in the app — F-UI-14.
 *
 * Wiring it in is **one call**, from wherever the registry is already in hand:
 *
 * ```ts
 * // app/main.tsx, beside the other registrations, once boot has produced a registry:
 * import { registerGuide } from "../ui/guide";
 * registerGuide({ registry: outcome.registry });
 * ```
 *
 * Until that line exists the guide is complete and unreachable, which is stated
 * here rather than worked around: `web/src/app/` belongs to someone else this
 * round, and the same position is recorded at the top of `ui/documents/index.ts`
 * for the same reason. Nothing here reaches into the shell except through the
 * slot registry it publishes.
 *
 * It registers a **toolbar item**, not a panel. `app/slots.ts` closes the panel
 * ids to the four names F-UI-08 gives and says a fifth is a decision rather than
 * an accident; a guide is something you open, read and close, so it takes the
 * whole window as a modal instead of a column of one.
 *
 * ## What is here
 *
 * - `chapters.ts` — the seven hand-written chapters. Prose only: the ideas the
 *   registry cannot express, plus facts read off the sealed registry at render
 *   time so a sentence cannot state a count the catalogue has moved past.
 * - `catalogue.ts` — the effect catalogue, **generated** from the descriptors
 *   (F-UI-15). No effect is named anywhere in this directory; an effect added
 *   tomorrow is documented tomorrow, in the words its own author wrote, and
 *   `catalogue.test.ts` proves it by handing the builder an effect that does not
 *   exist.
 */

import React from "react";

import { registerToolbarItem } from "../../app";
import { logger } from "../../lib/log";
import type { EffectRegistry } from "../../registry";
import { GuideDialog } from "./GuideDialog";
import { GUIDE_CHAPTERS } from "./chapters";

const log = logger("app");

export interface GuideOptions {
  /** The sealed registry. Every word of the effect catalogue is read from it. */
  readonly registry: EffectRegistry;
}

/**
 * Put the guide in the toolbar.
 *
 * Call once. A second call is a duplicate slot registration and the shell
 * throws, which is what stops one of two registrations from being silently
 * invisible.
 *
 * `side: "end"`, next to the theme control, rather than in the start group. That
 * group is the document workflow — open, undo, view, documents, export, batch,
 * surprise, in the order a person moves through them — and help is not a step
 * in it.
 */
export function registerGuide(options: GuideOptions): void {
  registerToolbarItem({
    id: "guide",
    side: "end",
    // 0 is the notices banner. 1 puts the guide between it and the theme
    // control, which the shell renders last on that side.
    order: 1,
    // A closure rather than a context provider: the shell's slot takes a
    // component with no props, and the registry is created outside the tree.
    component: () => React.createElement(GuideDialog, { registry: options.registry }),
  });
  log.info("guide registered", {
    chapters: GUIDE_CHAPTERS.length,
    effects: options.registry.size,
  });
}

export { GuideDialog } from "./GuideDialog";
export { EffectCatalogue } from "./EffectCatalogue";
export {
  GUIDE_CHAPTERS,
  factsFor,
  type GuideChapter,
  type GuideChapterId,
  type GuideEntry,
  type GuideFact,
  type GuideList,
  type GuideStep,
} from "./chapters";
export {
  buildCatalogue,
  catalogueFor,
  describeControl,
  type CatalogueView,
  type GuideCatalogue,
  type GuideControl,
  type GuideEffect,
  type GuideSection,
} from "./catalogue";
