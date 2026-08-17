/**
 * Concept help — the ideas the registry cannot describe, because they are not
 * effects (F-UI-13).
 *
 * F-UI-15's rule is that descriptive text has exactly one home. For an effect or
 * a parameter that home is the descriptor, and this directory reads it rather
 * than restating it. But the interface also asks the user to understand things
 * no descriptor is about — what a node is, what a slot means, what the colour
 * metric changes — and those had no home at all. This is it, and it is the only
 * file in the application that holds prose about them.
 *
 * ## What is deliberately not here
 *
 * `EFFECT_CONCEPTS` in `types/registry.ts` already explains the nine *family*
 * ideas: error diffusion, ordered dithering, halftone screens, tone and colour,
 * neighbourhood filters, optical artefacts, glitch, **the index map**, and
 * **working resolution**. F-UI-13 names the index map as a concept, and it is
 * one — it is simply already written, next to the descriptors that declare
 * `producesIndexMap`. Help reaches it as `effect-concept:index-map`, and a
 * second copy here is exactly the drift F-UI-15 exists to prevent.
 *
 * ## What makes an entry belong here
 *
 * It has to be a noun the interface puts on screen and does not define: a
 * heading, a badge, a control that carries a word rather than a number. If the
 * answer to "what is this?" is already in a descriptor, it is not a concept.
 *
 * Every claim below is a statement about how this build actually behaves, and
 * each is drawn from the module that implements it — the stack grammar from
 * `registry/stack.ts`, solo from `ui/stack/model.ts`, the metric from the core's
 * own note, extraction locks from `ui/palette/extract.ts`, the loop from
 * `types/document.ts`, tracks from `ui/timeline/model.ts`. Nothing here is
 * aspirational; when a behaviour changes, this text is wrong and has to move
 * with it.
 */

/**
 * The concepts, as a closed union.
 *
 * A union rather than a free string for the same reason `EffectConcept` is one:
 * a `data-help="concept:whatever"` that names nothing would be a control
 * pointing at help that does not exist, and the parser refuses it at the token
 * rather than opening an empty panel.
 */
export const UI_CONCEPT_IDS = [
  "stack",
  "node",
  "slot",
  "enable-solo",
  "opacity-blend",
  "node-seed",
  "palette",
  "colour-metric",
  "output-mode",
  "clock",
  "binding",
  "keyframe-track",
  "preview-quality",
  "surprise-seed",
  "surprise-keep",
  "surprise-off",
] as const;

export type UiConceptId = (typeof UI_CONCEPT_IDS)[number];

/**
 * The same shape `ConceptDescriptor` has in the registry, minus the `id` type.
 *
 * Structurally identical on purpose: `article.ts` turns either kind into one
 * `HelpArticle` without a branch per field, so a concept written here and a
 * concept written beside the effects render identically.
 */
export interface UiConcept {
  readonly id: UiConceptId;
  /** Heading, as the panel prints it. */
  readonly title: string;
  /** One line: the thing in a sentence. */
  readonly summary: string;
  /** What it is, what it decides, and what it costs to get wrong. */
  readonly description: string;
}

export const UI_CONCEPTS: Readonly<Record<UiConceptId, UiConcept>> = {
  stack: {
    id: "stack",
    title: "The stack",
    summary: "The ordered list of effects the picture passes through, top to bottom.",
    description:
      "The source enters at the top and every enabled node hands its result to the next one, so the order is the largest decision in a document. A blur in front of a dither crushes detail before it is quantized; the same blur behind it softens the dither's own grain instead, which is a different picture made of the same two nodes. Re-rendering starts at the earliest node you changed, so editing near the bottom of a long stack costs only the nodes below the edit. An effect may appear as many times as you like.",
  },
  node: {
    id: "node",
    title: "A node",
    summary: "One effect placed in the stack, holding its own settings.",
    description:
      "A node is an instance rather than the effect itself: two Bayer nodes in one stack are two independent sets of parameters, and rerolling one leaves the other where it was. Beside the effect's own controls, every node carries four things that have nothing to do with which effect it runs — whether it is enabled, the seed its random decisions come from, how much of its result reaches the picture, and how that result is mixed with what the node was handed.",
  },
  slot: {
    id: "slot",
    title: "Slot",
    summary: "Whether an effect belongs in front of the dither, is the dither, or comes after it.",
    description:
      "Every effect declares one of three slots — pre, dither, post — and it is shown on the node's row and against every row in the picker. Preprocess decides how much tone, colour and detail reach the quantizer; a dither-slot node is the one that reduces the picture to the palette; postprocess works on what came out. The editor does not enforce the order, because putting something where it does not belong is a legitimate way to find a look. Surprise Me does build to it, and the separate grammar that refuses genuinely unrenderable combinations applies either way.",
  },
  "enable-solo": {
    id: "enable-solo",
    title: "Enable and solo",
    summary: "Two different ways of taking part of the stack out of the render.",
    description:
      "Disabling a node removes it from the render completely, and everything downstream is re-judged without it — a disabled quantizer stops counting as one, so a node that reads palette indices will say it has nothing to read. Solo renders up to and including one node and stops there: everything below it is excluded and everything above it still runs. That is deliberately not \"show me this node alone\" — the tone work in front of a soloed dither is part of what that dither is doing, and hiding it would answer a question nobody asked.",
  },
  "opacity-blend": {
    id: "opacity-blend",
    title: "Opacity and blend",
    summary: "How much of a node's result reaches the picture, and how it is mixed with the node's own input.",
    description:
      "A node composites against what it was handed rather than against the source, so opacity at half strength is half of this node's contribution and not half of the stack's. The blend mode is the arithmetic of that mix, evaluated in linear light like everything else in the pipeline — which is why the pivoted modes, overlay and hard light and soft light, land differently here than in a compositor working in gamma space. A node that writes a different size than it reads has no pixel-for-pixel input to composite against, so it offers neither control rather than offering one that cannot apply.",
  },
  "node-seed": {
    id: "node-seed",
    title: "Node seed",
    summary: "The number every random decision inside this node is derived from.",
    description:
      "Nothing in the pipeline reads a clock or an unseeded random source. A node that jitters a threshold, shuffles a block or corrupts a byte derives all of it from this seed, which is what makes the same document render the same picture on every machine and an animated loop close exactly. Change the seed for a different draw at identical settings; leave it alone to keep an accident worth keeping.",
  },
  palette: {
    id: "palette",
    title: "The palette",
    summary: "The ordered list of colours the picture is reduced to.",
    description:
      "The palette belongs to the document rather than to any one node, so every quantizer in the stack maps to the same colours and the result has one vocabulary instead of several. Its order is meaningful wherever an effect works on palette indices rather than on colour. Swatches can be extracted from the image, taken from the built-in hardware sets, imported, or typed in by hand — and a locked swatch keeps both its colour and its position through a re-extraction, which is what lets you fix two colours and have the clustering fill in around them.",
  },
  "colour-metric": {
    id: "colour-metric",
    title: "Colour metric",
    summary: "The space in which \"the nearest palette colour\" is measured.",
    description:
      "Every quantizer answers one question per pixel: which entry in the palette is closest to this colour? OKLab measures that distance the way the eye judges it, so a pixel is replaced by something that looks like what it was. sRGB Euclidean measures it in stored code values, which weighs the three channels as the file happens to encode them and pulls toward different entries in the greens and the deep blues. It is a look control rather than a correctness switch: changing it moves the picture without a swatch having changed.",
  },
  "output-mode": {
    id: "output-mode",
    title: "Output mode",
    summary: "A palette generator — mono, greyscale, indexed, or per-channel RGB.",
    description:
      "An output mode is not a second rendering path. Every mode resolves to an ordinary list of sRGB colours, which is all any quantizing node consumes: mono is a two-entry palette, an N-level greyscale is N greys spaced evenly in code value, and per-channel RGB is the cross product of the three channels' level counts. The mode is kept so the list can be regenerated when a level count moves. Editing a swatch by hand switches the mode to indexed, because a generated list that has been edited is no longer generated and regenerating it would throw the edit away.",
  },
  clock: {
    id: "clock",
    title: "The clock",
    summary: "Loop length and frame rate — the two numbers all animation is measured against.",
    description:
      "The clock is a frame count and an fps, and normalized time is the frame divided by the frame count. It therefore runs from zero up to but never reaching one, which is what makes frame N the same instant as frame 0 rather than a duplicate of it. Everything animated is a function of that number alone; no part of the pipeline reads a wall clock, so an exported loop is the preview frame for frame.",
  },
  binding: {
    id: "binding",
    title: "Binding",
    summary: "A modulator attached to one numeric parameter.",
    description:
      "A binding drives a parameter over the loop from a shape — sine, triangle, saw, square, smooth noise or stepped random — with an amount, a phase, and a whole number of cycles per loop. That cycle count is an integer by construction, and it is the entire reason the loop closes without a crossfade. One parameter takes one driver: a parameter a modulator already drives cannot also carry a keyframe track, because whichever won would be an accident of order.",
  },
  "keyframe-track": {
    id: "keyframe-track",
    title: "Keyframe track",
    summary: "Values pinned at chosen frames, with the travel between them under your control.",
    description:
      "A track is the hand-placed alternative to a modulator: keys on the frames that matter, and an interpolation from each key to the next — linear, ease in, ease out, ease in-out, or hold. The last key wraps around to frame 0, so a track closes its loop the same way an integer cycle count does. Per track you also get a bypass and an amount, which are a mixer over the track rather than an edit to it: a bypassed track keeps its keys, and a track at zero leaves the parameter at the value the properties panel is showing. Tracks live in the session rather than in the `.dork` file, and the panel says so.",
  },
  "preview-quality": {
    id: "preview-quality",
    title: "Preview quality",
    summary: "The viewport drops below document resolution while something is being dragged, and never hides it.",
    description:
      "Anything that declares an interaction — a pan, a zoom, a slider drag, playback — holds the preview at a reduced resolution so the picture can keep up with the pointer, and the status bar shows the percentage for exactly as long as that is true. The badge follows the frame that is on screen rather than the interaction that caused it, so it stays up until the full-resolution render has actually arrived. A preview that quietly stopped being the truth is how the wrong picture gets shipped, which is why this is a badge and not a setting.",
  },
  "surprise-seed": {
    id: "surprise-seed",
    title: "Surprise seed",
    summary: "The one number an entire random document is derived from.",
    description:
      "Surprise Me generates the palette, the stack, every parameter and the animation from a single 64-bit seed, and that seed is shown, copyable, and carried in a share link. The same seed on the same build reproduces the same document exactly, so a good accident is never lost to a reroll. Keeping an aspect decides what the next press may not touch, turning one off decides what it does not make at all, and chaos decides how far from the defaults it is allowed to wander; the seed decides everything else.",
  },
  "surprise-keep": {
    id: "surprise-keep",
    title: "Keep",
    summary: "An aspect set to keep comes through the next Surprise unchanged.",
    description:
      "A surprise decides the palette, which effects are in the stack and how they are wired, every parameter, what moves, and what shape the document is. Each is set to reroll, keep, or off, and reroll is the default. Keep means the next press leaves that one exactly as it is and rerolls the rest — which is how a palette you like survives fifty stack rerolls. Keeping the stack keeps its wiring too, edges and masks included, so a branch you liked is still there; its parameters still reroll unless those are kept as well, and a kept set of parameters has nothing to give a stack that has just been recomposed, so new effects arrive at their defaults. Kept movement is carried binding by binding: one whose node has gone, or whose parameter the effect that replaced it does not have, is dropped rather than left pointing at nothing. Graph shape has no keep — keeping the stack already keeps it.",
  },
  "surprise-off": {
    id: "surprise-off",
    title: "Off",
    summary: "An aspect set to off is left out of the document entirely.",
    description:
      "Off is the opposite of keep, not a stronger version of it: keep says make no new one, off says make none at all. Two aspects have one, because for both the absence is an ordinary complete document. Animation off gives a document with no bindings — a still picture, and a timeline with no tracks. Graph shape off gives a plain chain over your own image: no generated source in place of the picture, no branch feeding a mask, and no feedback — so the document loops, which is the usual reason to reach for it, since a feedback node reads the previous frame and never returns to where it started. The other three have no off: a document cannot be without a palette, a stack with no dither in it is not a surprise, and every node must carry parameters — so there would be nothing for the word to mean.",
  },
};

/** Whether a string names a concept written here. */
export function isUiConceptId(value: string): value is UiConceptId {
  return Object.prototype.hasOwnProperty.call(UI_CONCEPTS, value);
}
