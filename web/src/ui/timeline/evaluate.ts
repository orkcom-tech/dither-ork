/**
 * Tracks plus a frame index become a document — the seam between the timeline
 * and the renderer.
 *
 * A plan is built once per edit and holds everything that does not depend on the
 * frame: the checked clock, the resolved modulator bindings (`animation/`'s job,
 * not repeated here), and the keyframe tracks resolved against their parameter
 * descriptors. {@link documentAtFrame} then turns a frame index into an ordinary
 * `DitherDocument` **with no bindings left in it**, which is precisely what
 * `state/render/graph.ts` accepts.
 *
 * ```ts
 * const plan = buildTimelinePlan({ document, registry, tracks, speed, phaseOffset });
 * const frameDocument = documentAtFrame(plan, playhead);   // hand to the renderer
 * ```
 *
 * ## Modulators are not re-implemented here
 *
 * Every modulator track goes through `animation/plan.ts` as an ordinary
 * `Binding`. That is what gets the branded cycles-per-loop, the seeded noise, the
 * clamp to the parameter's legal range and the refusals — an unknown node, a
 * parameter the effect does not declare, a parameter marked `animatable: false`.
 * None of that is restated in this file, and none of it can drift from the core,
 * because there is only one copy.
 *
 * ## What a keyframe track adds, and how it is scaled
 *
 * A keyframe holds an **absolute** parameter value, so a track's contribution is
 * measured against the parameter's authored value:
 *
 * ```
 * value(frame) = clamp( base + (key(frame) - base) * trackAmount, legal )
 * ```
 *
 * At `trackAmount` 0 the track is the identity and the parameter sits where the
 * properties panel shows it; at 1 it is exactly the keyframed value. That is the
 * same shape as `animation/binding.ts`'s `base + amount * unit`, deliberately:
 * F-AN-11's per-track amount then means one thing across both kinds of track
 * rather than two things that happen to share a label.
 *
 * The rounding, the clamp and the `-0` collapse mirror `bindingValueAt` exactly —
 * an `int` parameter is rounded *before* it is clamped, so the clamp is what
 * guarantees the legal bound, and `-0` becomes `0` because `graph/hash.ts` treats
 * them as one value and two documents that render the same picture must hash the
 * same.
 *
 * Pure. No React, no DOM, no clock.
 */

import {
  AnimationError,
  bindingValueAt,
  documentAtFrame as animationDocumentAtFrame,
  globalSpeed,
  loopClock,
  loopFrame,
  planAnimation,
  type AnimationPlan,
  type GlobalTiming,
  type LoopClock,
} from "../../animation";
import type { EffectRegistry } from "../../registry";
import type { DitherDocument, ParameterValue, StackNode } from "../../types/document";
import type { FloatParam, IntParam } from "../../types/registry";
import { keyframeValueAt, type Keyframe } from "./keyframes";
import { modulatorBindings, type Track } from "./model";

/** The two parameter kinds a track can drive, the same pair `animation/` takes. */
type NumericParam = FloatParam | IntParam;

/** A keyframe track that has been checked against its parameter's descriptor. */
export interface ResolvedKeyframeTrack {
  readonly trackId: string;
  readonly nodeId: string;
  readonly param: string;
  readonly descriptor: NumericParam;
  /** The value in the document — what the parameter reads at track amount 0. */
  readonly base: number;
  readonly amountScale: number;
  readonly keys: readonly Keyframe[];
}

export interface TimelinePlan {
  readonly document: DitherDocument;
  readonly clock: LoopClock;
  readonly animation: AnimationPlan;
  readonly keyframes: readonly ResolvedKeyframeTrack[];
  readonly timing: GlobalTiming;
  /** Node ids this plan expects to move, in stack order — for marking tracks. */
  readonly animatedNodes: readonly string[];
}

export interface TimelinePlanRequest {
  readonly document: DitherDocument;
  readonly registry: EffectRegistry;
  readonly tracks: readonly Track[];
  /** F-AN-10. A positive integer; anything else is refused by `animation/`. */
  readonly speed: number;
  /** F-AN-10, in turns. */
  readonly phaseOffset: number;
}

function findNumericParam(
  registry: EffectRegistry,
  node: StackNode,
  key: string,
): NumericParam {
  const descriptor = registry.get(node.effect);
  if (descriptor === undefined) {
    throw new AnimationError(
      "unknown-effect",
      `node ${node.id} names effect "${node.effect}", which this build does not have`,
      { nodeId: node.id, effect: node.effect },
    );
  }
  const param = descriptor.params.find((entry) => entry.key === key);
  if (param === undefined) {
    throw new AnimationError(
      "unknown-parameter",
      `effect "${descriptor.id}" declares no parameter "${key}"`,
      { nodeId: node.id, effect: descriptor.id, param: key },
    );
  }
  if (!param.animatable) {
    throw new AnimationError(
      "parameter-not-animatable",
      `"${descriptor.id}.${param.key}" declares animatable: false, so a keyframe track may not ` +
        `drive it`,
      { nodeId: node.id, effect: descriptor.id, param: param.key, type: param.type },
    );
  }
  if (param.type !== "float" && param.type !== "int") {
    throw new AnimationError(
      "parameter-not-numeric",
      `"${descriptor.id}.${param.key}" is a ${param.type}; only float and int parameters can ` +
        `carry a track`,
      { nodeId: node.id, effect: descriptor.id, param: param.key, type: param.type },
    );
  }
  return param;
}

function baseValue(node: StackNode, descriptor: NumericParam): number {
  const value = node.params[descriptor.key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AnimationError(
      "non-finite-value",
      `node ${node.id} parameter "${descriptor.key}" is ${String(value)}; a tracked parameter ` +
        `must hold a finite number in the document, because the track moves around it`,
      { nodeId: node.id, param: descriptor.key, value: String(value) },
    );
  }
  return value;
}

/**
 * Build the plan.
 *
 * Throws exactly where `animation/plan.ts` throws — an unknown node, a parameter
 * the effect does not declare, a parameter that is not animatable, a
 * cycles-per-loop that is not a positive integer. The store catches it and shows
 * it; nothing here repairs a track quietly.
 */
export function buildTimelinePlan(request: TimelinePlanRequest): TimelinePlan {
  const { document, registry, tracks } = request;
  const clock = loopClock(document.clock);

  const timing: GlobalTiming = {
    speed: globalSpeed(request.speed),
    phaseOffset: request.phaseOffset,
  };

  // The modulator half, delegated whole. The document handed over carries the
  // bindings the tracks describe and nothing else; the one that comes back out
  // of `documentAtFrame` carries none.
  const bound: DitherDocument = { ...document, bindings: modulatorBindings(tracks) };
  const animation = planAnimation(bound, registry, { timing });

  const nodes = new Map(document.stack.map((node) => [node.id, node]));
  const keyframes: ResolvedKeyframeTrack[] = [];
  for (const track of tracks) {
    if (!track.enabled || track.spec.kind !== "keyframe") continue;
    const node = nodes.get(track.nodeId);
    if (node === undefined) {
      throw new AnimationError(
        "unknown-node",
        `keyframe track targets node "${track.nodeId}", which is not in the stack`,
        { nodeId: track.nodeId, param: track.param },
      );
    }
    const descriptor = findNumericParam(registry, node, track.param);
    keyframes.push({
      trackId: track.id,
      nodeId: track.nodeId,
      param: track.param,
      descriptor,
      base: baseValue(node, descriptor),
      amountScale: track.amountScale,
      keys: track.spec.keys,
    });
  }

  const moving = new Set(animation.animatedNodes);
  for (const track of keyframes) moving.add(track.nodeId);

  return {
    document,
    clock,
    animation,
    keyframes,
    timing,
    animatedNodes: document.stack
      .filter((node) => moving.has(node.id))
      .map((node) => node.id),
  };
}

/**
 * Shape a raw value for a parameter.
 *
 * Mirrors `animation/binding.ts`'s `bindingValueAt` line for line, because a
 * keyframe and a modulator writing the same parameter must produce values from
 * the same set — an `int` rounded then clamped, and `-0` collapsed to `0`.
 */
export function shapeValue(descriptor: NumericParam, raw: number): number {
  const [min, max] = descriptor.legal;
  const shaped = descriptor.type === "int" ? Math.round(raw) : raw;
  const value = shaped < min ? min : shaped > max ? max : shaped;
  return value === 0 ? 0 : value;
}

/** The value one keyframe track writes on a frame, or `null` when it has no keys. */
export function keyframeTrackValueAt(
  track: ResolvedKeyframeTrack,
  clock: LoopClock,
  frame: number,
): number | null {
  const keyed = keyframeValueAt(track.keys, clock.frames, frame);
  if (keyed === null) return null;
  return shapeValue(track.descriptor, track.base + (keyed - track.base) * track.amountScale);
}

/**
 * The document one frame renders.
 *
 * Carries no bindings — `animation/plan.ts` strips them and this adds none — so
 * it goes straight to `RenderService.render`.
 */
export function documentAtFrame(plan: TimelinePlan, frame: number): DitherDocument {
  // Validates the index and reports it in loop terms.
  const at = loopFrame(plan.clock, frame);
  const modulated = animationDocumentAtFrame(plan.animation, at);
  if (plan.keyframes.length === 0) return modulated;

  const byNode = new Map<string, ResolvedKeyframeTrack[]>();
  for (const track of plan.keyframes) {
    const list = byNode.get(track.nodeId);
    if (list === undefined) byNode.set(track.nodeId, [track]);
    else list.push(track);
  }

  return {
    ...modulated,
    stack: modulated.stack.map((node) => {
      const tracks = byNode.get(node.id);
      if (tracks === undefined) return node;
      const params: Record<string, ParameterValue> = { ...node.params };
      for (const track of tracks) {
        const value = keyframeTrackValueAt(track, plan.clock, at);
        if (value === null) continue;
        params[track.param] = value;
      }
      return { ...node, params };
    }),
  };
}

/** What one track does across the whole loop, for the lane that draws it. */
export interface TrackCurve {
  readonly trackId: string;
  /** One value per sample, in frame order, starting at frame 0. */
  readonly values: readonly number[];
  /** The frame each sample was taken on. */
  readonly frames: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly legal: readonly [number, number];
  readonly base: number;
}

/**
 * Largest number of points a lane is drawn from.
 *
 * A lane is at most a few hundred CSS pixels wide, so more samples than this
 * cannot be told apart on screen — and the frame count is allowed to reach
 * `MAX_FRAMES`, which would otherwise be a hundred thousand evaluations per lane
 * per render.
 */
export const CURVE_SAMPLES = 240;

/**
 * Sample a track over the loop.
 *
 * The last sample is frame `N - 1` rather than frame `N`: `t` never reaches 1
 * (F-AN-01), and drawing frame `N` would draw frame 0 of the next loop as though
 * it were part of this one. The lane closes anyway, because the value at the
 * right-hand edge and the value at the left-hand edge are the same number — that
 * is the whole point of the wrap-around constraint, and drawing it honestly is
 * what lets somebody see it.
 */
export function trackCurve(plan: TimelinePlan, track: Track): TrackCurve | null {
  const total = plan.clock.frames;
  const count = Math.min(total, CURVE_SAMPLES);
  const frames: number[] = [];
  for (let i = 0; i < count; i += 1) {
    frames.push(Math.min(total - 1, Math.round((i * total) / count)));
  }

  const resolved = plan.animation.bindings.find(
    (binding) => binding.nodeId === track.nodeId && binding.param === track.param,
  );
  const keyed = plan.keyframes.find((entry) => entry.trackId === track.id);

  let read: ((frame: number) => number) | null = null;
  let legal: readonly [number, number] | null = null;
  let base = 0;

  // The lane draws the value the render will actually use, read back through
  // the core's own evaluator rather than through a second copy of the modulator
  // arithmetic. A drawing that could disagree with the picture is worse than no
  // drawing.
  if (resolved !== undefined) {
    legal = resolved.descriptor.legal;
    base = resolved.base;
    read = (frame) => bindingValueAt(resolved, plan.clock, frame);
  } else if (keyed !== undefined) {
    legal = keyed.descriptor.legal;
    base = keyed.base;
    read = (frame) => keyframeTrackValueAt(keyed, plan.clock, frame) ?? keyed.base;
  }

  if (read === null || legal === null) return null;

  const sample = read;
  const values = frames.map((frame) => sample(frame));
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { trackId: track.id, values, frames, min, max, legal, base };
}
