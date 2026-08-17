/**
 * The node registry descriptor.
 *
 * The registry is the single source of truth about effects. The UI builds its
 * effect list from it, the graph schedules from it, and Surprise Me samples
 * from it. There is no second list anywhere — see docs/API.md section 2.
 *
 * Two consequences drive the shapes below.
 *
 * **Surprise Me has no per-effect logic.** The generator reads this file's
 * types and nothing else, so a newly added effect becomes eligible the moment
 * it is registered. That only works if every parameter carries its own surprise
 * metadata, which is why `surprise` is a required field on every parameter kind
 * and why {@link validateRegistry} treats a missing one as a build failure
 * rather than something that shows up as a bad random document months later.
 *
 * **Adding an effect is adding one file.** Each effect lives in its own module
 * under `web/src/effects/`, default-exporting a single descriptor built with
 * {@link defineEffect}; the registry collects them by glob. Nothing central is
 * edited, so two effects added in parallel cannot conflict.
 *
 * ```ts
 * // web/src/effects/floyd-steinberg.ts
 * import { defineEffect } from "../types/registry";
 * export default defineEffect({ id: "floyd-steinberg", ... });
 * ```
 */

import type { CurvePoint, NodeSlot, SrgbTriplet } from "./document";
import type { GpuEffect } from "./gpu";
import type { ThresholdMatrix } from "../gpu/matrices";

/**
 * The two composite parameter values, re-exported from the schema that has to
 * serialise them.
 *
 * They are declared in `./document` and not here because `.dork` is what has to
 * write them down; a second declaration on this side would be one more thing to
 * keep byte-compatible with the first. Descriptors go on importing them from
 * the registry, which is where a parameter kind is described.
 */
export type { CurvePoint, SrgbTriplet };

/**
 * Effect families, matching the spec's requirement groups.
 *
 * `preprocess` is the one that is not in docs/API.md's list: the PP
 * requirements (F-PP-01 internal resolution, levels, HSL, curves, seeded noise)
 * are stack nodes with descriptors like any other, and the five families named
 * there give them no home.
 */
export type EffectFamily =
  | "preprocess"
  | "error-diffusion"
  | "ordered"
  | "pattern"
  | "glitch"
  | "special";

/**
 * A family idea shared by several effects and worth explaining exactly once
 * (F-UI-15).
 *
 * `family` says which requirement group an effect came from and is a *filing*
 * decision; a concept is a *teaching* decision, and the two do not coincide.
 * Posterize, threshold and invert are filed under `special` because the spec
 * lists them there, but what a reader needs told about them is the same thing
 * they need told about levels and curves: these are pointwise transfers of the
 * display-referred tone, applied before anything quantizes. Conversely the
 * `special` family holds four unrelated ideas at once.
 *
 * Kept as a closed union rather than a free string so that the guide's concept
 * chapters and the hover help cannot reference a concept nobody wrote.
 */
export type EffectConcept =
  | "error-diffusion"
  | "ordered-dithering"
  | "halftone-screen"
  | "tone-and-colour"
  | "neighbourhood-filter"
  | "optical"
  | "glitch"
  | "index-map"
  | "working-resolution";

/** One concept, written once and read by the guide and by hover help. */
export interface ConceptDescriptor {
  readonly id: EffectConcept;
  /** Heading, as the guide prints it. */
  readonly title: string;
  /** One line: what the family of effects has in common. */
  readonly summary: string;
  /** The explanation itself — what it is, why it is a family, how to use it. */
  readonly description: string;
}

/**
 * The concept texts.
 *
 * These are the paragraphs that would otherwise be copied into sixty-seven
 * descriptions. An effect names its concept and says only what makes it
 * different from its siblings; everything the siblings share is here.
 */
export const EFFECT_CONCEPTS: Readonly<Record<EffectConcept, ConceptDescriptor>> = {
  "error-diffusion": {
    id: "error-diffusion",
    title: "Error diffusion",
    summary:
      "Quantizes a pixel to the nearest palette colour, then pushes the difference onto pixels it has not reached yet.",
    description:
      "Every pixel is replaced by the closest colour the palette can offer, and the amount by which that was wrong — the error — is split among neighbours further along the scan. Those neighbours are therefore quantized against a value that already carries the debt, so the picture keeps its average tone even though no pixel keeps its own. What separates the fifteen kernels here is only where the error goes and in what proportions: a short reach gives a fine, busy grain, a wide reach gives a smooth one that softens edges. The cost is that the scan is serial by definition, so this whole family runs on the CPU while everything else runs as a compute pass. Error diffusion is the family to reach for when you want detail preserved and no visible pattern; ordered dithering is the one to reach for when the pattern is the point.",
  },
  "ordered-dithering": {
    id: "ordered-dithering",
    title: "Ordered dithering",
    summary:
      "Compares each pixel against a threshold read from a repeating tile, so the pattern is fixed and the same everywhere.",
    description:
      "A tile of thresholds is laid over the image and each pixel is pushed towards whichever of its two candidate palette colours its own threshold says. Because the tile repeats, the texture is completely regular — that regularity is the look, and it is why these effects survive being scaled up, animated or exported to vector where a diffusion grain would turn to mush. Every pixel decides on its own, so the whole family runs as one GPU pass and costs the same at any tile size. The shared controls move the tile rather than the algorithm: scale, rotation and offset are the primary animation targets, spread sets how much of the tone the pattern is allowed to carry, and threshold offset slides the cut between the two candidates.",
  },
  "halftone-screen": {
    id: "halftone-screen",
    title: "Halftone and pattern screens",
    summary:
      "Draws the tone as a geometric figure — a dot, a line, a ring — that grows and shrinks with brightness.",
    description:
      "A pattern screen is an ordered dither whose threshold comes from a drawing rather than from a tile of numbers: distance to the nearest dot centre, distance across a grating, distance from a point. Where the figure is fat the pixel goes dark, where it is thin the pixel goes light, so tone is carried by the *area* of ink rather than by its density. This is how print works, and it is why these effects read as printed matter rather than as a computer artefact. The geometry is the parameter set — cell size or pitch sets how coarse the figure is, angle sets which way it runs — and it is what distinguishes each of them from the others. Screens are best on images that have already been simplified; a fine screen over a busy photograph fights the detail rather than describing it.",
  },
  "tone-and-colour": {
    id: "tone-and-colour",
    title: "Tone and colour",
    summary:
      "Changes what tone or colour a pixel is, one pixel at a time, before anything quantizes.",
    description:
      "These are the pointwise front of the stack. Each one reads a single pixel and writes a single pixel, and every one of them is defined on the display-referred value — the tone as the screen shows it — rather than on linear light, because that is the domain in which 'lift the shadows by a quarter' means what it says. They matter more here than in an ordinary image editor: a dither has only a handful of colours to work with, so how much contrast, how much saturation and how many levels reach the dither decides most of what the result looks like. Put them before the dither node. Placed after one they operate on the dither's own texture instead of on the picture.",
  },
  "neighbourhood-filter": {
    id: "neighbourhood-filter",
    title: "Neighbourhood filters",
    summary:
      "Reads a pixel and the pixels around it, so it can find or remove detail at a chosen size.",
    description:
      "Blur, sharpen, edge detect and emboss all work the same way: they weigh a pixel against its neighbours and write the result. That gives them a size — the radius, or the fixed one-pixel tap of a 3×3 operator — and the size is what they are really controlling, since it says which detail counts as detail. All four belong before the dither. After one, every pixel is a step edge against its neighbour and the filter finds the dither's own texture rather than the picture's, which is a real look but almost never the intended one. Before it, they decide how much of the image survives into a small palette: blur to crush detail, sharpen to keep edges legible, edge detect or emboss to hand the dither line art instead of a photograph.",
  },
  optical: {
    id: "optical",
    title: "Optical and photographic",
    summary:
      "Imitates something a lens, a film or a projector does to a picture rather than something a computer does.",
    description:
      "Glow, vignette, lens distortion, light leak and grain are all artefacts of physical capture, and each is modelled as the physical thing rather than as a filter that resembles it — light that adds, light that is lost, a frame that is bent, silver that is uneven. They read as photography rather than as processing, which is why they are worth reaching for around a dither: the hard, quantized result of a dither plus one soft physical artefact is a much stronger picture than either alone. Whether one belongs before or after the dither is a real choice. Before it, the artefact is quantized along with everything else and becomes part of the pattern; after it, it sits over the pattern as light does over a printed page.",
  },
  glitch: {
    id: "glitch",
    title: "Glitch",
    summary:
      "Displaces, duplicates or corrupts pixels as if the picture had survived a broken machine.",
    description:
      "The glitch family breaks the picture on purpose, and it does so along one of three lines: geometry (slices, waves, tears and splits that move pixels somewhere they do not belong), signal (masks, scanlines, bit crushing and channel swaps that imitate the display or the storage format), and corruption (seeded bursts and shuffles). Everything stochastic here is driven by an explicit seed and by nothing else — no clock, no frame counter — so a look you liked is reproducible from the document and an animation loops cleanly. Several of the effects have no seed at all, and that is deliberate rather than an oversight: their pattern is a function of position, so there is nothing to reroll and a seed control would move nothing. Glitch nodes normally sit after the dither, where they tear a picture that is already made of hard palette colours.",
  },
  "index-map": {
    id: "index-map",
    title: "Working on palette regions",
    summary:
      "Reads the palette index each pixel was assigned, so region edges are exact rather than guessed.",
    description:
      "Once a node has quantized, the pipeline carries a second buffer alongside the colours: for every pixel, which palette entry it became. That map is what makes region work exact. A boundary between two regions is an integer inequality between two indices — free to compute, and correct even where the two palette colours are nearly identical or where dither noise would defeat an edge detector working on colour alone. Effects that read the map are therefore only legal downstream of a node that produces one, which the stack checks before anything renders. They also rewrite the map as well as the colours, because a node that moved a region boundary in colour and left the map behind would hand the next reader — another region effect, or the SVG tracer — a segmentation that no longer describes the pixels.",
  },
  "working-resolution": {
    id: "working-resolution",
    title: "Working resolution",
    summary:
      "Runs the middle of the stack on a smaller grid, then brings the frame back to size with the chunk intact.",
    description:
      "The size of a dither's grain is fixed in pixels, so the only way to make the grain coarse relative to the subject is to make the picture smaller while the dither runs. Internal resolution divides the working grid; nearest upscale multiplies it back afterwards, replicating each texel into a hard block. Used as a pair at the same factor, they crush detail without changing the exported size — and they are also the main performance lever, since every node between them costs a quarter of the work at factor two. Used alone, internal resolution simply exports smaller. The upscale must stay nearest and integer: any smoothing would average palette colours into ones the palette does not contain, which is the one thing an indexed pipeline must not do.",
  },
};

/**
 * Where an effect runs, and therefore what it costs.
 *
 * `wasm` is a serial CPU kernel — error diffusion is inherently serial, so the
 * whole family lives here. `gpu` is a WebGPU compute pass. Each `wasm` node
 * sitting between `gpu` nodes costs a readback plus an upload, which is the
 * known performance ceiling; the scheduler reads this field to coalesce runs of
 * `gpu` nodes and to log every crossing.
 */
export type ExecutionKind = "wasm" | "gpu";

/** Parameter kinds the registry can describe. */
export type ParamType =
  | "float"
  | "int"
  | "bool"
  | "enum"
  | "color"
  | "seed"
  | "curve";

/** An inclusive `[min, max]` bound. */
export type Range = readonly [min: number, max: number];

/** One option in a weighted draw. Weights are relative, not probabilities. */
export interface Weighted<T> {
  readonly value: T;
  /** Must be finite and greater than zero. */
  readonly weight: number;
}

/**
 * How a numeric surprise range is sampled.
 *
 * A union rather than a bare string, because `normal` needs parameters and
 * `log` has a precondition. Naming the distribution without them would leave
 * the generator guessing a mean, and a guessed mean is a look decision made by
 * accident.
 */
export type NumericDistribution =
  /** Flat across the surprise range. */
  | { readonly kind: "uniform" }
  /**
   * Flat in log space — the right default for anything measured in octaves
   * (cell size, radius, frequency), where uniform sampling spends most of its
   * draws in the top octave and the result always looks the same.
   * Requires a strictly positive range.
   */
  | { readonly kind: "log" }
  /** Clustered around `mean`, truncated to the surprise range. */
  | { readonly kind: "normal"; readonly mean: number; readonly sigma: number };

/**
 * Surprise metadata shared by `float` and `int`.
 *
 * `range` is deliberately narrower than the legal range. That gap is the whole
 * difference between a usable random result and noise (F-SM-04): a legal blur
 * radius goes to 200px, a musical one stops around 12.
 */
export interface NumericSurprise {
  readonly range: Range;
  readonly distribution: NumericDistribution;
  /**
   * Relative likelihood that this parameter is one of the ones Surprise Me
   * moves off its default. The chaos slider (F-SM-07) decides how many
   * parameters move; this decides which. Must be greater than zero.
   */
  readonly weight: number;
}

interface ParamBase {
  /** Key under `StackNode.params`. Unique within the effect. */
  readonly key: string;
  readonly label: string;
  readonly type: ParamType;
  /** Whether a modulator or keyframe track may bind to it (F-AN-02). */
  readonly animatable: boolean;
  /**
   * What this control does **to the picture** (F-UI-15).
   *
   * Required, and required to say something the label does not. "Serpentine
   * alternates direction every row so error stops drifting consistently to one
   * side" is the standard; "alternates the scan direction" restates the label
   * and {@link validateRegistry} rejects it as
   * `unhelpful-description`.
   *
   * This is the *only* descriptive string a parameter carries. The properties
   * panel's tooltip, the hover help of F-UI-13 and the guide's parameter tables
   * all read it, because three hand-written copies of 359 parameter
   * descriptions drift within a release.
   */
  readonly description: string;
}

export interface FloatParam extends ParamBase {
  readonly type: "float";
  /** The full range the UI and the loader accept. */
  readonly legal: Range;
  readonly default: number;
  readonly surprise: NumericSurprise;
  /** Drag/entry quantum. Absent means continuous. */
  readonly step?: number;
}

export interface IntParam extends ParamBase {
  readonly type: "int";
  /** Bounds and default must all be integers; the validator enforces it. */
  readonly legal: Range;
  readonly default: number;
  readonly surprise: NumericSurprise;
}

export interface BoolSurprise {
  /**
   * Probability of drawing `true`. The bool analogue of a narrowed range: a
   * serpentine toggle wants about 0.9 because off looks broken, an exotic mode
   * wants 0.1 because it should be a surprise rather than the norm.
   */
  readonly trueProbability: number;
  /** See {@link NumericSurprise.weight}. */
  readonly weight: number;
}

/** A bool's legal range is `{false, true}` by construction, so it is not declared. */
export interface BoolParam extends ParamBase {
  readonly type: "bool";
  readonly default: boolean;
  readonly surprise: BoolSurprise;
}

export interface EnumValue {
  readonly value: string;
  readonly label: string;
}

export interface EnumSurprise {
  /**
   * The subset drawn from, with relative weights. Every entry must name one of
   * the parameter's legal values, and the subset is usually smaller: a halftone
   * dot shape is legally any of four, but two of them carry the look.
   */
  readonly values: readonly Weighted<string>[];
  /** See {@link NumericSurprise.weight}. */
  readonly weight: number;
}

export interface EnumParam extends ParamBase {
  readonly type: "enum";
  /** The legal set, in UI order. */
  readonly values: readonly EnumValue[];
  readonly default: string;
  readonly surprise: EnumSurprise;
}

/**
 * Colour surprise, expressed in OKLab.
 *
 * Sampling sRGB channels independently clumps around muddy mid-greys and gives
 * uneven perceptual lightness; sampling OKLab does not. This is the same reason
 * palette synthesis works in OKLab (see docs/ARCHITECTURE.md, "Surprise
 * generator"). The legal range is the sRGB gamut, which is a property of the
 * type and not per-parameter, so it is not declared.
 */
export interface ColorSurprise {
  /** OKLab L, in `[0, 1]`. */
  readonly lightness: Range;
  /** OKLab chroma. sRGB tops out near 0.33; {@link CHROMA_CEILING} is the bound. */
  readonly chroma: Range;
  /**
   * OKLab hue in degrees, `[0, 360)`. `min > max` is legal and means the arc
   * wraps through 0 — the only way to express "warm" as one range.
   */
  readonly hue: Range;
  /** See {@link NumericSurprise.weight}. */
  readonly weight: number;
}

export interface ColorParam extends ParamBase {
  readonly type: "color";
  readonly default: SrgbTriplet;
  readonly surprise: ColorSurprise;
}

/**
 * Seed surprise.
 *
 * A seed has no narrower musical range — every seed is as good as every other,
 * which is the point of F-AN-05 — so the range and distribution are fixed by
 * the kind ({@link SEED_RANGE}, uniform) rather than restated on every effect.
 * The only decision left is whether a reroll touches it.
 */
export interface SeedSurprise {
  /** See {@link NumericSurprise.weight}. */
  readonly weight: number;
}

/**
 * An explicit seed exposed as a parameter.
 *
 * `StackNode.seed` already gives every node one seed. A `seed` parameter is for
 * effects that need more than one independent stochastic axis — row
 * displacement seeding slice heights separately from offsets — or that expose
 * the seed as a control in its own right, as the glitch family does.
 */
export interface SeedParam extends ParamBase {
  readonly type: "seed";
  readonly default: number;
  readonly surprise: SeedSurprise;
}

/** Legal range of a seed parameter: the full unsigned 32-bit space. */
export const SEED_RANGE: Range = [0, 0xffffffff];

/** Upper bound accepted for an OKLab chroma range. sRGB cannot exceed ~0.33. */
export const CHROMA_CEILING = 0.5;

/**
 * Named curve shapes.
 *
 * Surprise Me samples an archetype and jitters it. Sampling control points
 * directly produces curves that are legal and useless — non-monotonic, clipped
 * at both ends — which is the noise-versus-result distinction of F-SM-04 in its
 * most extreme form.
 */
export type CurveArchetype =
  | "linear"
  | "s-curve"
  | "inverse-s"
  | "lift"
  | "crush"
  | "invert";

export interface CurveSurprise {
  readonly archetypes: readonly Weighted<CurveArchetype>[];
  /** How far a control point may move from the archetype, in unit-square units. */
  readonly jitter: number;
  /** See {@link NumericSurprise.weight}. */
  readonly weight: number;
}

/**
 * An editable transfer curve (F-PP-05).
 *
 * The legal range is the unit square with strictly increasing `x` spanning the
 * full domain — a transfer curve that does not cover `[0, 1]` leaves pixels
 * undefined — so it is a property of the kind, enforced by the validator.
 */
export interface CurveParam extends ParamBase {
  readonly type: "curve";
  readonly default: readonly CurvePoint[];
  readonly surprise: CurveSurprise;
}

export type ParamDescriptor =
  | FloatParam
  | IntParam
  | BoolParam
  | EnumParam
  | ColorParam
  | SeedParam
  | CurveParam;

// --- image inputs --------------------------------------------------------
//
// Until multi-input landed, "how many pictures does this node read" had exactly
// one answer — one — and the graph hard-coded the port names. Masking, blending
// two chains and displacing one picture by another all need a second image
// edge, and each of those three reads its second picture for a *different
// reason*. A mask is coverage, a layer is colour, a displacement source is a
// vector field. An editor that knew only "this node has two inputs" could label
// neither port and could not refuse a mask wired into a displacement input, so
// what a port MEANS is declared here beside how many there are.

/**
 * What a node reads a picture *for*.
 *
 * The set is closed and short on purpose: each member is a different contract
 * between the node and the picture on that port, and a reader — the editor
 * labelling a port, the validator refusing a connection, the guide explaining
 * one — has to be able to enumerate them.
 */
export type InputRole =
  /** The picture this node transforms. Every node has exactly one, named `in`. */
  | "image"
  /**
   * Coverage: how much of this node's result reaches the picture, per pixel.
   *
   * Read as tone rather than as colour, and it is not composited into the
   * output — it is spatially-varying opacity (F-PP-08). See
   * `web/src/graph/mask.ts`.
   */
  | "mask"
  /** A second picture combined with the first as colour — blending two chains. */
  | "layer"
  /**
   * A picture read as a vector field: its channels are offsets, not tone.
   *
   * Distinct from `layer` because nothing about it is colour. A node reading a
   * displacement source samples *elsewhere in its own input*; a node reading a
   * layer samples the layer itself.
   */
  | "displace"
  /**
   * **The previous frame.** The one role that is not a function of this frame.
   *
   * An edge into a port with this role is a *feedback edge*: it does not
   * contribute to the topological order, and it is the only edge that may close
   * a cycle. See `web/src/graph/topology.ts`.
   */
  | "feedback";

/** One image input a node declares. */
export interface InputPortDescriptor {
  /** Stable, kebab-case, unique within the effect. The document's edges name it. */
  readonly key: string;
  /** What the editor writes beside the port. */
  readonly label: string;
  readonly role: InputRole;
  /**
   * One line: what wiring this port does to the picture.
   *
   * Required for the same reason every parameter's is (F-UI-15) — a port
   * nobody can explain is a port nobody wires on purpose — and checked the same
   * way, including the check that it does not merely restate the label.
   */
  readonly description: string;
  /**
   * True when the node cannot render without an edge here.
   *
   * `in` is never required: a node with no `in` edge is a root and reads the
   * decoded source, which is what every single-node document is.
   */
  readonly required: boolean;
}

/** The port every node's picture arrives on. */
export const PRIMARY_INPUT_PORT = "in";

/**
 * The port key masking uses.
 *
 * Universal rather than declared per effect: a mask is spatially-varying
 * opacity and opacity is a property of *every* node, so declaring it 71 times
 * would put the interesting declaration where nobody looks — and would let one
 * effect forget it and silently become unmaskable. `graph/ports.ts` appends it,
 * and it is the one port key an effect may not declare for itself.
 */
export const MASK_INPUT_PORT = "mask";

/**
 * What a node declares when it says nothing: one image input.
 *
 * This is the reason 71 shipped effects needed no edit. `inputs` is optional,
 * absent means exactly this, and the graph reads {@link inputPortsOf} rather
 * than the field.
 */
export const DEFAULT_INPUT_PORTS: readonly InputPortDescriptor[] = [
  {
    key: PRIMARY_INPUT_PORT,
    label: "Image",
    role: "image",
    description:
      "The picture this node works on. Unwired, the node is a root and reads the image the document opened.",
    required: false,
  },
];

/**
 * One effect's complete self-description.
 *
 * This is the only thing an effect has to add to become visible to the UI, the
 * scheduler and Surprise Me.
 */
export interface EffectDescriptor {
  /** Stable id, referenced by `StackNode.effect`. Kebab-case, unique. */
  readonly id: string;
  readonly name: string;
  /**
   * One line, in the words a user would use: what this does to the picture.
   *
   * This is the line the effect picker shows under the name and the first line
   * of the hover panel (F-UI-13), so it has to stand alone — no "see below", no
   * reference to a sibling effect, and no restatement of the name.
   */
  readonly summary: string;
  /**
   * The full description: how it behaves, what it is for, and what it pairs
   * with.
   *
   * Written once, here, and read by hover help (F-UI-13), the guide's generated
   * effect catalogue (F-UI-14) and search (F-ST-08) — F-UI-15 in one field. Say
   * what it does to the image rather than what category it is in, and where an
   * effect is commonly confused with another, say the difference: wave warp
   * displaces by a fixed geometric function, row displacement by a seed, and
   * neither displaces by the picture.
   */
  readonly description: string;
  /**
   * What a person might call this when they go looking for it, beyond its name.
   *
   * The reason this field exists is a real failure, not a hypothetical: the
   * owner of this tool could not find the glow effect, because it is named
   * "Epsilon glow" after the reference product and search matched only names
   * and structural fields. Every effect therefore carries the ordinary words
   * for what it produces — `epsilon-glow` answers to glow, neon, bloom and halo;
   * `blue-noise` answers to noise — and the words for the look it belongs to.
   *
   * Never empty, and no two entries may normalize to the same string.
   */
  readonly keywords: readonly string[];
  /**
   * The family idea this effect belongs to, explained once in
   * {@link EFFECT_CONCEPTS}.
   *
   * Optional because an effect need not belong to one, though every effect in
   * the shipped catalogue does — `catalogue.test.ts` asserts it. A concept is
   * not the same thing as {@link EffectFamily}: see {@link EffectConcept}.
   */
  readonly concept?: EffectConcept;
  /**
   * The spec requirement this implements, e.g. `"F-ED-01"`. Carried so the
   * catalogue can be checked against the spec mechanically instead of by
   * counting rows in a table by hand.
   */
  readonly requirement: string;
  /** Slot in the stack grammar. Surprise Me builds stacks against this. */
  readonly slot: NodeSlot;
  readonly family: EffectFamily;
  readonly execution: ExecutionKind;
  readonly params: readonly ParamDescriptor[];
  /**
   * The image inputs this node reads, in the order the graph evaluates them.
   *
   * **Optional, and absent means {@link DEFAULT_INPUT_PORTS}** — one `in` port
   * of role `image`. That is what keeps the 71 shipped effects untouched by
   * multi-input: they read one picture, they always did, and restating it 71
   * times would bury the two descriptors where the declaration is interesting.
   *
   * The first entry must be `in` with role `image`, because every node has a
   * picture it transforms and the composite blends against exactly that one.
   * The mask port is **not** declared here — it is universal, appended by
   * `graph/ports.ts`, for the reason given on {@link MASK_INPUT_PORT}.
   *
   * Read through {@link inputPortsOf}, never off the field: a reader that
   * checks `descriptor.inputs` directly sees `undefined` for 71 effects and
   * concludes they have no inputs at all.
   */
  readonly inputs?: readonly InputPortDescriptor[];
  /**
   * Relative likelihood in Surprise Me. 1.0 is ordinary; niche effects sit
   * lower so that signature looks appear more often than curiosities (F-SM-03).
   */
  readonly surpriseWeight: number;
  /**
   * True when this node quantizes and therefore emits an index map alongside
   * its RGBA buffer. The graph reads it to know when the pipeline changes shape
   * (see docs/ARCHITECTURE.md, "Data layout").
   */
  readonly producesIndexMap: boolean;
  /**
   * True when this node reads the index map — outline, dilate/erode,
   * hue-targeted recolour, index remap. Such a node is only legal downstream of
   * a quantizer, which is a grammar constraint Surprise Me must respect rather
   * than a runtime error to discover.
   */
  readonly requiresIndexMap: boolean;
  /**
   * Effect ids this one must not share a stack with. Incompatible combinations
   * are excluded by the grammar, not filtered after generation (F-SM-03).
   */
  readonly excludes?: readonly string[];
  /**
   * True when this node writes a different extent than it reads — internal
   * resolution (F-PP-01) down, nearest upscale (F-SP-14) up.
   *
   * Optional because sixty-five of the sixty-seven effects in the catalogue
   * write what they read, and making all of them restate `resamples: false`
   * would put the interesting declaration where nobody looks. Absent means the
   * same extent, exactly as an absent `PassExtent` does.
   *
   * It is here rather than derived from the effect's passes because the two
   * readers that need it have no passes to look at. `registry/stack.ts` checks
   * a stack the user is *building*, before anything is compiled, and refuses a
   * resampler placed where an index map is live — indices cannot be resampled
   * meaningfully, so that combination is not renderable and must not be
   * buildable. `graph/plan.ts` refuses a composite on a resampling node, whose
   * output and input are different pixel grids. The declaration cannot drift
   * from the passes: `gpu/compiler.ts` checks the two agree, both ways, every
   * time an effect is compiled.
   */
  readonly resamples?: boolean;
  /**
   * True when this node reads **the previous frame's output at its own position
   * in the stack** — the feedback node, and nothing else in the catalogue.
   *
   * It is the one declaration that says a node is *not a pure function of its
   * inputs*, and three layers that never see a pass read it:
   *
   * - `graph/feedback.ts` computes the cache exclusion from it. A node that
   *   reads its own history, and everything downstream of one, cannot be keyed
   *   on a content hash — the hash is the same on every frame and the pixels
   *   are not — so those nodes are excluded from the node cache and the
   *   feedback node keeps its own frame store instead. Upstream of it caches
   *   normally, which is most of the win.
   * - `animation/plan.ts` marks the document **non-looping** from it. F-AN-03
   *   guarantees frame N equals frame 0 by construction; a decaying trail
   *   cannot satisfy that, so the guarantee narrows honestly rather than
   *   quietly becoming false.
   * - `state/render/renderer.ts` requires frames to arrive in order, because
   *   frame N is the product of frames 0..N.
   *
   * Absent means the ordinary case — a pure function of its inputs — exactly as
   * an absent `resamples` means the same extent. The declaration cannot drift
   * from the passes: `gpu/compiler.ts` refuses a `feedback-color` binding on an
   * effect that does not declare this, and refuses this declaration on an
   * effect whose passes bind no feedback.
   */
  readonly readsFeedback?: boolean;
  /**
   * **Generators only.** What scale this effect's picture has structure at, and
   * therefore whether it is any use as a mask.
   *
   * Required on a `source`-slot effect and refused on every other, because the
   * question only means something about a picture made from parameters: a filter's
   * structure is the structure of whatever it was handed.
   *
   * # Why this is a declaration and not a rule in the generator
   *
   * A mask is read as one channel of a picture and multiplies the masked node's
   * opacity per pixel. Coverage with structure at the scale of the frame makes the
   * node happen *here and not there*, which is legible. Coverage that varies at
   * the scale of a pixel mixes the masked node's output with its input everywhere
   * at once, and the average of two similar pictures is the picture — which is why
   * a branch rooted in a fine noise field is a second render pass that buys
   * nothing.
   *
   * Measured, over ninety-six documents at chaos 0.8, as the mean absolute RGB
   * difference between a branched document and the same document with the branch
   * cut out:
   *
   * | branch root | branches | median difference |
   * | --- | --- | --- |
   * | `gen-shape` (a figure) | 12 | 0.145 |
   * | `gen-gradient` (a ramp) | 5 | 0.045 |
   * | `gen-noise` (a fractal field) | 13 | **0.017**, six of thirteen under 0.01 |
   *
   * `surprise/grammar.ts` roots a mask branch only in a generator that declares
   * `"large-scale"`. The alternative was a list of effect ids in the generator,
   * which is the same knowledge in the place that cannot be checked and that a
   * fourth generator would silently fall out of.
   *
   * It is deliberately about the effect and not about its parameters. A noise
   * field *can* be tuned to one slow billow across the frame, and at that setting
   * it would mask well; but the value has to be readable before any parameter has
   * been drawn — the grammar picks the branch root before `params.ts` runs — and
   * the declaration therefore describes what the effect does across its declared
   * surprise ranges, which for noise is 12 to 400 pixels per feature over one to
   * six octaves.
   */
  readonly coverage?: CoverageStructure;
}

/**
 * The scale a generator's picture has structure at — see
 * {@link EffectDescriptor.coverage}.
 *
 * Two values and not a number, because the only reader is a yes/no question
 * ("may a mask branch be rooted here?") and a threshold on a made-up scalar would
 * be a number nobody could argue with.
 */
export type CoverageStructure =
  /** Structure at the scale of the frame: a ramp, a figure, a large region. */
  | "large-scale"
  /**
   * Structure at the scale of a pixel or a few: grain, a fractal field. Fine to
   * *look* at — it is why the noise generator exists — and useless as coverage.
   */
  | "fine";

/**
 * The image inputs this effect declares, defaulted.
 *
 * The one accessor for the field. Every reader goes through it so "absent means
 * one image input" is stated once instead of being re-derived — and re-derived
 * wrongly — in the graph, the validator and the editor.
 */
export function inputPortsOf(
  descriptor: EffectDescriptor,
): readonly InputPortDescriptor[] {
  return descriptor.inputs ?? DEFAULT_INPUT_PORTS;
}

/**
 * Identity function that types a descriptor literal without widening it.
 *
 * It exists so an effect file has exactly one import and no type annotation:
 * the literal keeps its narrow types (so `params` stays a tuple of the specific
 * parameter kinds) while still being checked against
 * {@link EffectDescriptor} at the point of definition, where the error is
 * readable.
 */
export function defineEffect<const D extends EffectDescriptor>(descriptor: D): D {
  return descriptor;
}

// --- from an effect id to its compute passes -----------------------------
//
// The registry globs *descriptors*, and a descriptor says an effect runs on the
// GPU without saying where its passes are. Until this contract existed each
// effect module exported its `GpuEffect` under a name of its own — `INVERT_GPU`,
// `blurGpuEffect`, `halftoneEffect()` — and the only caller was a page that
// imported them all by hand. A document loader cannot do that: it has an
// effect id out of a `.dork` file and nothing else.
//
// One convention, stated once: **an effect module that declares `execution:
// "gpu"` exports `const gpu: GpuEffectSource` beside its default export.**
// `registry/gpu-effects.ts` collects them with the same glob that collects the
// descriptors, and refuses a catalogue where the two disagree.

/**
 * What an effect needs handed to it before its passes exist.
 *
 * A closed union with two members rather than a boolean, because the interesting
 * case is the one the naive design gets wrong: the five ordered dithers cannot
 * be built at all until the Rust core has produced a threshold tile, so
 * "constructible from nothing" is a property some effects do not have and the
 * lookup has to be able to say so *before* it tries. Today `threshold-matrix` is
 * the only kind of build-time data any effect needs; a second kind is a
 * deliberate edit here, not something a caller can improvise.
 */
export type GpuBuildRequirement =
  /** Constructible from nothing. Forty-three of the forty-eight. */
  | { readonly kind: "none" }
  /**
   * Needs a validated tile of `size * size` ranks from `dither-core`
   * (F-OD-01..05). Nothing on the web side fabricates one.
   */
  | { readonly kind: "threshold-matrix"; readonly size: number };

/** The build-time data itself, in the same closed set as the requirement. */
export type GpuBuildData =
  | { readonly kind: "none" }
  | { readonly kind: "threshold-matrix"; readonly matrix: ThresholdMatrix };

/** The only value of {@link GpuBuildData} an effect requiring nothing accepts. */
export const NO_GPU_BUILD_DATA: GpuBuildData = { kind: "none" };

/** Thrown when {@link GpuEffectSource.build} is handed data of the wrong kind. */
export class GpuBuildDataError extends Error {
  readonly effect: string;

  constructor(effect: string, message: string) {
    super(message);
    this.name = "GpuBuildDataError";
    this.effect = effect;
  }
}

/**
 * An effect module's GPU side: how to get from its id to its compute passes.
 *
 * `build` is a function rather than a ready-made `GpuEffect` for two reasons,
 * both of which bite in a catalogue this size. Several effects assemble a table
 * before they can name their passes — the glyph sheet (F-PT-08), the clustered
 * dot screens (F-PT-03) — and doing that at module-evaluation time makes every
 * effect in the build cost something whether or not the document uses it. And a
 * `const` evaluated at import time has to be declared after everything it
 * mentions; a thunk can sit anywhere in the file, which is what makes the
 * convention a mechanical addition to each existing module rather than a
 * reordering of it.
 */
export interface GpuEffectSource {
  /** Must equal the id of the descriptor the same module default-exports. */
  readonly effect: string;
  readonly requires: GpuBuildRequirement;
  /** @throws GpuBuildDataError when `data.kind` is not `requires.kind`. */
  build(data: GpuBuildData): GpuEffect;
}

/**
 * Declare the GPU side of an effect whose passes are constant.
 *
 * ```ts
 * export const gpu = staticGpuEffect("invert", () => INVERT_GPU);
 * ```
 */
export function staticGpuEffect(
  effect: string,
  build: () => GpuEffect,
): GpuEffectSource {
  return {
    effect,
    requires: { kind: "none" },
    build: (data) => {
      if (data.kind !== "none") {
        throw new GpuBuildDataError(
          effect,
          `${effect} needs no build-time data, but was handed ${data.kind}`,
        );
      }
      return build();
    },
  };
}

/**
 * Declare the GPU side of an effect whose passes need a threshold tile.
 *
 * ```ts
 * export const gpu = thresholdMatrixGpuEffect(spec.effectId, spec.tile, (matrix) =>
 *   orderedDitherEffect(spec, matrix),
 * );
 * ```
 *
 * The tile is not fetched here and it is not defaulted. `size` is declared so a
 * caller can ask the core for the right tile *before* it has anything to build
 * with; the matrix's own id and size are checked by the effect that consumes it.
 */
export function thresholdMatrixGpuEffect(
  effect: string,
  size: number,
  build: (matrix: ThresholdMatrix) => GpuEffect,
): GpuEffectSource {
  return {
    effect,
    requires: { kind: "threshold-matrix", size },
    build: (data) => {
      if (data.kind !== "threshold-matrix") {
        throw new GpuBuildDataError(
          effect,
          `${effect} needs a ${size}x${size} threshold matrix, but was handed ${data.kind}`,
        );
      }
      return build(data.matrix);
    },
  };
}

/**
 * The shape of an effect module, as the glob loader sees it.
 *
 * `gpu` is present exactly when the descriptor declares `execution: "gpu"`, and
 * `registry/gpu-effects.ts` fails the catalogue when it is not.
 */
export interface EffectModule {
  readonly default: EffectDescriptor;
  readonly gpu?: GpuEffectSource;
}

/** Everything {@link validateRegistry} can reject, as a closed set. */
export type RegistryIssueCode =
  | "empty-id"
  | "malformed-id"
  | "duplicate-effect-id"
  | "malformed-requirement"
  | "invalid-surprise-weight"
  | "unknown-exclusion"
  | "self-exclusion"
  | "diffusion-must-run-serially"
  | "index-map-consumer-in-preprocess"
  | "resampler-must-run-on-gpu"
  | "feedback-must-run-on-gpu"
  | "feedback-must-not-resample"
  | "malformed-input-port"
  | "duplicate-input-port"
  | "primary-input-port-missing"
  | "reserved-input-port"
  | "feedback-port-mismatch"
  | "source-must-run-on-gpu"
  | "source-must-not-read-index-map"
  | "source-must-not-resample"
  | "source-must-declare-coverage"
  | "coverage-is-for-generators"
  | "missing-summary"
  | "missing-description"
  | "unhelpful-description"
  | "missing-keywords"
  | "duplicate-keyword"
  | "unknown-concept"
  | "duplicate-param-key"
  | "empty-param-key"
  | "missing-surprise"
  | "invalid-weight"
  | "invalid-probability"
  | "inverted-legal-range"
  | "inverted-surprise-range"
  | "surprise-outside-legal"
  | "default-outside-legal"
  | "non-integer-bound"
  | "log-needs-positive-range"
  | "invalid-normal-parameters"
  | "empty-enum"
  | "duplicate-enum-value"
  | "unknown-enum-default"
  | "enum-surprise-outside-legal"
  | "empty-surprise-set"
  | "invalid-color-component"
  | "chroma-out-of-gamut"
  | "hue-out-of-range"
  | "lightness-out-of-range"
  | "invalid-seed-default"
  | "curve-too-short"
  | "curve-not-monotonic"
  | "curve-outside-unit-square"
  | "curve-domain-not-covered"
  | "invalid-jitter";

export interface RegistryIssue {
  /** Effect id, or `"<unnamed>"` when the id itself is what is wrong. */
  readonly effect: string;
  /** Parameter key, when the issue is inside a parameter. */
  readonly param?: string;
  readonly code: RegistryIssueCode;
  readonly message: string;
}

export interface RegistryValidation {
  readonly ok: boolean;
  readonly issues: readonly RegistryIssue[];
}

// --- validation ---------------------------------------------------------
//
// Validation runs at build time (docs/API.md section 2). Most of what it checks
// cannot be expressed in the type system at all — that a surprise range sits
// inside its legal range, that a default is reachable, that a log distribution
// has a positive range — so this is the only gate.
//
// It also checks that required metadata is *present*, which the types appear to
// guarantee. They guarantee it for descriptors written as literals in this
// repository; they guarantee nothing for a descriptor assembled programmatically
// or arriving from an untyped module. Since the cost of the check is a `typeof`
// and the cost of missing it is Surprise Me silently skipping a parameter
// forever, it is checked.

function issue(
  effect: string,
  code: RegistryIssueCode,
  message: string,
): RegistryIssue {
  return { effect, code, message };
}

function paramIssue(
  effect: string,
  param: string,
  code: RegistryIssueCode,
  message: string,
): RegistryIssue {
  return { effect, param, code, message };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRange(value: unknown): value is Range {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1])
  );
}

function isPresentObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isPositiveWeight(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

/** `F-` plus a two-or-three letter group plus a number, e.g. `F-ED-01`, `F-ED-CTL`. */
const REQUIREMENT_PATTERN = /^F-[A-Z]{2}-[A-Z0-9]{2,3}$/;

/**
 * Fold case, punctuation and whitespace away so two strings can be compared for
 * *saying the same thing* rather than for being the same bytes.
 *
 * Used by the descriptive-text checks below to catch the laziest way a
 * description arrives undocumented: repeating the label. `search.ts` has a
 * normalizer of its own with the same rule; it is not shared because this file
 * is the one `search.ts` imports and the dependency must not run the other way.
 */
function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Present, a string, and not blank. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Check one descriptive string: present, and not a restatement of the thing it
 * is supposed to describe.
 *
 * Both halves are the requirement. F-UI-15 asks that a missing description be a
 * validation failure the way missing surprise metadata is, because that is what
 * stops a newly added effect arriving undocumented — but a description that
 * merely echoes the label arrives undocumented too, and costs a reader the same
 * time as an absent one while looking like it was written.
 */
function checkDescriptiveText(
  text: unknown,
  restates: readonly string[],
  missingCode: RegistryIssueCode,
  what: string,
  report: (code: RegistryIssueCode, message: string) => void,
): void {
  if (!isText(text)) {
    report(missingCode, `no ${what}; F-UI-15 requires one on every entry`);
    return;
  }
  const normalized = normalizeText(text);
  for (const restated of restates) {
    if (normalized === normalizeText(restated)) {
      report(
        "unhelpful-description",
        `${what} "${text}" only restates "${restated}"; say what it does to the picture`,
      );
      return;
    }
  }
}

/** The descriptive text every parameter carries (F-UI-15). */
function checkParamText(
  effectId: string,
  param: ParamDescriptor,
  issues: RegistryIssue[],
): void {
  checkDescriptiveText(
    param.description,
    [param.label, param.key],
    "missing-description",
    "description",
    (code, message) => issues.push(paramIssue(effectId, param.key, code, message)),
  );
}

/** The descriptive text and search keywords every effect carries (F-UI-15). */
function checkEffectText(
  effectId: string,
  effect: EffectDescriptor,
  issues: RegistryIssue[],
): void {
  const report = (code: RegistryIssueCode, message: string): void => {
    issues.push(issue(effectId, code, message));
  };
  const name = typeof effect.name === "string" ? effect.name : "";

  checkDescriptiveText(effect.summary, [name, effectId], "missing-summary", "summary", report);
  // The description is also checked against the summary: an effect whose long
  // form is its short form has one description under two field names, which is
  // the drift F-UI-15 exists to prevent showing up inside a single descriptor.
  checkDescriptiveText(
    effect.description,
    [name, effectId, typeof effect.summary === "string" ? effect.summary : ""],
    "missing-description",
    "description",
    report,
  );

  const keywords: unknown = effect.keywords;
  if (!Array.isArray(keywords) || keywords.length === 0) {
    report(
      "missing-keywords",
      "no search keywords; an effect nobody can name is an effect nobody can find",
    );
  } else {
    const seen: string[] = [];
    for (const keyword of keywords as readonly unknown[]) {
      if (!isText(keyword) || normalizeText(keyword).length === 0) {
        report("missing-keywords", `keyword ${JSON.stringify(keyword)} is blank`);
        continue;
      }
      const normalized = normalizeText(keyword);
      if (seen.includes(normalized)) {
        report("duplicate-keyword", `keyword "${keyword}" is declared twice`);
        continue;
      }
      seen.push(normalized);
    }
  }

  if (effect.concept !== undefined && !(effect.concept in EFFECT_CONCEPTS)) {
    report(
      "unknown-concept",
      `concept "${String(effect.concept)}" has no entry in EFFECT_CONCEPTS, so nothing can explain it`,
    );
  }
}

/**
 * Lowercase kebab-case. Enforced rather than merely documented because an id
 * ends up in the share URL fragment (F-DO-06) and in preset file names, where
 * a space or a capital is a bug discovered by a user rather than by CI.
 */
const EFFECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Checks the weighted set every categorical surprise uses: non-empty, every
 * weight positive, every value legal.
 */
function checkWeightedSet(
  effectId: string,
  key: string,
  set: unknown,
  legalValues: readonly string[] | null,
  issues: RegistryIssue[],
): void {
  if (!Array.isArray(set) || set.length === 0) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "empty-surprise-set",
        "surprise draws from an empty set, so this parameter can never be surprised",
      ),
    );
    return;
  }
  for (const entry of set as readonly unknown[]) {
    if (!isPresentObject(entry) || !isPositiveWeight(entry["weight"])) {
      issues.push(
        paramIssue(
          effectId,
          key,
          "invalid-weight",
          "every surprise option needs a finite weight greater than zero",
        ),
      );
      continue;
    }
    const value = entry["value"];
    if (legalValues !== null && !legalValues.includes(String(value))) {
      issues.push(
        paramIssue(
          effectId,
          key,
          "enum-surprise-outside-legal",
          `surprise option ${String(value)} is not one of the legal values`,
        ),
      );
    }
  }
}

/** Shared numeric checks for `float` and `int`. */
function checkNumericParam(
  effectId: string,
  param: FloatParam | IntParam,
  issues: RegistryIssue[],
): void {
  const key = param.key;
  const requireIntegers = param.type === "int";

  if (!isRange(param.legal)) {
    issues.push(
      paramIssue(effectId, key, "inverted-legal-range", "legal range is not a finite [min, max]"),
    );
    return;
  }
  const [legalMin, legalMax] = param.legal;
  if (legalMin >= legalMax) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "inverted-legal-range",
        `legal range [${legalMin}, ${legalMax}] is empty or inverted`,
      ),
    );
  }

  if (!isFiniteNumber(param.default)) {
    issues.push(
      paramIssue(effectId, key, "default-outside-legal", "default is not a finite number"),
    );
  } else if (param.default < legalMin || param.default > legalMax) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "default-outside-legal",
        `default ${param.default} is outside the legal range [${legalMin}, ${legalMax}]`,
      ),
    );
  }

  if (requireIntegers) {
    for (const [what, value] of [
      ["legal min", legalMin],
      ["legal max", legalMax],
      ["default", param.default],
    ] as const) {
      if (!Number.isInteger(value)) {
        issues.push(
          paramIssue(
            effectId,
            key,
            "non-integer-bound",
            `${what} ${value} is not an integer on an int parameter`,
          ),
        );
      }
    }
  }

  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(
      paramIssue(effectId, key, "missing-surprise", "no surprise metadata; Surprise Me cannot sample it"),
    );
    return;
  }

  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, key, "invalid-weight", "surprise weight must be finite and greater than zero"),
    );
  }

  const range: unknown = surprise["range"];
  if (!isRange(range)) {
    issues.push(
      paramIssue(effectId, key, "missing-surprise", "surprise range is missing or not a finite [min, max]"),
    );
    return;
  }
  const [surpriseMin, surpriseMax] = range;
  if (surpriseMin > surpriseMax) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "inverted-surprise-range",
        `surprise range [${surpriseMin}, ${surpriseMax}] is inverted`,
      ),
    );
  }
  if (surpriseMin < legalMin || surpriseMax > legalMax) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "surprise-outside-legal",
        `surprise range [${surpriseMin}, ${surpriseMax}] escapes the legal range [${legalMin}, ${legalMax}]`,
      ),
    );
  }
  if (requireIntegers && (!Number.isInteger(surpriseMin) || !Number.isInteger(surpriseMax))) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "non-integer-bound",
        `surprise range [${surpriseMin}, ${surpriseMax}] is not integral on an int parameter`,
      ),
    );
  }

  const distribution: unknown = surprise["distribution"];
  if (!isPresentObject(distribution)) {
    issues.push(
      paramIssue(effectId, key, "missing-surprise", "no sampling distribution declared"),
    );
    return;
  }
  const kind = distribution["kind"];
  if (kind === "log" && surpriseMin <= 0) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "log-needs-positive-range",
        `log sampling needs a strictly positive range; got [${surpriseMin}, ${surpriseMax}]`,
      ),
    );
  }
  if (kind === "normal") {
    const mean = distribution["mean"];
    const sigma = distribution["sigma"];
    if (!isFiniteNumber(mean) || mean < surpriseMin || mean > surpriseMax) {
      issues.push(
        paramIssue(
          effectId,
          key,
          "invalid-normal-parameters",
          "normal sampling needs a finite mean inside the surprise range",
        ),
      );
    }
    if (!isFiniteNumber(sigma) || sigma <= 0) {
      issues.push(
        paramIssue(
          effectId,
          key,
          "invalid-normal-parameters",
          "normal sampling needs a sigma greater than zero",
        ),
      );
    }
  }
  if (kind !== "uniform" && kind !== "log" && kind !== "normal") {
    issues.push(
      paramIssue(effectId, key, "missing-surprise", `unknown sampling distribution ${String(kind)}`),
    );
  }
}

function checkBoolParam(effectId: string, param: BoolParam, issues: RegistryIssue[]): void {
  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(
      paramIssue(effectId, param.key, "missing-surprise", "no surprise metadata"),
    );
    return;
  }
  if (!isProbability(surprise["trueProbability"])) {
    issues.push(
      paramIssue(
        effectId,
        param.key,
        "invalid-probability",
        "trueProbability must be a number in [0, 1]",
      ),
    );
  }
  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, param.key, "invalid-weight", "surprise weight must be greater than zero"),
    );
  }
  if (typeof param.default !== "boolean") {
    issues.push(
      paramIssue(effectId, param.key, "default-outside-legal", "default must be a boolean"),
    );
  }
}

function checkEnumParam(effectId: string, param: EnumParam, issues: RegistryIssue[]): void {
  const key = param.key;
  if (!Array.isArray(param.values) || param.values.length === 0) {
    issues.push(paramIssue(effectId, key, "empty-enum", "enum parameter declares no values"));
    return;
  }

  const legalValues: string[] = [];
  for (const option of param.values) {
    if (legalValues.includes(option.value)) {
      issues.push(
        paramIssue(effectId, key, "duplicate-enum-value", `value ${option.value} is declared twice`),
      );
    }
    legalValues.push(option.value);
  }

  if (!legalValues.includes(param.default)) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "unknown-enum-default",
        `default ${param.default} is not one of the declared values`,
      ),
    );
  }

  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(paramIssue(effectId, key, "missing-surprise", "no surprise metadata"));
    return;
  }
  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, key, "invalid-weight", "surprise weight must be greater than zero"),
    );
  }
  checkWeightedSet(effectId, key, surprise["values"], legalValues, issues);
}

function checkColorParam(effectId: string, param: ColorParam, issues: RegistryIssue[]): void {
  const key = param.key;
  const triplet: unknown = param.default;
  if (!Array.isArray(triplet) || triplet.length !== 3) {
    issues.push(
      paramIssue(effectId, key, "invalid-color-component", "default must be an [r, g, b] triplet"),
    );
  } else {
    for (const component of triplet as readonly unknown[]) {
      if (!Number.isInteger(component) || (component as number) < 0 || (component as number) > 255) {
        issues.push(
          paramIssue(
            effectId,
            key,
            "invalid-color-component",
            `default component ${String(component)} is not an 8-bit sRGB value`,
          ),
        );
      }
    }
  }

  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(paramIssue(effectId, key, "missing-surprise", "no surprise metadata"));
    return;
  }
  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, key, "invalid-weight", "surprise weight must be greater than zero"),
    );
  }

  const lightness: unknown = surprise["lightness"];
  const chroma: unknown = surprise["chroma"];
  const hue: unknown = surprise["hue"];

  if (!isRange(lightness) || lightness[0] > lightness[1]) {
    issues.push(
      paramIssue(effectId, key, "lightness-out-of-range", "lightness must be a [min, max] with min <= max"),
    );
  } else if (lightness[0] < 0 || lightness[1] > 1) {
    issues.push(
      paramIssue(effectId, key, "lightness-out-of-range", "OKLab lightness lives in [0, 1]"),
    );
  }

  if (!isRange(chroma) || chroma[0] > chroma[1]) {
    issues.push(
      paramIssue(effectId, key, "chroma-out-of-gamut", "chroma must be a [min, max] with min <= max"),
    );
  } else if (chroma[0] < 0 || chroma[1] > CHROMA_CEILING) {
    issues.push(
      paramIssue(
        effectId,
        key,
        "chroma-out-of-gamut",
        `chroma must stay within [0, ${CHROMA_CEILING}]; sRGB cannot reach further`,
      ),
    );
  }

  // No min <= max check: an inverted hue range is the legal way to say the arc
  // wraps through 0.
  if (!isRange(hue) || hue[0] < 0 || hue[0] >= 360 || hue[1] < 0 || hue[1] >= 360) {
    issues.push(
      paramIssue(effectId, key, "hue-out-of-range", "hue bounds must both lie in [0, 360)"),
    );
  }
}

function checkSeedParam(effectId: string, param: SeedParam, issues: RegistryIssue[]): void {
  const [seedMin, seedMax] = SEED_RANGE;
  if (!Number.isInteger(param.default) || param.default < seedMin || param.default > seedMax) {
    issues.push(
      paramIssue(
        effectId,
        param.key,
        "invalid-seed-default",
        `default ${param.default} is not a 32-bit unsigned integer`,
      ),
    );
  }
  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(paramIssue(effectId, param.key, "missing-surprise", "no surprise metadata"));
    return;
  }
  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, param.key, "invalid-weight", "surprise weight must be greater than zero"),
    );
  }
}

function checkCurveParam(effectId: string, param: CurveParam, issues: RegistryIssue[]): void {
  const key = param.key;
  const points = param.default;
  if (!Array.isArray(points) || points.length < 2) {
    issues.push(
      paramIssue(effectId, key, "curve-too-short", "a curve needs at least two control points"),
    );
  } else {
    let previousX = Number.NEGATIVE_INFINITY;
    let outside = false;
    for (const point of points) {
      if (
        !isFiniteNumber(point.x) ||
        !isFiniteNumber(point.y) ||
        point.x < 0 ||
        point.x > 1 ||
        point.y < 0 ||
        point.y > 1
      ) {
        outside = true;
        continue;
      }
      if (point.x <= previousX) {
        issues.push(
          paramIssue(
            effectId,
            key,
            "curve-not-monotonic",
            `control point x=${point.x} does not increase; a curve must be a function of x`,
          ),
        );
      }
      previousX = point.x;
    }
    if (outside) {
      issues.push(
        paramIssue(effectId, key, "curve-outside-unit-square", "control points must lie in the unit square"),
      );
    }
    const first = points[0];
    const last = points[points.length - 1];
    if (first !== undefined && last !== undefined && (first.x !== 0 || last.x !== 1)) {
      issues.push(
        paramIssue(
          effectId,
          key,
          "curve-domain-not-covered",
          "a transfer curve must span x = 0 to x = 1, or some inputs have no output",
        ),
      );
    }
  }

  const surprise: unknown = param.surprise;
  if (!isPresentObject(surprise)) {
    issues.push(paramIssue(effectId, key, "missing-surprise", "no surprise metadata"));
    return;
  }
  if (!isPositiveWeight(surprise["weight"])) {
    issues.push(
      paramIssue(effectId, key, "invalid-weight", "surprise weight must be greater than zero"),
    );
  }
  if (!isProbability(surprise["jitter"])) {
    issues.push(
      paramIssue(effectId, key, "invalid-jitter", "jitter must be a number in [0, 1]"),
    );
  }
  checkWeightedSet(effectId, key, surprise["archetypes"], null, issues);
}

/**
 * Validate one descriptor in isolation.
 *
 * Cross-effect rules — id uniqueness, exclusion targets — need the whole set
 * and live in {@link validateRegistry}.
 */
/** Every {@link InputRole}, so a malformed one can be named against the set. */
const INPUT_ROLES: readonly InputRole[] = [
  "image",
  "mask",
  "layer",
  "displace",
  "feedback",
];

/**
 * The declared image inputs, checked as a set.
 *
 * An effect that declares nothing is not checked and cannot be wrong: absent
 * means {@link DEFAULT_INPUT_PORTS}, which is a constant in this file.
 *
 * Everything here is a rule the graph would otherwise discover at wiring time
 * or — worse — at render time. A port with a duplicate key makes every edge to
 * it ambiguous; a first port that is not the picture breaks the composite,
 * which blends a node's output against its `in`; a `feedback` port on an effect
 * that does not declare `readsFeedback` is an edge nothing would ever serve,
 * because the previous frame comes from the frame store and the store is only
 * consulted for a node the descriptor marks.
 */
function checkInputPorts(
  id: string,
  effect: EffectDescriptor,
  issues: RegistryIssue[],
): void {
  const declared = effect.inputs;
  const feedbackPorts = (declared ?? []).filter(
    (port) => isPresentObject(port) && port.role === "feedback",
  );

  // Both directions. A feedback effect with no port declares a loop nothing can
  // draw; a feedback port on an ordinary effect declares an edge nothing feeds.
  if (effect.readsFeedback === true && feedbackPorts.length !== 1) {
    issues.push(
      issue(
        id,
        "feedback-port-mismatch",
        `declares readsFeedback: true and ${feedbackPorts.length} input port(s) of role "feedback"; it must declare exactly one, because that port is what makes the loop a visible edge in the graph rather than a hidden read of a frame store`,
      ),
    );
  }
  if (effect.readsFeedback !== true && feedbackPorts.length > 0) {
    issues.push(
      issue(
        id,
        "feedback-port-mismatch",
        `declares an input port of role "feedback" without readsFeedback: true; the previous frame comes from the frame store, which is only consulted for a node whose descriptor marks it, so an edge into that port would never be served`,
      ),
    );
  }

  if (declared === undefined) return;

  if (!Array.isArray(declared) || declared.length === 0) {
    issues.push(
      issue(
        id,
        "primary-input-port-missing",
        "declares an empty inputs list; omit the field to mean the default single image input rather than declaring no inputs at all",
      ),
    );
    return;
  }

  const first = declared[0];
  if (
    !isPresentObject(first) ||
    first["key"] !== PRIMARY_INPUT_PORT ||
    first["role"] !== "image"
  ) {
    issues.push(
      issue(
        id,
        "primary-input-port-missing",
        `the first declared input must be { key: "${PRIMARY_INPUT_PORT}", role: "image" }; every node has one picture it transforms, and the per-node composite (F-ST-03) blends its output against exactly that port`,
      ),
    );
  }

  const seen: string[] = [];
  for (const port of declared) {
    if (!isPresentObject(port)) {
      issues.push(issue(id, "malformed-input-port", "an input port is not an object"));
      continue;
    }
    const key: unknown = port.key;
    if (!isText(key) || !EFFECT_ID_PATTERN.test(key)) {
      issues.push(
        issue(
          id,
          "malformed-input-port",
          `input port key ${JSON.stringify(key)} is not lowercase kebab-case; the key is written into every saved document's edge list`,
        ),
      );
      continue;
    }
    if (key === MASK_INPUT_PORT) {
      issues.push(
        issue(
          id,
          "reserved-input-port",
          `declares an input port "${MASK_INPUT_PORT}"; that key is reserved — masking is spatially-varying opacity and is appended to every node by graph/ports.ts, so a declared one would shadow it`,
        ),
      );
      continue;
    }
    if (seen.includes(key)) {
      issues.push(
        issue(
          id,
          "duplicate-input-port",
          `input port key "${key}" is declared twice; every edge naming it would be ambiguous`,
        ),
      );
    }
    seen.push(key);

    if (!INPUT_ROLES.includes(port.role as InputRole)) {
      issues.push(
        issue(
          id,
          "malformed-input-port",
          `input port "${key}" has role ${JSON.stringify(port.role)}; expected one of ${INPUT_ROLES.join(", ")}`,
        ),
      );
    }
    if (typeof port.required !== "boolean") {
      issues.push(
        issue(
          id,
          "malformed-input-port",
          `input port "${key}" does not say whether it is required; an editor cannot refuse an unwired port it was never told about`,
        ),
      );
    }
    if (port.role === "image" && port.required === true) {
      issues.push(
        issue(
          id,
          "malformed-input-port",
          `input port "${key}" is role "image" and required; an unwired image input is a root node reading the decoded source, which is what every single-node document is`,
        ),
      );
    }
    if (!isText(port.label)) {
      issues.push(
        issue(id, "malformed-input-port", `input port "${key}" has no label`),
      );
    }
    // Same rule and the same reason as every other descriptive string here
    // (F-UI-15): present, and not a restatement of the label it sits under.
    checkDescriptiveText(
      port.description,
      [isText(port.label) ? port.label : "", key],
      "malformed-input-port",
      `input port "${key}" description`,
      (code, message) => issues.push(issue(id, code, message)),
    );
  }
}

export function validateEffect(effect: EffectDescriptor): readonly RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const id = typeof effect.id === "string" && effect.id.length > 0 ? effect.id : "<unnamed>";

  if (id === "<unnamed>") {
    issues.push(issue(id, "empty-id", "effect has no id"));
  } else if (!EFFECT_ID_PATTERN.test(id)) {
    issues.push(issue(id, "malformed-id", `effect id ${id} is not lowercase kebab-case`));
  }
  if (typeof effect.requirement !== "string" || !REQUIREMENT_PATTERN.test(effect.requirement)) {
    issues.push(
      issue(
        id,
        "malformed-requirement",
        `requirement ${String(effect.requirement)} is not a spec id such as F-ED-01`,
      ),
    );
  }
  if (!isPositiveWeight(effect.surpriseWeight)) {
    issues.push(
      issue(id, "invalid-surprise-weight", "surpriseWeight must be finite and greater than zero"),
    );
  }

  // F-UI-15. Checked here rather than left to the type system for the reason
  // stated at the top of the validation section: the types guarantee this for
  // literals written in this repository and guarantee nothing for a descriptor
  // assembled programmatically. An effect that reaches the registry without a
  // description is an effect the hover panel, the picker and the guide all have
  // to invent text for, and inventing it is how the three copies start.
  checkEffectText(id, effect, issues);

  // Error diffusion is serial by definition — that constraint is the reason the
  // renderer is split in two at all. A descriptor claiming otherwise is a
  // mislabelled effect, and it would be scheduled into a GPU batch that cannot
  // run it.
  if (effect.family === "error-diffusion" && effect.execution !== "wasm") {
    issues.push(
      issue(
        id,
        "diffusion-must-run-serially",
        "error diffusion cannot be expressed as a compute pass; execution must be wasm",
      ),
    );
  }

  // Nothing has quantized before the dither slot, so an index-map consumer
  // placed in preprocess can never have an input to read.
  if (effect.requiresIndexMap && effect.slot === "preprocess") {
    issues.push(
      issue(
        id,
        "index-map-consumer-in-preprocess",
        "reads the index map but sits before the dither slot, where none exists yet",
      ),
    );
  }

  // --- source nodes ------------------------------------------------------
  //
  // A source node produces an image from its parameters alone. All three rules
  // below are the same sentence read three ways: it has no image input, so
  // nothing about its input can be true of it.

  // The serial backend's kernels are transforms of a surface it is handed —
  // that is what a `WasmBackend` node *is*. A source has no such surface, so
  // there is nothing for a serial kernel to be given and no way for one to say
  // "write a frame from nothing". A compute pass says it by declaring an
  // `output-color` binding and no `input-color`, which is exactly what
  // `gpu/compiler.ts` checks.
  if (effect.slot === "source" && effect.execution !== "gpu") {
    issues.push(
      issue(
        id,
        "source-must-run-on-gpu",
        `sits in the source slot with execution "${effect.execution}"; a generator writes a frame with no input surface, which is a compute pass declaring output-color and no input-color, and the serial backend has no such shape`,
      ),
    );
  }

  // Same argument as `index-map-consumer-in-preprocess`, one slot earlier and
  // stronger: a source node is in front of every quantizer *and* reads no
  // image, so an index map could not reach it by either route.
  if (effect.slot === "source" && effect.requiresIndexMap) {
    issues.push(
      issue(
        id,
        "source-must-not-read-index-map",
        "sits in the source slot and reads the index map; a generator has no image input, so no map can reach it however the stack is ordered",
      ),
    );
  }

  // `resamples` declares that a node writes a different extent than the one it
  // reads. A source reads none: its extent is the working extent it is asked
  // for, and `PassExtent` is defined relative to an `input-color` binding the
  // compiler will refuse it for having.
  if (effect.slot === "source" && effect.resamples === true) {
    issues.push(
      issue(
        id,
        "source-must-not-resample",
        "sits in the source slot and declares resamples: true; a resampling rule is relative to the extent a pass reads, and a generator reads none — it writes the working extent it is given",
      ),
    );
  }

  // Resampling is expressed as a `PassExtent` on a compute pass, and a serial
  // kernel has none. A `wasm` effect claiming to resample is a declaration
  // nothing could honour: the WASM backend hands back a buffer at the extent it
  // was given, so the stack grammar would refuse combinations that in fact
  // render, and the graph would refuse composites that in fact compose.
  if (effect.resamples === true && effect.execution !== "gpu") {
    issues.push(
      issue(
        id,
        "resampler-must-run-on-gpu",
        `declares resamples: true with execution "${effect.execution}"; a changed extent is a PassExtent on a compute pass and a serial kernel has none`,
      ),
    );
  }

  // Feedback is a second colour binding on a compute pass, so a serial kernel
  // has no way to express it. Refused here rather than at compile time so a
  // mislabelled descriptor fails the catalogue — which is terminal and lists
  // every issue — instead of failing the first render that reaches the node.
  if (effect.readsFeedback === true && effect.execution !== "gpu") {
    issues.push(
      issue(
        id,
        "feedback-must-run-on-gpu",
        `declares readsFeedback: true with execution "${effect.execution}"; the previous frame arrives as a feedback-color binding on a compute pass and a serial kernel has none`,
      ),
    );
  }

  // The frame store holds one texture per node at the extent that node writes.
  // A node that resampled would write a different shape than the history it
  // just read, so frame N would read frame N-1 at the wrong grid — and the
  // extent would keep changing on every frame it ran.
  if (effect.readsFeedback === true && effect.resamples === true) {
    issues.push(
      issue(
        id,
        "feedback-must-not-resample",
        "declares readsFeedback and resamples together; the frame store holds the previous frame at the extent this node writes, and a node that changes extent has no common pixel grid with its own history",
      ),
    );
  }

  // `coverage` is a fact about a picture made from parameters, so it belongs to
  // exactly the source slot. Both directions are refused, and both are refused
  // *here* — at the gate that stops the application starting — for the reason
  // every other declaration in this block is: the reader is Surprise Me's
  // grammar, which runs long after startup and cannot ask a question of a field
  // that is not there.
  //
  // Missing on a generator is the one that matters. `surprise/grammar.ts` roots
  // a mask branch only in a generator declaring "large-scale"; a fourth generator
  // added without the field would silently never be chosen as a branch root, and
  // "my new generator never shows up in a mask" is not a failure anybody would
  // connect to a missing line in a descriptor.
  if (effect.slot === "source" && effect.coverage === undefined) {
    issues.push(
      issue(
        id,
        "source-must-declare-coverage",
        'sits in the source slot and declares no `coverage`; a generator is the only thing a mask branch can be rooted in, and whether its picture has structure at the scale of the frame ("large-scale") or of a pixel ("fine") is what decides whether such a branch is visible at all',
      ),
    );
  }
  if (effect.slot !== "source" && effect.coverage !== undefined) {
    issues.push(
      issue(
        id,
        "coverage-is-for-generators",
        `is in the "${effect.slot}" slot and declares coverage "${effect.coverage}"; the field describes the structure of a picture made from parameters, and a filter's structure is whatever it was handed`,
      ),
    );
  }

  if (effect.excludes !== undefined && effect.excludes.includes(effect.id)) {
    issues.push(issue(id, "self-exclusion", "effect excludes itself"));
  }

  checkInputPorts(id, effect, issues);

  const seenKeys: string[] = [];
  for (const param of effect.params) {
    if (typeof param.key !== "string" || param.key.length === 0) {
      issues.push(issue(id, "empty-param-key", "a parameter has no key"));
      continue;
    }
    if (seenKeys.includes(param.key)) {
      issues.push(
        issue(id, "duplicate-param-key", `parameter key ${param.key} is declared twice`),
      );
    }
    seenKeys.push(param.key);

    checkParamText(id, param, issues);

    switch (param.type) {
      case "float":
      case "int":
        checkNumericParam(id, param, issues);
        break;
      case "bool":
        checkBoolParam(id, param, issues);
        break;
      case "enum":
        checkEnumParam(id, param, issues);
        break;
      case "color":
        checkColorParam(id, param, issues);
        break;
      case "seed":
        checkSeedParam(id, param, issues);
        break;
      case "curve":
        checkCurveParam(id, param, issues);
        break;
    }
  }

  return issues;
}

/**
 * Validate the whole registry.
 *
 * Called at build time; a non-`ok` result fails the build. That is what keeps
 * Surprise Me correct as effects are added, instead of letting it degrade
 * quietly into never touching a parameter nobody described.
 */
export function validateRegistry(
  effects: readonly EffectDescriptor[],
): RegistryValidation {
  const issues: RegistryIssue[] = [];
  const seenIds: string[] = [];

  for (const effect of effects) {
    issues.push(...validateEffect(effect));
    if (typeof effect.id === "string" && effect.id.length > 0) {
      if (seenIds.includes(effect.id)) {
        issues.push(
          issue(effect.id, "duplicate-effect-id", `effect id ${effect.id} is registered twice`),
        );
      }
      seenIds.push(effect.id);
    }
  }

  for (const effect of effects) {
    for (const excluded of effect.excludes ?? []) {
      if (!seenIds.includes(excluded)) {
        issues.push(
          issue(
            effect.id,
            "unknown-exclusion",
            `excludes ${excluded}, which is not a registered effect`,
          ),
        );
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
