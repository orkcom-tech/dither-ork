/**
 * A `.dork` document survives being written and read back.
 *
 * The gap this closes: the registry has declared `color` and `curve` parameter
 * kinds since it was written, and `ParameterValue` in `web/src/types/document.ts`
 * was `number | boolean | string`. A document containing either could be saved
 * and could not be loaded — the value came back as the descriptor default with a
 * coercion warning, which is a document that silently stopped being the one that
 * was saved. `registry/params.ts` named the gap and refused to invent a packing,
 * because how a colour is serialised is a schema decision.
 *
 * The medium here is `JSON.stringify`/`JSON.parse` because that is what `.dork`
 * is (F-DO-01). The parsed values then go through `validateParams` and
 * `coerceParams` against the same descriptor, which is the assertion that
 * matters: **zero adjustments**. A round trip that merely deep-equals proves
 * JSON works; one that also coerces to nothing proves the schema and the
 * registry agree about what the value is.
 *
 * That this file compiles is itself half the test. A `SrgbTriplet` and a
 * `readonly CurvePoint[]` are written into `StackNode.params` below with no
 * cast, which the old schema would have refused.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLevel } from "../lib/log";
import {
  DOCUMENT_SCHEMA_VERSION,
  type CurvePoint,
  type DitherDocument,
  type ParameterValue,
  type SrgbTriplet,
} from "../types/document";
import type {
  ColorParam,
  CurveParam,
  EffectDescriptor,
  EnumParam,
  FloatParam,
} from "../types/registry";
import { coerceParams, validateParams } from "./params";

setLevel("error");

// A coercion warns. Nothing here should produce one, and the assertions say so;
// silencing the console keeps a genuine failure readable rather than buried.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const TINT: ColorParam = {
  key: "tint",
  label: "Tint",
  description:
    "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
  type: "color",
  animatable: false,
  default: [255, 64, 32],
  surprise: {
    lightness: [0.4, 0.8],
    chroma: [0.05, 0.2],
    hue: [20, 60],
    weight: 1,
  },
};

const TRANSFER: CurveParam = {
  key: "transfer",
  label: "Transfer",
  description:
    "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
  type: "curve",
  animatable: false,
  default: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  surprise: {
    archetypes: [{ value: "s-curve", weight: 1 }],
    jitter: 0.1,
    weight: 1,
  },
};

const AMOUNT: FloatParam = {
  key: "amount",
  label: "Amount",
  description:
    "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
  type: "float",
  animatable: true,
  legal: [0, 1],
  default: 1,
  surprise: { range: [0.2, 0.9], distribution: { kind: "uniform" }, weight: 1 },
};

const MODE: EnumParam = {
  key: "mode",
  label: "Mode",
  description:
    "Fixture control. It has a kind and a range so the test can exercise them; nothing renders it.",
  type: "enum",
  animatable: false,
  values: [
    { value: "rgb", label: "Per channel" },
    { value: "lightness", label: "Lightness only" },
  ],
  default: "rgb",
  surprise: { values: [{ value: "rgb", weight: 1 }], weight: 1 },
};

/**
 * An effect declaring every kind that is hard to serialise.
 *
 * Constructed rather than taken from the catalogue because no shipped effect
 * declares a `color` or a `curve` yet — gradient map (F-SP-09) wanted three
 * colours and had to spell them as nine floats, and its own module comment names
 * this schema as the first of two things that has to change before it can stop.
 */
const EFFECT: EffectDescriptor = {
  id: "tinted-curve",
  name: "Tinted curve",
  summary: "Fixture effect, constructed by a test rather than shipped in the catalogue.",
  description:
    "Not one of the sixty-seven. It exists so this test can exercise one rule in isolation, which a real descriptor cannot do without dragging its whole parameter set along.",
  keywords: ["fixture", "test"],
  requirement: "F-PP-05",
  slot: "preprocess",
  family: "preprocess",
  execution: "gpu",
  params: [AMOUNT, MODE, TINT, TRANSFER],
  surpriseWeight: 1,
  producesIndexMap: false,
  requiresIndexMap: false,
};

const TINT_VALUE: SrgbTriplet = [17, 200, 96];
const CURVE_VALUE: readonly CurvePoint[] = [
  { x: 0, y: 0.05 },
  { x: 0.5, y: 0.62 },
  { x: 1, y: 0.95 },
];

// Written with no cast. The old `ParameterValue` refused both of the last two.
const PARAMS: Readonly<Record<string, ParameterValue>> = {
  amount: 0.75,
  mode: "lightness",
  tint: TINT_VALUE,
  transfer: CURVE_VALUE,
};

const DOCUMENT: DitherDocument = {
  schema: DOCUMENT_SCHEMA_VERSION,
  source: { name: "photo.png", width: 1600, height: 1200 },
  palette: {
    id: "gameboy-dmg",
    name: "Game Boy DMG",
    colors: [8, 24, 32, 52, 104, 86, 136, 192, 112, 224, 248, 208],
    metric: "oklab",
  },
  clock: { frames: 48, fps: 24 },
  stack: [
    {
      id: "n1",
      effect: EFFECT.id,
      enabled: true,
      opacity: 1,
      blend: "normal",
      params: PARAMS,
      seed: 991,
    },
  ],
  bindings: [
    {
      nodeId: "n1",
      param: "amount",
      shape: "sine",
      amount: 0.25,
      cyclesPerLoop: 2,
      phase: 0,
      bipolar: true,
    },
  ],
  surpriseSeed: "7f3a1c92b04e5d68",
};

function save(document: DitherDocument): string {
  return JSON.stringify(document);
}

function load(text: string): DitherDocument {
  // `.dork` arrives as untyped JSON; the loader's job is to check it against the
  // registry, which is exactly what the assertions below do.
  return JSON.parse(text) as DitherDocument;
}

describe("a document carrying a colour and a curve", () => {
  it("comes back identical", () => {
    expect(load(save(DOCUMENT))).toEqual(DOCUMENT);
  });

  it("brings the colour back as three numbers, not a string", () => {
    const reloaded = load(save(DOCUMENT));
    expect(reloaded.stack[0]?.params["tint"]).toEqual([17, 200, 96]);
  });

  it("brings the curve back as its control points", () => {
    const reloaded = load(save(DOCUMENT));
    expect(reloaded.stack[0]?.params["transfer"]).toEqual(CURVE_VALUE);
  });

  it("validates against the descriptor after the trip", () => {
    const reloaded = load(save(DOCUMENT));
    const params = reloaded.stack[0]?.params ?? {};
    const validation = validateParams(EFFECT, params);
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it("needs no coercion after the trip", () => {
    const reloaded = load(save(DOCUMENT));
    const params = reloaded.stack[0]?.params ?? {};
    const coercion = coerceParams(EFFECT, params);
    // The assertion the whole file is for. Any adjustment here is the document
    // having quietly become a different document.
    expect(coercion.adjustments).toEqual([]);
    expect(coercion.values).toEqual(PARAMS);
  });

  it("survives two trips unchanged", () => {
    // A schema that loses precision loses it once and then looks stable, so one
    // trip is not enough to see it.
    const once = save(DOCUMENT);
    expect(save(load(once))).toBe(once);
  });
});

describe("the parameter kinds the registry declares", () => {
  it("are all expressible in the document", () => {
    // One value per kind, straight into a `params` record. This is a
    // compile-time assertion with a runtime shape: if a kind cannot be written
    // here, `.dork` cannot carry an effect that declares it.
    const everyKind: Readonly<Record<string, ParameterValue>> = {
      float: 0.5,
      int: 3,
      bool: true,
      enum: "round",
      seed: 4294967295,
      color: [0, 128, 255] as SrgbTriplet,
      curve: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ] as readonly CurvePoint[],
    };
    expect(JSON.parse(JSON.stringify(everyKind)) as unknown).toEqual(everyKind);
  });
});
