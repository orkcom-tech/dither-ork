# API

Contracts between the layers. Six surfaces: the WASM core, the node registry,
the `.dork` document, the GPU pass layer, the render graph, and the worker RPC.

Items marked **planned** are specified but not yet implemented.

---

## 1. WASM core

Compiled from `core/crates/dither-wasm`, generated into `web/src/wasm/pkg` by
the `wasm` compose service. Import and initialise before any other call:

```ts
import init, * as core from "./wasm/pkg/dither_wasm.js";
await init();
```

**Everything returned from this boundary that is not a typed array is a
`wasm-bindgen` handle.** Every getter copies out of WASM memory, and the handle
holds linear memory until `free()` is called. Read each getter once, hold the
result, and release the handle.

### `version(): string`

Version of the compiled core. Logged at startup so a stale WASM build is
visible rather than mysterious.

### `kernels(): KernelInfo[]`

Every registered error-diffusion kernel, in catalogue order. The web layer
builds its effect list from this rather than keeping a parallel copy that can
drift out of sync — and it carries the display name as well as the id for
exactly that reason, since a UI that has only ids has to invent labels, and
invented labels are a second list.

```ts
const handles = core.kernels();
const kernels = handles.map((k) => ({ id: k.id, name: k.name }));
for (const handle of handles) handle.free();
// [{ id: "floyd-steinberg", name: "Floyd-Steinberg" }, ...]
```

### `DitherOptions`

Every control of F-ED-CTL, as one object. This replaced the eight positional
parameters `dither_image` used to take: the controls only grow — threshold
jitter, the overshoot clamp and the channel mode arrived together and would have
made it eleven — and a call site with eleven bare positionals is one
transposition away from silently dithering with the wrong strength.

The kernel is a constructor argument rather than a settable property because it
is the one choice the object cannot be built without, and because resolving it
once means an unknown id is reported where it was written instead of at render
time.

```ts
class DitherOptions {
  constructor(kernel_id: string);   // throws on an unrecognised id
  readonly kernelId: string;
  strength: number;                 // 0..=1; 0 is plain nearest-colour quantization
  serpentine: boolean;              // alternate scan direction per row
  jitter: number;                   // 0..=1, seeded threshold jitter
  seed: bigint;                     // 64-bit, explicit; nothing invents one
  overshootLimit: number;           // headroom outside [0, 1] for the working buffer
  channels: DiffusionChannels;      // PerChannel | Luma
  metric: ColorMetric;              // Oklab | Srgb
  free(): void;
}
```

Ranges are checked when the options are *used*, not in the setters. A setter
that silently clamps is a setter that lies about what it stored, and one that
throws makes a property assignment a `try` block; both are worse than one
refusal at the point the values are read.

`seed` is a `BigInt` because the document seed is 64 bits (F-SM-02) and
narrowing it to a JS `number` would quietly throw away half of it.

**`metric` is a look control, not a correctness switch.** `Oklab` is
perceptually correct; `Srgb` reproduces what period-accurate tools did by doing
the maths in gamma space.

`serpentine` is ignored by Riemersma, which does not scan in rows at all. The
registry descriptor for that kernel omits the control rather than showing an
inert one.

### `ditherImage(...): DitherOutput`

```ts
function ditherImage(
  rgba: Uint8Array,        // 8-bit sRGB RGBA, width * height * 4 bytes
  width: number,
  height: number,
  palette_rgb: Uint8Array, // packed sRGB triplets, length % 3 === 0
  options: DitherOptions,  // carries the kernel
): DitherOutput;
```

Decodes to linear light, dithers, re-encodes to sRGB.

Throws rather than panicking on bad input — a malformed call surfaces as a JS
error instead of an aborted WASM instance. Error cases: zero dimensions, buffer
length mismatch, empty or misaligned palette, a palette larger than a `u16`
index map can address, and any control outside its range.

### `DitherOutput`

| Member | Type | Notes |
| --- | --- | --- |
| `width` | `number` | |
| `height` | `number` | |
| `pixels` | `Uint8Array` | 8-bit sRGB RGBA, ready for `ImageData` or a texture upload |
| `indices` | `Uint16Array` | one palette index per pixel |

Both buffers are returned deliberately. The **index map** is what makes
hue-targeted recolour, index remap, outline, dilate/erode and the SVG tracer
lossless and cheap; carrying it is a chosen memory cost.

### `builtinPalettes(): PaletteInfo[]`

The hardware palette library (F-CO-04), in catalogue order. Same arrangement as
`kernels()`: the web layer reads this table rather than keeping a copy that can
drift from the values the renderer uses.

```ts
class PaletteInfo {
  readonly id: string;    // stable; .dork documents store it
  readonly name: string;
  readonly srgb: Uint8Array;  // packed 8-bit sRGB triplets
  free(): void;
}
```

Only factual hardware colour specifications are bundled. The NES and the Apple
II are absent because neither has a digital RGB specification — both emit
composite, so every published table is one particular measurement — and a
palette whose real values cannot be established is left out rather than shipped
with invented numbers.

### `extractPalette(...): ExtractedPalette`

Automatic palette extraction (F-CO-02). Decodes to linear light, clusters
there, and returns sRGB triplets — the same round trip `ditherImage` does, so an
extracted palette fed straight back in matches what the extraction saw.

```ts
class ExtractOptions {
  constructor();                // Wu, k = 16, seed = 0n, maxIterations = 64
  method: ExtractMethod;        // MedianCut | Wu | KMeans
  k: number;                    // requested size; the result may be smaller
  seed: bigint;
  maxIterations: number;        // Lloyd ceiling; ignored by the single-pass methods
  free(): void;
}

function extractPalette(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: ExtractOptions,
): ExtractedPalette;
```

| Member | Type | Notes |
| --- | --- | --- |
| `srgb` | `Uint8Array` | packed triplets, ready to hand back to `ditherImage` |
| `indices` | `Uint16Array` | one palette index per source pixel |
| `populations` | `Uint32Array` | pixels matched to each entry; input to a population sort (F-CO-06) |
| `paletteLen` | `number` | entries actually produced |
| `occupiedBins` | `number` | occupied histogram bins — the ceiling on palette size for this image, and the explanation for a short palette |
| `iterations` | `number` | Lloyd iterations run; zero for the single-pass methods |
| `emptyClusterRepairs` | `number` | clusters re-seeded deterministically after losing every member |
| `emptyClustersDropped` | `number` | clusters still empty at the end, producing no entry |

The report travels with the result rather than being logged inside the core:
`dither-core` has no logger, because a crate that must not know a browser exists
must not pick the browser's logging story either.

**All three methods take a seed**, even though only k-means draws from one
today, so the document records a seed for every extraction and a later change
that adds a stochastic step cannot quietly become unseeded.

Throws on zero dimensions, a buffer length mismatch, a `k` outside `1..=65536`,
or `maxIterations` of zero — each a caller error the core would otherwise
panic on.

### `bayerRanks(size)` and `blueNoiseRanks(size, seed)`

Threshold tiles for the ordered dithers (F-OD-01..05).

```ts
function bayerRanks(size: number): Uint32Array;              // size a power of two >= 2
function blueNoiseRanks(size: number, seed: bigint): Uint32Array;  // power of two >= 4
```

**Ranks, not normalized thresholds.** Both return `size * size` integers that
are a permutation of `0 .. size*size - 1`; the shader turns rank `k` into the
threshold `(k + 0.5) / (size * size)` itself. Integers cross the language
boundary exactly, whereas two float implementations of the same recursion
disagree in the last bit and put a visible seam between a CPU preview and a GPU
export. It is also the natural output of both generators — Bayer's recursion
produces an ordering, and void-and-cluster produces one by definition.

`web/src/gpu/matrices.ts` validates the permutation before a tile is uploaded. A
generator that repeats a rank produces a tile that dithers, looks broadly right,
and has a fixed pattern of pixels that never cross their threshold.

Blue noise is Ulichney's void-and-cluster method, not a white-noise texture with
a blue name, and it costs `O(size^4)`: 64x64 is a fraction of a second, so build
once and cache.

### Rust-side contract

`dither-core` has no web dependencies and must keep it that way — that boundary
is what makes a future native or CLI build a packaging exercise rather than a
rewrite.

```rust
pub fn dither(
    pixels: &[Rgba],          // linear light, unassociated alpha
    width: usize,
    height: usize,
    palette: &Palette,
    kernel: &Kernel,
    opts: Options,
) -> DitherResult;            // { pixels: Vec<Rgba>, indices: Vec<u16> }
```

Adding a kernel means adding a `Kernel` constant — an id, a name, a tap table
and a divisor — and listing it in `KERNELS`. No new code paths:

```rust
pub const FLOYD_STEINBERG: Kernel = Kernel {
    id: "floyd-steinberg",
    name: "Floyd-Steinberg",
    taps: &[tap!(1, 0, 7.0), tap!(-1, 1, 3.0), tap!(0, 1, 5.0), tap!(1, 1, 1.0)],
    divisor: 16.0,
};
```

Tap `dx` is mirrored automatically on right-to-left rows when serpentine
scanning is on, so tables are written exactly as published.

---

## 2. Node registry

Defined in `web/src/types/registry.ts`; discovered, validated and sealed by
`web/src/registry/`. The single source of truth about effects: the UI builds its
effect list from it, the graph schedules from it, and the Surprise generator
samples from it. There is no second list anywhere.

```ts
interface EffectDescriptor {
  readonly id: string;                 // "floyd-steinberg", "bayer-8"
  readonly name: string;
  /** The spec requirement this implements, e.g. "F-ED-01". */
  readonly requirement: string;
  readonly slot: "preprocess" | "dither" | "postprocess";
  readonly family:
    | "preprocess" | "error-diffusion" | "ordered" | "pattern" | "glitch" | "special";
  readonly execution: "wasm" | "gpu";
  readonly params: readonly ParamDescriptor[];
  /** Relative likelihood in Surprise Me. 1.0 is ordinary; niche effects sit lower. */
  readonly surpriseWeight: number;
  /** True when this node quantizes and therefore emits an index map. */
  readonly producesIndexMap: boolean;
  /** True when it reads one — outline, dilate/erode, hue-targeted recolour. */
  readonly requiresIndexMap: boolean;
  /** Effect ids it must not share a stack with; the grammar excludes them. */
  readonly excludes?: readonly string[];
}
```

`ParamDescriptor` is a **discriminated union over `type`**, not one shape with
optional fields: `float`, `int`, `bool`, `enum`, `color`, `seed` and `curve`
each carry the surprise metadata that kind actually needs. A bool has a
`trueProbability` and no range; an enum draws from a weighted subset of its own
values; a colour samples in OKLab, because sampling sRGB channels independently
clumps around muddy mid-greys. Read the file for the full set — it is the
authority and this section does not duplicate it.

`execution` has exactly two values and needs no third; see
docs/ARCHITECTURE.md, "The constraint everything follows from", for why, and for
what F-GL-06 would cost.

### What is registered

63 effects, all validated:

| Family | Count | Execution | Slot |
| --- | --- | --- | --- |
| `error-diffusion` | 15 | `wasm` | dither |
| `ordered` | 5 | `gpu` | dither |
| `pattern` | 8 | `gpu` | dither |
| `special` | 15 | `gpu` | 12 preprocess, 3 postprocess |
| `glitch` | 16 | `gpu` | postprocess |
| `preprocess` | 4 | `gpu` | preprocess |

Totals: 15 `wasm`, 48 `gpu`; 16 preprocess, 28 dither, 19 postprocess.

Two of the spec's 61 named effects are deliberately absent: **F-GL-06** JPEG
glitch (needs an encoder, and therefore an execution kind that does not exist)
and **F-SP-14** nearest-neighbour upscale (a resampling stage, not a pass — it
belongs with F-PP-01 and F-EX-12).

The `preprocess` family holds F-PP-02 (brightness/contrast), F-PP-03 (levels),
F-PP-04 (HSL) and F-PP-06 (noise injection). The other four F-PP requirements
are not effect descriptors and will not become ones: F-PP-01 is the internal
resolution stage, F-PP-05 needs an editable spline that `ParamDescriptor`'s
`curve` kind declares but nothing packs, and F-PP-07/08 take an uploaded image.

`web/src/registry/catalogue.test.ts` asserts every number in that table, runs
the startup validator over the shipped descriptors, and checks that every `gpu`
effect has a shader named after its id and that no shader is orphaned. An effect
that stops being discovered fails the build instead of quietly leaving a gap in
the stack panel.

### Adding an effect is adding one file

One effect is one module under `web/src/effects/` whose name ends in
`.effect.ts` and whose default export is a descriptor. `registry/discovery.ts`
collects them with `import.meta.glob`, eagerly, at startup. Nothing central is
edited, so two effects written in parallel cannot conflict — which is not
hypothetical: the catalogue arrived as nine parallel contributions and none of
them touched a shared file.

A parallel effect's module carries four more things beside the descriptor: the
uniform layout, the `ComputePass` list, the `GpuEffect` that wraps them, and the
`gpu` source that resolves the id to it. They live together because the
parameter keys, the byte offsets and the shader's `struct Params` are the same
fact written three times, and splitting them puts a rename one file away from a
wrong picture with no error.

Helper modules may sit in the same directory; the `.effect.ts` suffix is what
distinguishes a descriptor from a helper. `effects/error-diffusion.ts` is one —
the shared F-ED-CTL control set and the factory that stamps the 15 kernel
descriptors from it.

The glob matching nothing is itself a failure, because a renamed directory
produces exactly that and would otherwise present as an app with no effects.

### Validation

**Validation runs at startup and it is terminal.** `loadEffectRegistry()`
discovers, validates the whole set, and returns a sealed registry, or logs one
line per issue naming the effect and the module it came from and throws
`RegistryValidationError`.

A missing `surprise` range, a missing distribution, a `surpriseWeight` of zero,
a duplicate id, a default outside its own legal range, a log distribution over a
range that includes zero, an `error-diffusion` effect claiming `gpu` execution,
an index-map consumer in the `preprocess` slot — each fails the whole
catalogue. Nothing is repaired and nothing is dropped: a catalogue that is 62
effects because one was quietly discarded is worse than one that refuses to
start.

Startup is expected to surface that rather than continue. `web/src/main.ts`
renders the verdict and every issue on the page, and stops.

---

## 3. `.dork` document

Defined in `web/src/types/document.ts`. A document is Source + Stack + Palette +
Clock + Bindings — the unit that is saved, shared by URL, applied across a
batch, and generated whole by Surprise Me.

```jsonc
{
  "schema": 1,
  "source": { "name": "photo.png", "width": 1600, "height": 1200 },
  "palette": {
    "id": "gameboy-dmg",
    "name": "Game Boy DMG",
    "colors": [8, 24, 32, 52, 104, 86, 136, 192, 112, 224, 248, 208],
    "metric": "oklab"
  },
  "clock": { "frames": 48, "fps": 24 },
  "stack": [
    {
      "id": "n1",
      "effect": "internal-resolution",
      "enabled": true,
      "opacity": 1,
      "blend": "normal",
      "params": { "factor": 4, "filter": "box" },
      "seed": 0
    },
    {
      "id": "n2",
      "effect": "floyd-steinberg",
      "enabled": true,
      "opacity": 1,
      "blend": "normal",
      "params": { "strength": 1, "serpentine": true },
      "seed": 991
    }
  ],
  "bindings": [
    {
      "nodeId": "n2",
      "param": "strength",
      "shape": "sine",
      "amount": 0.25,
      "cyclesPerLoop": 2,
      "phase": 0,
      "bipolar": true
    }
  ],
  "surpriseSeed": "7f3a1c92b04e5d68"
}
```

Rules that the schema encodes:

- **`colors` is packed sRGB triplets**, not hex strings — the same layout the
  WASM boundary takes, so no conversion sits between them.
- **`cyclesPerLoop` is an integer.** That single constraint is why frame `N`
  equals frame `0` and the loop closes without a crossfade. The UI snaps it; the
  loader rejects non-integers.
- **Every node carries a `seed`.** No node reads an unseeded RNG, which is what
  makes a document reproducible and the loop-seam test possible.
- **`source` is a reference, not the image.** The self-contained variant adds
  `source.dataUrl`. A share URL carries the recipe, never the picture.
- **`surpriseSeed`**, when present, reproduces the whole document exactly.

Normalized loop time:

```ts
normalizedTime(clock, frame) === (frame % clock.frames) / clock.frames  // never reaches 1
```

Documents are versioned. A newer `schema` than the build understands is
**refused**, not read on a best-effort basis.

---

## 4. GPU pass layer

Defined in `web/src/types/gpu.ts`; implemented in `web/src/gpu/`. The contract
between a parallel effect and the pass compiler that schedules it.

An effect provides a `GpuEffect`: an id and one or more `ComputePass`es. Each
pass declares its complete, constant WGSL, its entry point, its
`@workgroup_size`, a `DispatchShape` (`per-pixel`, `per-row`, `per-column`,
`fixed`), a `PassAccess` (`pointwise`, `neighbourhood`, `global`), its bindings
by role, and its uniform layout **with explicit byte offsets**.

Three rules the layer enforces rather than documents:

- **Offsets are declared, not derived.** WGSL's uniform address space is
  std140-like, so a packer that lays fields out sequentially writes to addresses
  the shader does not read from — and the symptom is a wrong-looking image with
  no error anywhere. `uniforms.ts` validates alignment, overlap and total size
  on every pack and throws naming the field.
- **A binding role has the same binding number in every shader** (0 input
  colour, 1 output colour, 2 input index, 3 output index, 4 palette, 5 uniforms,
  6+ tables and scratch), so any shader can be read without cross-referencing
  its descriptor. `web/src/shaders/CONVENTIONS.md` is the full set.
- **A pass that writes nothing observable is a compile error**, not a no-op
  dispatch.

Scheduling is `planExecution(units)` over the stack in order: a maximal run of
consecutive `gpu` nodes becomes one `PassBatch` encoded into one command buffer,
and each `gpu`↔`wasm` transition is counted as a **crossing**. The crossing
count, not the pass count, is what sets the ceiling on how live the preview
feels, so it is planned and logged rather than discovered.

`boundary.ts` is the only place a surface changes residency. Every readback and
every upload logs its node, direction, byte count and duration — the known
performance trap has to be readable from the console rather than found with a
profiler.

Working surfaces are `rgba16float` for colour and `r32uint` for the index map.
Input and output are always different textures: `PassAccess` permits a
`pointwise` pass to alias them but WebGPU does not, so `SurfaceChain`
ping-pongs.

### Getting from an effect id to its passes

**One named export per module.** An effect whose descriptor says
`execution: "gpu"` also exports `const gpu: GpuEffectSource`, built with
`staticGpuEffect` or `thresholdMatrixGpuEffect` from `web/src/types/registry.ts`.
`registry/gpu-effects.ts` collects those with the same glob that collects the
descriptors, and `loadGpuEffects()` returns a `GpuEffectResolver`.

```ts
const resolver = loadGpuEffects();
const requirement = resolver.requirementOf(id);   // ask first
const effect = requirement.kind === "none"
  ? resolver.resolve(id, NO_GPU_BUILD_DATA)
  : resolver.resolve(id, { kind: "threshold-matrix", matrix });
```

**The source is a source rather than a `GpuEffect` because not every effect is
constructible from nothing.** The five ordered dithers need a threshold tile out
of `dither-core` before their passes can be named, so `GpuEffectSource.requires`
states what the effect is waiting for and the caller fetches it *before* asking
for passes. A design that assumed every effect could be built from nothing would
have worked for forty-three of the forty-eight and quietly excluded the family
the dither slot is named after.

Coverage is checked against the sealed catalogue, not assumed. A `gpu`
descriptor with no source, a source with no descriptor, a `wasm` descriptor that
exports passes anyway, or two modules claiming the same id — each fails the whole
catalogue the way a missing surprise range does, because a resolver that is
silently one effect short renders a document with one node missing, and that is
a picture nobody can tell is wrong.

One thing the requirement does **not** carry, and it is a real gap: the tile
*size* but not which generator produces it. A caller holding nothing but an
effect id therefore cannot ask the core for the right tile, and both
`web/test/gpu-golden/harness.ts` and `web/src/gpu/effects/` carry a small table
saying "`blue-noise` wants void-and-cluster, the four Bayers want Bayer". That
belongs in `GpuBuildRequirement`, so that an effect needing a tile that nobody
has taught the table about fails loudly instead of quietly receiving a plausible
wrong screen.

### Conventions the shaders settled on

`web/src/shaders/CONVENTIONS.md` is the authority. Three things it did not
predict, established while the catalogue was written and now in force:

- **Angles are in turns, never degrees**, wherever a modulator might bind to
  one — tile rotation, emboss light angle, drag angle, spiral rotation. A
  parameter ramping 0 → 1 then closes the loop by construction and the UI never
  has to know that 360 is special. Screen angles in the halftone family are the
  exception and are in degrees, because 15/75/0/45 is the requirement's own
  wording and a printer's.
- **An enum reaches a shader as its ordinal**, restated as a `const` block at
  the top of the WGSL against the descriptor's `values` order. Both sides say so,
  and both say the list is append-only: inserting a value in the middle
  renumbers every saved document.
- **Shared blocks are fenced and duplicated**, per CONVENTIONS.md — 38 of the 48
  shaders carry at least one. The palette search, the sRGB transfer, the clamped
  texel fetch, the perceptual-lightness pair, the gaussian kernel geometry and
  the halftone dot areas are each identical everywhere they appear. The seeded
  hash is the one that is **not**: three variants exist under three fence names
  (`seeded hash`, `seeded hashing`, `integer hash`), each self-consistent, plus
  one unfenced copy in `datamosh-smear.wgsl`. All four are deterministic
  functions of pixel and seed, so nothing is unseeded — but they are one thing
  written four ways, and they should be one.

## 5. Render graph

Defined in `web/src/types/graph.ts`; implemented in `web/src/graph/`. It
schedules a document, hashes it, caches node outputs and executes against the
GPU and WASM backends. It computes no pixels itself — `backend.ts` is that line.

```ts
const cache = new NodeCache({ budget: { maxBytes }, surfaces, log: logger("graph") });
const outcome = await renderGraph({ graph, source, palette, retain: { kind: "all" } }, deps);
await renderAnimation({ frames, graphForFrame, source, palette, onFrame }, deps);
```

Every node exposes a **content hash** over its parameters, seed and input hash;
outputs are cached against it, so editing a parameter invalidates that node and
everything downstream and nothing upstream re-runs. The cache has an explicit
byte budget with LRU eviction and a logged eviction event, not an
out-of-memory crash.

## 6. Worker RPC — **planned**

Comlink interfaces. The main thread holds UI state only; it never renders.

```ts
interface RenderWorker {
  init(canvas: OffscreenCanvas): Promise<void>;
  setDocument(doc: DitherDocument): Promise<void>;
  /** Patch one parameter; invalidates that node and everything downstream. */
  setParam(nodeId: string, key: string, value: ParameterValue): Promise<void>;
  renderFrame(frame: number, quality: "preview" | "full"): Promise<RenderStats>;
  play(fps: number): Promise<void>;
  stop(): Promise<void>;
}

interface RenderStats {
  readonly frame: number;
  readonly ms: number;
  readonly nodesExecuted: number;
  readonly cacheHits: number;
  /** Bytes moved across the GPU/CPU boundary — the known perf ceiling. */
  readonly boundaryBytes: number;
}

interface ExportWorker {
  exportStill(doc: DitherDocument, format: StillFormat, scale: number): Promise<Blob>;
  exportAnimation(
    doc: DitherDocument,
    format: AnimatedFormat,
    scale: number,
    onProgress: (frame: number, total: number) => void,
  ): Promise<Blob>;
  exportVector(doc: DitherDocument, options: VectorOptions): Promise<Blob>;
  cancel(): Promise<void>;
}
```

`cancel()` actually stops the worker; it does not merely stop reporting.

Animated export re-evaluates only **bound** nodes per frame. Unbound nodes
render once and are reused across all frames.

---

## 7. Capability report

`web/src/lib/capabilities.ts`, implementing F-UI-12.

```ts
interface Capability {
  readonly id: string;       // "webgpu", "sab", "opfs", "fsa"
  readonly label: string;
  readonly fatal: boolean;
  readonly state: "ok" | "missing";
  readonly detail: string;   // what this means for the user, one line
}

interface CapabilityReport {
  readonly capabilities: readonly Capability[];
  readonly fatalFailures: readonly Capability[];
  readonly usable: boolean;
  readonly adapterInfo?: GPUAdapterInfo;
}
```

| Capability | Fatal | On failure |
| --- | --- | --- |
| WebGPU | yes | unsupported screen naming the requirement |
| SharedArrayBuffer | yes | unsupported screen; in dev it means COOP/COEP are missing |
| OPFS | no | autosave and libraries fall back to IndexedDB |
| File System Access | no | batch degrades to multi-select in, ZIP out |

Non-fatal degradation is always **stated in the UI**. There are no silent
fallbacks.

---

## 8. Logging

`web/src/lib/log.ts`.

```ts
const log = logger("gpu", correlationId());
log.info("pass compiled", { effect: "bayer-8", ms: 1.4 });
await log.time("readback", () => device.queue.onSubmittedWorkDone());
```

Channels: `app`, `graph`, `gpu`, `wasm`, `export`, `batch`, `io`.
Levels: `debug`, `info`, `warn`, `error` — `debug` in dev, `info` in production.

`time()` logs duration on success **and** on failure, then rethrows. No error
path is silent and no `catch` is empty.
