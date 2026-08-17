/**
 * Registry validation — the gate the whole catalogue passes through.
 *
 * Validation is the only thing standing between "an effect forgot its surprise
 * metadata" and Surprise Me quietly never touching that parameter for the rest
 * of the project. Most of what it checks cannot be expressed in the type system
 * at all: that a surprise range sits inside its legal range, that a default is
 * reachable, that a log distribution has a positive range. So these tests are
 * the specification of that gate, not a restatement of the types.
 *
 * The file is organised as one test per failure mode, and the last test asserts
 * that **every** `RegistryIssueCode` has one. That last assertion is compile-time
 * as much as runtime: `EVERY_FAILURE_MODE` is a `Record<RegistryIssueCode, true>`,
 * so adding a new rejection code to the validator without adding a test for it
 * stops type-checking here.
 *
 * The malformed descriptors below are cast into place. That is deliberate and it
 * is the case the validator's own comment describes: the types guarantee the
 * metadata is present for descriptors written as literals in this repository,
 * and guarantee nothing for one assembled programmatically or arriving from an
 * untyped module. Those are exactly the inputs the runtime checks exist for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLevel } from "../lib/log";
import {
  CHROMA_CEILING,
  EFFECT_CONCEPTS,
  SEED_RANGE,
  validateEffect,
  validateRegistry,
  type BoolParam,
  type ColorParam,
  type CurveParam,
  type EffectDescriptor,
  type EnumParam,
  type FloatParam,
  type IntParam,
  type RegistryIssue,
  type RegistryIssueCode,
  type SeedParam,
} from "../types/registry";
import {
  EffectRegistryBuilder,
  RegistryValidationError,
  UnknownEffectError,
  createEffectRegistry,
} from "./registry";

setLevel("error");

// A rejected catalogue logs one line per issue before it throws — deliberately,
// so the failure names the offending module. Several tests provoke that, so the
// console is silenced rather than the logger.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// --- well-formed fixtures ------------------------------------------------

const FLOAT_PARAM: FloatParam = {
  key: "spread",
  label: "Spread",
  type: "float",
  description:
    "How much of the tone the pattern is allowed to carry. At 0 the matrix does nothing and the result is plain quantization.",
  animatable: true,
  legal: [0, 2],
  default: 1,
  surprise: { range: [0.4, 1.2], distribution: { kind: "uniform" }, weight: 1 },
};

const INT_PARAM: IntParam = {
  key: "levels",
  label: "Levels",
  type: "int",
  description: "How many tones each channel is allowed. 2 is pure black and white.",
  animatable: true,
  legal: [2, 256],
  default: 4,
  surprise: { range: [2, 16], distribution: { kind: "log" }, weight: 1 },
};

const BOOL_PARAM: BoolParam = {
  key: "serpentine",
  label: "Serpentine",
  type: "bool",
  description:
    "Alternates direction every row so error stops drifting consistently to one side.",
  animatable: false,
  default: true,
  surprise: { trueProbability: 0.9, weight: 0.5 },
};

const ENUM_PARAM: EnumParam = {
  key: "shape",
  label: "Dot shape",
  type: "enum",
  description: "The figure the ink is drawn as, which decides how the midtones join up.",
  animatable: false,
  values: [
    { value: "round", label: "Round" },
    { value: "square", label: "Square" },
    { value: "line", label: "Line" },
  ],
  default: "round",
  surprise: {
    values: [
      { value: "round", weight: 2 },
      { value: "square", weight: 1 },
    ],
    weight: 0.7,
  },
};

const COLOR_PARAM: ColorParam = {
  key: "tint",
  label: "Tint",
  type: "color",
  description: "Colour the whole frame is pushed towards.",
  animatable: true,
  default: [255, 0, 128],
  surprise: {
    lightness: [0.4, 0.9],
    chroma: [0.02, 0.2],
    // Wraps through 0 — the only way to express "warm" as one range.
    hue: [300, 60],
    weight: 0.4,
  },
};

const SEED_PARAM: SeedParam = {
  key: "jitterSeed",
  label: "Jitter seed",
  type: "seed",
  description: "Fixes which pixels are jittered. The same seed always gives the same picture.",
  animatable: false,
  default: 0,
  surprise: { weight: 0.3 },
};

const CURVE_PARAM: CurveParam = {
  key: "transfer",
  label: "Transfer",
  type: "curve",
  description: "Maps input tone to output tone. The diagonal is no change.",
  animatable: false,
  default: [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
  ],
  surprise: {
    archetypes: [
      { value: "s-curve", weight: 2 },
      { value: "linear", weight: 1 },
    ],
    jitter: 0.1,
    weight: 0.6,
  },
};

const VALID: EffectDescriptor = {
  id: "bayer-4",
  name: "Bayer 4×4",
  summary: "Sixteen thresholds in a repeating tile — the ordered dither most people picture.",
  description:
    "A stand-in for the real Bayer 4×4 descriptor, carrying the fields the validator reads and nothing else.",
  keywords: ["bayer", "ordered", "dither"],
  concept: "ordered-dithering",
  requirement: "F-OD-02",
  slot: "dither",
  family: "ordered",
  execution: "gpu",
  params: [FLOAT_PARAM],
  surpriseWeight: 1,
  producesIndexMap: true,
  requiresIndexMap: false,
};

const DIFFUSION: EffectDescriptor = {
  id: "floyd-steinberg",
  name: "Floyd–Steinberg",
  summary: "Pushes each pixel's quantization error onto neighbours it has not reached yet.",
  description:
    "A stand-in for the real Floyd–Steinberg descriptor, present so the serial-execution rule has something to be checked against.",
  keywords: ["floyd", "steinberg", "diffusion"],
  concept: "error-diffusion",
  requirement: "F-ED-01",
  slot: "dither",
  family: "error-diffusion",
  execution: "wasm",
  params: [BOOL_PARAM],
  surpriseWeight: 1,
  producesIndexMap: true,
  requiresIndexMap: false,
};

// --- helpers -------------------------------------------------------------

/**
 * Reinterpret a deliberately malformed literal as a descriptor.
 *
 * See the file comment: this is the untyped-input path the runtime checks are
 * written for, and there is no way to express it without telling the compiler to
 * stand aside.
 */
function asDescriptor(value: unknown): EffectDescriptor {
  return value as EffectDescriptor;
}

/** A copy of {@link VALID} whose sole parameter is `param`. */
function withParam(param: unknown): EffectDescriptor {
  return asDescriptor({ ...VALID, params: [param] });
}

/** {@link VALID} with some top-level fields replaced, malformed or not. */
function withFields(fields: Readonly<Record<string, unknown>>): EffectDescriptor {
  return asDescriptor({ ...VALID, ...fields });
}

/** Every failure mode reached by a test, so the coverage check at the end is real. */
const observed = new Set<RegistryIssueCode>();

function rejects(
  issues: readonly RegistryIssue[],
  code: RegistryIssueCode,
  because: string,
): void {
  observed.add(code);
  expect(
    issues.map((issue) => issue.code),
    because,
  ).toContain(code);
}

function accepts(effect: EffectDescriptor): void {
  expect(validateEffect(effect)).toEqual([]);
}

// --- acceptance ----------------------------------------------------------

describe("validateEffect accepts", () => {
  it("a well-formed descriptor", () => {
    accepts(VALID);
    expect(validateRegistry([VALID])).toEqual({ ok: true, issues: [] });
  });

  it("a descriptor carrying one parameter of every kind", () => {
    accepts(
      withFields({
        params: [
          FLOAT_PARAM,
          INT_PARAM,
          BOOL_PARAM,
          ENUM_PARAM,
          COLOR_PARAM,
          SEED_PARAM,
          CURVE_PARAM,
        ],
      }),
    );
  });

  it("a hue range that wraps through zero", () => {
    // `min > max` is legal for hue and only for hue. Rejecting it would make
    // "warm" impossible to express as one range.
    accepts(withParam({ ...COLOR_PARAM, surprise: { ...COLOR_PARAM.surprise, hue: [340, 40] } }));
  });

  it("a normal distribution whose mean sits inside the surprise range", () => {
    accepts(
      withParam({
        ...FLOAT_PARAM,
        surprise: {
          range: [0.4, 1.2],
          distribution: { kind: "normal", mean: 0.8, sigma: 0.2 },
          weight: 1,
        },
      }),
    );
  });

  it("a surprise range equal to the legal range", () => {
    // Narrower is the point (F-SM-04) but equal is not *invalid* — a seed-like
    // parameter has no narrower musical range, and the validator is not the
    // place to legislate taste.
    accepts(withParam({ ...FLOAT_PARAM, surprise: { ...FLOAT_PARAM.surprise, range: [0, 2] } }));
  });

  it("an effect that excludes another registered effect", () => {
    const excluding = withFields({ excludes: ["floyd-steinberg"] });
    expect(validateRegistry([excluding, DIFFUSION]).ok).toBe(true);
  });

  it("an index-map consumer that sits after the dither slot", () => {
    accepts(
      withFields({
        id: "outline",
        requirement: "F-CO-04",
        slot: "postprocess",
        family: "special",
        producesIndexMap: false,
        requiresIndexMap: true,
      }),
    );
  });
});

// --- effect-level rejections ---------------------------------------------

describe("validateEffect rejects", () => {
  it("an effect with no id", () => {
    rejects(validateEffect(withFields({ id: "" })), "empty-id", "an effect must have an id");
  });

  it("an id that is not lowercase kebab-case", () => {
    // The id ends up in the share URL fragment and in preset file names, where a
    // space or a capital is a bug a user finds rather than CI.
    for (const bad of ["Bayer4", "bayer_4", "bayer 4", "bayer-", "-bayer", "bayer--4"]) {
      rejects(validateEffect(withFields({ id: bad })), "malformed-id", `id ${bad}`);
    }
  });

  it("a requirement that is not a spec id", () => {
    for (const bad of ["OD-02", "F-od-02", "F-ODX-02", "F-OD-", "bayer"]) {
      rejects(
        validateEffect(withFields({ requirement: bad })),
        "malformed-requirement",
        `requirement ${bad}`,
      );
    }
    // The three-character form used by shared control groups stays legal.
    accepts(withFields({ requirement: "F-ED-CTL" }));
  });

  it("a surprise weight that is zero, negative or not a number", () => {
    for (const bad of [0, -1, Number.NaN, "1"]) {
      rejects(
        validateEffect(withFields({ surpriseWeight: bad })),
        "invalid-surprise-weight",
        `surpriseWeight ${String(bad)}`,
      );
    }
  });

  it("an error-diffusion effect that declares gpu execution", () => {
    // Error diffusion is serial by definition — that constraint is the reason
    // the renderer is split in two at all. A descriptor claiming otherwise would
    // be scheduled into a GPU batch that cannot run it.
    rejects(
      validateEffect({ ...DIFFUSION, execution: "gpu" }),
      "diffusion-must-run-serially",
      "error diffusion cannot be a compute pass",
    );
    // The same descriptor on the serial path is fine.
    accepts(DIFFUSION);
  });

  it("an index-map consumer placed in the preprocess slot", () => {
    // Nothing has quantized before the dither slot, so it could never have an
    // input to read.
    rejects(
      validateEffect(
        withFields({ slot: "preprocess", family: "preprocess", requiresIndexMap: true }),
      ),
      "index-map-consumer-in-preprocess",
      "nothing has quantized yet",
    );
  });

  it("a serial effect that claims to resample", () => {
    // A changed extent is a `PassExtent` on a compute pass and a serial kernel
    // has none, so nothing could honour the claim — while the stack grammar and
    // the plan would both start refusing placements that in fact work.
    rejects(
      validateEffect({ ...DIFFUSION, resamples: true }),
      "resampler-must-run-on-gpu",
      "a serial kernel has no extent rule",
    );
    // The same claim on the parallel path is exactly what F-PP-01 declares.
    accepts(withFields({ resamples: true }));
  });

  it("a serial effect that claims to read its own previous frame", () => {
    // The previous frame arrives as a `feedback-color` binding on a compute
    // pass; a serial kernel has no binding list, so nothing could honour the
    // claim — while the cache would already have excluded the node and
    // everything after it, and the document would already be marked
    // non-looping, for a history nothing reads.
    rejects(
      validateEffect({ ...DIFFUSION, readsFeedback: true }),
      "feedback-must-run-on-gpu",
      "a serial kernel has none",
    );
    accepts(withFields({ readsFeedback: true }));
  });

  it("an effect that both reads feedback and resamples", () => {
    // The frame store holds one texture per node at the extent that node
    // writes. A node changing extent has no common pixel grid with its own
    // history, and the extent would move on every frame it ran.
    rejects(
      validateEffect(withFields({ readsFeedback: true, resamples: true })),
      "feedback-must-not-resample",
      "no common pixel grid with its own history",
    );
  });

  it("a serial effect placed in the source slot", () => {
    // A generator writes a frame with no input surface, which is a compute pass
    // declaring `output-color` and no `input-color`. The serial backend's
    // kernels are transforms of a surface they are handed, so there is nothing
    // for one to be given and no shape for it to say this in.
    rejects(
      validateEffect({ ...DIFFUSION, slot: "source" }),
      "source-must-run-on-gpu",
      "the serial backend has no such shape",
    );
    accepts(withFields({ slot: "source" }));
  });

  it("a source effect that reads the index map", () => {
    // Stronger than the preprocess rule it echoes: a source node is in front of
    // every quantizer *and* reads no image, so no map could reach it by either
    // route however the stack is ordered.
    rejects(
      validateEffect(withFields({ slot: "source", requiresIndexMap: true })),
      "source-must-not-read-index-map",
      "no map can reach it however the stack is ordered",
    );
  });

  it("a source effect that claims to resample", () => {
    // A resampling rule is relative to the extent a pass *reads*, and a
    // generator reads none — it writes the working extent it is given. The
    // compiler refuses the `input-color` binding such a rule would need.
    rejects(
      validateEffect(withFields({ slot: "source", resamples: true })),
      "source-must-not-resample",
      "a generator reads none",
    );
  });

  it("an effect that excludes itself", () => {
    rejects(
      validateEffect(withFields({ excludes: ["bayer-4"] })),
      "self-exclusion",
      "an effect cannot exclude itself",
    );
  });

  it("a parameter with no key", () => {
    rejects(
      validateEffect(withParam({ ...FLOAT_PARAM, key: "" })),
      "empty-param-key",
      "a parameter needs a key to be addressed by",
    );
  });

  it("two parameters sharing a key", () => {
    rejects(
      validateEffect(
        withFields({ params: [FLOAT_PARAM, { ...INT_PARAM, key: FLOAT_PARAM.key }] }),
      ),
      "duplicate-param-key",
      "one key can only mean one parameter",
    );
  });
});

// --- surprise metadata ---------------------------------------------------

describe("validateEffect rejects missing surprise metadata", () => {
  it("on every parameter kind", () => {
    // The field is required by the types, so this can only arrive from an
    // untyped module — and that is precisely when a silent skip would be
    // permanent, because Surprise Me would simply never move the parameter.
    for (const param of [
      FLOAT_PARAM,
      INT_PARAM,
      BOOL_PARAM,
      ENUM_PARAM,
      COLOR_PARAM,
      SEED_PARAM,
      CURVE_PARAM,
    ]) {
      const { surprise: _dropped, ...rest } = param;
      rejects(
        validateEffect(withParam(rest)),
        "missing-surprise",
        `${param.type} parameter without surprise metadata`,
      );
    }
  });

  it("when the surprise range is absent or malformed", () => {
    rejects(
      validateEffect(withParam({ ...FLOAT_PARAM, surprise: { distribution: { kind: "uniform" }, weight: 1 } })),
      "missing-surprise",
      "no surprise range",
    );
    rejects(
      validateEffect(withParam({ ...FLOAT_PARAM, surprise: { ...FLOAT_PARAM.surprise, range: [0.4] } })),
      "missing-surprise",
      "a range is exactly two finite numbers",
    );
    rejects(
      validateEffect(
        withParam({ ...FLOAT_PARAM, surprise: { ...FLOAT_PARAM.surprise, range: [0.4, Number.NaN] } }),
      ),
      "missing-surprise",
      "a range bound cannot be NaN",
    );
  });

  it("when no sampling distribution is declared, or an unknown one is", () => {
    rejects(
      validateEffect(withParam({ ...FLOAT_PARAM, surprise: { range: [0.4, 1.2], weight: 1 } })),
      "missing-surprise",
      "naming no distribution leaves the generator guessing",
    );
    rejects(
      validateEffect(
        withParam({
          ...FLOAT_PARAM,
          surprise: { ...FLOAT_PARAM.surprise, distribution: { kind: "gaussian" } },
        }),
      ),
      "missing-surprise",
      "an unknown distribution is not a distribution",
    );
  });

  it("when a surprise weight is zero, negative or missing", () => {
    for (const param of [FLOAT_PARAM, BOOL_PARAM, ENUM_PARAM, COLOR_PARAM, SEED_PARAM, CURVE_PARAM]) {
      rejects(
        validateEffect(withParam({ ...param, surprise: { ...param.surprise, weight: 0 } })),
        "invalid-weight",
        `${param.type} weight 0`,
      );
    }
  });

  it("when a weighted option carries no positive weight", () => {
    rejects(
      validateEffect(
        withParam({
          ...ENUM_PARAM,
          surprise: { ...ENUM_PARAM.surprise, values: [{ value: "round", weight: 0 }] },
        }),
      ),
      "invalid-weight",
      "an option with weight 0 can never be drawn",
    );
  });

  it("when a categorical surprise draws from an empty set", () => {
    rejects(
      validateEffect(
        withParam({ ...ENUM_PARAM, surprise: { ...ENUM_PARAM.surprise, values: [] } }),
      ),
      "empty-surprise-set",
      "an empty set means the parameter can never be surprised",
    );
    rejects(
      validateEffect(
        withParam({ ...CURVE_PARAM, surprise: { ...CURVE_PARAM.surprise, archetypes: [] } }),
      ),
      "empty-surprise-set",
      "a curve with no archetypes can never be surprised",
    );
  });
});

// --- ranges --------------------------------------------------------------

describe("validateEffect rejects bad ranges", () => {
  it("a surprise range that escapes the legal range", () => {
    // The gap between the two is the whole difference between a usable random
    // result and noise (F-SM-04); a surprise range wider than legal would hand
    // the loader values it must then clamp.
    for (const range of [
      [-0.5, 1.2],
      [0.4, 3],
      [-1, 3],
    ]) {
      rejects(
        validateEffect(withParam({ ...FLOAT_PARAM, surprise: { ...FLOAT_PARAM.surprise, range } })),
        "surprise-outside-legal",
        `surprise ${JSON.stringify(range)} against legal [0, 2]`,
      );
    }
  });

  it("an inverted surprise range", () => {
    rejects(
      validateEffect(
        withParam({ ...FLOAT_PARAM, surprise: { ...FLOAT_PARAM.surprise, range: [1.2, 0.4] } }),
      ),
      "inverted-surprise-range",
      "min must not exceed max",
    );
  });

  it("an empty or inverted legal range", () => {
    for (const legal of [
      [2, 0],
      [1, 1],
    ]) {
      rejects(
        validateEffect(withParam({ ...FLOAT_PARAM, legal, default: 1, surprise: { range: [1, 1], distribution: { kind: "uniform" }, weight: 1 } })),
        "inverted-legal-range",
        `legal ${JSON.stringify(legal)}`,
      );
    }
    rejects(
      validateEffect(withParam({ ...FLOAT_PARAM, legal: [0] })),
      "inverted-legal-range",
      "a legal range is exactly two finite numbers",
    );
  });

  it("a default outside the legal range", () => {
    for (const bad of [-1, 2.5]) {
      rejects(
        validateEffect(withParam({ ...FLOAT_PARAM, default: bad })),
        "default-outside-legal",
        `default ${bad} against legal [0, 2]`,
      );
    }
    rejects(
      validateEffect(withParam({ ...FLOAT_PARAM, default: Number.NaN })),
      "default-outside-legal",
      "a default must be a finite number",
    );
    rejects(
      validateEffect(withParam({ ...BOOL_PARAM, default: "yes" })),
      "default-outside-legal",
      "a bool default must be a boolean",
    );
  });

  it("a non-integer bound, default or surprise range on an int parameter", () => {
    rejects(
      validateEffect(withParam({ ...INT_PARAM, default: 4.5 })),
      "non-integer-bound",
      "an int default must be an integer",
    );
    rejects(
      validateEffect(withParam({ ...INT_PARAM, legal: [2, 256.5] })),
      "non-integer-bound",
      "an int legal bound must be an integer",
    );
    rejects(
      validateEffect(
        withParam({ ...INT_PARAM, surprise: { ...INT_PARAM.surprise, range: [2, 16.5] } }),
      ),
      "non-integer-bound",
      "an int surprise bound must be an integer",
    );
  });

  it("log sampling over a range that reaches zero", () => {
    // Log sampling is the right default for anything measured in octaves, and it
    // is undefined at zero.
    rejects(
      validateEffect(
        withParam({
          ...FLOAT_PARAM,
          surprise: { range: [0, 1.2], distribution: { kind: "log" }, weight: 1 },
        }),
      ),
      "log-needs-positive-range",
      "log of zero",
    );
  });

  it("normal sampling with a mean outside the range or a non-positive sigma", () => {
    // Naming the distribution without its parameters would leave the generator
    // guessing a mean, and a guessed mean is a look decision made by accident.
    rejects(
      validateEffect(
        withParam({
          ...FLOAT_PARAM,
          surprise: {
            range: [0.4, 1.2],
            distribution: { kind: "normal", mean: 1.9, sigma: 0.2 },
            weight: 1,
          },
        }),
      ),
      "invalid-normal-parameters",
      "the mean must sit inside the surprise range",
    );
    rejects(
      validateEffect(
        withParam({
          ...FLOAT_PARAM,
          surprise: {
            range: [0.4, 1.2],
            distribution: { kind: "normal", mean: 0.8, sigma: 0 },
            weight: 1,
          },
        }),
      ),
      "invalid-normal-parameters",
      "sigma must be greater than zero",
    );
  });
});

// --- categorical, colour, seed, curve ------------------------------------

describe("validateEffect rejects bad enums", () => {
  it("an enum declaring no values", () => {
    rejects(
      validateEffect(withParam({ ...ENUM_PARAM, values: [] })),
      "empty-enum",
      "an enum with no options is not a control",
    );
  });

  it("a duplicated enum value", () => {
    rejects(
      validateEffect(
        withParam({
          ...ENUM_PARAM,
          values: [
            { value: "round", label: "Round" },
            { value: "round", label: "Also round" },
          ],
        }),
      ),
      "duplicate-enum-value",
      "one value can only mean one option",
    );
  });

  it("a default that is not one of the declared values", () => {
    rejects(
      validateEffect(withParam({ ...ENUM_PARAM, default: "hexagon" })),
      "unknown-enum-default",
      "the default must be selectable",
    );
  });

  it("a surprise option outside the legal set", () => {
    rejects(
      validateEffect(
        withParam({
          ...ENUM_PARAM,
          surprise: { ...ENUM_PARAM.surprise, values: [{ value: "hexagon", weight: 1 }] },
        }),
      ),
      "enum-surprise-outside-legal",
      "Surprise Me cannot draw a value the effect does not have",
    );
  });
});

describe("validateEffect rejects bad colours", () => {
  it("a default that is not an 8-bit sRGB triplet", () => {
    for (const bad of [[255, 0], [255, 0, 128, 255], [255, 0, 300], [255, 0, -1], [1.5, 0, 0], "#ff0080"]) {
      rejects(
        validateEffect(withParam({ ...COLOR_PARAM, default: bad })),
        "invalid-color-component",
        `default ${JSON.stringify(bad)}`,
      );
    }
  });

  it("a chroma range sRGB cannot reach", () => {
    rejects(
      validateEffect(
        withParam({
          ...COLOR_PARAM,
          surprise: { ...COLOR_PARAM.surprise, chroma: [0.02, CHROMA_CEILING + 0.01] },
        }),
      ),
      "chroma-out-of-gamut",
      `sRGB tops out well below ${CHROMA_CEILING}`,
    );
    rejects(
      validateEffect(
        withParam({ ...COLOR_PARAM, surprise: { ...COLOR_PARAM.surprise, chroma: [0.2, 0.02] } }),
      ),
      "chroma-out-of-gamut",
      "chroma is the one range that may not invert",
    );
  });

  it("a hue bound outside [0, 360)", () => {
    for (const hue of [[0, 360], [-1, 90], [400, 90]]) {
      rejects(
        validateEffect(withParam({ ...COLOR_PARAM, surprise: { ...COLOR_PARAM.surprise, hue } })),
        "hue-out-of-range",
        `hue ${JSON.stringify(hue)}`,
      );
    }
  });

  it("a lightness range outside [0, 1]", () => {
    rejects(
      validateEffect(
        withParam({ ...COLOR_PARAM, surprise: { ...COLOR_PARAM.surprise, lightness: [0.4, 1.4] } }),
      ),
      "lightness-out-of-range",
      "OKLab lightness lives in [0, 1]",
    );
    rejects(
      validateEffect(
        withParam({ ...COLOR_PARAM, surprise: { ...COLOR_PARAM.surprise, lightness: [0.9, 0.4] } }),
      ),
      "lightness-out-of-range",
      "lightness may not invert",
    );
  });
});

describe("validateEffect rejects bad seeds and curves", () => {
  it("a seed default outside the 32-bit unsigned space", () => {
    for (const bad of [-1, SEED_RANGE[1] + 1, 1.5]) {
      rejects(
        validateEffect(withParam({ ...SEED_PARAM, default: bad })),
        "invalid-seed-default",
        `seed default ${bad}`,
      );
    }
  });

  it("a curve with fewer than two control points", () => {
    rejects(
      validateEffect(withParam({ ...CURVE_PARAM, default: [{ x: 0, y: 0 }] })),
      "curve-too-short",
      "one point is not a curve",
    );
  });

  it("a curve that is not a function of x", () => {
    rejects(
      validateEffect(
        withParam({
          ...CURVE_PARAM,
          default: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0.3 },
            { x: 0.5, y: 0.7 },
            { x: 1, y: 1 },
          ],
        }),
      ),
      "curve-not-monotonic",
      "two outputs for one input",
    );
  });

  it("a curve with points outside the unit square", () => {
    rejects(
      validateEffect(
        withParam({
          ...CURVE_PARAM,
          default: [
            { x: 0, y: 0 },
            { x: 0.5, y: 1.4 },
            { x: 1, y: 1 },
          ],
        }),
      ),
      "curve-outside-unit-square",
      "control points live in the unit square",
    );
  });

  it("a curve that does not span the whole domain", () => {
    // A transfer curve stopping short of x = 1 leaves the brightest pixels with
    // no defined output.
    rejects(
      validateEffect(
        withParam({
          ...CURVE_PARAM,
          default: [
            { x: 0.1, y: 0 },
            { x: 0.9, y: 1 },
          ],
        }),
      ),
      "curve-domain-not-covered",
      "the curve must cover x = 0 to x = 1",
    );
  });

  it("a jitter outside [0, 1]", () => {
    for (const bad of [-0.1, 1.1, Number.NaN]) {
      rejects(
        validateEffect(withParam({ ...CURVE_PARAM, surprise: { ...CURVE_PARAM.surprise, jitter: bad } })),
        "invalid-jitter",
        `jitter ${bad}`,
      );
    }
  });
});

// --- catalogue-level rules -----------------------------------------------

describe("validateRegistry", () => {
  it("rejects two effects registered under one id", () => {
    const result = validateRegistry([VALID, { ...VALID, name: "Bayer 4×4 again" }]);
    expect(result.ok).toBe(false);
    rejects(result.issues, "duplicate-effect-id", "a document references an effect by id");
  });

  it("rejects an exclusion naming an effect that is not registered", () => {
    // Incompatible combinations are excluded by the grammar rather than filtered
    // after generation, so a typo in an exclusion silently widens the grammar.
    const result = validateRegistry([withFields({ excludes: ["pixel-sort"] })]);
    expect(result.ok).toBe(false);
    rejects(result.issues, "unknown-exclusion", "the exclusion target must exist");
  });

  it("names the effect and the parameter an issue came from", () => {
    const issues = validateRegistry([
      withFields({ id: "halftone", params: [{ ...FLOAT_PARAM, default: 99 }] }),
    ]).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.effect).toBe("halftone");
    expect(issues[0]?.param).toBe("spread");
  });

  it("reports every issue rather than stopping at the first", () => {
    // 41 effects arriving at once means one run has to name everything wrong
    // with all of them, not the first thing wrong with the first of them.
    const issues = validateRegistry([
      withFields({ id: "Bad Id", surpriseWeight: 0 }),
      { ...DIFFUSION, execution: "gpu" },
    ]).issues;
    const found = issues.map((issue) => issue.code);
    expect(found).toContain("malformed-id");
    expect(found).toContain("invalid-surprise-weight");
    expect(found).toContain("diffusion-must-run-serially");
  });

  it("accepts a catalogue of several well-formed effects", () => {
    expect(validateRegistry([VALID, DIFFUSION]).ok).toBe(true);
  });
});

// --- the builder ---------------------------------------------------------

describe("EffectRegistryBuilder", () => {
  it("refuses the whole catalogue when one descriptor is invalid", () => {
    // Nothing is repaired and nothing is dropped: a catalogue that is 62 effects
    // because one was quietly discarded is worse than one that refuses to start.
    const builder = new EffectRegistryBuilder()
      .register(VALID, "effects/bayer-4.effect.ts")
      .register(DIFFUSION, "effects/floyd-steinberg.effect.ts")
      .register(withFields({ id: "broken", surpriseWeight: 0 }), "effects/broken.effect.ts");

    expect(() => builder.seal()).toThrowError(RegistryValidationError);
    try {
      builder.seal();
      expect.unreachable("an invalid catalogue must not seal");
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryValidationError);
      const issues = (error as RegistryValidationError).issues;
      expect(issues.map((issue) => issue.effect)).toContain("broken");
      // The two good effects are not silently kept — there is no registry at all.
      expect((error as RegistryValidationError).message).toContain("broken");
    }
  });

  it("produces a queryable registry from a valid catalogue", () => {
    const registry = createEffectRegistry([
      { descriptor: VALID, module: "effects/bayer-4.effect.ts" },
      { descriptor: DIFFUSION, module: "effects/floyd-steinberg.effect.ts" },
    ]);

    expect(registry.size).toBe(2);
    expect(registry.has("bayer-4")).toBe(true);
    expect(registry.get("bayer-4")).toBe(VALID);
    expect(registry.require("floyd-steinberg")).toBe(DIFFUSION);
    expect(registry.all()).toEqual([VALID, DIFFUSION]);
    expect(registry.bySlot("dither")).toEqual([VALID, DIFFUSION]);
    expect(registry.bySlot("preprocess")).toEqual([]);
    expect(registry.byExecution("gpu")).toEqual([VALID]);
    expect(registry.byExecution("wasm")).toEqual([DIFFUSION]);
    expect(registry.byFamily("error-diffusion")).toEqual([DIFFUSION]);
    expect(registry.origin("bayer-4")).toBe("effects/bayer-4.effect.ts");
  });

  it("throws rather than returning undefined for an effect a document names", () => {
    // A document naming an effect this build does not have is a real error;
    // rendering the rest of the stack would be a plausible wrong image.
    const registry = createEffectRegistry([
      { descriptor: VALID, module: "effects/bayer-4.effect.ts" },
    ]);
    expect(() => registry.require("pixel-sort")).toThrowError(UnknownEffectError);
    expect(registry.get("pixel-sort")).toBeUndefined();
  });

  it("names both modules when one id is registered twice", () => {
    const builder = new EffectRegistryBuilder()
      .register(VALID, "effects/bayer-4.effect.ts")
      .register(VALID, "effects/ordered/bayer-4.effect.ts");
    expect(() => builder.seal()).toThrowError(RegistryValidationError);
  });

  it("survives a registry with methods destructured off it", () => {
    // The UI destructures these into hooks and callbacks, so a method that lost
    // `this` on the way would be a failure mode designed in.
    const { has, require: requireEffect } = createEffectRegistry([
      { descriptor: VALID, module: "effects/bayer-4.effect.ts" },
    ]);
    expect(has("bayer-4")).toBe(true);
    expect(requireEffect("bayer-4")).toBe(VALID);
  });
});

// --- coverage ------------------------------------------------------------

/**
 * Every rejection the validator can report.
 *
 * Typed as a total record so adding a code to `RegistryIssueCode` without adding
 * a test for it fails to compile. That is the point: these are the guard rails
 * the whole catalogue is written against, and an untested one is a rail that
 * might not be there.
 */
const EVERY_FAILURE_MODE: Record<RegistryIssueCode, true> = {
  "empty-id": true,
  "malformed-id": true,
  "duplicate-effect-id": true,
  "malformed-requirement": true,
  "invalid-surprise-weight": true,
  "unknown-exclusion": true,
  "self-exclusion": true,
  "diffusion-must-run-serially": true,
  "index-map-consumer-in-preprocess": true,
  "resampler-must-run-on-gpu": true,
  "feedback-must-run-on-gpu": true,
  "feedback-must-not-resample": true,
  "source-must-run-on-gpu": true,
  "source-must-not-read-index-map": true,
  "source-must-not-resample": true,
  "missing-summary": true,
  "missing-description": true,
  "unhelpful-description": true,
  "missing-keywords": true,
  "duplicate-keyword": true,
  "unknown-concept": true,
  "duplicate-param-key": true,
  "empty-param-key": true,
  "missing-surprise": true,
  "invalid-weight": true,
  "invalid-probability": true,
  "inverted-legal-range": true,
  "inverted-surprise-range": true,
  "surprise-outside-legal": true,
  "default-outside-legal": true,
  "non-integer-bound": true,
  "log-needs-positive-range": true,
  "invalid-normal-parameters": true,
  "empty-enum": true,
  "duplicate-enum-value": true,
  "unknown-enum-default": true,
  "enum-surprise-outside-legal": true,
  "empty-surprise-set": true,
  "invalid-color-component": true,
  "chroma-out-of-gamut": true,
  "hue-out-of-range": true,
  "lightness-out-of-range": true,
  "invalid-seed-default": true,
  "curve-too-short": true,
  "curve-not-monotonic": true,
  "curve-outside-unit-square": true,
  "curve-domain-not-covered": true,
  "invalid-jitter": true,
};

// --- descriptive text (F-UI-15) -----------------------------------------
//
// These sit with the rest of the validator's rules rather than in a file of
// their own because they are the same kind of gate: the reason a missing
// surprise range is a build failure is that Surprise Me would otherwise skip
// the parameter forever, and the reason a missing description is one is that
// hover help, the picker and the guide would otherwise each invent their own —
// which is the three-copies drift F-UI-15 exists to prevent.

describe("validateEffect rejects descriptive text that", () => {
  it("is absent on the effect", () => {
    for (const field of ["summary", "description", "keywords"] as const) {
      const missing = { ...VALID };
      delete (missing as Record<string, unknown>)[field];
      rejects(
        validateEffect(asDescriptor(missing)),
        field === "summary"
          ? "missing-summary"
          : field === "description"
            ? "missing-description"
            : "missing-keywords",
        `${field} absent`,
      );
    }
  });

  it("is blank or the wrong type on the effect", () => {
    rejects(
      validateEffect(withFields({ summary: "   " })),
      "missing-summary",
      "whitespace is not a summary",
    );
    rejects(
      validateEffect(withFields({ description: 42 })),
      "missing-description",
      "a number is not a description",
    );
  });

  it("only restates the name it is supposed to describe", () => {
    // The laziest way a description arrives undocumented, and the one that
    // looks like it was written.
    rejects(
      // Punctuation and case are folded first, so "bayer 4×4!" is caught too.
      validateEffect(withFields({ summary: "  bayer 4×4!  " })),
      "unhelpful-description",
      "summary echoing the name",
    );
    rejects(
      validateEffect(withFields({ description: VALID.summary })),
      "unhelpful-description",
      "description echoing the summary",
    );
  });

  it("is absent on a parameter", () => {
    const { description: _dropped, ...bare } = FLOAT_PARAM;
    rejects(
      validateEffect(withParam(bare)),
      "missing-description",
      "parameter with no description",
    );
    const issues = validateEffect(withParam(bare));
    expect(issues.find((i) => i.code === "missing-description")?.param).toBe("spread");
  });

  it("only restates the parameter's own label", () => {
    rejects(
      validateEffect(withParam({ ...FLOAT_PARAM, description: "Spread" })),
      "unhelpful-description",
      "description echoing the label",
    );
  });
});

describe("validateEffect rejects keywords that", () => {
  it("are empty, blank or not a list", () => {
    for (const bad of [[], "glow", [""], ["  "], [7]]) {
      rejects(
        validateEffect(withFields({ keywords: bad })),
        "missing-keywords",
        `keywords ${JSON.stringify(bad)}`,
      );
    }
  });

  it("repeat, once punctuation and case are folded away", () => {
    // "Blue Noise" and "blue-noise" are one keyword typed twice, and a
    // duplicate is a weight applied twice in ranking rather than a synonym.
    rejects(
      validateEffect(withFields({ keywords: ["Blue Noise", "blue-noise"] })),
      "duplicate-keyword",
      "same keyword under two spellings",
    );
  });
});

describe("validateEffect rejects a concept", () => {
  it("that no entry in EFFECT_CONCEPTS explains", () => {
    rejects(
      validateEffect(withFields({ concept: "vibes" })),
      "unknown-concept",
      "a concept with nothing to explain it",
    );
  });

  it("but accepts every concept the table does declare", () => {
    for (const concept of Object.keys(EFFECT_CONCEPTS)) {
      expect(validateEffect(withFields({ concept })), concept).toEqual([]);
    }
  });
});

describe("EFFECT_CONCEPTS", () => {
  it("keys every entry with its own id, so a lookup cannot return a mismatch", () => {
    for (const [id, concept] of Object.entries(EFFECT_CONCEPTS)) {
      expect(concept.id).toBe(id);
    }
  });

  it("gives every concept a title, a summary and a description of its own", () => {
    for (const concept of Object.values(EFFECT_CONCEPTS)) {
      expect(concept.title.trim().length, concept.id).toBeGreaterThan(0);
      expect(concept.summary.trim().length, concept.id).toBeGreaterThan(0);
      expect(concept.description.trim().length, concept.id).toBeGreaterThan(0);
      expect(concept.description, concept.id).not.toBe(concept.summary);
    }
  });
});

describe("failure-mode coverage", () => {
  it("rejects a bool probability outside [0, 1]", () => {
    // The bool analogue of a narrowed range: a serpentine toggle wants about
    // 0.9, an exotic mode wants 0.1.
    for (const bad of [-0.1, 1.1, "often"]) {
      rejects(
        validateEffect(withParam({ ...BOOL_PARAM, surprise: { ...BOOL_PARAM.surprise, trueProbability: bad } })),
        "invalid-probability",
        `trueProbability ${String(bad)}`,
      );
    }
  });

  it("has a test for every failure mode the validator can report", () => {
    const untested = Object.keys(EVERY_FAILURE_MODE).filter(
      (code) => !observed.has(code as RegistryIssueCode),
    );
    expect(untested).toEqual([]);
  });
});
