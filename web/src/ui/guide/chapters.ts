/**
 * The guide's hand-written chapters (F-UI-14).
 *
 * **Only what the registry cannot say is written here.** The effect catalogue is
 * generated from the descriptors (`catalogue.ts`, F-UI-15) and nothing in this
 * file names an effect, a parameter or a count. What is left is the handful of
 * ideas a person has to hold before any of the sixty-seven make sense: that the
 * stack is a pipeline, that the palette is the whole vocabulary of the result,
 * that the work happens in linear light, that a quantizer leaves an index map
 * behind, that a loop closes because its frequencies are whole numbers, and
 * which file format to ask for.
 *
 * Two rules keep it from rotting.
 *
 * **A chapter states no number and no list of its own.** Where a fact about
 * this build belongs in the prose, the chapter declares a {@link GuideChapter.facts}
 * function that reads it off the sealed registry at render time, or a
 * {@link GuideChapter.lists} built from a table that already exists elsewhere —
 * the export format tables are the case, and their one-line `detail` is already
 * written in this voice for the export dialog. A sentence here that counted the
 * dithers by hand would be wrong the first time one was added, and wrong
 * silently.
 *
 * **It is short on purpose.** A guide that is read beats a complete one that is
 * not, so each chapter is the shortest thing that answers the question a person
 * actually arrives with. Everything an individual effect does is one search box
 * away in the catalogue below it.
 */

import { ANIMATED_FORMATS } from "../../export/animated";
import { EXPORT_FORMATS } from "../../export";
import type { EffectRegistry } from "../../registry";

/**
 * The chapters, in reading order.
 *
 * A closed union rather than free strings because the contents rail, the
 * scroll anchors and this list have to agree, and a typo in one of three places
 * is a link that goes nowhere.
 */
export type GuideChapterId =
  | "start"
  | "stack"
  | "palette"
  | "light"
  | "index-map"
  | "animation"
  | "export";

/** One numbered step. Used only by the getting-started chapter. */
export interface GuideStep {
  readonly title: string;
  readonly text: string;
}

/** A term and what it is for — the shape of the export format tables. */
export interface GuideEntry {
  readonly term: string;
  readonly detail: string;
}

export interface GuideList {
  readonly title: string;
  readonly entries: readonly GuideEntry[];
}

/** One count or list read off the build rather than written down. */
export interface GuideFact {
  readonly label: string;
  readonly value: string;
}

export interface GuideChapter {
  readonly id: GuideChapterId;
  readonly title: string;
  /** One line under the heading, before anything else. */
  readonly lede: string;
  /** Numbered steps, shown above the prose. */
  readonly steps?: readonly GuideStep[];
  /** The chapter itself, in reading order. */
  readonly paragraphs: readonly string[];
  /** Definition lists, shown below the prose. */
  readonly lists?: readonly GuideList[];
  /**
   * Facts about *this build*, resolved when the guide is opened.
   *
   * A function rather than data so the chapter cannot state a count that the
   * catalogue has since moved past. See the note at the top of the file.
   */
  readonly facts?: (registry: EffectRegistry) => readonly GuideFact[];
}

const START: GuideChapter = {
  id: "start",
  title: "Getting started",
  lede: "Four steps from a photograph to a file.",
  steps: [
    {
      title: "Open an image",
      text:
        "Use open image in the toolbar, drop a file anywhere on the window, or paste one from the clipboard. PNG, JPEG, WebP, BMP and the first frame of a GIF all work.",
    },
    {
      title: "Add a dither",
      text:
        "In the Stack panel, press add and choose something from the Error diffusion group. That is the family the word “dithering” usually means, and every one of them works on the picture straight away.",
    },
    {
      title: "Change the palette",
      text:
        "The Palette panel holds the colours the result is allowed to use. Extract a set from the picture itself, or take one of the hardware palettes, and watch the same stack become a different picture.",
    },
    {
      title: "Export",
      text:
        "export in the toolbar writes the picture you are looking at. PNG unless you have a reason to want something else — the Export chapter below is that list of reasons.",
    },
  ],
  paragraphs: [
    "Nothing you do is destructive and nothing is committed. Every change is one undo step, the picture is rebuilt from the original every time, and the recipe can be saved on its own as a .dork file or a preset that carries no image at all.",
    "If you would rather start from an accident than from a blank stack, press Surprise Me. It builds a whole document — palette, effects, order, parameters, animation — from a single seed that is shown in the interface, so a result you like can be reproduced exactly and a result you nearly like can be rerolled a piece at a time.",
    "Each part of a surprise has a mode. Reroll is the default: press Surprise and it changes. Lock keeps that part exactly as it is while everything else moves, which is how you hold a palette you like through fifty rerolls of the stack. Animation has a third mode, exclude, which leaves it out altogether — the document comes back with nothing bound and nothing moving. Locking animation is the opposite: it pins the movement you already have, so if you want the picture to sit still, exclude it rather than lock it.",
  ],
};

const STACK: GuideChapter = {
  id: "stack",
  title: "The stack, and why order matters",
  lede: "Effects are a pipeline, not a set of checkboxes.",
  paragraphs: [
    "Each effect takes the picture the effect above it produced, changes it, and hands the result down. Nothing is applied “to the original”. That is the single idea to take away, because everything surprising about this tool follows from it: turn one effect off and every effect below it is working on a different picture.",
    "So the order of the list is a larger decision than most of the parameter values in it. Soften the picture before a dither and the dither is handed something simpler, so the result comes out in fewer, larger areas of flat colour. Soften it after the dither and you are smearing the dither's own dots into grey mush. Neither is wrong and neither is a variation of the other — they are two different pictures, and the only difference between them is which row sits on top.",
    "A node's badge says which part of the pipeline it belongs to: pre for the ones that prepare the picture, dither for the one that reduces it to palette colours, post for the ones that work on the result. Dragging a row past a boundary where it cannot work is refused before it happens, and the refusal names both nodes and the reason rather than failing later as a render error.",
    "Every row also carries an enable toggle, a solo — render only as far as this node — an opacity and a blend mode against its own input. So “a bit of that effect” is a slider rather than a decision about whether the node is in the stack at all.",
  ],
  facts: (registry) => [
    {
      label: "prepare",
      value: `${registry.bySlot("preprocess").length} effects can sit before the dither`,
    },
    {
      label: "dither",
      value: `${registry.bySlot("dither").length} reduce the picture to palette colours`,
    },
    {
      label: "finish",
      value: `${registry.bySlot("postprocess").length} work on the result`,
    },
  ],
};

const PALETTE: GuideChapter = {
  id: "palette",
  title: "What a palette is here",
  lede: "The complete list of colours the picture is allowed to end up as.",
  paragraphs: [
    "A palette in this tool is not a tint, a filter or a suggestion. Every dither does the same thing underneath: for each pixel it finds the closest colour the palette can offer and uses that one instead, spreading the difference around in whatever way gives the family its character. The palette is therefore the entire vocabulary of the result. Two colours give you a 1-bit print; sixteen chosen well still read as a photograph.",
    "Extraction reads a palette out of the picture you opened. Median cut, Wu and k-means are three ways of asking the same question — which handful of colours describes this image best — and they disagree in ways you can see, so trying more than one is worth the two seconds. Swatches you lock keep their place when you extract again, which is how you pin the two colours you care about and let the algorithm fill in around them.",
    "The distance metric decides what “closest” means, and it is a look control rather than a correctness switch. OKLab measures distance the way an eye judges it, which is why it is the default and why a photographic palette lands on the colours a person would have picked. sRGB Euclidean measures it the way period tools did, dragging colours toward whichever channel happens to be largest. Neither is more correct than the other when the thing you are making is trying to look like 1994.",
    "The built-in library is hardware colour specifications only — the palettes machines actually had, each recorded with the source it was taken from. Anything else is yours to import or build, and either way a palette can be exported and shared as a file of its own.",
  ],
};

const LIGHT: GuideChapter = {
  id: "light",
  title: "Linear light",
  lede: "Why this looks better than a naive dither.",
  paragraphs: [
    "An image file does not store brightness. It stores a code value that a screen turns into brightness, and the relationship between the two is a curve — half of 255 is nowhere near half as much light. Dithering is arithmetic about light: the error a pixel carries is the amount of light it did not get, and it is only meaningful to hand that debt to a neighbour if both are measured in light. So this tool removes the curve when an image is opened, does everything in real light, and puts the curve back when it writes a file. Getting that wrong is the single most common reason a hand-rolled dither comes out muddy — a flat mid-grey reduced to black and white drifts dark, because the black it is being sent to is much further away than the white. Here a mid-grey averages back to its own brightness, and a test says so rather than an eye.",
    "The tone controls are the deliberate exception. Brightness, levels, curves and the rest act on the value as the screen shows it, because that is the only domain in which “lift the shadows by a quarter” means what it says. They belong in front of the dither: a dither has only a handful of colours to work with, so how much contrast and how much saturation reach it decides most of what you end up looking at.",
  ],
};

const INDEX_MAP: GuideChapter = {
  id: "index-map",
  title: "The index map",
  lede: "The second picture the pipeline carries once something has quantized.",
  paragraphs: [
    "When a node reduces the picture to palette colours it writes down two things: the colours, and — for every pixel — which palette entry that colour is. The second buffer is the index map, and it is why some of the most useful things here are exact instead of approximate.",
    "With the map in hand, the boundary between two palette regions is an integer inequality between two indices. It costs nothing to compute and it is right even where the two colours are nearly identical, and even in the middle of dither noise where any edge detector working on colour alone would find edges everywhere. That is what puts an outline stroke exactly on the region edge instead of near it, and it is what makes the SVG export a faithful trace of the picture rather than an autotrace with a tolerance to tune.",
    "It also explains a refusal you will meet. Anything that reads the map has to sit below something that made one. Most dithers make one — but a CMYK halftone's output is ink printed over ink, so there is no single palette entry that any pixel is, and it leaves no map behind. Put a map reader under it and the editor refuses and names both nodes. The same rule stops the picture being resampled while a map is live: an index is a name, not a quantity, and the average of two names is not a colour.",
  ],
  facts: (registry) => {
    const dithers = registry.bySlot("dither");
    const writers = dithers.filter((effect) => effect.producesIndexMap);
    const silent = dithers.filter((effect) => !effect.producesIndexMap);
    const readers = registry.all().filter((effect) => effect.requiresIndexMap);
    const names = (effects: readonly { readonly name: string }[]): string =>
      effects.map((effect) => effect.name).join(", ");
    return [
      {
        label: "writes a map",
        value: `${writers.length} of the ${dithers.length} dithers`,
      },
      {
        label: "leaves none",
        value: silent.length === 0 ? "every dither in this build writes one" : names(silent),
      },
      {
        label: "reads the map",
        value:
          readers.length === 0
            ? "nothing in this build reads it yet"
            : `${names(readers)}, and the SVG export`,
      },
    ];
  },
};

const ANIMATION: GuideChapter = {
  id: "animation",
  title: "Animation",
  lede: "A loop that closes, by construction.",
  paragraphs: [
    "Set a frame count and a rate, then bind any numeric parameter to a modulator — sine, triangle, saw, square, smooth noise, stepped random — or draw keyframes for it on the timeline. The picture becomes a function of the frame, and the preview plays it.",
    "Cycles per loop is a whole number, and the control will not accept anything else. That is the guarantee rather than a limitation: a wave that runs a whole number of cycles across the loop is at exactly the same point in its cycle on the last frame as on the first, so the last frame is the first frame — the same bits, not close enough. The loop closes with no crossfade, no ping-pong and nothing for you to check. Ask for 2.5 cycles and it would land halfway through a cycle at the seam, and every repeat would visibly jump.",
    "Nothing in the pipeline reads a clock or an unseeded random number either. Every grain of noise is a function of the document's own seed and the frame index, so scrubbing back to a frame gives you that frame again, and an export of the loop is the loop you watched.",
    "Before an animated export runs, the first and last frames are hashed and compared. If a binding has broken periodicity the export stops and says which one did it, rather than writing a file that stutters once a second forever.",
  ],
  facts: (registry) => {
    const animatable = registry
      .all()
      .reduce(
        (count, effect) => count + effect.params.filter((param) => param.animatable).length,
        0,
      );
    return [
      { label: "bindable", value: `${animatable} parameters can take a modulator or a keyframe track` },
    ];
  },
};

const EXPORT: GuideChapter = {
  id: "export",
  title: "Export",
  lede: "Which format for what.",
  paragraphs: [
    "Start with PNG. A dithered picture is nearly always 256 colours or fewer — that is what having a palette means — and at that size the file is written as an indexed PNG: one byte a pixel plus a colour table, lossless, and several times smaller than the same picture stored as full-colour RGBA. Nothing is given up by not choosing something else.",
    "Choose SVG when the result is going to be cut, printed or stitched rather than looked at on a screen. The picture is traced into filled paths with one group per palette colour, marked as a layer, which is what a vinyl cutter or an embroidery digitiser expects to be handed. There is a minimum-feature filter for dropping the specks a machine cannot cut, and a simplified mode for when exact pixel outlines are more detail than the material can hold.",
    "Avoid GIF unless the thing receiving it only takes GIF. It is the only moving format that uses the document's own colours directly, with no second quantization — which is exactly right, and is why it is here — but its compression works by finding repeated runs of pixels, and a dither is made out of not having any. A dithered loop as GIF is usually several times the size of the same loop as animated WebP or WebM.",
    "Whatever you choose, the size multiplier is a whole number applied with nearest-neighbour, and it is independent of the zoom you are previewing at. A 4× export is the same pixels four times as large, never a resample, so the dither pattern survives the enlargement intact.",
  ],
  lists: [
    {
      title: "Stills",
      entries: EXPORT_FORMATS.map((format) => ({
        term: format.label,
        detail: format.detail,
      })),
    },
    {
      title: "Loops",
      entries: ANIMATED_FORMATS.map((format) => ({
        term: format.label,
        detail: format.detail,
      })),
    },
  ],
};

/**
 * Every chapter, in the order they are meant to be read.
 *
 * Getting started first because that is what somebody who has just opened the
 * application needs; the stack next because it is the idea people get wrong;
 * then the three that explain why the results look the way they do; then the
 * two that are about producing something. The generated catalogue follows all
 * of them, since it is a reference rather than something to read through.
 */
export const GUIDE_CHAPTERS: readonly GuideChapter[] = [
  START,
  STACK,
  PALETTE,
  LIGHT,
  INDEX_MAP,
  ANIMATION,
  EXPORT,
];

/** Facts for one chapter against this build, or an empty list. */
export function factsFor(
  chapter: GuideChapter,
  registry: EffectRegistry,
): readonly GuideFact[] {
  return chapter.facts === undefined ? [] : chapter.facts(registry);
}
