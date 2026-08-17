/**
 * The surprise panel's state, as pure functions.
 *
 * Everything the panel can be asked to do that does not need a renderer, a
 * document store or a WASM core lives here, so it is unit-tested without any of
 * them — the same arrangement `ui/palette/model.ts` and `ui/stack/model.ts` use.
 *
 * The one thing worth reading twice is {@link readiness}. Surprise Me is refused
 * rather than degraded when its inputs are not all there, and the refusal names
 * which input. That is not caution: F-SM-05 draws the palette mode from three
 * modes — extract, library, synthesize — and a mode that is drawn and then found
 * unavailable would have to fall back to another, which would make one seed mean
 * two different palettes depending on whether the hardware library had finished
 * loading. Refusing until all three are available is what keeps F-SM-02's "the
 * same seed always reproduces the same result" true.
 *
 * # One control per aspect, with three states
 *
 * The panel used to show four on/off locks and nothing else, and two things were
 * wrong with that. It was not clear what a lock *meant* — the padlock says "this
 * one is special" and leaves which way round to be guessed — and there was no way
 * to say **do not make this**, so somebody who wanted the picture to stop moving
 * reached for the animation lock and pinned animation on.
 *
 * So an aspect now carries exactly one {@link AspectMode}: `reroll`, `keep`, or
 * `off`. Three named states in one control rather than two independent toggles,
 * for the reason `ui/timeline/model.ts` derives a track id from its target:
 * **the illegal combination should be unrepresentable rather than prevented**.
 * "Keep this" and "do not make this at all" cannot both be true of one aspect,
 * and with two rows of toggles that is a rule somebody has to remember to
 * enforce in the store, in the panel, and in whatever calls them next. With one
 * mode per aspect there is no rule — there is nowhere to write the contradiction
 * down. The generator still checks it, because it is public and pure.
 *
 * `off` is only offered where the absence is a state a document can actually
 * hold, which is animation and nothing else; `SurpriseExcludes` in
 * `surprise/generate.ts` is where that argument is written out in full, and this
 * file reads {@link EXCLUDABLE_KEYS} rather than restating it.
 */

import type { SurpriseExcludes, SurpriseLocks } from "../../surprise";
import type { UiConceptId } from "../help";

/** Where the chaos slider starts (F-SM-07). */
export const DEFAULT_CHAOS = 0.35;

/** The slider's quantum. Coarse enough that the number reads as a setting. */
export const CHAOS_STEP = 0.05;

/**
 * The things a surprise decides independently, in panel order.
 *
 * Four of them are what `SurpriseLocks` carries, because an aspect *is* what a
 * lock locks — naming them twice is how the two lists drift apart. The fifth is
 * **graph shape**, which has an off and no keep; see {@link LOCKABLE_KEYS}.
 */
export const ASPECT_KEYS = ["palette", "stack", "params", "animation", "shape"] as const;
export type AspectKey = (typeof ASPECT_KEYS)[number];

/**
 * The aspects that have a `keep`.
 *
 * The four `SurpriseLocks` carries, and graph shape is deliberately not among
 * them. "Keep the shape" would have to mean "compose a different graph of the
 * same kind", and that is not something anybody reached for the padlock to ask:
 * a shape somebody liked came with the effects that were in it, and **`stack`
 * set to keep already keeps the wiring** — the edges, the output and the masks —
 * so the useful half of "keep the shape" is a control that already exists. A
 * second one beside it would be two buttons for one idea, and the one that did
 * less would be the one people pressed.
 */
export const LOCKABLE_KEYS = ["palette", "stack", "params", "animation"] as const;
export type LockableKey = (typeof LOCKABLE_KEYS)[number];

export function isLockable(key: AspectKey): key is LockableKey {
  return (LOCKABLE_KEYS as readonly AspectKey[]).includes(key);
}

/**
 * What a surprise does with one aspect.
 *
 * - `reroll` — make a new one on every press. The default, and what the feature
 *   is for.
 * - `keep` — the lock (F-SM-06): the next press leaves this one alone.
 * - `off` — the exclude: do not produce it at all.
 */
export type AspectMode = "reroll" | "keep" | "off";

/**
 * The aspects that have an `off`.
 *
 * Two, and `surprise/generate.ts`'s {@link SurpriseExcludes} is where the reason
 * lives: an exclude is only offerable where the absence is a state a document
 * can hold. `bindings: []` is one — an ordinary still document. A plain chain
 * over the document's own image is the other, and not merely *a* state but the
 * state every `.dork` written before schema 2 is in.
 *
 * The remaining three still have none. A palette with no colours is refused by
 * the loader and by the GPU; an empty stack is Surprise Me doing nothing; a node
 * with no parameters does not exist. Offering an `off` there would be three
 * controls that either lie or do nothing.
 */
export const EXCLUDABLE_KEYS = ["animation", "shape"] as const;
export type ExcludeKey = (typeof EXCLUDABLE_KEYS)[number];

export function isExcludable(key: AspectKey): key is ExcludeKey {
  return (EXCLUDABLE_KEYS as readonly AspectKey[]).includes(key);
}

/**
 * The modes this aspect offers, in the order the panel shows them.
 *
 * Built from the two lists rather than written out, so an aspect that gains a
 * keep or an off gains the button in the same edit that gains the behaviour.
 */
export function modesFor(key: AspectKey): readonly AspectMode[] {
  const modes: AspectMode[] = ["reroll"];
  if (isLockable(key)) modes.push("keep");
  if (isExcludable(key)) modes.push("off");
  return modes;
}

export function aspectLabel(key: AspectKey): string {
  switch (key) {
    case "palette":
      return "palette";
    case "stack":
      return "stack";
    case "params":
      return "parameters";
    case "animation":
      return "animation";
    case "shape":
      return "graph shape";
  }
}

export function modeLabel(mode: AspectMode): string {
  switch (mode) {
    case "reroll":
      return "reroll";
    case "keep":
      return "keep";
    case "off":
      return "off";
  }
}

/**
 * One line saying what this button will do, in the words a person would use.
 *
 * Shown on the control itself, so the answer to "what does this mean" is where
 * the question is asked. The longer form — what keeping and leaving out are, in
 * general — is contextual help (F-UI-13) and lives in `ui/help/concepts.ts`, so
 * there is one copy of each and this file does not restate it.
 */
export function modeHint(key: AspectKey, mode: AspectMode): string {
  // `off` is answered first and for the one aspect that has it, rather than
  // falling through a ternary that would quietly hand back the `reroll` line for
  // a state that does not exist. A wrong sentence on a control is worse than a
  // stack trace nobody can reach.
  if (mode === "off") {
    if (!isExcludable(key)) throw noOffError(key);
    return key === "animation"
      ? "Leave animation out entirely. Nothing moves, and the timeline has no tracks."
      : // Three things in one sentence because they are one setting: no
        // generator in place of the picture, no branch driving a mask, and no
        // feedback. The loop is named because it is the only consequence that
        // is not about how the picture looks.
        "A plain chain over your image: no generated source, no branch feeding a mask, and no feedback — so the document loops.";
  }
  if (key === "shape") {
    if (mode === "keep") {
      // Unreachable through the panel: `modesFor` offers this aspect no keep.
      // Stated rather than returning a sentence for a state that does not exist.
      throw new Error(
        '"shape" has no keep: locking the stack already keeps the wiring, so a second control for it would be two buttons for one idea',
      );
    }
    return "Draw a new shape every press: sometimes a generated source, sometimes a branch feeding a mask, sometimes feedback. Chaos decides how often it is more than a chain.";
  }
  switch (key) {
    case "palette":
      return mode === "keep"
        ? "Keep this palette. A liked palette survives fifty stack rerolls."
        : "Make a new palette every time you press Surprise.";
    case "stack":
      return mode === "keep"
        ? "Keep these effects and their order. Parameters still reroll unless they are kept too."
        : "Pick new effects, and a new order for them, every time you press Surprise.";
    case "params":
      return mode === "keep"
        ? "Keep every parameter. With the stack rerolling, new effects arrive at their defaults — there is nothing of theirs to keep."
        : "Draw new values for every parameter every time you press Surprise.";
    case "animation":
      return mode === "keep"
        ? // A reroll re-uses the node ids, so "the node is gone" is not the whole
          // rule and saying it would be a promise the generator does not keep: a
          // binding is also dropped when the effect that inherited its id has no
          // such parameter. `surprise/animation.ts` explains why.
          "Keep the movement you have. A binding the new stack cannot carry — its node is gone, or the effect that took its place has no such parameter — is dropped."
        : "Set a few parameters moving every time you press Surprise.";
  }
}

/**
 * The contextual-help article each mode points at (F-UI-13).
 *
 * Here rather than spelled out at the call site, so the mode list and the
 * articles are checked against each other by the type system and by one test —
 * a `data-help` naming a concept nobody wrote is a control that opens nothing,
 * and `parseHelpToken` would only find out at hover time.
 *
 * `reroll` reaches the seed article on purpose: rerolling is what the seed
 * decides, and that article is where the three modes are already named.
 */
export function modeConcept(mode: AspectMode): UiConceptId {
  switch (mode) {
    case "reroll":
      return "surprise-seed";
    case "keep":
      return "surprise-keep";
    case "off":
      return "surprise-off";
  }
}

/**
 * The one refusal both {@link modeHint} and {@link withAspectMode} need.
 *
 * Written once so the reason a person reads in a stack trace is the reason this
 * file actually holds, rather than two paraphrases of it.
 */
function noOffError(key: AspectKey): Error {
  return new Error(
    `"${key}" cannot be turned off: a document has no state in which it is absent, so there would be nothing to generate instead`,
  );
}

/** The locks and the excludes together — one mode per aspect, seen two ways. */
export interface AspectState {
  readonly locks: SurpriseLocks;
  readonly excludes: SurpriseExcludes;
}

/** Which of the three states this aspect is in. */
export function aspectMode(state: AspectState, key: AspectKey): AspectMode {
  if (isExcludable(key) && state.excludes[key]) return "off";
  if (!isLockable(key)) return "reroll";
  return state.locks[key] ? "keep" : "reroll";
}

/**
 * Put one aspect into one mode.
 *
 * Both fields are written together, which is what makes "kept and excluded"
 * unrepresentable rather than merely forbidden: there is no sequence of calls
 * that leaves an aspect in two states.
 *
 * @throws when asked for `off` on an aspect that has none. Unreachable through
 * the panel — {@link modesFor} does not offer the button — so reaching it means
 * a caller invented a mode the document could not hold, and that is a defect
 * worth a stack trace rather than a silent no-op.
 */
export function withAspectMode(
  state: AspectState,
  key: AspectKey,
  mode: AspectMode,
): AspectState {
  if (mode === "off") {
    if (!isExcludable(key)) throw noOffError(key);
    return {
      locks: isLockable(key) ? { ...state.locks, [key]: false } : state.locks,
      excludes: { ...state.excludes, [key]: true },
    };
  }
  return {
    locks: isLockable(key) ? { ...state.locks, [key]: mode === "keep" } : state.locks,
    excludes: isExcludable(key) ? { ...state.excludes, [key]: false } : state.excludes,
  };
}

/** How many aspects the next press will leave alone. */
export function keptCount(locks: SurpriseLocks): number {
  return LOCKABLE_KEYS.filter((key) => locks[key]).length;
}

/** Clamp and snap the chaos slider. Out-of-range input is a caller bug, not a value. */
export function clampChaos(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CHAOS;
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  return Math.round(clamped / CHAOS_STEP) * CHAOS_STEP;
}

/** A word for where the slider is, so the number is not the only label. */
export function chaosLabel(chaos: number): string {
  if (chaos < 0.2) return "tame";
  if (chaos < 0.45) return "lively";
  if (chaos < 0.7) return "loud";
  if (chaos < 0.9) return "wild";
  return "feral";
}

/** What the surprise engine needs before it can run, and what is missing. */
export type Readiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

export interface ReadinessInput {
  /** An image is open, so there is something to be surprised against (F-SM-01). */
  readonly hasSource: boolean;
  /** The hardware palette library has been read from the core (F-CO-04). */
  readonly libraryReady: boolean;
  /** Set when reading the library failed; shown instead of "still loading". */
  readonly libraryFailure: string | null;
}

export function readiness(input: ReadinessInput): Readiness {
  if (!input.hasSource) {
    return { ready: false, reason: "Open an image first — a surprise is built against it." };
  }
  if (input.libraryFailure !== null) {
    return {
      ready: false,
      reason: `The built-in palette library could not be read (${input.libraryFailure}), and one of the three palette modes draws from it.`,
    };
  }
  if (!input.libraryReady) {
    return {
      ready: false,
      reason: "Reading the built-in palette library — one of the three palette modes draws from it.",
    };
  }
  return { ready: true };
}

/**
 * One line naming the stack, for the button's tooltip and the history strip.
 *
 * Arrows rather than commas because the stack is an order, and reading it as a
 * pipeline is the point.
 */
export function describeStack(effectNames: readonly string[]): string {
  return effectNames.length === 0 ? "empty stack" : effectNames.join(" → ");
}
