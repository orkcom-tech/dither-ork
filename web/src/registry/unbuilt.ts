/**
 * Effects the spec names and this build does not have.
 *
 * This table exists because of a specific failure and answers a specific
 * question: *what does the search box say when the thing the user is looking
 * for genuinely is not here?* Returning nothing is the wrong answer, and it is
 * the answer that cost the owner time — an empty result is indistinguishable
 * from "you spelled it wrong", so a person retypes the query five ways before
 * concluding anything. Naming the gap ends the search in one step.
 *
 * Everything here is a **declaration of absence**, not a stub. Nothing in this
 * module is renderable, nothing appears in the effect picker, and no descriptor
 * is fabricated for any of it. A registered effect is the only thing that can be
 * added to a stack; these entries can only ever be printed as an explanation.
 * `search.test.ts` ("the unbuilt table") asserts that every requirement listed
 * here is one the registry does *not* implement, so an entry that becomes real
 * fails the build rather than going on telling people a shipped effect does not
 * exist.
 *
 * The reasons are copied from where the decisions were made — the spec's own
 * F-PT-09 and F-PT-10 entries and the note at the top of
 * `registry/catalogue.test.ts` — rather than restated from memory.
 */

/** One named requirement the catalogue does not implement. */
export interface UnbuiltFeature {
  /** Spec requirement id, e.g. `"F-GL-06"`. */
  readonly requirement: string;
  /** The name the spec gives it, so a reader can find the requirement. */
  readonly name: string;
  /** What it would do, in the same voice as an effect's summary. */
  readonly summary: string;
  /**
   * Why it is not built. Stated, because "not yet" without a reason reads as an
   * oversight, and three of these four are deliberate sequencing rather than
   * something anyone forgot.
   */
  readonly reason: string;
  /** What a person searching for this would type. Same rules as an effect's. */
  readonly keywords: readonly string[];
  /**
   * Effect ids worth offering instead — the closest built thing, even when it is
   * not close. Empty when there is honestly nothing near it, which is a better
   * answer than a misleading suggestion.
   */
  readonly nearest: readonly string[];
}

export const UNBUILT_FEATURES: readonly UnbuiltFeature[] = [
  {
    requirement: "F-GL-06",
    name: "JPEG glitch",
    summary:
      "Re-encode the picture as a JPEG at a chosen quality and optionally corrupt bytes of the compressed stream.",
    reason:
      "It needs a JPEG encoder inside the render pipeline, and the pipeline has no execution kind that could hold one — every node here is either a compute pass or a serial CPU kernel over a pixel buffer.",
    keywords: [
      "jpeg",
      "jpg",
      "compression",
      "artifacts",
      "artefacts",
      "blocky",
      "databend",
      "quality",
      "encode",
      "corrupt bytes",
    ],
    // Bit crush is the closest thing that is really here: it also destroys the
    // picture by attacking how it is stored rather than what it looks like.
    nearest: ["bit-crush", "block-shuffle", "noise-burst"],
  },
  {
    requirement: "F-PT-09",
    name: "Luminance-displaced line screen",
    summary:
      "Parallel lines whose displacement across their own run is driven by the image's brightness — the Unknown Pleasures ridgeline.",
    reason:
      "Nothing in the catalogue displaces by the picture. Row displacement offsets by a seed, wave warp offsets by a fixed geometric function, and line screen draws lines without moving them; the missing piece is exactly the one that makes the lines read as a contour of the image rather than as a texture over it, together with the hidden-line removal that makes them read as depth.",
    keywords: [
      "unknown pleasures",
      "joy division",
      "ridgeline",
      "ridge",
      "contour",
      "terrain",
      "topographic",
      "elevation",
      "displaced lines",
      "luminance displacement",
      "mountain",
      "heightmap",
      "oscilloscope",
    ],
    nearest: ["line-screen", "wave-warp", "row-displacement"],
  },
  {
    requirement: "F-PT-10",
    name: "Wave field with obstacle interaction",
    summary:
      "Waves emanating from a source that bend around the picture's subject, or are blocked by it and leave a shadow behind it.",
    reason:
      "It has to know where the subject is as a shape — how far every pixel is from it and in which direction — which is a signed distance field (F-INF-01). Half of that infrastructure now exists: web/src/gpu/sdf.ts fixes what a field is and ships the analytic primitives the Shape source draws from. The half this needs does not — a field transformed out of the picture rather than described by parameters, which is a jump flood over a scratch texture the pass vocabulary has no role for. Concentric rings and spiral are the geometric screens that already ship; they are radial patterns that take no account of what is in the picture at all.",
    keywords: [
      "radio waves",
      "wave field",
      "wavefront",
      "diffraction",
      "obstacle",
      "flow around",
      "shadow",
      "occlusion",
      "sonar",
      "ripple around",
      "interference",
      "subject aware",
    ],
    nearest: ["concentric-rings", "wave-warp", "line-screen"],
  },
  {
    requirement: "F-PP-08",
    name: "Node masking",
    summary:
      "Limit any node to part of the picture — by luminance range, by colour range, or by an uploaded mask image.",
    reason:
      "A mask is a second image edge on the render graph, and the graph carries one image edge per node. This is the only F-PP requirement with no descriptor, and it is a graph change rather than an effect.",
    keywords: [
      "mask",
      "masking",
      "selection",
      "limit",
      "restrict",
      "region",
      "matte",
      "stencil",
      "local",
      "partial",
      "apply to part",
    ],
    // Nothing here masks. Saying so is more use than pointing at a node that
    // takes a second image for an unrelated purpose.
    nearest: [],
  },
];

/**
 * The unbuilt feature a query is asking about, or `null`.
 *
 * Deliberately generous where an effect search is strict: this only runs once
 * the catalogue has already returned nothing, so a loose match costs a wrong
 * explanation at worst, while a strict one costs the empty result this table
 * exists to replace. One matching token is enough, and a requirement id typed
 * in full matches outright.
 */
export function unbuiltFor(
  tokens: readonly string[],
  normalize: (text: string) => string,
): UnbuiltFeature | null {
  if (tokens.length === 0) return null;

  let best: UnbuiltFeature | null = null;
  let bestScore = 0;

  for (const feature of UNBUILT_FEATURES) {
    const haystack = [
      normalize(feature.requirement),
      normalize(feature.name),
      ...feature.keywords.map(normalize),
    ];
    let score = 0;
    for (const token of tokens) {
      // A whole word beats being a fragment of one, so "wave" scores on the
      // "wave field" keyword rather than tying with everything containing "ave".
      if (haystack.some((h) => h.split(" ").includes(token))) score += 2;
      else if (haystack.some((h) => h.includes(token))) score += 1;
    }
    if (score > bestScore) {
      best = feature;
      bestScore = score;
    }
  }

  return best;
}
