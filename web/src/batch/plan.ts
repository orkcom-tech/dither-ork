/**
 * What has to be true before a run may start, and what is worth saying even
 * when it may.
 *
 * Pure, and separated from `run.ts` so the panel can call it on every keystroke
 * in the template field and show the reason the button is disabled *on the
 * button*, rather than discovering it after two hundred files have been
 * decoded.
 *
 * ## Refusals versus warnings
 *
 * A **refusal** is a state in which the run would destroy something or produce
 * nothing: no images, a template with a typo in it, two inputs that provably
 * write to one name, per-image palettes with no extractor behind them. Those
 * stop the button.
 *
 * A **warning** is a state a person may well have meant: an empty stack, a
 * template that can only be checked once the pictures exist. Those are printed
 * and the run proceeds, because refusing something legitimate is its own kind
 * of lying about what the application can do.
 *
 * ## Why the collision check is exact in one case and a warning in the other
 *
 * `{width}` and `{height}` expand to the *output* extent, which is only certain
 * after an encode — a vector export ignores the scale multiplier, so predicting
 * it would sometimes be wrong. So:
 *
 * - A template with neither token produces names that depend only on things
 *   known now, and the check is **exact**: colliding names are refused, by name.
 * - A template with either token cannot be checked now, so the duplicate
 *   *inputs* are named as a warning and `run.ts` carries the backstop, which
 *   fails the second item rather than overwriting the first.
 */

import { formatInfo } from "../export";
import { MAX_ZIP_ENTRIES } from "./zip";
import {
  NAME_TOKENS,
  outputFileName,
  templateRefusal,
  templateUsesExtent,
} from "./naming";
import { duplicatesIn } from "./queue";
import type { BatchDeliveryKind } from "./destination";
import type { BatchInputFile, BatchSettings } from "./types";

export interface BatchPlanContext {
  readonly items: readonly BatchInputFile[];
  readonly settings: BatchSettings;
  readonly presetName: string;
  /** Whether an extractor was supplied, which F-BA-04's per-image mode needs. */
  readonly hasExtractor: boolean;
  /** How many nodes the document's stack has. Zero is legal and is a warning. */
  readonly stackSize: number;
  readonly delivery: BatchDeliveryKind;
}

export interface BatchPlan {
  /** Every reason the run may not start. Empty means it may. */
  readonly refusals: readonly string[];
  /** Every reason it is worth pausing over. Never stops anything. */
  readonly warnings: readonly string[];
  /**
   * The names the run will produce, when they can be known — for the queue's
   * preview column. `null` when the template depends on the output extent.
   */
  readonly names: readonly string[] | null;
}

export function planBatch(context: BatchPlanContext): BatchPlan {
  const refusals: string[] = [];
  const warnings: string[] = [];

  if (context.items.length === 0) {
    refusals.push("No images are queued. Add files, or drop a folder onto this dialog.");
  }

  const template = templateRefusal(context.settings.template);
  if (template !== null) refusals.push(template);

  if (context.settings.palette === "per-image" && !context.hasExtractor) {
    // Not a silent fall back to the document palette: the person asked for one
    // thing and would have received another, which is the failure the whole
    // codebase is written against.
    refusals.push(
      "Per-image palettes were chosen but no extractor is available, so every " +
        "output would silently use the document's palette instead.",
    );
  }

  if (context.delivery === "zip" && context.items.length > MAX_ZIP_ENTRIES) {
    refusals.push(
      `${context.items.length} files is more than the ${MAX_ZIP_ENTRIES} a ZIP can ` +
        `hold. Write into a folder instead, or run this in smaller groups.`,
    );
  }

  let names: readonly string[] | null = null;
  if (template === null && !templateUsesExtent(context.settings.template)) {
    // Every token this template uses is known now, so the names are exact and
    // so is the collision check. The extent passed here is never read.
    names = context.items.map((item, index) =>
      outputFileName(context.settings.template, {
        sourceName: item.path,
        index,
        total: context.items.length,
        presetName: context.presetName,
        width: 0,
        height: 0,
        format: context.settings.export.format,
      }),
    );
    const collided = duplicatesIn(names);
    if (collided.length > 0) {
      const shown = collided.slice(0, 4).join(", ");
      const more = collided.length > 4 ? ` and ${collided.length - 4} more` : "";
      refusals.push(
        `${collided.length} output name${collided.length === 1 ? "" : "s"} would be ` +
          `produced twice (${shown}${more}), and the second file would replace the ` +
          `first. Add {index} to the name template.`,
      );
    }
  } else if (template === null) {
    const stems = context.items.map((item) => item.path.split(/[/\\]/).pop() ?? item.path);
    const repeated = duplicatesIn(stems);
    if (repeated.length > 0) {
      warnings.push(
        `The name template uses {width} or {height}, which are only known once a ` +
          `picture has been rendered, so the names cannot be checked yet. ` +
          `${repeated.length} input name${repeated.length === 1 ? " is" : "s are"} ` +
          `repeated; if two of them come out the same size, the second will be ` +
          `refused rather than overwrite the first.`,
      );
    }
  }

  if (context.stackSize === 0) {
    warnings.push(
      "The stack is empty, so every output is the input re-encoded as " +
        `${formatInfo(context.settings.export.format).label} and nothing else.`,
    );
  }

  return { refusals, warnings, names };
}

/** The token list, as one line for a hint under the template field. */
export function tokenHint(): string {
  return NAME_TOKENS.map((token) => `{${token.id}}`).join(" ");
}
