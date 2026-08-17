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
 * entries and the note at the top of `registry/catalogue.test.ts` — rather than
 * restated from memory.
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
   * oversight, and the entries that have left this table left it because their
   * stated reason was checkable and turned out to be wrong.
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
];

// F-PT-09 and F-PT-10 were here from the day the owner found the reference
// images this catalogue could not reproduce. **Both are built** — `ridgeline`
// and `wave-field` — so their entries are gone rather than reworded, which is
// the rule this table's own test enforces: an entry that becomes real fails the
// build rather than going on telling people a shipped effect does not exist.
//
// What made F-PT-10 possible was F-INF-01's second producer, and its stated
// reason for being unbuilt turned out to be wrong rather than merely unfinished:
// the entry here said a jump flood "needs a scratch texture the pass vocabulary
// has no role for". A jump flood carries a packed seed *coordinate* per texel,
// not a colour, and `ScratchSize` holds that exactly. See `web/src/gpu/sdf.ts`.
//
// The keywords both entries carried are now on the descriptors, so the queries
// that used to reach this table — "unknown pleasures", "radio waves",
// "ridgeline" — reach a real effect instead of an explanation.

// F-PP-08, node masking, was here from phase 3 until multi-input landed. Its
// stated reason — "a mask is a second image edge on the render graph, and the
// graph carries one image edge per node" — stopped being true, so the entry is
// gone rather than reworded. It is **not** an effect and never appears in the
// catalogue: a mask is spatially-varying opacity, it lives on the node beside
// `opacity` and `blend`, and every node in the catalogue has one for free. See
// `web/src/graph/mask.ts`.
//
// Only the `image` coverage is reachable, by wiring a picture into a node's
// mask port in the node editor. The luminance-band and colour coverages are
// implemented and evaluated identically on both backends but have no control
// that sets them, and neither has the channel choice or `invert`. That half is
// unbuilt in the UI rather than in the engine, so it is recorded in the guide
// and in docs/ARCHITECTURE.md instead of as an entry here — this table answers
// "which effect is missing", and masking is not an effect.

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
      // A whole word beats being a fragment of one, so "jpeg" scores on the
      // "jpeg" keyword rather than tying with everything containing "peg".
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
