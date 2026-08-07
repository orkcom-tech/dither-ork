/**
 * The browser half of the GPU golden harness.
 *
 * Runs inside headless Chromium against a software WebGPU adapter, renders
 * every effect the registry reports as `execution: "gpu"` through the real
 * compute path, and hands the finished frames back to `run.mjs` over the
 * DevTools protocol. It compares nothing and stores nothing — the Node side owns
 * the reference tree, because a harness that both produced and judged its own
 * output inside the same process would have nowhere to put the loud re-bless
 * banner.
 *
 * ## Everything here is enumerated, never listed
 *
 * The plan comes from `registry.byExecution("gpu")` and the passes come from
 * `loadGpuEffects()`. Nothing names an effect. That is the difference between a
 * set that covers the catalogue and a set that covers whatever somebody
 * remembered to add: an effect written next week is rendered by this file
 * without it being edited, and an effect that stops being discovered takes the
 * count down, which `run.mjs` refuses.
 *
 * ## Two parameter sets per effect
 *
 * **Defaults** pin what the properties panel opens with. **Surprise** pins the
 * far end of each parameter's declared surprise range (F-SM-04). Both are needed
 * and neither is enough:
 *
 * - A handful of effects are deliberately the identity at their defaults — a
 *   channel swap opens with every output reading its own channel — and a
 *   reference image of the identity records nothing about the shader behind it.
 * - The surprise end alone would leave the opening state of every other effect
 *   unprotected, which is the state most renders in the product actually use.
 *
 * Both are derived mechanically from the descriptor, so neither needs a per-effect
 * decision and neither goes stale when a default moves — it fails the comparison,
 * which is the moment to look at the picture and re-bless.
 *
 * ## Scheduling goes through `prepareNodePasses`, not through this file
 *
 * Uniforms, per-pass extents and per-node bulk data are resolved by the same
 * call `state/render/gpu-backend.ts` makes. That is not tidiness: a harness that
 * assembled its own `ScheduleUnit` could only render passes that write what they
 * read and bind nothing per node, which silently excluded F-PP-01, F-PP-05,
 * F-PP-07 and F-SP-14 — four effects whose references did not exist and whose
 * absence looked like an unrelated failure.
 *
 * A render therefore has its **own** extent. Two of the effects resample, so
 * `run.mjs` is told the width and height of each frame rather than assuming the
 * fixture's.
 *
 * ## What is pinned
 *
 * The fixture, the palette, the seed, the uploaded tile, and normalized time.
 * Nothing reads a clock (F-AN-05) and nothing draws from an unseeded source, so
 * two runs of this file on one machine produce byte-identical frames — which is
 * the property the whole reference set rests on.
 */

import {
  GpuLayer,
  linearToSrgb,
  planExecution,
  prepareNodePasses,
  readColorSurface,
  SurfaceChain,
  thresholdMatrix,
  uploadPalette,
  writeColorSurface,
  type NodeRenderState,
} from "../../src/gpu";
import { checkCapabilities } from "../../src/lib/capabilities";
import {
  defaultParams,
  loadEffectRegistry,
  loadGpuEffects,
  type EffectRegistry,
  type GpuEffectResolver,
} from "../../src/registry";
import { CURVE_ARCHETYPES } from "../../src/surprise";
import {
  encodeThresholdMap,
  THRESHOLD_MAP_SLOT,
} from "../../src/effects/threshold-map.effect";
import type { CurvePoint, Palette, ParameterValue } from "../../src/types/document";
import type { Extent, GpuEffect } from "../../src/types/gpu";
import type { EffectDescriptor, ParamDescriptor } from "../../src/types/registry";
import { NO_GPU_BUILD_DATA } from "../../src/types/registry";
import {
  FIXTURE_HEIGHT,
  FIXTURE_ID,
  FIXTURE_WIDTH,
  fixtureAsLinearSurface,
  renderFixture,
} from "./fixture";

import init, * as core from "../../src/wasm/pkg/dither_wasm.js";

/**
 * The palette every reference is rendered against.
 *
 * `cga-16` rather than `mono`. Sixteen entries spread over the cube means the
 * palette search does real work and the quantizing effects have somewhere to
 * push a hue, so a defect in the search or in the OKLab distance moves the
 * picture. Two colours would flatten all of that to a decision about lightness
 * and let the colour path break without a single reference image noticing.
 */
const PALETTE_ID = "cga-16";

/**
 * The node seed every stochastic effect is handed.
 *
 * Fixed, and the only source of randomness any of them has — there is no
 * `Math.random()` in a render path, by convention and by review. A shader whose
 * output changed between two runs at this seed would be a defect the harness
 * reports as an unstable reference rather than one it hides behind a tolerance.
 */
const NODE_SEED = 0x2f6a_1b3d;

/** Seed for the void-and-cluster tile, matching `web/src/main.ts`. */
const BLUE_NOISE_SEED = 0x5eed_0d17n;

/**
 * Where an ordered dither's threshold tile comes from.
 *
 * `GpuBuildRequirement` carries the tile *size* and not which generator
 * produces it, so a caller holding nothing but an effect id cannot ask the core
 * for the right tile. `web/src/main.ts` has the same problem and solves it with
 * an inline `id === "blue-noise"` check. This table is that fact written once,
 * and — unlike a branch — an effect that needs a tile and is not in it fails the
 * whole run instead of quietly getting a Bayer tile that looks plausible and is
 * wrong. The right home for it is the requirement itself; see the report.
 */
const TILE_SOURCE: Readonly<Record<string, "bayer" | "blue-noise">> = {
  "bayer-2": "bayer",
  "bayer-4": "bayer",
  "bayer-8": "bayer",
  "bayer-16": "bayer",
  "blue-noise": "blue-noise",
};

/**
 * The quantizer placed upstream of an effect that reads an index map.
 *
 * Outline (F-SP-10) and dilate/erode (F-SP-11) have nothing to read until
 * something has quantized, and the registry validator already refuses to let
 * them sit in the preprocess slot for that reason. They get a real ordered
 * dither at its declared defaults, through the same compute path as everything
 * else, so the reference records the pair rather than an invented index map.
 */
const UPSTREAM_QUANTIZER = "bayer-4";

/**
 * Size of the tile handed to a binding that requires uploaded bytes.
 *
 * 32 rather than the fixture's own shape: the threshold map is a *matrix*, it
 * tiles, and a tile the size of the frame would make every texel's threshold a
 * function of its own position only — which is a picture that cannot tell a
 * correct wrap from a broken one.
 */
const SUPPLIED_TILE_SIZE = 32;

/** Seed for the tile above. Fixed, for the reason {@link NODE_SEED} is. */
const SUPPLIED_TILE_SEED = 0x7a1e_0d17n;

/**
 * Bytes for an instance-data slot that declares `supplied: "required"`.
 *
 * F-PP-07 is the only such binding in the catalogue: its matrix is an image the
 * user uploaded, so there is nothing in the descriptor for the harness to derive
 * it from and `resolvePassInstances` — correctly — refuses to substitute
 * anything. This table is what the harness uploads, and it is keyed by **slot**
 * rather than by effect id, because the slot is what the binding names.
 *
 * The same argument as {@link TILE_SOURCE}: a table rather than a branch, so an
 * effect that grows a required slot which is not in it fails the whole run
 * instead of quietly rendering without one.
 *
 * The bytes are a real void-and-cluster tile from the core, encoded through the
 * effect's own {@link encodeThresholdMap} — the one call the app's image loader
 * makes — so the reference records the shader's header parsing and unpacking
 * rather than a layout this file invented.
 */
const SUPPLIED_SOURCE: Readonly<Record<string, () => Uint8Array>> = {
  [THRESHOLD_MAP_SLOT]: () => {
    const size = SUPPLIED_TILE_SIZE;
    const ranks = core.blueNoiseRanks(size, SUPPLIED_TILE_SEED);
    const last = size * size - 1;
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i += 1) {
      const grey = Math.round(((ranks[i] ?? 0) * 255) / last);
      rgba[i * 4] = grey;
      rgba[i * 4 + 1] = grey;
      rgba[i * 4 + 2] = grey;
      rgba[i * 4 + 3] = 255;
    }
    return encodeThresholdMap(size, size, rgba);
  },
};

export type VariantId = "defaults" | "surprise";

const VARIANTS: readonly VariantId[] = ["defaults", "surprise"];

export interface PlannedRender {
  readonly effect: string;
  readonly name: string;
  readonly requirement: string;
  readonly family: string;
  readonly variant: VariantId;
  /** Passes the effect declares; reported so a pass appearing or vanishing is visible. */
  readonly passes: number;
  /** True when a quantizer runs upstream of this render. */
  readonly quantized: boolean;
}

export interface HarnessInfo {
  readonly adapter: {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
  };
  readonly fixture: {
    readonly id: string;
    readonly width: number;
    readonly height: number;
    /** Base64 of the 8-bit sRGB RGBA fixture, so the source PNG is written from the same bytes. */
    readonly rgba: string;
  };
  readonly palette: { readonly id: string; readonly entries: number };
  readonly registry: { readonly total: number; readonly gpu: number };
  readonly plan: readonly PlannedRender[];
}

export type RenderOutcome =
  | {
      readonly ok: true;
      readonly rgba: string;
      /**
       * The shape this render produced, which is not always the fixture's.
       * F-PP-01 and F-SP-14 resample, so the reference set stores a picture per
       * render at whatever extent that render wrote — and the Node side reads
       * the numbers from here rather than assuming.
       */
      readonly width: number;
      readonly height: number;
    }
  | { readonly ok: false; readonly error: string };

interface Prepared {
  readonly plan: readonly PlannedRender[];
  readonly params: readonly Readonly<Record<string, ParameterValue>>[];
  readonly descriptors: readonly EffectDescriptor[];
  readonly effects: readonly GpuEffect[];
}

let layer: GpuLayer | undefined;
let prepared: Prepared | undefined;
let palette: ReturnType<typeof uploadPalette> | undefined;
let sourceTexture: GPUTexture | undefined;
let quantizer: { descriptor: EffectDescriptor; gpu: GpuEffect } | undefined;

function paramTypesOf(descriptor: EffectDescriptor): ReadonlyMap<string, ParamDescriptor> {
  return new Map(descriptor.params.map((param) => [param.key, param]));
}

/**
 * Bytes for every slot this effect's passes declare as `supplied: "required"`.
 *
 * Enumerated from the bindings, so an effect that grows one is covered without
 * this file being edited — and an effect whose slot has no entry in
 * {@link SUPPLIED_SOURCE} fails here, naming the slot, rather than reaching the
 * scheduler as "carries no bytes for it".
 */
function suppliedFor(effect: GpuEffect): ReadonlyMap<string, Uint8Array> {
  const bytes = new Map<string, Uint8Array>();
  for (const pass of effect.passes) {
    for (const binding of pass.bindings) {
      if (binding.role !== "instance-data") continue;
      if (binding.supplied !== "required" || bytes.has(binding.slot)) continue;
      const source = SUPPLIED_SOURCE[binding.slot];
      if (source === undefined) {
        throw new Error(
          `"${effect.effect}" binds instance-data slot "${binding.slot}" as supplied ` +
            `"required", and nothing states what to upload for it. Add it to SUPPLIED_SOURCE ` +
            `in web/test/gpu-golden/harness.ts.`,
        );
      }
      bytes.set(binding.slot, source());
    }
  }
  return bytes;
}

/**
 * Every parameter pushed to the end of its surprise range furthest from its
 * default.
 *
 * Read out of the descriptor rather than chosen per effect, so the value is one
 * the Surprise generator can really produce and the picture is one the app can
 * really make. `seed` is left at its default because moving it would change the
 * frame without exercising anything the shader does differently; `color` has no
 * uniform-field representation yet and nothing is invented for it.
 *
 * `curve` declares archetypes rather than a range, so "furthest from the
 * default" is measured the only way a transfer curve can be: total vertical
 * distance from the diagonal, which is what the default *is*. Un-jittered, since
 * jitter is the sampler's randomness and every value here is pinned.
 */
function surpriseParams(descriptor: EffectDescriptor): Record<string, ParameterValue> {
  const params: Record<string, ParameterValue> = { ...defaultParams(descriptor) };
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
      case "curve": {
        let furthest: readonly CurvePoint[] | undefined;
        let widest = -1;
        for (const option of param.surprise.archetypes) {
          const points = CURVE_ARCHETYPES[option.value];
          const spread = points.reduce((total, p) => total + Math.abs(p.y - p.x), 0);
          if (spread > widest) {
            widest = spread;
            furthest = points;
          }
        }
        if (furthest !== undefined) params[param.key] = furthest.map((p) => ({ ...p }));
        break;
      }
      case "seed":
      case "color":
        break;
    }
  }
  return params;
}

/** Build an effect's passes, fetching whatever build-time data it declares. */
function buildEffect(resolver: GpuEffectResolver, id: string): GpuEffect {
  const requirement = resolver.requirementOf(id);
  if (requirement.kind === "none") return resolver.resolve(id, NO_GPU_BUILD_DATA);

  const source = TILE_SOURCE[id];
  if (source === undefined) {
    throw new Error(
      `"${id}" needs a ${requirement.size}x${requirement.size} threshold tile, and nothing ` +
        `states which generator produces it. Add it to TILE_SOURCE in ` +
        `web/test/gpu-golden/harness.ts, or — better — put the generator in ` +
        `GpuBuildRequirement so no caller has to know.`,
    );
  }
  const ranks =
    source === "blue-noise"
      ? core.blueNoiseRanks(requirement.size, BLUE_NOISE_SEED)
      : core.bayerRanks(requirement.size);
  return resolver.resolve(id, {
    kind: "threshold-matrix",
    matrix: thresholdMatrix(id, requirement.size, ranks),
  });
}

/**
 * The palette, straight out of the core's hardware library.
 *
 * Read rather than transcribed, exactly as docs/API.md requires of every caller:
 * a second copy of sixteen colours in a test file is a second thing that can
 * drift from the values the renderer actually uses.
 */
function loadPalette(): Palette {
  const handles = core.builtinPalettes();
  try {
    const entry = handles.find((p) => p.id === PALETTE_ID);
    if (entry === undefined) {
      throw new Error(
        `the core has no built-in palette "${PALETTE_ID}"; the golden set is rendered against it`,
      );
    }
    return {
      id: entry.id,
      name: entry.name,
      colors: Array.from(entry.srgb),
      metric: "oklab",
    };
  } finally {
    for (const handle of handles) handle.free();
  }
}

/** Linear-light planes back to the 8-bit sRGB RGBA a reference PNG stores. */
function encodeSrgb(
  surface: { r: Float32Array; g: Float32Array; b: Float32Array; a: Float32Array },
  width: number,
  height: number,
): Uint8Array {
  const pixels = width * height;
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const at = i * 4;
    out[at] = Math.max(0, Math.min(255, Math.round(linearToSrgb(surface.r[i] ?? 0) * 255)));
    out[at + 1] = Math.max(0, Math.min(255, Math.round(linearToSrgb(surface.g[i] ?? 0) * 255)));
    out[at + 2] = Math.max(0, Math.min(255, Math.round(linearToSrgb(surface.b[i] ?? 0) * 255)));
    out[at + 3] = Math.max(0, Math.min(255, Math.round((surface.a[i] ?? 0) * 255)));
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Wait for a software adapter to appear.
 *
 * Headless Chromium hands back `null` from `requestAdapter()` for a short window
 * while the GPU process is still bringing the SwiftShader Vulkan device up, and
 * the specified answer for "no adapter" is the same `null` as "this machine has
 * no GPU". Retrying is the only way to tell the two apart; not retrying makes
 * the whole job fail intermittently with a message that blames the wrong thing.
 */
async function awaitAdapter(): Promise<GPUAdapter> {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter !== null) return adapter;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "no WebGPU adapter after 10s — the browser was launched without a software adapter",
  );
}

async function initialise(): Promise<HarnessInfo> {
  // First, because the failure it catches surfaces deep inside `init()` as
  // something that does not mention it: the core is compiled with `+atomics`,
  // so its linear memory is shared, so `WebAssembly.instantiate` refuses it
  // without `SharedArrayBuffer`, which a document that is not cross-origin
  // isolated does not have. `run.mjs` asserts the same thing from the outside;
  // this one names it for anyone who opens the page by hand.
  if (globalThis.crossOriginIsolated !== true) {
    throw new Error(
      "the harness document is not cross-origin isolated, so SharedArrayBuffer is unavailable " +
        "and the WASM core (built with +atomics — shared memory) cannot instantiate. The server " +
        "must send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: " +
        "require-corp on every response, including the .wasm.",
    );
  }

  try {
    await init();
  } catch (error) {
    throw new Error(
      `the WASM core failed to instantiate: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      { cause: error },
    );
  }

  const adapter = await awaitAdapter();
  const report = await checkCapabilities();
  if (report.fatalFailures.length > 0) {
    throw new Error(
      `the browser cannot run the renderer: ` +
        report.fatalFailures.map((c) => `${c.label} — ${c.detail}`).join("; "),
    );
  }
  layer = await GpuLayer.create({ report });

  const registry: EffectRegistry = loadEffectRegistry();
  const resolver = loadGpuEffects();

  const documentPalette = loadPalette();
  palette = uploadPalette(layer.context, documentPalette, layer.buffers, `golden:${PALETTE_ID}`);

  sourceTexture = layer.textures.acquire(
    "rgba16float",
    FIXTURE_WIDTH,
    FIXTURE_HEIGHT,
    "golden/source",
  );
  writeColorSurface(
    layer.context,
    sourceTexture,
    fixtureAsLinearSurface(),
    FIXTURE_WIDTH,
    FIXTURE_HEIGHT,
    "golden/source",
  );

  // Sorted by id so the plan — and therefore the order of the run and of every
  // report — does not depend on the order the glob happened to return modules
  // in. A reference set whose order can shift is a diff nobody can read.
  const descriptors = [...registry.byExecution("gpu")].sort((a, b) => a.id.localeCompare(b.id));

  const plan: PlannedRender[] = [];
  const params: Record<string, ParameterValue>[] = [];
  const planDescriptors: EffectDescriptor[] = [];
  const effects: GpuEffect[] = [];

  for (const descriptor of descriptors) {
    const gpu = buildEffect(resolver, descriptor.id);
    await layer.compiler.compile(descriptor, gpu);
    for (const variant of VARIANTS) {
      plan.push({
        effect: descriptor.id,
        name: descriptor.name,
        requirement: descriptor.requirement,
        family: descriptor.family,
        variant,
        passes: gpu.passes.length,
        quantized: descriptor.requiresIndexMap,
      });
      params.push(
        variant === "defaults"
          ? { ...defaultParams(descriptor) }
          : surpriseParams(descriptor),
      );
      planDescriptors.push(descriptor);
      effects.push(gpu);
    }
  }

  const quantizerGpu = buildEffect(resolver, UPSTREAM_QUANTIZER);
  const quantizerDescriptor = registry.require(UPSTREAM_QUANTIZER);
  await layer.compiler.compile(quantizerDescriptor, quantizerGpu);
  quantizer = { descriptor: quantizerDescriptor, gpu: quantizerGpu };

  prepared = { plan, params, descriptors: planDescriptors, effects };

  return {
    adapter: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
    },
    fixture: {
      id: FIXTURE_ID,
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      rgba: toBase64(renderFixture()),
    },
    palette: { id: PALETTE_ID, entries: palette.count },
    registry: { total: registry.size, gpu: descriptors.length },
    plan,
  };
}

/**
 * One node's state, as `prepareNodePasses` takes it.
 *
 * The harness used to pack uniforms and assemble a `ScheduleUnit` by hand, which
 * worked for exactly as long as every pass wrote what it read and carried no
 * bulk data. It cost the catalogue four effects: F-PP-01 and F-SP-14 resample,
 * so their passes reach the executor with no resolved output extent, and F-PP-05
 * and F-PP-07 bind a per-node buffer nobody built. Going through the same call
 * `state/render/gpu-backend.ts` makes is what stops the harness from being a
 * second, weaker renderer that agrees with the product only where the product is
 * simple.
 */
function renderState(
  nodeId: string,
  descriptor: EffectDescriptor,
  gpu: GpuEffect,
  values: Readonly<Record<string, ParameterValue>>,
  paletteSize: number,
): NodeRenderState {
  const supplied = suppliedFor(gpu);
  return {
    nodeId,
    params: values,
    paramTypes: paramTypesOf(descriptor),
    seed: NODE_SEED,
    // Still frame at the start of the loop. Nothing here animates.
    normalizedTime: 0,
    paletteSize,
    ...(supplied.size === 0 ? {} : { supplied }),
  };
}

async function renderOne(index: number): Promise<RenderOutcome> {
  const active = prepared;
  const gpuLayer = layer;
  const gpuPalette = palette;
  const source = sourceTexture;
  const upstream = quantizer;
  if (
    active === undefined ||
    gpuLayer === undefined ||
    gpuPalette === undefined ||
    source === undefined ||
    upstream === undefined
  ) {
    return { ok: false, error: "renderOne called before init() resolved" };
  }

  const entry = active.plan[index];
  const descriptor = active.descriptors[index];
  const gpu = active.effects[index];
  const values = active.params[index];
  if (entry === undefined || descriptor === undefined || gpu === undefined || values === undefined) {
    return { ok: false, error: `no planned render at index ${index}` };
  }

  const nodeId = `golden/${entry.effect}/${entry.variant}`;
  const color = new SurfaceChain(
    gpuLayer.textures,
    "rgba16float",
    source,
    FIXTURE_WIDTH,
    FIXTURE_HEIGHT,
    `${nodeId}/color`,
  );
  const index_ = new SurfaceChain(
    gpuLayer.textures,
    "r32uint",
    null,
    FIXTURE_WIDTH,
    FIXTURE_HEIGHT,
    `${nodeId}/index`,
  );

  try {
    const fixtureExtent: Extent = { width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT };
    // The extent the effect under test reads. Not the fixture's the moment
    // anything upstream resamples — which nothing upstream here does, since the
    // quantizer is pointwise, but taking it from the prepared node rather than
    // assuming is what keeps that a fact instead of a coincidence.
    let reads = fixtureExtent;

    if (descriptor.requiresIndexMap) {
      const upstreamNode = prepareNodePasses(
        upstream.gpu,
        renderState(
          `${nodeId}/upstream`,
          upstream.descriptor,
          upstream.gpu,
          defaultParams(upstream.descriptor),
          gpuPalette.count,
        ),
        fixtureExtent,
      );
      for (const batch of planExecution([upstreamNode.unit]).batches) {
        gpuLayer.executor.run(batch, { color, index: index_, palette: gpuPalette });
      }
      reads = upstreamNode.output;
    }

    const node = prepareNodePasses(
      gpu,
      renderState(nodeId, descriptor, gpu, values, gpuPalette.count),
      reads,
    );
    for (const batch of planExecution([node.unit]).batches) {
      gpuLayer.executor.run(batch, { color, index: index_, palette: gpuPalette });
    }

    // What the chain actually holds, not what the plan predicted. The two agree
    // — `resolveScheduledOutput` refuses a pass where they do not — and reading
    // the chain means a readback can never be asked for a shape the texture is
    // not.
    const wrote = color.extent;
    const readback = await readColorSurface(
      gpuLayer.context,
      gpuLayer.staging,
      color.current,
      wrote.width,
      wrote.height,
      nodeId,
    );
    return {
      ok: true,
      rgba: toBase64(encodeSrgb(readback.surface, wrote.width, wrote.height)),
      width: wrote.width,
      height: wrote.height,
    };
  } catch (error) {
    // Collected rather than thrown past the driver: one effect that cannot run
    // must not hide the forty-three that can, exactly as the CPU harness
    // collects its comparison failures instead of asserting on the first.
    return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  } finally {
    const produced = color.hasContent ? color.current : null;
    const producedIndex = index_.hasContent ? index_.current : null;
    color.release();
    index_.release();
    if (produced !== null && produced !== source) gpuLayer.textures.release(produced);
    if (producedIndex !== null) gpuLayer.textures.release(producedIndex);
  }
}

/** What `run.mjs` calls over the DevTools protocol. */
export interface GoldenHarness {
  init(): Promise<HarnessInfo>;
  render(index: number): Promise<RenderOutcome>;
}

declare global {
  // eslint-disable-next-line no-var
  var __ditherOrkGolden: GoldenHarness | undefined;
  // eslint-disable-next-line no-var
  var __ditherOrkGoldenError: string | undefined;
}

globalThis.__ditherOrkGolden = {
  init: async () => {
    try {
      return await initialise();
    } catch (error) {
      // Recorded as well as rethrown: the driver reads this to print the real
      // cause, because a DevTools exception carries a stack the page can no
      // longer explain.
      globalThis.__ditherOrkGoldenError =
        error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
      throw error;
    }
  },
  render: renderOne,
};
