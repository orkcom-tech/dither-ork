/**
 * Scaffold entry point.
 *
 * This page is the proof that the engine works, not a decoration on top of it.
 * It runs, in order: the startup capability check (F-UI-12), node registry
 * discovery and validation, the WASM core, and then one section per thing the
 * repository actually implements — every registered diffusion kernel, a
 * selection of the hardware palette library, all three palette extractors, and
 * the ordered dithers through the real WebGPU compute path.
 *
 * Two rules it holds itself to.
 *
 * **Nothing is faked.** Every picture below is produced by the code that would
 * produce it in the app. The ordered dithers really compile WGSL, really
 * dispatch, and really cross the readback boundary; the threshold ranks really
 * come out of the Rust core. There is no CPU stand-in for the GPU path, because
 * a stand-in would make this page prove the opposite of what it claims.
 *
 * **Nothing is hidden.** A section that cannot run says so, in place, with the
 * error that stopped it. A blank gap would read as "not interesting"; a stated
 * failure reads as what it is.
 */

import { checkCapabilities, type Capability } from "./lib/capabilities";
import { correlationId, logger } from "./lib/log";
import {
  loadEffectRegistry,
  RegistryValidationError,
  type EffectRegistry,
} from "./registry";
import {
  createOrderedDither,
  GpuLayer,
  linearToSrgb,
  ORDERED_DITHERS,
  ORDERED_DITHER_UNIFORMS,
  ORDERED_PARAM_TYPES,
  orderedDitherDefaults,
  orderedDitherSpec,
  packUniforms,
  planExecution,
  readColorSurface,
  srgbToLinear,
  SurfaceChain,
  thresholdMatrix,
  uploadPalette,
  writeColorSurface,
  type ScheduleUnit,
} from "./gpu";
import type { Palette, ParameterValue } from "./types/document";
import type { GpuEffect, ScheduledPass } from "./types/gpu";
import type { CpuColorSurface } from "./types/graph";
import type { EffectDescriptor, EffectFamily, ParamDescriptor } from "./types/registry";

// --- the parallel catalogue ---------------------------------------------
//
// Thirty-nine imports, named one by one, because there is no way to ask for
// them collectively: `registry/discovery.ts` globs the *descriptors*, and a
// descriptor says an effect runs on the GPU without saying where its passes
// are. Nothing in the repository resolves an effect id to its `GpuEffect` — the
// renderer does not need it yet because there is no document loader, and this
// page is the first caller that wants all of them at once. Listing them here
// keeps that gap visible and in one place rather than inventing a convention
// the effect files were not written against. See docs/API.md section 4.

import { BIT_CRUSH_GPU } from "./effects/bit-crush.effect";
import { BLOCK_SHUFFLE_GPU } from "./effects/block-shuffle.effect";
import { DILATE_ERODE_GPU } from "./effects/dilate-erode.effect";
import { GRADIENT_MAP_GPU } from "./effects/gradient-map.effect";
import { GRAIN_GPU } from "./effects/grain.effect";
import { INVERT_GPU } from "./effects/invert.effect";
import { LENS_DISTORTION_GPU } from "./effects/lens-distortion.effect";
import { LIGHT_LEAK_GPU } from "./effects/light-leak.effect";
import { OUTLINE_GPU } from "./effects/outline.effect";
import { POSTERIZE_GPU } from "./effects/posterize.effect";
import { SLICE_REPEAT_GPU } from "./effects/slice-repeat.effect";
import { THRESHOLD_GPU } from "./effects/threshold.effect";
import { VIGNETTE_GPU } from "./effects/vignette.effect";
import { WAVE_WARP_GPU } from "./effects/wave-warp.effect";
import { blurGpuEffect } from "./effects/blur.effect";
import { channelSwapEffect } from "./effects/channel-swap.effect";
import { chromaticAberrationGpuEffect } from "./effects/chromatic-aberration.effect";
import { clusteredDotGpuEffect } from "./effects/clustered-dot.effect";
import { cmykHalftoneEffect } from "./effects/cmyk-halftone.effect";
import { columnDisplacementGpuEffect } from "./effects/column-displacement.effect";
import { concentricRingsGpuEffect } from "./effects/concentric-rings.effect";
import { crossHatchEffect } from "./effects/cross-hatch.effect";
import { crtMaskEffect } from "./effects/crt-mask.effect";
import { datamoshSmearEffect } from "./effects/datamosh-smear.effect";
import { edgeDetectGpuEffect } from "./effects/edge-detect.effect";
import { embossGpuEffect } from "./effects/emboss.effect";
import { epsilonGlowGpuEffect } from "./effects/epsilon-glow.effect";
import { ghostEchoEffect } from "./effects/ghost-echo.effect";
import { glyphTileGpuEffect } from "./effects/glyph-tile.effect";
import { halftoneEffect } from "./effects/halftone.effect";
import { interlaceTearEffect } from "./effects/interlace-tear.effect";
import { lineScreenEffect } from "./effects/line-screen.effect";
import { noiseBurstEffect } from "./effects/noise-burst.effect";
import { pixelSortGpuEffect } from "./effects/pixel-sort.effect";
import { rgbSplitGpuEffect } from "./effects/rgb-split.effect";
import { rowDisplacementGpuEffect } from "./effects/row-displacement.effect";
import { scanlinesEffect } from "./effects/scanlines.effect";
import { sharpenGpuEffect } from "./effects/sharpen.effect";
import { spiralGpuEffect } from "./effects/spiral.effect";

const log = logger("app", correlationId());

/** Working size of the demo source. 160x124 upscaled 2x lands on 320x248. */
const SOURCE_WIDTH = 160;
const SOURCE_HEIGHT = 124;
const SCALE = 2;

/**
 * Height of the detail strip in the generated source.
 *
 * The strip is not decoration. Without it the source is smooth everywhere, and
 * a smooth source cannot tell a working blur from a pass-through: both come back
 * within a fraction of a level of the input, and so do sharpen, edge detect,
 * emboss and chromatic aberration, because there is no high-frequency content
 * for any of them to act on. Twenty-four rows of combs, checkerboards and one
 * hard step give every neighbourhood effect something to prove itself against.
 */
const DETAIL_ROWS = 24;

/**
 * Seed for the blue-noise tile.
 *
 * Fixed and explicit. `Math.random()` in a render path is a defect
 * (F-AN-05), and that applies to a demo page as much as to an export: a tile
 * that differed between reloads would make every visual comparison on this page
 * meaningless.
 */
const BLUE_NOISE_SEED = 0x5eed_0d17n;

/** Palette size the extraction section asks for. */
const EXTRACTION_K = 8;

/**
 * Hardware palettes shown, by id. A selection rather than all fifteen: these
 * six are the ones whose differences are visible at a glance — two-colour,
 * four-colour green, four-colour grey, two sixteen-colour sets built on
 * completely different principles, and an eight-colour digital-RGB set.
 */
const SHOWN_PALETTES = [
  "mono",
  "gameboy-dmg",
  "cga-16",
  "c64",
  "pico-8",
  "teletext",
] as const;

// --- DOM ----------------------------------------------------------------

function element<E extends HTMLElement>(selector: string): E | null {
  const found = document.querySelector<E>(selector);
  if (found === null) {
    // The page and this module are edited together, so a missing node is a
    // mistake rather than a condition to handle. It does not stop the run —
    // everything still logs — but it never passes unremarked.
    log.error("page is missing an element", { selector });
  }
  return found;
}

function setStatus(selector: string, html: string): void {
  const target = element(selector);
  if (target !== null) target.innerHTML = html;
}

function okMark(text: string): string {
  return `<span class="ok">${text}</span>`;
}

function failMark(text: string): string {
  return `<span class="fail">${text}</span>`;
}

/** Escapes text that goes into `innerHTML`. Effect ids and error strings both. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderCapabilities(caps: readonly Capability[]): void {
  const body = element<HTMLTableSectionElement>("#capabilities tbody");
  if (body === null) return;
  body.innerHTML = "";
  for (const c of caps) {
    const row = document.createElement("tr");
    const cls = c.state === "ok" ? "ok" : c.fatal ? "fail" : "warn";
    const mark = c.state === "ok" ? "OK" : c.fatal ? "FAIL" : "WARN";
    row.innerHTML =
      `<td class="state ${cls}">${mark}</td>` +
      `<td>${escapeHtml(c.label)}</td>` +
      `<td class="detail">${escapeHtml(c.detail)}</td>`;
    body.append(row);
  }
}

/** Draw an `ImageData` at an integer scale, nearest-neighbour, with a caption. */
function showCanvas(
  containerSelector: string,
  caption: string,
  image: ImageData,
  scale: number,
  swatches?: readonly number[],
): void {
  const container = element(containerSelector);
  if (container === null) return;

  const canvas = document.createElement("canvas");
  canvas.width = image.width * scale;
  canvas.height = image.height * scale;

  const buffer = document.createElement("canvas");
  buffer.width = image.width;
  buffer.height = image.height;
  const bufferCtx = buffer.getContext("2d");
  if (bufferCtx === null) {
    log.error("2d context unavailable for the staging canvas", { caption });
    return;
  }
  bufferCtx.putImageData(image, 0, 0);

  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    log.error("2d context unavailable for the display canvas", { caption });
    return;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buffer, 0, 0, canvas.width, canvas.height);

  const figure = document.createElement("figure");
  figure.append(canvas);
  const cap = document.createElement("figcaption");
  cap.textContent = caption;
  figure.append(cap);

  if (swatches !== undefined) figure.append(swatchStrip(swatches));
  container.append(figure);
}

/** A palette shown as its own colours. Packed sRGB triplets, as everywhere. */
function swatchStrip(colors: readonly number[]): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "swatches";
  for (let i = 0; i + 2 < colors.length; i += 3) {
    const cell = document.createElement("div");
    cell.className = "swatch";
    cell.style.background = `rgb(${colors[i] ?? 0} ${colors[i + 1] ?? 0} ${colors[i + 2] ?? 0})`;
    strip.append(cell);
  }
  return strip;
}

// --- the source image ---------------------------------------------------

/**
 * The generated source.
 *
 * Three registers, top to bottom: a hue sweep across x over a lightness ramp
 * down y, a resolution chart of combs and checkerboards, and a neutral wedge
 * with a slow band. One frame that exercises everything the catalogue has to
 * get right — choosing between palette entries of different hue, reproducing a
 * flat tone no entry can reach, and *responding to an edge*.
 *
 * The middle register is the one that earns its place on this page. A gradient
 * is a poor witness for a neighbourhood effect: the derivative is near zero
 * everywhere, so a blur, a sharpen, an edge detect and a no-op all return the
 * input to within a fraction of a level and the page cannot tell them apart.
 *
 * Written in sRGB because that is what an image file would arrive as; the core
 * removes the transfer on the way in.
 */
function sourceImage(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  const detailTop = Math.round((height - DETAIL_ROWS) * (2 / 3));
  const detailEnd = detailTop + DETAIL_ROWS;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      let r: number;
      let g: number;
      let b: number;

      if (y < detailTop) {
        const hue = (x / (width - 1)) * 360;
        const value = 0.15 + 0.85 * (1 - y / Math.max(1, detailTop - 1));
        [r, g, b] = hsvToSrgb(hue, 0.85, value);
      } else if (y < detailEnd) {
        const v = detailValue(x, y - detailTop, width);
        r = v;
        g = v;
        b = v;
      } else {
        const ramp = x / (width - 1);
        const band =
          0.5 + 0.5 * Math.sin(((y - detailEnd) / Math.max(1, height - detailEnd)) * Math.PI * 2);
        const v = ramp * (0.35 + 0.65 * band);
        r = v;
        g = v;
        b = v;
      }

      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, width, height);
}

/**
 * One texel of the detail strip, in six equal blocks across the width.
 *
 * Every block is hard-edged and every one of them is a different spatial
 * frequency, because the frequencies are the point: a 1px comb dies under a
 * radius-4 gaussian and survives a radius-1 one, a 4px checker survives both,
 * and the single hard step is what an unsharp mask puts a halo on. Reading the
 * six across one output tells you what a neighbourhood node actually did.
 */
function detailValue(x: number, row: number, width: number): number {
  const block = Math.min(5, Math.floor((x / width) * 6));
  const local = x - Math.floor((block * width) / 6);
  switch (block) {
    case 0:
      return local % 2 === 0 ? 0.05 : 0.95; // 1px vertical comb
    case 1:
      return row % 2 === 0 ? 0.05 : 0.95; // 1px horizontal comb
    case 2:
      return (Math.floor(local / 2) + Math.floor(row / 2)) % 2 === 0 ? 0.05 : 0.95; // 2px checker
    case 3:
      return (Math.floor(local / 4) + Math.floor(row / 4)) % 2 === 0 ? 0.05 : 0.95; // 4px checker
    case 4:
      return local < Math.floor(width / 12) ? 0.05 : 0.95; // one hard step
    default:
      return (local + row) % 5 < 2 ? 0.05 : 0.95; // thin diagonals
  }
}

/** HSV to sRGB, all components 0..1 except `h` in degrees. */
function hsvToSrgb(h: number, s: number, v: number): readonly [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;
  const table: readonly (readonly [number, number, number])[] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const rgb = table[Math.min(5, Math.floor(hp))] ?? ([0, 0, 0] as const);
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

// --- the WASM core ------------------------------------------------------

async function loadCore() {
  // Generated by the `wasm` compose service into src/wasm/pkg. The import is
  // dynamic so a missing build produces a clear message instead of a blank page.
  const mod = await import("./wasm/pkg/dither_wasm.js");
  await mod.default();
  return mod;
}

type Core = Awaited<ReturnType<typeof loadCore>>;

interface Named {
  readonly id: string;
  readonly name: string;
}

interface BuiltinPalette extends Named {
  readonly srgb: Uint8Array;
}

/**
 * Copy the kernel table out of WASM memory and free the handles.
 *
 * Every getter on a `wasm-bindgen` struct copies, and every returned struct is
 * a live handle into the linear memory until `free()` is called. Reading each
 * one once and releasing it immediately is the contract docs/API.md states;
 * skipping it on a page that allocates a few dozen of them would leak quietly.
 */
function readKernels(core: Core): readonly Named[] {
  const handles = core.kernels();
  const kernels = handles.map((k) => ({ id: k.id, name: k.name }));
  for (const handle of handles) handle.free();
  return kernels;
}

function readBuiltinPalettes(core: Core): readonly BuiltinPalette[] {
  const handles = core.builtinPalettes();
  const palettes = handles.map((p) => ({ id: p.id, name: p.name, srgb: p.srgb }));
  for (const handle of handles) handle.free();
  return palettes;
}

/** One diffusion pass, with the options object built and released around it. */
function ditherWith(
  core: Core,
  source: ImageData,
  paletteSrgb: Uint8Array,
  kernelId: string,
): ImageData {
  const options = new core.DitherOptions(kernelId);
  try {
    const output = core.ditherImage(
      new Uint8Array(source.data.buffer),
      source.width,
      source.height,
      paletteSrgb,
      options,
    );
    try {
      return new ImageData(
        new Uint8ClampedArray(output.pixels),
        output.width,
        output.height,
      );
    } finally {
      output.free();
    }
  } finally {
    options.free();
  }
}

// --- sections -----------------------------------------------------------

function renderRegistryTable(registry: EffectRegistry): void {
  const body = element<HTMLTableSectionElement>("#registry-table tbody");
  if (body === null) return;
  body.innerHTML = "";

  const header = document.createElement("tr");
  header.innerHTML =
    "<th>Effect</th><th>Req</th><th>Family</th><th>Slot</th><th>Runs on</th><th>Params</th>";
  body.append(header);

  for (const effect of registry.all()) {
    const row = document.createElement("tr");
    row.innerHTML =
      `<td>${escapeHtml(effect.name)}</td>` +
      `<td class="detail">${escapeHtml(effect.requirement)}</td>` +
      `<td class="detail">${escapeHtml(effect.family)}</td>` +
      `<td class="detail">${escapeHtml(effect.slot)}</td>` +
      `<td class="detail">${escapeHtml(effect.execution)}</td>` +
      `<td class="detail">${effect.params.length}</td>`;
    body.append(row);
  }
}

/**
 * Registry discovery and validation, reported on the page.
 *
 * Returns `null` when the catalogue is rejected. That is terminal by design:
 * a build whose catalogue is wrong renders wrong documents convincingly, so
 * nothing downstream is allowed to proceed on a partial registry.
 */
function runRegistry(): EffectRegistry | null {
  try {
    const registry = loadEffectRegistry();
    const wasm = registry.byExecution("wasm").length;
    const gpu = registry.byExecution("gpu").length;
    setStatus(
      "#registry-status",
      `${okMark("validated")} — ${registry.size} effect(s): ` +
        `${wasm} serial (WASM), ${gpu} parallel (WebGPU). ` +
        `Families: ${describeFamilies(registry)}.`,
    );
    renderRegistryTable(registry);
    return registry;
  } catch (error) {
    const issues =
      error instanceof RegistryValidationError
        ? `<ul class="issues">${error.issues
            .map(
              (i) =>
                `<li>${escapeHtml(i.effect)}${i.param === undefined ? "" : `.${escapeHtml(i.param)}`} — ` +
                `${escapeHtml(i.code)}: ${escapeHtml(i.message)}</li>`,
            )
            .join("")}</ul>`
        : "";
    setStatus(
      "#registry-status",
      `${failMark("rejected")} — ${escapeHtml(String(error))}${issues}`,
    );
    log.error("node registry rejected at startup", { error: String(error) });
    return null;
  }
}

function describeFamilies(registry: EffectRegistry): string {
  const families = ["error-diffusion", "ordered", "pattern", "glitch", "special", "preprocess"] as const;
  return families
    .map((family) => ({ family, count: registry.byFamily(family).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.family} ${entry.count}`)
    .join(", ");
}

async function runDiffusion(
  core: Core,
  source: ImageData,
  kernels: readonly Named[],
  palette: BuiltinPalette,
): Promise<void> {
  setStatus(
    "#diffusion-note",
    `${kernels.length} kernel(s) registered in <code>diffusion.rs</code>, ` +
      `every one of them below, in the ${escapeHtml(palette.name)} palette. ` +
      `F-ED-14 (Ostromoukhov) is deliberately absent — its 256-row coefficient ` +
      `table has no closed form, and a kernel written from memory would render ` +
      `and be wrong.`,
  );

  for (const kernel of kernels) {
    const image = await log.time(`dither ${kernel.id}`, () =>
      ditherWith(core, source, palette.srgb, kernel.id),
    );
    showCanvas("#diffusion", kernel.name, image, SCALE);
  }
}

async function runPalettes(
  core: Core,
  source: ImageData,
  palettes: readonly BuiltinPalette[],
  kernelId: string,
): Promise<void> {
  const shown = SHOWN_PALETTES.map((id) => palettes.find((p) => p.id === id)).filter(
    (p): p is BuiltinPalette => p !== undefined,
  );
  const missing = SHOWN_PALETTES.filter((id) => !palettes.some((p) => p.id === id));

  setStatus(
    "#palettes-note",
    `${palettes.length} hardware palette(s) ship in the core (F-CO-04); ` +
      `${shown.length} of them below, each dithered with ${escapeHtml(kernelId)}. ` +
      (missing.length > 0
        ? `${failMark("missing")}: ${missing.map(escapeHtml).join(", ")}. `
        : "") +
      `The NES and the Apple II are absent on purpose: neither has a digital RGB ` +
      `specification, so every published table is one particular measurement, and ` +
      `inventing numbers is worse than the gap.`,
  );

  for (const palette of shown) {
    const image = await log.time(`palette ${palette.id}`, () =>
      ditherWith(core, source, palette.srgb, kernelId),
    );
    showCanvas(
      "#palettes",
      `${palette.name} — ${palette.srgb.length / 3} colours`,
      image,
      SCALE,
      Array.from(palette.srgb),
    );
  }
}

async function runExtraction(
  core: Core,
  source: ImageData,
  kernelId: string,
): Promise<void> {
  const methods = [
    { method: core.ExtractMethod.MedianCut, label: "Median cut" },
    { method: core.ExtractMethod.Wu, label: "Wu" },
    { method: core.ExtractMethod.KMeans, label: "k-means" },
  ] as const;

  setStatus(
    "#extraction-note",
    `F-CO-02. All three extractors, K=${EXTRACTION_K}, taken from the source ` +
      `above and then fed straight back into ${escapeHtml(kernelId)}. Every one ` +
      `takes an explicit seed even though only k-means draws from it today, so a ` +
      `later stochastic step cannot arrive unseeded.`,
  );

  const rgba = new Uint8Array(source.data.buffer);
  for (const entry of methods) {
    const options = new core.ExtractOptions();
    options.method = entry.method;
    options.k = EXTRACTION_K;
    options.seed = 0n;

    try {
      const extracted = await log.time(`extract ${entry.label}`, () =>
        core.extractPalette(rgba, source.width, source.height, options),
      );
      try {
        const srgb = extracted.srgb;
        log.info("palette extracted", {
          method: entry.label,
          requested: EXTRACTION_K,
          produced: extracted.paletteLen,
          occupiedBins: extracted.occupiedBins,
          iterations: extracted.iterations,
          emptyClusterRepairs: extracted.emptyClusterRepairs,
          emptyClustersDropped: extracted.emptyClustersDropped,
        });

        const image = ditherWith(core, source, srgb, kernelId);
        const detail =
          `${entry.label} — ${extracted.paletteLen}/${EXTRACTION_K} colours, ` +
          `${extracted.occupiedBins} occupied bins` +
          (extracted.iterations > 0 ? `, ${extracted.iterations} iterations` : "");
        showCanvas("#extraction", detail, image, SCALE, Array.from(srgb));
      } finally {
        extracted.free();
      }
    } finally {
      options.free();
    }
  }
}

// --- the WebGPU path ----------------------------------------------------

/** Planar linear-light `f32`, which is what the GPU upload takes. */
function toLinearSurface(image: ImageData): CpuColorSurface {
  const pixels = image.width * image.height;
  const r = new Float32Array(pixels);
  const g = new Float32Array(pixels);
  const b = new Float32Array(pixels);
  const a = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    r[i] = srgbToLinear((image.data[at] ?? 0) / 255);
    g[i] = srgbToLinear((image.data[at + 1] ?? 0) / 255);
    b[i] = srgbToLinear((image.data[at + 2] ?? 0) / 255);
    // Alpha is linear already — it carries no transfer function (F-IN-03).
    a[i] = (image.data[at + 3] ?? 0) / 255;
  }
  return { residency: "cpu", r, g, b, a };
}

/** The inverse, for display. sRGB transfer is reapplied on the way out. */
function toImageData(
  surface: CpuColorSurface,
  width: number,
  height: number,
): ImageData {
  const pixels = width * height;
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    data[at] = Math.round(linearToSrgb(surface.r[i] ?? 0) * 255);
    data[at + 1] = Math.round(linearToSrgb(surface.g[i] ?? 0) * 255);
    data[at + 2] = Math.round(linearToSrgb(surface.b[i] ?? 0) * 255);
    data[at + 3] = Math.round((surface.a[i] ?? 0) * 255);
  }
  return new ImageData(data, width, height);
}

/**
 * Every ordered dither, through the compute path, end to end.
 *
 * Threshold ranks from Rust, a table binding per effect, one dispatch each
 * against the shared linear-light surface, and a readback per result. The
 * scheduler is asked to plan the run even though there is one node in it, so
 * the crossing count on the page comes from the same code that will count them
 * for a real stack.
 */
async function runOrdered(
  core: Core,
  layer: GpuLayer,
  source: ImageData,
  palette: BuiltinPalette,
): Promise<void> {
  const width = source.width;
  const height = source.height;
  const documentPalette: Palette = {
    id: palette.id,
    name: palette.name,
    colors: Array.from(palette.srgb),
    metric: "oklab",
  };

  const gpuPalette = uploadPalette(
    layer.context,
    documentPalette,
    layer.buffers,
    `demo:${palette.id}`,
  );

  const sourceTexture = layer.textures.acquire(
    "rgba16float",
    width,
    height,
    "demo/source",
  );
  writeColorSurface(
    layer.context,
    sourceTexture,
    toLinearSurface(source),
    width,
    height,
    "demo/source",
  );

  try {
    for (const spec of ORDERED_DITHERS) {
      const nodeId = `demo/${spec.effectId}`;

      const ranks = await log.time(`threshold ranks ${spec.effectId}`, () =>
        spec.effectId === "blue-noise"
          ? core.blueNoiseRanks(spec.tile, BLUE_NOISE_SEED)
          : core.bayerRanks(spec.tile),
      );
      const matrix = thresholdMatrix(spec.effectId, spec.tile, ranks);
      const { descriptor, gpu } = createOrderedDither(spec, matrix);
      await layer.compiler.compile(descriptor, gpu);

      const pass = gpu.passes[0];
      if (pass === undefined) {
        // createOrderedDither always builds exactly one pass; if that ever
        // stops being true the failure is named rather than indexed past.
        throw new Error(`${spec.effectId}: the effect declared no compute pass`);
      }

      const scheduled: ScheduledPass = {
        nodeId,
        pass,
        uniforms: packUniforms(nodeId, ORDERED_DITHER_UNIFORMS, {
          params: orderedDitherDefaults(),
          paramTypes: ORDERED_PARAM_TYPES,
          width,
          height,
          // A still frame. Nothing on this page animates, so t is pinned at the
          // start of the loop rather than read from a clock.
          normalizedTime: 0,
          seed: 0,
          paletteSize: gpuPalette.count,
        }),
        width,
        height,
      };

      const color = new SurfaceChain(
        layer.textures,
        "rgba16float",
        sourceTexture,
        width,
        height,
        `${nodeId}/color`,
      );
      const index = new SurfaceChain(
        layer.textures,
        "r32uint",
        null,
        width,
        height,
        `${nodeId}/index`,
      );

      try {
        const plan = planExecution([
          { nodeId, execution: "gpu", passes: [scheduled] },
        ]);
        for (const batch of plan.batches) {
          layer.executor.run(batch, { color, index, palette: gpuPalette });
        }

        const readback = await readColorSurface(
          layer.context,
          layer.staging,
          color.current,
          width,
          height,
          nodeId,
        );
        showCanvas(
          "#ordered",
          `${spec.name} — ${spec.tile}×${spec.tile} tile, ${readback.crossing.bytes} B read back in ${readback.crossing.ms} ms`,
          toImageData(readback.surface, width, height),
          SCALE,
        );
      } finally {
        // The chain keeps whichever texture holds the result, so it is handed
        // back explicitly — otherwise every effect would grow the pool by one
        // working surface that nothing can ever reuse.
        const produced = color.hasContent ? color.current : null;
        const producedIndex = index.hasContent ? index.current : null;
        color.release();
        index.release();
        if (produced !== null && produced !== sourceTexture) {
          layer.textures.release(produced);
        }
        if (producedIndex !== null) layer.textures.release(producedIndex);
      }
    }
  } finally {
    layer.textures.release(sourceTexture);
  }

  const stats = layer.stats();
  setStatus(
    "#ordered-status",
    `${okMark("ready")} — ${ORDERED_DITHERS.length} effect(s) compiled and dispatched on ` +
      `${escapeHtml(describeAdapter(layer))}. ` +
      `Pipelines: ${stats.pipelines.compiled} compiled, ${stats.pipelines.hits} cache hit(s). ` +
      `Textures: ${stats.textures.created} created, ${stats.textures.reused} reused.`,
  );
  log.info("ordered dithers complete", {
    effects: ORDERED_DITHERS.length,
    pipelines: stats.pipelines.compiled,
    texturesCreated: stats.textures.created,
    texturesReused: stats.textures.reused,
  });
}

// --- every other parallel effect ----------------------------------------

/**
 * The thirty-nine parallel effects that are not ordered dithers.
 *
 * Some modules export a `GpuEffect` constant and some a factory, depending on
 * whether the effect ships a table it has to build (a glyph sheet, a clustered
 * screen). Both are resolved here so the runner below sees one shape.
 */
const PARALLEL_CATALOGUE: readonly GpuEffect[] = [
  // pattern (F-PT)
  halftoneEffect(),
  cmykHalftoneEffect(),
  lineScreenEffect(),
  crossHatchEffect(),
  concentricRingsGpuEffect(),
  spiralGpuEffect(),
  clusteredDotGpuEffect(),
  glyphTileGpuEffect(),
  // special (F-SP)
  epsilonGlowGpuEffect,
  blurGpuEffect,
  sharpenGpuEffect,
  edgeDetectGpuEffect,
  embossGpuEffect,
  POSTERIZE_GPU,
  THRESHOLD_GPU,
  INVERT_GPU,
  GRADIENT_MAP_GPU,
  OUTLINE_GPU,
  DILATE_ERODE_GPU,
  VIGNETTE_GPU,
  LENS_DISTORTION_GPU,
  LIGHT_LEAK_GPU,
  GRAIN_GPU,
  // glitch (F-GL)
  pixelSortGpuEffect,
  rowDisplacementGpuEffect,
  columnDisplacementGpuEffect,
  rgbSplitGpuEffect,
  chromaticAberrationGpuEffect,
  datamoshSmearEffect(),
  scanlinesEffect(),
  crtMaskEffect(),
  WAVE_WARP_GPU,
  SLICE_REPEAT_GPU,
  BLOCK_SHUFFLE_GPU,
  BIT_CRUSH_GPU,
  channelSwapEffect(),
  ghostEchoEffect(),
  interlaceTearEffect(),
  noiseBurstEffect(),
];

/** Which page section a family's figures go into. */
const FAMILY_SECTION: Readonly<Record<string, string>> = {
  pattern: "#pattern",
  special: "#special",
  glitch: "#glitch",
};

/**
 * Every parameter at its declared default.
 *
 * Defaults rather than flattering values on purpose: this page is meant to show
 * what the properties panel opens with, so a node whose default does nothing is
 * a finding rather than something to paper over with a livelier setting.
 */
function defaultParams(descriptor: EffectDescriptor): Record<string, ParameterValue> {
  const params: Record<string, ParameterValue> = {};
  for (const param of descriptor.params) {
    switch (param.type) {
      case "float":
      case "int":
      case "seed":
        params[param.key] = param.default;
        break;
      case "bool":
        params[param.key] = param.default;
        break;
      case "enum":
        params[param.key] = param.default;
        break;
      case "color":
      case "curve":
        // Neither has a uniform-field representation yet — `UniformFieldType`
        // is scalars and vectors, and a colour reaches a shader as three
        // separate float params where an effect needs one. Nothing is packed
        // for them, so nothing is invented here either.
        break;
    }
  }
  return params;
}

function paramTypesOf(descriptor: EffectDescriptor): ReadonlyMap<string, ParamDescriptor> {
  return new Map(descriptor.params.map((param) => [param.key, param]));
}

/**
 * The same parameters pushed as far off their defaults as the surprise metadata
 * allows.
 *
 * Used only when the default render came back identical to its input. Some
 * defaults genuinely are the identity — a channel swap opens with every output
 * reading its own channel, because a node that rearranged the picture the moment
 * it was added would be a node you cannot add without committing — and a figure
 * of the identity proves nothing about the shader behind it. Rather than
 * hand-picking a flattering value per effect, this reads the surprise range the
 * descriptor already declares (F-SM-04) and takes the end furthest from the
 * default. That is a value the generator can really produce, so a picture drawn
 * from it is a picture the app can really make.
 */
function surprisedParams(descriptor: EffectDescriptor): Record<string, ParameterValue> {
  const params = defaultParams(descriptor);
  for (const param of descriptor.params) {
    switch (param.type) {
      case "float":
      case "int": {
        const [low, high] = param.surprise.range;
        params[param.key] =
          Math.abs(low - param.default) >= Math.abs(high - param.default) ? low : high;
        break;
      }
      case "bool":
        params[param.key] = !param.default;
        break;
      case "enum": {
        const other = param.surprise.values.find((option) => option.value !== param.default);
        if (other !== undefined) params[param.key] = other.value;
        break;
      }
      case "seed":
      case "color":
      case "curve":
        break;
    }
  }
  return params;
}

/**
 * How much of the frame a node actually changed, and how bright it left it.
 *
 * The whole point of rendering all thirty-nine: an effect that compiles,
 * validates and returns its input unchanged looks identical to one that works
 * until you put the two frames side by side, and an effect that returns zeroes
 * looks like a deliberate black. Both are stated numerically in every caption
 * so they cannot be missed by eye.
 */
interface FrameDelta {
  /** Fraction of pixels differing from the input by more than one 8-bit step. */
  readonly changed: number;
  /** Mean absolute 8-bit difference across RGB. */
  readonly magnitude: number;
  /** Mean sRGB luminance of the result, 0..1. */
  readonly luminance: number;
}

function frameDelta(before: ImageData, after: ImageData): FrameDelta {
  const pixels = Math.min(before.data.length, after.data.length) / 4;
  let changed = 0;
  let total = 0;
  let luma = 0;
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    const dr = Math.abs((after.data[at] ?? 0) - (before.data[at] ?? 0));
    const dg = Math.abs((after.data[at + 1] ?? 0) - (before.data[at + 1] ?? 0));
    const db = Math.abs((after.data[at + 2] ?? 0) - (before.data[at + 2] ?? 0));
    if (dr > 1 || dg > 1 || db > 1) changed += 1;
    total += (dr + dg + db) / 3;
    luma +=
      (0.2126 * (after.data[at] ?? 0) +
        0.7152 * (after.data[at + 1] ?? 0) +
        0.0722 * (after.data[at + 2] ?? 0)) /
      255;
  }
  const n = Math.max(1, pixels);
  return { changed: changed / n, magnitude: total / n, luminance: luma / n };
}

function describeDelta(delta: FrameDelta): string {
  return (
    `changed ${(delta.changed * 100).toFixed(1)}% of pixels, ` +
    `mean |Δ| ${delta.magnitude.toFixed(1)}/255, mean luma ${(delta.luminance * 100).toFixed(0)}%`
  );
}

/**
 * The Bayer 4×4 quantizer the two index-map consumers run behind.
 *
 * Outline (F-SP-10) and dilate/erode (F-SP-11) read the index map, and the
 * validator already refuses to let such a node sit in the preprocess slot
 * because nothing has quantized yet. On this page that means they cannot be
 * shown alone: they need a real quantizer immediately upstream, so they get
 * one, and it is the same compute path everything else on the page uses.
 */
async function quantizerUnit(
  core: Core,
  layer: GpuLayer,
  width: number,
  height: number,
  paletteSize: number,
): Promise<ScheduleUnit> {
  const spec = orderedDitherSpec("bayer-4");
  const ranks = core.bayerRanks(spec.tile);
  const matrix = thresholdMatrix(spec.effectId, spec.tile, ranks);
  const { descriptor, gpu } = createOrderedDither(spec, matrix);
  await layer.compiler.compile(descriptor, gpu);

  const nodeId = "catalogue/quantizer";
  const pass = gpu.passes[0];
  if (pass === undefined) throw new Error("bayer-4 declared no compute pass");
  return {
    nodeId,
    execution: "gpu",
    passes: [
      {
        nodeId,
        pass,
        uniforms: packUniforms(nodeId, ORDERED_DITHER_UNIFORMS, {
          params: orderedDitherDefaults(),
          paramTypes: ORDERED_PARAM_TYPES,
          width,
          height,
          normalizedTime: 0,
          seed: 0,
          paletteSize,
        }),
        width,
        height,
      },
    ],
  };
}

/**
 * Compile and run every parallel effect that is not an ordered dither.
 *
 * One node per effect, at its declared defaults, against the same source and
 * the same palette as every other section. A failure is reported in place and
 * the run continues, because the interesting output of this section is the list
 * of effects that did *not* work, and stopping at the first one hides the rest.
 */
async function runParallelCatalogue(
  core: Core,
  layer: GpuLayer,
  registry: EffectRegistry,
  source: ImageData,
  palette: BuiltinPalette,
): Promise<void> {
  const width = source.width;
  const height = source.height;
  const documentPalette: Palette = {
    id: palette.id,
    name: palette.name,
    colors: Array.from(palette.srgb),
    metric: "oklab",
  };
  const gpuPalette = uploadPalette(
    layer.context,
    documentPalette,
    layer.buffers,
    `catalogue:${palette.id}`,
  );

  const sourceTexture = layer.textures.acquire("rgba16float", width, height, "catalogue/source");
  writeColorSurface(
    layer.context,
    sourceTexture,
    toLinearSurface(source),
    width,
    height,
    "catalogue/source",
  );

  const failures = new Map<EffectFamily, string[]>();
  const rendered = new Map<EffectFamily, number>();
  const suspicious = new Map<EffectFamily, string[]>();
  const noteSuspicion = (family: EffectFamily, line: string): void => {
    const list = suspicious.get(family) ?? [];
    list.push(line);
    suspicious.set(family, list);
  };

  /**
   * Run one effect once, on its own pair of surface chains, and hand back both
   * the result and whatever frame it should be measured against.
   *
   * Chains per render rather than per effect: an effect may be run twice (see
   * the identity check below), and reusing a chain would feed the second run the
   * first one's output instead of the source.
   */
  const renderNode = async (
    descriptor: EffectDescriptor,
    gpu: GpuEffect,
    params: Readonly<Record<string, ParameterValue>>,
    label: string,
  ): Promise<{ image: ImageData; reference: ImageData; upstream: ImageData | null }> => {
    const nodeId = `catalogue/${descriptor.id}/${label}`;
    const color = new SurfaceChain(
      layer.textures,
      "rgba16float",
      sourceTexture,
      width,
      height,
      `${nodeId}/color`,
    );
    const index = new SurfaceChain(
      layer.textures,
      "r32uint",
      null,
      width,
      height,
      `${nodeId}/index`,
    );

    try {
      // Outline and dilate/erode read an index map, so they need a real
      // quantizer upstream. It runs and is read back first, because the frame
      // those two must be measured against is the quantized one, not the
      // photographic source — measuring them against the source would report the
      // Bayer dither's own change as theirs.
      let upstream: ImageData | null = null;
      if (descriptor.requiresIndexMap) {
        const quantizer = await quantizerUnit(core, layer, width, height, gpuPalette.count);
        for (const batch of planExecution([quantizer]).batches) {
          layer.executor.run(batch, { color, index, palette: gpuPalette });
        }
        const quantized = await readColorSurface(
          layer.context,
          layer.staging,
          color.current,
          width,
          height,
          `${nodeId}/upstream`,
        );
        upstream = toImageData(quantized.surface, width, height);
      }

      const unit: ScheduleUnit = {
        nodeId,
        execution: "gpu",
        passes: gpu.passes.map((pass) => ({
          nodeId,
          pass,
          uniforms: packUniforms(`${nodeId}/${pass.id}`, pass.uniforms, {
            params,
            paramTypes: paramTypesOf(descriptor),
            width,
            height,
            // Still frame: t is pinned at the start of the loop. Nothing on this
            // page animates and nothing reads a clock (F-AN-05).
            normalizedTime: 0,
            seed: 0x2f6a_1b3d,
            paletteSize: gpuPalette.count,
          }),
          width,
          height,
        })),
      };

      for (const batch of planExecution([unit]).batches) {
        layer.executor.run(batch, { color, index, palette: gpuPalette });
      }

      const readback = await readColorSurface(
        layer.context,
        layer.staging,
        color.current,
        width,
        height,
        nodeId,
      );
      const image = toImageData(readback.surface, width, height);
      return { image, reference: upstream ?? source, upstream };
    } finally {
      const produced = color.hasContent ? color.current : null;
      const producedIndex = index.hasContent ? index.current : null;
      color.release();
      index.release();
      if (produced !== null && produced !== sourceTexture) layer.textures.release(produced);
      if (producedIndex !== null) layer.textures.release(producedIndex);
    }
  };

  try {
    for (const gpu of PARALLEL_CATALOGUE) {
      const descriptor = registry.get(gpu.effect);
      if (descriptor === undefined) {
        // A compute pass with no descriptor is an effect the catalogue does not
        // know about, which means the UI could never offer it.
        log.error("a compute pass names an effect the registry has no descriptor for", {
          effect: gpu.effect,
        });
        continue;
      }
      const section = FAMILY_SECTION[descriptor.family];
      if (section === undefined) {
        log.error("no page section for family", {
          effect: gpu.effect,
          family: descriptor.family,
        });
        continue;
      }

      try {
        await layer.compiler.compile(descriptor, gpu);

        const run = await renderNode(descriptor, gpu, defaultParams(descriptor), "defaults");
        if (run.upstream !== null) {
          showCanvas(
            section,
            `↳ upstream of ${descriptor.name}: Bayer 4×4 quantizer, the frame it is measured against`,
            run.upstream,
            SCALE,
          );
        }

        const delta = frameDelta(run.reference, run.image);
        showCanvas(
          section,
          `${descriptor.name} — ${descriptor.requirement}, ` +
            `${gpu.passes.length} pass(es), ${descriptor.params.length} param(s); ${describeDelta(delta)}`,
          run.image,
          SCALE,
        );
        rendered.set(descriptor.family, (rendered.get(descriptor.family) ?? 0) + 1);

        // A node that returned its input, or that returned black, is exactly
        // what this section exists to catch. Neither is left to the eye.
        if (delta.luminance < 0.01) {
          noteSuspicion(descriptor.family, `${descriptor.id} rendered an almost black frame`);
        } else if (delta.changed < 0.005) {
          // The identity at defaults is not automatically a defect — it is the
          // right opening state for a rearrangement node — but a figure of the
          // identity says nothing about the shader, so the effect is run again at
          // the far end of its own surprise range and both are shown.
          const moved = await renderNode(
            descriptor,
            gpu,
            surprisedParams(descriptor),
            "surprised",
          );
          const movedDelta = frameDelta(moved.reference, moved.image);
          showCanvas(
            section,
            `↳ ${descriptor.name} at the far end of its surprise range, because its ` +
              `defaults are the identity; ${describeDelta(movedDelta)}`,
            moved.image,
            SCALE,
          );
          noteSuspicion(
            descriptor.family,
            movedDelta.changed < 0.005
              ? `${descriptor.id} returned its input unchanged at its defaults AND across its whole surprise range`
              : `${descriptor.id} is the identity at its declared defaults (it does move — see the second figure)`,
          );
        }
      } catch (error) {
        const list = failures.get(descriptor.family) ?? [];
        list.push(`${descriptor.id}: ${String(error)}`);
        failures.set(descriptor.family, list);
        log.error("catalogue effect failed", {
          effect: descriptor.id,
          error: String(error),
        });
      }
    }
  } finally {
    layer.textures.release(sourceTexture);
  }

  for (const [family, selector] of Object.entries(FAMILY_SECTION)) {
    const key = family as EffectFamily;
    const declared = registry.byFamily(key).length;
    const shown = rendered.get(key) ?? 0;
    const broken = failures.get(key) ?? [];
    const doubtful = suspicious.get(key) ?? [];
    setStatus(
      `${selector}-status`,
      (broken.length === 0 && shown === declared
        ? okMark("all rendered")
        : failMark("incomplete")) +
        ` — ${shown} of ${declared} ${escapeHtml(family)} effect(s) rendered.` +
        (broken.length === 0
          ? ""
          : `<ul class="issues">${broken
              .map((line) => `<li>${escapeHtml(line)}</li>`)
              .join("")}</ul>`) +
        (doubtful.length === 0
          ? ""
          : ` ${failMark("look at these")}:<ul class="issues">${doubtful
              .map((line) => `<li>${escapeHtml(line)}</li>`)
              .join("")}</ul>`),
    );
  }

  const doubtfulTotal = [...suspicious.values()].flat();
  if (doubtfulTotal.length > 0) {
    log.error("effects whose output does not look like the named effect", {
      effects: doubtfulTotal.join("; "),
    });
  }
  log.info("parallel catalogue complete", {
    effects: PARALLEL_CATALOGUE.length,
    rendered: [...rendered.values()].reduce((a, b) => a + b, 0),
    suspicious: doubtfulTotal.length,
  });
}

function describeAdapter(layer: GpuLayer): string {
  const info = layer.context.adapterInfo;
  const parts = [info.vendor, info.architecture, info.device].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join(" / ") : "an unnamed adapter";
}

// --- startup ------------------------------------------------------------

async function main(): Promise<void> {
  const report = await log.time("capability check", checkCapabilities);
  renderCapabilities(report.capabilities);

  // Validation runs before anything is rendered, because the catalogue is what
  // every later stage would be reading from.
  const registry = runRegistry();
  if (registry === null) {
    setStatus(
      "#core-status",
      `${failMark("blocked")} — the node registry did not validate; nothing downstream may run on a partial catalogue.`,
    );
    return;
  }

  if (!report.usable) {
    const names = report.fatalFailures.map((c) => c.label).join(", ");
    setStatus(
      "#core-status",
      `${failMark("blocked")} — missing: ${escapeHtml(names)}. ` +
        `See docs/ARCHITECTURE.md, "Platform support policy".`,
    );
    log.error("startup blocked", { missing: names });
    return;
  }

  let core: Core;
  try {
    core = await log.time("load wasm core", loadCore);
  } catch (error) {
    setStatus(
      "#core-status",
      `${failMark("not built")} — run <code>docker compose up wasm</code>, ` +
        `or check that src/wasm/pkg exists. ${escapeHtml(String(error))}`,
    );
    log.error("wasm core failed to load", { error: String(error) });
    return;
  }

  const kernels = readKernels(core);
  const palettes = readBuiltinPalettes(core);
  setStatus(
    "#core-status",
    `${okMark("loaded")} — dither-core v${escapeHtml(core.version())}, ` +
      `${kernels.length} diffusion kernel(s), ${palettes.length} built-in palette(s).`,
  );
  log.info("core loaded", {
    version: core.version(),
    kernels: kernels.length,
    palettes: palettes.length,
  });

  // Every effect id below has to exist in the registry too, or the page is
  // demonstrating something the catalogue does not know about.
  const unregistered = [...kernels, ...ORDERED_DITHERS.map((s) => ({ id: s.effectId }))]
    .map((entry) => entry.id)
    .filter((id) => !registry.has(id));
  if (unregistered.length > 0) {
    log.error("core exposes effects the registry does not describe", {
      missing: unregistered.join(", "),
    });
    setStatus(
      "#registry-status",
      `${failMark("incomplete")} — the core exposes ${unregistered.length} effect(s) with no ` +
        `registry descriptor: ${escapeHtml(unregistered.join(", "))}. ` +
        `Every effect is one file under <code>src/effects/</code>.`,
    );
  }

  const source = sourceImage(SOURCE_WIDTH, SOURCE_HEIGHT);
  showCanvas("#source", `generated ${SOURCE_WIDTH}×${SOURCE_HEIGHT}`, source, 3);

  const gameboy = palettes.find((p) => p.id === "gameboy-dmg");
  const cga = palettes.find((p) => p.id === "cga-16");
  if (gameboy === undefined || cga === undefined) {
    // Both ids are asserted by a core test, so this cannot happen against a
    // matching build — which is exactly why a mismatched one must say so.
    log.error("a required built-in palette is missing from the core", {
      ids: "gameboy-dmg, cga-16",
    });
    setStatus(
      "#diffusion-note",
      `${failMark("blocked")} — the core did not ship the palettes this page needs.`,
    );
    return;
  }

  const primaryKernel = kernels[0];
  if (primaryKernel === undefined) {
    setStatus("#diffusion-note", `${failMark("blocked")} — the core registered no kernels.`);
    log.error("core registered no diffusion kernels");
    return;
  }

  await runDiffusion(core, source, kernels, gameboy);
  await runPalettes(core, source, palettes, primaryKernel.id);
  await runExtraction(core, source, primaryKernel.id);

  // The GPU section is last because it is the one that can legitimately be
  // unavailable, and a failure here must not take the WASM proof down with it.
  try {
    const layer = await log.time("acquire gpu layer", () =>
      GpuLayer.create({ report }),
    );
    await runOrdered(core, layer, source, cga);
    // Every other parallel effect, grouped by family. Separate from the ordered
    // section because that one is the tile-and-table path specifically; this is
    // the rest of the catalogue proving it renders at all.
    await runParallelCatalogue(core, layer, registry, source, cga);
  } catch (error) {
    setStatus(
      "#ordered-status",
      `${failMark("not ready")} — ${escapeHtml(String(error))}`,
    );
    log.error("webgpu path unavailable", { error: String(error) });
  }
}

main().catch((error: unknown) => {
  log.error("fatal", { error: String(error) });
});
