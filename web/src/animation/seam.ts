/**
 * F-AN-06 — loop seam validation.
 *
 * Run before an animated export. Answers two different questions, and keeping
 * them apart is what makes the report worth reading.
 *
 * ## 1. Does frame N equal frame 0?
 *
 * The ground truth is a **hash comparison**: `hashForFrame(0)` against
 * `hashForFrame(N)`, where the caller supplies the graph's output hash — which
 * `prepareGraph` already produces per frame, so this costs a second prepare and
 * no rendering at all.
 *
 * Everything this module produces is a pure function of `frame mod N`, so the
 * two hashes agree by construction and this check is *expected* to pass. It
 * earns its place by covering what this module does not control: an effect that
 * reads a clock, an asset re-registered between frames, a future keyframe track
 * that interpolates without wrapping. If it fails, something outside the
 * modulators broke periodicity, and the report says so in those words rather
 * than blaming a binding.
 *
 * ## 2. Which binding would break periodicity if it could?
 *
 * The per-binding check is deliberately **not** the wrapped evaluation. It
 * extends each modulator past the end of the loop — `unwrappedPhase` at frame
 * `N`, with no `mod N` — and compares that phase against frame 0's. For an
 * integer cycle count those are the same phase; for 2.5 they are half a turn
 * apart. So the check measures the F-AN-03 property directly instead of
 * restating it, and it catches a `CyclesPerLoop` that reached the spec through a
 * cast, a hand-edited `.dork`, or a future binding kind that is not periodic.
 *
 * Phases are compared rather than shape outputs on purpose: `Math.sin` is not
 * correctly rounded on any platform, so two evaluations of the same phase can
 * differ in the last bits and a value comparison would need a tolerance chosen
 * against the shape's slope. A phase is one number in turns with an obvious
 * scale, and the tolerance below is nine orders of magnitude below anything
 * visible and several above any accumulated rounding.
 *
 * ## A document that was never going to close
 *
 * A feedback node's output is the product of every frame before it, so frame N
 * is not frame 0 and no arrangement of the controls makes it. Such a document
 * is **marked non-looping by `planAnimation`** (`plan.loops === false`), and
 * this validator's job changes shape for it rather than failing it:
 *
 * - The **hash comparison is not run**, and `hashes` comes back `null`. Running
 *   it would be asking a question whose answer is already known, at the cost of
 *   a second prepare, and reporting the mismatch as `frame-hash-mismatch` would
 *   blame "something outside the modulators" for a property the document
 *   declares about itself.
 * - A `does-not-loop` issue is reported at **`info` severity**, which is
 *   neither an error nor a warning. It does not clear `ok`, because there is
 *   nothing wrong; it exists so that every surface reading a seam report —
 *   the export dialog, the timeline — says the same sentence, drawn from the
 *   same place, instead of three of them inventing wording.
 * - **Every per-binding check still runs at full strength.** F-AN-03 narrows
 *   for the document as a whole and not for its modulators: a cycles-per-loop
 *   of 2.5 is still an error here, because "this document does not close" is
 *   not a licence for a binding to be wrong as well.
 *
 * Decision 2 of `docs/dither-ork-node-graph.md`.
 *
 * ## Warnings, which are not failures
 *
 * A loop can close and still look wrong at the seam, and those are reported as
 * warnings rather than refused:
 *
 * - A hold that does not divide the frame count. Every pattern is held `K`
 *   frames except the last, which is short — the loop repeats cleanly and
 *   hitches once per repeat.
 * - A scroll whose travel is not a whole number of pattern periods. The offset
 *   returns to zero at the seam, so the loop closes; the pattern visibly snaps
 *   because it was mid-cell when it got there.
 * - A modulator sampled fewer than twice per feature. It loops, and it does not
 *   render the shape it names — it renders an alias of it.
 * - A binding whose swing runs past its parameter's legal range. The clamp
 *   flattens the shape at one or both ends; the value is still correct and the
 *   motion is not what the amount says.
 */

import type { LogFields } from "../lib/log";
import { logger } from "../lib/log";
import type { ResolvedBinding } from "./binding";
import { bindingSwing } from "./binding";
import type { AnimationPlan } from "./plan";
import { featuresPerLoop, modulatorPhase, unwrappedPhase } from "./modulator";
import type { ResolvedVariation } from "./temporal";
import { temporalContinuity } from "./temporal";

/**
 * Largest phase difference, in turns, still counted as periodic.
 *
 * `frac(cycles + phase)` and `frac(phase)` are the same real number and can
 * differ by a few ulps once `cycles` is large enough to push bits off the end of
 * `phase`. At the ceilings in `cycles.ts` that error is below 1e-12 turns. A
 * genuinely aperiodic binding is off by a fraction of a turn. Nothing lands
 * between.
 */
export const SEAM_PHASE_TOLERANCE = 1e-9;

/**
 * `info` is neither a failure nor a caution.
 *
 * It exists for exactly one thing today: a document that contains a feedback
 * node and therefore does not close. Nothing about it is wrong, nothing about
 * it can be fixed, and it must be *said* — so it needs a level that does not
 * clear `ok` and does not read as a complaint. A warning would tell the user to
 * go and correct something that is a property of the effect they chose.
 */
export type SeamSeverity = "error" | "warning" | "info";

export type SeamIssueCode =
  /** The document contains a feedback node, so frame N is not frame 0. */
  | "does-not-loop"
  /** A modulator's unwrapped phase at frame N is not its phase at frame 0 (F-AN-03). */
  | "phase-not-periodic"
  /** The output hash of frame N differs from frame 0's. The loop does not close. */
  | "frame-hash-mismatch"
  /** A temporal hold does not divide the frame count, so the last hold is short. */
  | "hold-does-not-divide"
  /** A scroll travels a fraction of a pattern period, so the pattern snaps at the seam. */
  | "scroll-not-period-aligned"
  /** A modulator has fewer than two frames per feature; the render is an alias of it. */
  | "sampled-below-nyquist"
  /** A binding's swing runs past its parameter's legal range and is clamped. */
  | "binding-clips";

export interface SeamIssue {
  readonly code: SeamIssueCode;
  readonly severity: SeamSeverity;
  /** Empty for an issue about the frame as a whole rather than one node. */
  readonly nodeId: string;
  /** The parameter for a binding issue; `null` for a node- or frame-level one. */
  readonly param: string | null;
  /** What a timeline would label the offending track. */
  readonly source: string;
  readonly message: string;
  readonly detail: LogFields;
}

export interface SeamReport {
  /** True when nothing of `error` severity was found. Warnings and info do not clear it. */
  readonly ok: boolean;
  readonly frames: number;
  readonly issues: readonly SeamIssue[];
  /**
   * The two hashes, when a `hashForFrame` was supplied; `null` when it was not,
   * **and `null` for a non-looping document**, whose two hashes are known to
   * differ and would only be a second prepare spent proving what the document
   * already declares.
   */
  readonly hashes: { readonly frame0: string; readonly frameN: string } | null;
  /**
   * Whether frame N is frame 0 for this document at all — `plan.loops`, carried
   * onto the report so a caller that has a report does not also need the plan.
   *
   * A document that does not loop can still be exported: it renders 0..N-1 and
   * the file simply does not join up at the ends. What must not happen is
   * refusing it for failing a check it was never going to pass, or letting the
   * user find out after 300 frames of encoding.
   */
  readonly loops: boolean;
}

export interface SeamOptions {
  /**
   * The graph's output hash for a frame.
   *
   * Called exactly twice — for frame 0 and for frame `N` — so the caller can
   * pass `prepareGraph(...).hashes.get(outputNodeId)` without preparing the
   * whole animation. Passing nothing skips the ground-truth check and leaves the
   * report to the per-binding analysis, which is what an editor wants while a
   * document is being edited and what an export must not settle for.
   */
  readonly hashForFrame?: (frame: number) => string;
}

const log = logger("graph");

/** Distance between two phases on the circle, in turns, in `[0, 0.5]`. */
export function phaseDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 1 - d);
}

function describeBinding(binding: ResolvedBinding): string {
  return `${binding.nodeId}.${binding.param} (${binding.spec.shape})`;
}

function describeVariation(variation: ResolvedVariation): string {
  return `${variation.nodeId} (${variation.variation.mode})`;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Check that the loop closes, and report what would stop it.
 *
 * Never throws. A seam report is something an editor shows while a document is
 * being changed; refusing to produce one would leave the UI with nothing to say.
 * The export path reads `ok`.
 */
export function validateLoopSeam(
  plan: AnimationPlan,
  options: SeamOptions = {},
): SeamReport {
  const { clock } = plan;
  const issues: SeamIssue[] = [];

  // First, so a reader of the issue list meets the fact about the whole
  // document before the per-binding detail rather than after it.
  if (!plan.loops) {
    const named = plan.feedbackNodes.join(", ");
    issues.push({
      code: "does-not-loop",
      severity: "info",
      // Deliberately not attributed to one node: it is true of the document,
      // and a single node id would read as "this one is the problem".
      nodeId: "",
      param: null,
      source: "document",
      message:
        `This document does not loop. ${plan.feedbackNodes.length === 1 ? "Node" : "Nodes"} ${named} ` +
        `read the previous frame, so frame ${clock.frames} is the product of every frame before it ` +
        `and cannot be frame 0. That is a property of feedback rather than a fault in the ` +
        `settings — the ${clock.frames} frames still render and export, they just do not join up ` +
        `at the ends.`,
      detail: { feedbackNodes: named, frames: clock.frames },
    });
  }

  for (const binding of plan.bindings) {
    const source = describeBinding(binding);

    const atZero = modulatorPhase(binding.spec, clock, 0);
    const atSeam = unwrappedPhase(binding.spec, clock, clock.frames);
    const drift = phaseDistance(atZero, atSeam);
    if (drift > SEAM_PHASE_TOLERANCE) {
      issues.push({
        code: "phase-not-periodic",
        severity: "error",
        nodeId: binding.nodeId,
        param: binding.param,
        source,
        message:
          `${source} is ${round(drift)} turns away from where it started after one loop. ` +
          `Its effective cycles-per-loop is ${binding.spec.cycles}, which must be a whole ` +
          `number for frame N to be frame 0 (F-AN-03).`,
        detail: {
          cycles: binding.spec.cycles,
          phase: round(binding.spec.phase),
          drift: round(drift),
        },
      });
    }

    const features = featuresPerLoop(binding.spec);
    if (features * 2 > clock.frames) {
      issues.push({
        code: "sampled-below-nyquist",
        severity: "warning",
        nodeId: binding.nodeId,
        param: binding.param,
        source,
        message:
          `${source} has ${features} feature(s) over ${clock.frames} frame(s) — fewer than two ` +
          `frames per feature. The loop closes; what renders is an alias of the shape rather ` +
          `than the shape.`,
        detail: { features, frames: clock.frames, shape: binding.spec.shape },
      });
    }

    const swing = bindingSwing(binding, clock);
    const [min, max] = binding.descriptor.legal;
    if (swing.min < min || swing.max > max) {
      issues.push({
        code: "binding-clips",
        severity: "warning",
        nodeId: binding.nodeId,
        param: binding.param,
        source,
        message:
          `${source} swings ${round(swing.min)}..${round(swing.max)}, past the legal ` +
          `${min}..${max} of ${binding.effect}.${binding.param}. The clamp holds the value ` +
          `legal and flattens the shape at the end(s) it overruns.`,
        detail: {
          swingMin: round(swing.min),
          swingMax: round(swing.max),
          legalMin: min,
          legalMax: max,
          base: round(binding.base),
          amount: round(binding.amount),
        },
      });
    }
  }

  for (const resolved of plan.variations) {
    const variation = resolved.variation;
    const source = describeVariation(resolved);

    if ("hold" in variation) {
      const remainder = clock.frames % variation.hold;
      if (remainder !== 0) {
        issues.push({
          code: "hold-does-not-divide",
          severity: "warning",
          nodeId: resolved.nodeId,
          param: null,
          source,
          message:
            `${source} holds each pattern ${variation.hold} frame(s), which does not divide the ` +
            `${clock.frames}-frame loop; the last hold is ${remainder} frame(s) long. Frame N ` +
            `is still frame 0, so the loop closes — it hitches once per repeat.`,
          detail: { hold: variation.hold, frames: clock.frames, lastHold: remainder },
        });
      }
    }

    if (variation.mode === "bayer-offset-scroll") {
      const [cx, cy] = variation.cellsPerLoop;
      const period = variation.cellPeriod;
      const rx = ((cx % period) + period) % period;
      const ry = ((cy % period) + period) % period;
      if (rx !== 0 || ry !== 0) {
        issues.push({
          code: "scroll-not-period-aligned",
          severity: "warning",
          nodeId: resolved.nodeId,
          param: null,
          source,
          message:
            `${source} travels ${cx}, ${cy} cell(s) over the loop, which is not a whole number ` +
            `of its ${period}-cell pattern period; the offset returns to zero at the seam so the ` +
            `loop closes, and the pattern snaps ${rx}, ${ry} cell(s) getting there. Use a ` +
            `multiple of ${period}.`,
          detail: { cellsX: cx, cellsY: cy, period, residualX: rx, residualY: ry },
        });
      }
    }

    // Recorded so the report can be read without knowing the mode table: a
    // stepwise mode jumps by design, so a reader who sees no issue for it knows
    // that is the answer rather than an omission.
    log.debug("temporal variation checked", {
      nodeId: resolved.nodeId,
      mode: variation.mode,
      continuity: temporalContinuity(variation.mode),
    });
  }

  let hashes: SeamReport["hashes"] = null;
  const hashForFrame = options.hashForFrame;
  // Skipped for a non-looping document. The two hashes describe the graph's
  // *parameters*, which a feedback node's history is not part of, so they would
  // in fact agree — and reporting "the loop closes" for a document that does
  // not would be the exact false reassurance F-AN-06 exists to prevent. The
  // honest answer is the `does-not-loop` issue above, and it is already there.
  if (hashForFrame !== undefined && plan.loops) {
    const frame0 = hashForFrame(0);
    const frameN = hashForFrame(clock.frames);
    hashes = { frame0, frameN };
    if (frame0 !== frameN) {
      const named = issues.filter((issue) => issue.severity === "error").length;
      issues.push({
        code: "frame-hash-mismatch",
        severity: "error",
        nodeId: "",
        param: null,
        source: "frame",
        message:
          named > 0 ?
            `frame ${clock.frames} does not hash the same as frame 0; the ${named} binding(s) ` +
            `reported above are the cause.`
          : `frame ${clock.frames} does not hash the same as frame 0, and no binding in this ` +
            `document explains it — every modulator and every temporal variation returned to ` +
            `its starting value. Something outside them is not a pure function of the frame ` +
            `index: an effect reading a clock, an asset re-registered between frames, or an ` +
            `unseeded draw.`,
        detail: { frame0, frameN, explainedBy: named },
      });
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const report: SeamReport = {
    ok: errors.length === 0,
    frames: clock.frames,
    issues,
    hashes,
    loops: plan.loops,
  };

  const summary = {
    frames: clock.frames,
    bindings: plan.bindings.length,
    variations: plan.variations.length,
    errors: errors.length,
    warnings: warnings.length,
    hashed: hashes !== null,
    loops: plan.loops,
  };
  // Three outcomes rather than two, because "does not close, and was never
  // going to" is not the same event as "should have closed and did not", and
  // logging them the same way is how the second one stops being noticed.
  if (!report.ok) log.warn("loop seam does not close", summary);
  else if (!plan.loops) log.info("document does not loop; seam validation skipped", summary);
  else log.info("loop seam validated", summary);

  return report;
}
