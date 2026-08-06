/**
 * Resolving a pass's output extent.
 *
 * One place, one arithmetic. The rule a pass declares
 * ({@link PassExtent}) is turned into a concrete {@link Extent} here and
 * nowhere else, because the number produced is read by four layers that must
 * agree exactly — the texture pool allocates it, the executor dispatches over
 * it, the uniform packer hands it to the shader as `output-width`, and the
 * graph charges the cache for it. Two of those computing `ceil(w / f)` slightly
 * differently is a one-texel border of stale pixels, which is visible,
 * intermittent, and attributable to nothing.
 *
 * The invariants this module enforces, all of them rejections rather than
 * repairs:
 *
 * - **The factor is an integer of at least 1.** A fractional internal
 *   resolution makes the output extent a rounding decision, and a factor of
 *   zero makes it a division by zero dressed up as a black frame.
 * - **The result is at least one texel on each axis.** A 3-pixel-wide image at
 *   factor 8 resolves to 1, not to 0; a zero-width texture is a WebGPU
 *   validation error a long way from the slider that caused it.
 * - **The input extent is itself valid.** A pass fed a non-integer extent is a
 *   bug upstream, and finding it here names the pass.
 */

import type { ParameterValue } from "../types/document";
import type { ComputePass, Extent, ExtentAxes, PassExtent } from "../types/gpu";
import { SAME_EXTENT } from "../types/gpu";
import { logger } from "../lib/log";

const log = logger("gpu");

export class ExtentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtentError";
  }
}

/** Human-readable, for error messages and log lines. */
export function describeExtent(extent: Extent): string {
  return `${extent.width}x${extent.height}`;
}

export function extentsEqual(a: Extent, b: Extent): boolean {
  return a.width === b.width && a.height === b.height;
}

/** Reject an extent nothing downstream could allocate or dispatch over. */
export function assertExtent(label: string, extent: Extent): Extent {
  for (const [axis, value] of [
    ["width", extent.width],
    ["height", extent.height],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ExtentError(
        `${label}: ${axis} ${String(value)} is not a positive integer`,
      );
    }
  }
  return extent;
}

/** The rule a pass declares. Absent means {@link SAME_EXTENT}. */
export function passExtentRule(pass: ComputePass): PassExtent {
  return pass.extent ?? SAME_EXTENT;
}

/** Whether a pass can write a different shape than it reads. */
export function resizes(rule: PassExtent): boolean {
  return rule.kind !== "same";
}

function scaleOf(axes: ExtentAxes | undefined, axis: "x" | "y"): boolean {
  const which = axes ?? "both";
  return which === "both" || which === axis;
}

/**
 * Read the factor out of the node's own parameters.
 *
 * Refused rather than defaulted when the key is absent: a resampling node whose
 * factor parameter is missing is a node the registry and the pass disagree
 * about, and quietly using 1 would make the disagreement invisible by rendering
 * the identity.
 */
function factorOf(
  label: string,
  rule: Extract<PassExtent, { factorParam: string }>,
  params: Readonly<Record<string, ParameterValue>>,
): number {
  const raw = params[rule.factorParam];
  if (raw === undefined) {
    throw new ExtentError(
      `${label}: extent rule "${rule.kind}" reads parameter "${rule.factorParam}", which this node does not carry`,
    );
  }
  if (typeof raw !== "number") {
    throw new ExtentError(
      `${label}: extent parameter "${rule.factorParam}" is a ${typeof raw}; a resampling factor has to be a number`,
    );
  }
  if (!Number.isInteger(raw) || raw < 1) {
    throw new ExtentError(
      `${label}: extent parameter "${rule.factorParam}" is ${raw}; the factor must be an integer of at least 1`,
    );
  }
  return raw;
}

/**
 * The extent a pass writes, given the extent it reads and the node's
 * parameters.
 *
 * Pure. It touches no device and no registry, which is what lets the whole
 * resizing story be tested without a GPU.
 */
export function resolveExtent(
  label: string,
  rule: PassExtent,
  input: Extent,
  params: Readonly<Record<string, ParameterValue>>,
): Extent {
  assertExtent(`${label} input`, input);

  if (rule.kind === "same") return input;

  const factor = factorOf(label, rule, params);
  const scaleX = scaleOf(rule.axes, "x");
  const scaleY = scaleOf(rule.axes, "y");

  const apply = (value: number, scale: boolean): number => {
    if (!scale) return value;
    // Ceil, then floor at one texel. See the note on `PassExtent.downscale`:
    // the last output texel of a box or Lanczos filter legitimately covers a
    // partial source window, and dropping it drops a column of the image.
    return rule.kind === "downscale"
      ? Math.max(1, Math.ceil(value / factor))
      : value * factor;
  };

  const output: Extent = {
    width: apply(input.width, scaleX),
    height: apply(input.height, scaleY),
  };
  assertExtent(`${label} output`, output);

  log.debug("extent resolved", {
    pass: label,
    rule: rule.kind,
    axes: rule.axes ?? "both",
    factor,
    from: describeExtent(input),
    to: describeExtent(output),
  });
  return output;
}

/** {@link resolveExtent} for a pass, reading its own declared rule. */
export function resolvePassExtent(
  pass: ComputePass,
  input: Extent,
  params: Readonly<Record<string, ParameterValue>>,
): Extent {
  return resolveExtent(pass.id, passExtentRule(pass), input, params);
}
