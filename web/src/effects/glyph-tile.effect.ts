/**
 * F-PT-08 — Glyph / tile dither.
 *
 * The image is divided into cells; each cell's mean colour picks a pair of
 * palette entries and a position between them, and the glyph whose ink coverage
 * is closest to that position is stamped into the cell. Choosing on *coverage*
 * is what makes this a dither rather than an ASCII-art filter — the cell
 * averages back to its own tone — and it is why every glyph's coverage is
 * counted from its bitmap here instead of being asserted alongside it.
 *
 * ## The built-in sets
 *
 * **`block`** is the Unicode block-element density ramp: space, light shade,
 * medium shade, dark shade, full block, at exactly 0, 1/4, 1/2, 3/4 and 1
 * coverage. Those five patterns have canonical definitions — the shades are the
 * 25%, 50% and 75% dot screens every terminal font draws them as — so the
 * bitmaps below are the definitions rather than a rendering of them. It is the
 * only one of the two sets that can reach solid ink.
 *
 * **`ascii`** is the classic ten-step ramp ` .:-=+*#%@`. The bitmaps are
 * authored here, as 8x8 art literals that can be read at a glance, and they are
 * **not** a published font: no bitmap font is bundled, and rasterizing a system
 * font with Canvas2D was rejected because the same document would then render
 * differently on macOS and Windows, which is not the rounding-level platform
 * difference docs/ARCHITECTURE.md accepts. What is exact is the mapping — the
 * ramp is sorted by measured coverage, so the tonal behaviour does not depend
 * on the letterforms being anyone's idea of a good `@`.
 *
 * No ASCII glyph fills its cell — the densest here covers 36/64 — so the ASCII
 * set cannot reach solid ink. That is a property of writing with letters, not a
 * defect, and it is why the block set is also built in.
 *
 * ## User-uploaded sheets
 *
 * F-PT-08 also asks for user-uploaded tile sheets. There is no upload path in
 * the repository yet and none is invented here; see the report accompanying
 * this file, and `buildGlyphTable` for the shape a decoded sheet would have to
 * take.
 */

import { staticGpuEffect, defineEffect, type ParamDescriptor } from "../types/registry";
import type { ParameterValue } from "../types/document";
import type {
  ComputePass,
  GpuEffect,
  PassBinding,
  UniformLayout,
} from "../types/gpu";
import { logger } from "../lib/log";

import wgsl from "../shaders/glyph-tile.wgsl?raw";

const log = logger("gpu");

export const GLYPH_TILE_ID = "glyph-tile";

/** Canonical binding numbers, restated from `shaders/CONVENTIONS.md`. */
const BINDING = {
  inputColor: 0,
  outputColor: 1,
  outputIndex: 3,
  palette: 4,
  uniforms: 5,
  glyphs: 6,
} as const;

/** Parameter keys, in one place so the shader struct and the packer agree. */
export const GLYPH_TILE_PARAM = {
  glyphSet: "glyphSet",
  cellSize: "cellSize",
  invert: "invert",
  offsetX: "offsetX",
  offsetY: "offsetY",
  contrast: "contrast",
  thresholdOffset: "thresholdOffset",
} as const;

/** Glyph raster edge, in texels. Restated as `glyph_size` in the table header. */
const GLYPH_SIZE = 8;

/** Words of table header before the per-set directory. Restated in the WGSL. */
const HEADER_WORDS = 4;

const MIN_CELL = 4;
const MAX_CELL = 16;

/**
 * The ASCII ramp, drawn rather than described.
 *
 * Eight rows of eight columns; `#` is ink and anything else is paper. Written
 * out so a glyph can be judged by looking at it, which is the only useful
 * review for a letterform.
 */
const ASCII_GLYPHS: readonly string[] = [
  // space
  [
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
  ].join("\n"),
  // .
  [
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    "..##....",
    "..##....",
  ].join("\n"),
  // :
  [
    "........",
    "........",
    "..##....",
    "..##....",
    "........",
    "..##....",
    "..##....",
    "........",
  ].join("\n"),
  // -
  [
    "........",
    "........",
    "........",
    ".#####..",
    ".#####..",
    "........",
    "........",
    "........",
  ].join("\n"),
  // =
  [
    "........",
    "........",
    "..####..",
    "..####..",
    "........",
    "..####..",
    "..####..",
    "........",
  ].join("\n"),
  // +
  [
    "........",
    "...##...",
    "...##...",
    ".######.",
    ".######.",
    "...##...",
    "...##...",
    "........",
  ].join("\n"),
  // *
  [
    "........",
    "..#..#..",
    "..####..",
    ".######.",
    ".######.",
    "..####..",
    "..#..#..",
    "........",
  ].join("\n"),
  // %
  [
    "##....#.",
    "##...#..",
    "....#...",
    "...#....",
    "..#.....",
    ".#...##.",
    "#....##.",
    "........",
  ].join("\n"),
  // #
  [
    ".##..##.",
    ".##..##.",
    "########",
    ".##..##.",
    "########",
    ".##..##.",
    ".##..##.",
    "........",
  ].join("\n"),
  // @
  [
    ".######.",
    "#......#",
    "#.####.#",
    "#.#..#.#",
    "#.####.#",
    "#.......",
    "#......#",
    ".######.",
  ].join("\n"),
];

/**
 * The Unicode block-element ramp.
 *
 * The three shades are the canonical 25%, 50% and 75% dot screens: every fourth
 * pixel, a checkerboard, and everything but every fourth pixel. Drawn at 8x8
 * they come out at exactly 16, 32 and 48 of 64.
 */
const BLOCK_GLYPHS: readonly string[] = [
  // space
  [
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
    "........",
  ].join("\n"),
  // light shade
  [
    "#.#.#.#.",
    "........",
    "#.#.#.#.",
    "........",
    "#.#.#.#.",
    "........",
    "#.#.#.#.",
    "........",
  ].join("\n"),
  // medium shade
  [
    "#.#.#.#.",
    ".#.#.#.#",
    "#.#.#.#.",
    ".#.#.#.#",
    "#.#.#.#.",
    ".#.#.#.#",
    "#.#.#.#.",
    ".#.#.#.#",
  ].join("\n"),
  // dark shade
  [
    "########",
    "#.#.#.#.",
    "########",
    "#.#.#.#.",
    "########",
    "#.#.#.#.",
    "########",
    "#.#.#.#.",
  ].join("\n"),
  // full block
  [
    "########",
    "########",
    "########",
    "########",
    "########",
    "########",
    "########",
    "########",
  ].join("\n"),
];

/**
 * Glyph sets, in the order their ordinal reaches the shader.
 *
 * The uniform packer turns an enum value into its position in the descriptor's
 * `values` list, and the shader uses that position to index the table's set
 * blocks. Both are derived from this one array so the two orders cannot drift —
 * inserting a set in the middle would otherwise silently renumber every
 * document already saved.
 */
const GLYPH_SETS = [
  { value: "ascii", label: "ASCII  .:-=+*#%@", art: ASCII_GLYPHS },
  { value: "block", label: "Blocks  ░▒▓█", art: BLOCK_GLYPHS },
] as const;

/**
 * The uniform block, byte for byte as `struct Params` declares it in
 * `../shaders/glyph-tile.wgsl`.
 *
 * Every slot is a 4-byte scalar, so no field needs padding in front of it and
 * the only padding is the tail that rounds 36 up to 48.
 */
export const GLYPH_TILE_UNIFORMS: UniformLayout = {
  sizeBytes: 48,
  fields: [
    { source: { kind: "builtin", name: "width" }, type: "u32", offset: 0 },
    { source: { kind: "builtin", name: "height" }, type: "u32", offset: 4 },
    { source: { kind: "param", key: GLYPH_TILE_PARAM.glyphSet }, type: "u32", offset: 8 },
    { source: { kind: "param", key: GLYPH_TILE_PARAM.cellSize }, type: "u32", offset: 12 },
    { source: { kind: "param", key: GLYPH_TILE_PARAM.invert }, type: "u32", offset: 16 },
    { source: { kind: "param", key: GLYPH_TILE_PARAM.offsetX }, type: "f32", offset: 20 },
    { source: { kind: "param", key: GLYPH_TILE_PARAM.offsetY }, type: "f32", offset: 24 },
    { source: { kind: "param", key: GLYPH_TILE_PARAM.contrast }, type: "f32", offset: 28 },
    {
      source: { kind: "param", key: GLYPH_TILE_PARAM.thresholdOffset },
      type: "f32",
      offset: 32,
    },
  ],
};

const PARAMS: readonly ParamDescriptor[] = [
  {
    key: GLYPH_TILE_PARAM.glyphSet,
    label: "Glyph set",
    type: "enum",
    hint: "Blocks reach solid ink; ASCII tops out around half coverage, which is what makes it read as type.",
    animatable: false,
    values: GLYPH_SETS.map((set) => ({ value: set.value, label: set.label })),
    default: "ascii",
    surprise: {
      values: [
        { value: "ascii", weight: 2 },
        { value: "block", weight: 3 },
      ],
      weight: 1,
    },
  },
  {
    key: GLYPH_TILE_PARAM.cellSize,
    label: "Cell size",
    type: "int",
    hint: "Cell edge in pixels. The glyph raster is 8×8, so below about 6 the letterforms stop being readable.",
    // Not animatable: the value reaches the shader as a u32 and the uniform
    // packer refuses a non-integer for one, so a modulator bound here would
    // fail the pack rather than round. It also re-tiles the whole image, so
    // interpolating it would pop rather than move.
    animatable: false,
    legal: [MIN_CELL, MAX_CELL],
    default: 8,
    // 8 is the raster's own size and the point where the glyphs are sharpest;
    // the range around it stays legible.
    surprise: { range: [6, 12], distribution: { kind: "uniform" }, weight: 1 },
  },
  {
    key: GLYPH_TILE_PARAM.invert,
    label: "Light on dark",
    type: "bool",
    hint: "Draw the glyph in the lighter of the two candidate colours — the terminal look — instead of the darker.",
    animatable: false,
    default: false,
    surprise: {
      // Both readings are real and neither is a default the eye expects, so the
      // draw is close to even, weighted slightly towards ink on paper.
      trueProbability: 0.45,
      weight: 0.7,
    },
  },
  {
    key: GLYPH_TILE_PARAM.offsetX,
    label: "Offset X",
    type: "float",
    // The cell grid is locked to whole pixels: a fractional origin would
    // resample the glyph raster and blur the letterforms, which is the one
    // thing this effect must not do.
    hint: "Shifts the cell grid horizontally, in whole pixels.",
    animatable: true,
    legal: [-1024, 1024],
    default: 0,
    surprise: { range: [-8, 8], distribution: { kind: "uniform" }, weight: 0.4 },
  },
  {
    key: GLYPH_TILE_PARAM.offsetY,
    label: "Offset Y",
    type: "float",
    hint: "Shifts the cell grid vertically, in whole pixels.",
    animatable: true,
    legal: [-1024, 1024],
    default: 0,
    surprise: { range: [-8, 8], distribution: { kind: "uniform" }, weight: 0.4 },
  },
  {
    key: GLYPH_TILE_PARAM.contrast,
    label: "Contrast",
    type: "float",
    hint: "Steepens the tone-to-glyph mapping around its midpoint, pushing the result towards fewer, harder glyphs.",
    animatable: true,
    legal: [0.05, 4],
    default: 1,
    surprise: { range: [0.7, 2], distribution: { kind: "log" }, weight: 0.8 },
  },
  {
    key: GLYPH_TILE_PARAM.thresholdOffset,
    label: "Density offset",
    type: "float",
    hint: "Slides the whole image up or down the glyph ramp. ±0.5 forces the sparsest or densest glyph.",
    animatable: true,
    legal: [-0.5, 0.5],
    default: 0,
    surprise: { range: [-0.15, 0.15], distribution: { kind: "uniform" }, weight: 0.6 },
  },
];

/** Parameter descriptors keyed for `packUniforms`. */
export const GLYPH_TILE_PARAM_TYPES: ReadonlyMap<string, ParamDescriptor> = new Map(
  PARAMS.map((param) => [param.key, param]),
);

/** Defaults, for a node created without an explicit parameter set. */
export function glyphTileDefaults(): Record<string, ParameterValue> {
  const defaults: Record<string, ParameterValue> = {};
  for (const param of PARAMS) {
    switch (param.type) {
      case "float":
      case "int":
      case "enum":
      case "bool":
        defaults[param.key] = param.default;
        break;
      default:
        break;
    }
  }
  return defaults;
}

// --- glyph sheets -------------------------------------------------------

export class GlyphSheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlyphSheetError";
  }
}

/** One glyph: `size` row bitmasks and the count of ink pixels across them. */
export interface Glyph {
  readonly rows: readonly number[];
  readonly coverage: number;
}

/**
 * Parse one art literal into row bitmasks.
 *
 * Bit `x` of a row is column `x`, counting from the left — the same convention
 * the shader reads with `(row >> gx) & 1`.
 */
export function parseGlyph(art: string, size: number): Glyph {
  const lines = art.split("\n");
  if (lines.length !== size) {
    throw new GlyphSheetError(`glyph has ${lines.length} rows, expected ${size}`);
  }
  const rows: number[] = [];
  let coverage = 0;
  for (const line of lines) {
    if (line.length !== size) {
      throw new GlyphSheetError(`glyph row "${line}" is ${line.length} columns, expected ${size}`);
    }
    let mask = 0;
    for (let x = 0; x < size; x += 1) {
      if (line[x] === "#") {
        mask |= 1 << x;
        coverage += 1;
      }
    }
    rows.push(mask);
  }
  return { rows, coverage };
}

/**
 * Pack the built-in sets as the shader reads them.
 *
 * Layout, all u32: a four-word header (`setCount`, `glyphSize`, `stride`,
 * reserved), then two words per set (glyph count, word offset), then each set's
 * glyphs as `[coverage, row 0, ... row n]`, ordered by increasing coverage.
 *
 * **This is also the shape a user-uploaded sheet has to arrive in.** An upload
 * path would decode an image, cut it into `glyphSize` tiles, threshold each to
 * ink/paper, count coverage, sort, and append another set block — none of which
 * exists yet, and none of which is stubbed here.
 */
export function buildGlyphTable(): Uint32Array {
  const sets = GLYPH_SETS.map((set) => {
    const glyphs = set.art.map((art) => parseGlyph(art, GLYPH_SIZE));
    // Sorted by coverage because the shader picks the glyph nearest a target
    // coverage; an unsorted set would still work, but a ramp that is monotone
    // is the thing an author can reason about.
    const sorted = [...glyphs].sort((a, b) => a.coverage - b.coverage);
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (previous === undefined || current === undefined) {
        throw new GlyphSheetError(`set "${set.value}" lost a glyph while sorting`);
      }
      if (previous.coverage === current.coverage) {
        // Two glyphs of equal coverage are one wasted step of the ramp: the
        // second can never be the nearest match, so it would never be drawn.
        throw new GlyphSheetError(
          `set "${set.value}" has two glyphs at coverage ${current.coverage}; one of them can never be selected`,
        );
      }
    }
    return { value: set.value, glyphs: sorted };
  });

  const stride = GLYPH_SIZE + 1;
  const directory = sets.length * 2;
  const dataWords = sets.reduce((total, set) => total + set.glyphs.length * stride, 0);
  const words = new Uint32Array(HEADER_WORDS + directory + dataWords);

  words[0] = sets.length;
  words[1] = GLYPH_SIZE;
  words[2] = stride;
  words[3] = 0;

  let cursor = HEADER_WORDS + directory;
  sets.forEach((set, index) => {
    words[HEADER_WORDS + index * 2] = set.glyphs.length;
    words[HEADER_WORDS + index * 2 + 1] = cursor;
    for (const glyph of set.glyphs) {
      words[cursor] = glyph.coverage;
      for (let row = 0; row < GLYPH_SIZE; row += 1) {
        words[cursor + 1 + row] = glyph.rows[row] ?? 0;
      }
      cursor += stride;
    }
  });

  log.debug("glyph sheets built", {
    sets: sets.length,
    glyphs: sets.reduce((total, set) => total + set.glyphs.length, 0),
    bytes: words.byteLength,
  });
  return words;
}

/** Built once and kept: the table is constant. */
let glyphTable: Uint32Array | null = null;

function glyphTableBytes(): Uint8Array {
  if (glyphTable === null) glyphTable = buildGlyphTable();
  // A view, not a copy. Uint32Array already uses host byte order and WebGPU
  // buffer contents are host byte order, so the shader's array<u32> reads
  // exactly these words.
  return new Uint8Array(glyphTable.buffer, glyphTable.byteOffset, glyphTable.byteLength);
}

/**
 * The compute pass.
 *
 * One dispatch, but `neighbourhood` rather than `pointwise`: every invocation
 * reads its whole cell to compute the mean the glyph is chosen from, so input
 * and output must not alias.
 */
export function glyphTileGpuEffect(): GpuEffect {
  const bindings: readonly PassBinding[] = [
    { role: "input-color", binding: BINDING.inputColor },
    { role: "output-color", binding: BINDING.outputColor },
    { role: "output-index", binding: BINDING.outputIndex },
    { role: "palette", binding: BINDING.palette },
    { role: "uniforms", binding: BINDING.uniforms },
    { role: "table", binding: BINDING.glyphs, data: glyphTableBytes() },
  ];

  const pass: ComputePass = {
    id: `${GLYPH_TILE_ID}/stamp`,
    label: "Glyph tile stamp",
    wgsl,
    entryPoint: "main",
    // 64 invocations, well under the 256 guaranteed everywhere.
    workgroupSize: [8, 8, 1],
    dispatch: { kind: "per-pixel" },
    access: "neighbourhood",
    bindings,
    uniforms: GLYPH_TILE_UNIFORMS,
  };

  return { effect: GLYPH_TILE_ID, passes: [pass] };
}

export default defineEffect({
  id: GLYPH_TILE_ID,
  name: "Glyph tile",
  requirement: "F-PT-08",
  slot: "dither",
  family: "pattern",
  execution: "gpu",
  params: PARAMS,
  // The most transformative effect in the family: it replaces the image with
  // type. Strong enough that it should be a surprise rather than a regular
  // (F-SM-03).
  surpriseWeight: 0.5,
  // Quantizing is the point: the index map it emits is what makes outline,
  // dilate/erode, hue-targeted recolour and the tracer lossless downstream.
  producesIndexMap: true,
  requiresIndexMap: false,
});

/** Resolves this effect's id to its passes; see `registry/gpu-effects.ts`. */
export const gpu = staticGpuEffect("glyph-tile", () => glyphTileGpuEffect());
