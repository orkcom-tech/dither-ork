# API

Contracts between the layers. Nine surfaces: the WASM core, the node registry,
the `.dork` document, the GPU pass layer, the render graph, the editor session,
the shell's slots, export, and the worker RPC.

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

### `traceSvg(indices, width, height, paletteRgb, options): TracedSvg`

F-EX-08 through F-EX-10. `indices` is one palette index per pixel, row-major —
exactly what `DitherOutput.indices` and `ExtractedPalette.indices` hand back —
and `paletteRgb` is the packed sRGB triplet layout everything else at this
boundary already takes.

```ts
const options = new core.TraceOptions();
options.mode = core.TraceMode.Simplified;  // or PixelPerfect
options.tolerance = 2;                     // px, read only in Simplified
options.minFeatureArea = 64;               // px², regions and holes below go
options.strokeOnly = false;                // outlines for a cutter
options.strokeWidth = 1;
const traced = core.traceSvg(indices, w, h, paletteRgb, options);
const svg = traced.svg;                    // read once, then free
traced.free(); options.free();
```

One `<g>` per palette colour that survives into the output, marked
`inkscape:groupmode="layer"` and labelled with the colour, so a cutter or an
embroidery machine sees layers it understands rather than one undifferentiated
drawing. A colour absent from the index map produces **no** group rather than an
empty one, so `layers` can be below the palette size. Every coordinate is an
integer pixel corner, which is why adjacent colours share their boundary exactly
and there is no seam.

`TracedSvg` carries a report as well as the document — `layers`, `contours`,
`points`, `contoursDropped`, `regionsDropped`, `regionPixelsDropped`,
`holesFilled`, `holePixelsFilled`, `uncoveredPixels` — for the same reason
`ExtractedPalette` does: `dither-core` has no logger, and the two dropped counts
are the difference between "the tracer lost my detail" and "the minimum feature
size you set removed 412 specks". `uncoveredPixels` is the one to put in front
of a person: on a Floyd-Steinberg dither a `minFeatureArea` large enough to make
the file usable can leave a startling fraction of the image bare, and that is a
thing to be told before it goes to a cutter, not after.

Every condition the core would panic on is checked at the boundary first, so a
malformed call is a rejected promise rather than an aborted WASM instance.

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
  /** One line: what it does to a picture. Shown on every picker row. */
  readonly summary: string;
  /** The full account — what it does, what the controls change, where it
      belongs in a stack, and what it is confused with. */
  readonly description: string;
  /** What a person would type looking for this. Searched, never displayed. */
  readonly keywords: readonly string[];
  /** The family idea, if it belongs to one — a key of `EFFECT_CONCEPTS`. */
  readonly concept?: EffectConcept;
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
  /** True when it writes a different extent than it reads. Such a node cannot
      composite against its own input, so the row hides opacity and blend. */
  readonly resamples?: boolean;
}
```

`ParamDescriptor` is a **discriminated union over `type`**, not one shape with
optional fields: `float`, `int`, `bool`, `enum`, `color`, `seed` and `curve`
each carry the surprise metadata that kind actually needs. A bool has a
`trueProbability` and no range; an enum draws from a weighted subset of its own
values; a colour samples in OKLab, because sampling sRGB channels independently
clumps around muddy mid-greys. Every kind also carries a `label` and a
`description` — the one sentence saying what moving this control does to the
picture. Read the file for the full set — it is the authority and this section
does not duplicate it.

**The descriptive fields are the only copy.** The properties panel, the effect
picker, the hover help (F-UI-13) and the generated catalogue in the user guide
(F-UI-14) all read them; none of those four contains prose about an effect. That
is F-UI-15, and the validator below enforces it rather than trusting it.
`EFFECT_CONCEPTS`, in the same file, holds the nine *family* ideas — error
diffusion, ordered dithering, halftone screens, tone and colour, neighbourhood
filters, optical artefacts, glitch, the index map, working resolution — because
those are about a group of effects and belong to no single descriptor.

`execution` has exactly two values and needs no third; see
docs/ARCHITECTURE.md, "The constraint everything follows from", for why, and for
what F-GL-06 would cost.

### What is registered

67 effects, all validated:

| Family | Count | Execution | Slot |
| --- | --- | --- | --- |
| `error-diffusion` | 15 | `wasm` | dither |
| `ordered` | 6 | `gpu` | dither |
| `pattern` | 8 | `gpu` | dither |
| `special` | 16 | `gpu` | 12 preprocess, 4 postprocess |
| `glitch` | 16 | `gpu` | postprocess |
| `preprocess` | 6 | `gpu` | preprocess |

Totals: 15 `wasm`, 52 `gpu`; 18 preprocess, 29 dither, 20 postprocess.

Four requirements the spec names have no descriptor, and **the application says
so by name** rather than leaving a search to come back empty. They are declared
in `web/src/registry/unbuilt.ts`, with the reason and the closest built
alternatives, and `search.test.ts` asserts that none of them is a registered
effect — so an entry that becomes real fails the build instead of going on
telling people a shipped effect does not exist:

| Requirement | | Why not |
| --- | --- | --- |
| **F-GL-06** | JPEG glitch | Needs a JPEG encoder inside the render path, and therefore an execution kind that does not exist |
| **F-PT-09** | Luminance-displaced line screen | Nothing in the catalogue displaces by the picture; the missing piece is that, plus hidden-line removal |
| **F-PT-10** | Wave field with obstacle interaction | Needs a signed distance field — shared infrastructure (F-INF-01) that is not built |
| **F-PP-08** | Node masking | A mask is a second image edge on the graph, and the graph carries one per node |

`registry/search.ts` consults that table only after the catalogue has returned
nothing, and `describeMiss` writes the sentence — one implementation, so the
picker, the hover help and the guide give the same account of the same miss.

**F-SP-14** nearest-neighbour upscale was a fifth such gap and is now built: it
is the other half of the F-PP-01 pair — internal resolution runs the middle of
the stack small, nearest upscale brings the frame back to size with the chunk
intact — which is what made it a pass rather than a resampling stage.

The `preprocess` family holds F-PP-01 (internal resolution), F-PP-02
(brightness/contrast), F-PP-03 (levels), F-PP-04 (HSL), F-PP-05 (curves) and
F-PP-06 (noise injection). F-PP-07, an uploaded threshold map, is registered in
the `ordered` family, because a user-supplied threshold map *is* an ordered
dither; its image arrives through `InstanceDataBinding` rather than as a
parameter. **F-PP-08 (masking) is the one F-PP requirement with no descriptor
and will not get one**: it is a second image edge on the graph, and the graph
gives each node one input.

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
catalogue. Nothing is repaired and nothing is dropped: a catalogue that is 66
effects because one was quietly discarded is worse than one that refuses to
start.

**The prose is validated on the same terms** (F-UI-15). A missing `summary`,
`description` or `keywords` on an effect, or a missing `description` on any
parameter, is `missing-summary` / `missing-description` / `missing-keywords` and
fails the catalogue. So does a duplicated keyword. So — and this is the one that
matters in practice — does `unhelpful-description`: text that normalises to the
same thing as the label, the key, the name or, for a description, the summary.
An effect whose description echoes its name arrives undocumented exactly as one
with no description does, and costs a reader the same time while looking like it
was written. **The fix for a validation failure here is the text, never the
rule.**

Startup is expected to surface that rather than continue. `app/boot.ts` returns
`registry-failed` and `app/StartupFailureScreen.tsx` puts the verdict and every
issue on the screen instead of the application. The proof page does the same
thing on its own page.

### What the grammar checks, and what it does not

`registry/stack.ts` validates a whole stack: index-map dependencies (a node that
reads one must be downstream of a node that emits one) and declared exclusions.
The stack editor consults it *before* a node is added or moved, so an illegal
stack is refused with a reason at the picker rather than built and then found
broken.

It does **not** know about extents. `internal-resolution` placed after a
quantizer resamples colour while an index map is live at the old extent; that is
refused, correctly, but by the pass scheduler at render time — so it reaches the
user as an error banner rather than as a disabled entry in the picker. The check
is right and it is in the wrong layer.

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

### `bindings` is the only animation the schema carries

`bindings` holds **modulators** and nothing else. Two things that animate are
not in it, and both are stated here rather than discovered:

- **Keyframe tracks (F-AN-08)** live in `web/src/ui/timeline/model.ts` for the
  session. They survive an edit and do **not** survive a save, a share link or a
  reload. The timeline panel says so.
- **Temporal variation (F-AN-04)** — stepping a node's seed or pattern offset per
  frame — is a plan option (`AnimationOptions.variations`), not a document field.
  `web/src/animation/temporal.ts` implements and tests it; nothing sets it.

Modulator bindings round-trip in both directions. A document that arrives with
them becomes timeline tracks (`TimelineStore.#adopt`), and a track a person makes
becomes bindings (`TimelineStore.#publish` → `store.setBindings`), so an
animation made in the editor is in the `.dork`, the autosave and the share link.

One consequence worth stating because it caught this code: **a still export of an
animated document is the frame at the playhead.** Once tracks are written back,
`store.document` carries bindings and `buildRenderGraph` refuses it, so
`exportSourceFor` takes the timeline and resolves the playhead's frame. It is
also the right answer independently — the honest response to "export this as a
PNG" is the picture on screen.

### Who may hand a bound document to the renderer: nobody

`state/render/graph.ts`'s `buildRenderGraph` **throws** on a document whose
`bindings` is non-empty, and that is permanent rather than a gap. It compiles a
document to a graph; a binding's value depends on a frame and a modulator shape,
so there is nothing for it to compile, and compiling the authored value instead
would draw a picture that is not the document.

The resolution happens upstream, and there is exactly one way in:

```ts
const plan = planAnimation(document, registry, { timing, variations });   // animation/plan.ts
const seam = validateLoopSeam(plan, { hashForFrame });                    // F-AN-06, before exporting
const frameDocument = documentAtFrame(plan, frame);                       // bindings resolved, list empty
const graph = buildRenderGraph(frameDocument, { width, height, quality, frame, solo });
```

`ui/timeline/evaluate.ts` wraps this with the keyframe tracks and exposes the
same two names, which is what the live preview (`ui/timeline/preview.ts`) and the
animated export (`ui/export/animated.ts`) both call. Anything else that wants a
frame of an animated document goes through one of those two.

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
have worked for forty-six of the fifty-two and quietly excluded the family
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

## 6. Editor session and document store

`web/src/state/`. The session is the one call that turns the shell into an
application; the store is the only mutable state in it.

```ts
const session = await createEditorSession({ registry, report, palette: paletteStore });
session.attachViewport(viewport);          // from the shell, once it has mounted
await session.openFile(file);              // from the toolbar's file input
const off = session.onError((error) => …); // null when a render succeeds again
```

`createEditorSession` acquires the GPU device and the Rust core, restores the
autosave *before* the store exists — a restored document is the store's initial
state, not an edit pushed into it — bridges the palette editor to the document
palette in both directions, installs drop and paste, and subscribes the
renderer. Renders are **coalesced, not queued**: one in flight, one latest
pending, and anything arriving during a render replaces the pending one.

`attachViewport` takes `null`. React mounts and unmounts the viewport host to
prove the effect is clean, so a session that treated its first viewport as its
only one would draw into a canvas that had been thrown away.

### `DocumentStore`

```ts
const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);

store.addNode(effectId, index?): string;   // returns the id it created
store.duplicateNode(nodeId): string;
store.removeNode(nodeId): void;
store.moveNode(nodeId, toIndex): void;
store.setNodeEnabled(nodeId, enabled): void;
store.setNodeSeed(nodeId, seed, options?): void;
store.setNodeParam(nodeId, key, value, options?): void;
store.selectNode(nodeId | null): void;
store.setSolo(nodeId | null): void;
store.setNodeOpacity(nodeId, opacity, options?): void;
store.setNodeBlend(nodeId, blend): void;
store.setPalette(palette, options?): void;
store.loadDocument(document, label): void;   // .dork opened, preset applied
store.undo(): boolean;  store.redo(): boolean;
```

Three properties the types cannot state and every caller depends on:

- **`getSnapshot()` is referentially stable.** `useSyncExternalStore` compares
  snapshots with `Object.is`; a store that rebuilt one per read renders forever
  and one that mutated in place renders never.
- **Every command is one undo step** (F-ST-04) unless it passes
  `{ continuous: true }`, which coalesces consecutive commits of the *same*
  control into one step whose starting point is where the drag began. Pointer
  controls pass it; discrete ones must not, or two clicks of one checkbox
  collapse into a step that undoes both.
- **`addNode` and `duplicateNode` return the id.** A caller that searched the
  new stack instead guesses wrong the moment the same effect appears twice.

`DocumentSnapshot` carries the document, the decoded source, the selection, the
solo point, the undo and redo labels, the restore notice and a `revision` that
increments on every change — the renderer's "something moved" signal.

**Selection and solo are on the store, not in the document.** They are ways of
looking at a document rather than part of one, they are not saved and not
undone, and both are cleared when the node they name leaves the stack — solo
because `buildRenderGraph` refuses a solo point that is not in the stack, which
would otherwise turn every later render into an error.

**Per-node opacity and blend (F-ST-03)** are `setNodeOpacity` and
`setNodeBlend`. Two commands rather than one because they are two gestures:
opacity is dragged and coalesces into a single undo step under
`opacity:<nodeId>`, blend is chosen from a menu and is one step per choice.
Opacity is refused outside `[0, 1]` rather than clamped — it has no registry
descriptor and therefore no legal range for `coerceParams` to clamp against, so
the bound is stated once, as a refusal.

Both backends composite. The arithmetic is defined once, in
`web/src/graph/blend.ts`, and applied by each execution kind in its own —
`web/src/gpu/composite.ts` with `shaders/_composite.wgsl` for the parallel half,
`compositeLinearSurface` on the planar `f32` for the serial one — so a composite
costs no boundary crossing on either side. Blending is in **linear light**, like
the rest of the pipeline; the consequence for the pivoted modes is argued in
`blend.ts`.

Two things a caller has to know:

- **A node that resamples cannot carry a composite.** `internal-resolution` and
  `nn-upscale` write a different extent than they read, so their output has no
  pixel-for-pixel correspondence with their own input and there is no picture
  "50% of it" could mean. `planRender` throws `unsupported-composite` naming the
  node; the stack row hides the two controls on such a node rather than
  disabling them, because there is nothing the user could change to make them
  apply.
- **The index map is not composited.** It records which palette entry the node
  chose per pixel; opacity changes how much of that decision is shown, not what
  the decision was, and blending two indices is meaningless. Dropping it instead
  would mean a stack `validateStack` accepted at full opacity fails to render
  the moment a slider moves.

### `loadDocument(document, label)`

The command everything that *replaces* the open document goes through: a `.dork`
opened, a preset applied, a shared link taken. Four things it does, and a caller
depends on all four:

1. **One undo step**, labelled. Opening a document is something a person can
   change their mind about; clearing the history instead would throw away the
   work that was on screen with no way back to it.
2. **Selection and solo are cleared if the new stack does not contain them**,
   before the commit, so the replacement is one notification. Solo is the one
   that matters — `buildRenderGraph` refuses a solo point that is not in the
   stack, so a stale one turns every later render into an error rather than into
   a wrong picture.
3. **The decoded image is not touched.** Whether to open one is the caller's
   decision; a self-contained `.dork` goes back through the ordinary intake
   immediately after, so it gets the same sniff, the same extent ceiling
   (F-IN-04) and the same log line every dropped file gets.
4. **The source *reference* is rewritten to the image that is open**, when one
   is. `openSource` maintains the invariant that no reachable state names an
   image that is not loaded, and a document dropped in over the top would break
   it — a later save would record a picture the recipe was not applied to. With
   nothing open the document keeps its own reference, which is what lets the
   documents panel say which image to go and find.

## 7. Shell slots

`web/src/app/slots.ts`. How anything gets into the shell, which imports no panel.

```ts
registerPanel({ id: "stack", title: "Stack", region: "left", order: 0, component });
registerToolbarItem({ id: "open", side: "start", order: 0, component });
```

`id` is a closed union of the four panels F-UI-08 names. A duplicate
registration **throws** — two modules claiming `properties` means one of them is
silently invisible, which is the failure the registry exists to prevent.
Registration is observable, so a panel registered after the first render appears
without a reload. A region nothing registered into is not rendered at all.

Panels take no props: the shell's slot takes a component with no props, so
dependencies arrive by closure at registration time. A context would need a
provider in a file no panel owns.

`toolbarSlots` is where everything that is not one of the four panels goes —
documents, export, batch, Surprise Me and the guide, ordered by the `order` each
registration carries rather than by the order of the calls in `main.tsx`.

**Contextual help uses neither registry.** `installHelp({ registry })` mounts a
React root of its own on `document.body` and returns the uninstaller; the shell
knows nothing about it. That is not a shortcut around the slots — help describes
controls drawn by panels that mount and unmount underneath it, and a component
living in one of the four regions would be unmounted along with that region. A
control opts in with one attribute:

```tsx
<div {...helpFor({ kind: "param", effect: effect.id, param: param.key })}>…</div>
```

Nothing is drawn until an annotated control is dwelt on, so installing it against
a build where no call site has been annotated costs one empty `<div>` and shows
nothing — which is the honest behaviour rather than an empty panel.

## 8. Export

`web/src/export/`. **Nothing in it may know that a document store, a renderer or
a session exist.** It states what it needs as two interfaces in its own
vocabulary, and `web/src/ui/export/session.ts` is the single adapter that
satisfies both from an `EditorSession`.

```ts
interface ExportImageSource {
  subject(): ExportSubject | null;                       // name, extent, solo, revision
  renderFrame(signal?: AbortSignal): Promise<ExportFrame>;
  subscribe(listener: () => void): () => void;
}

interface VectorTracer {
  trace(
    indices: Uint16Array, width: number, height: number,
    paletteRgb: Uint8Array, settings: VectorTraceSettings,
  ): TracedDocument;                                     // { svg, report }
}
```

`subject()` must be **referentially stable** until something changes, for the
same reason `getSnapshot()` must be: it is read through `useSyncExternalStore`.

### The pipeline

```ts
const frame  = await source.renderFrame();               // the picture on screen
const census = { indexed: await indexImage(frame.width, frame.height, frame.data) };
const size   = await estimateExportSize(frame, settings, { census, tracer });
const where  = await chooseDestination(exportFileName(name, settings), settings.format);
if (where !== null) await runExport({ frame, settings, census, tracer, destination: where, onProgress });
```

Four things this order encodes, each of which breaks something if changed:

- **The destination is chosen inside the click.** `showSaveFilePicker` needs
  transient user activation and a 4x PNG encode outlives it, so asking after the
  work fails on exactly the exports large enough to matter.
- **The census is taken once, on the frame**, and handed to every later estimate
  and to the export itself. It depends on the frame alone — nearest-neighbour
  replication cannot invent a colour — so a quality slider costs no pass over
  the image, and an indexed export never builds the scaled RGBA buffer at all.
- **The estimate encodes the same frame the export will.** Below a pixel budget
  it encodes all of it and reports `exact: true`; above it, a centred band with
  the real encoder, multiplied by the row ratio, with a known upward bias.
- **The frame is already sRGB.** The renderer reapplies the transfer once on the
  way to the screen, so export encodes the bytes the viewport drew.

### `ExportSettings`

```ts
interface ExportSettings {
  readonly format: "png" | "jpeg" | "webp" | "svg";
  readonly quality: number;                   // 1..100, read by the lossy formats
  readonly scale: number;                     // integer, nearest-neighbour (F-EX-12)
  readonly trace: VectorTraceSettings;        // mode, tolerance, minFeatureArea,
}                                             // strokeOnly, strokeWidth
```

`ExportFormatInfo` carries `alpha`, `lossy` and `vector` so the panel reads
declarations rather than testing ids. `vector` is what turns the scale control
off: the multiplier replicates pixels and an SVG has none. The panel **hides**
the control rather than disabling it, because there is nothing a person could
change to make it apply — the same rule the stack row uses for a composite on a
resampling node.

Two refusals a caller must expect, both stated rather than worked around:

- **`encodeFrame` with `format: "svg"` and no `tracer` throws.** There is no
  default; the tracer lives in WASM and this module may not import it.
- **A frame of more than 256 distinct colours cannot be traced**, and is
  refused. An SVG layer is a colour; quantizing at export time would be a second
  dither the document never asked for. The panel knows this before the button is
  pressed, from the census, and says so there.

## 9. The render worker

`web/src/worker/`. The main thread holds UI state only; it never renders. **This
is the interface everything that wants a picture uses** — animation, Surprise Me,
batch and animated export all build on it.

Not Comlink, though the stack table named it: three properties this seam needs
are ones a call proxy cannot express — abandoning a call that is already
running, transferring an object produced inside a call out of it, and a lane
discipline between preview and export over one device. `worker/protocol.ts`
carries the full argument. The shape below is what a proxy would have generated,
written out, plus those three.

```ts
class RenderService {
  static create(options: { report: CapabilityReport }): Promise<RenderService>;

  /** The worker's device and core, once they are up. */
  readonly info: {
    readonly coreVersion: string;
    readonly kernels: readonly { id: string; name: string }[];
    /** The main thread sizes its image limits (F-IN-05) from this. */
    readonly maxTextureDimension2D: number;
    readonly adapter: {
      vendor: string; architecture: string; device: string; description: string;
    };
    readonly ms: number;
  };

  /**
   * Point the worker at an image, or at nothing.
   *
   * The pixel planes are copied, not transferred: the main thread keeps its own
   * decoded surface for the before/after reference (F-UI-04) and palette
   * extraction (F-CO-02). Once per image open, never per frame; the byte count
   * and the duration are logged on both sides.
   */
  setSource(image: SourceImage | null): Promise<void>;

  render(params: RenderParams): Promise<RenderResult>;
  /** Same, with the call id first, so `cancel(id)` can stop it mid-render. */
  renderCancellable(params: RenderParams): { id: number; frame: Promise<RenderResult> };
  cancel(id: number): void;

  /** F-EX-08. One synchronous WASM call, on the worker's thread rather than this one. */
  trace(params: {
    indices: Uint16Array; width: number; height: number;
    paletteRgb: Uint8Array; settings: VectorTraceSettings;
  }): Promise<{ svg: string; report: VectorTraceReport; ms: number }>;

  /**
   * F-EX-04, as three calls rather than one.
   *
   * The encoder is a `wasm-bindgen` handle and may only be held in the worker,
   * and a GIF is built frame by frame — a 60-frame loop at document resolution
   * is more index map than anyone wants to hold twice, so one call taking every
   * frame would mean a full `frames x width x height` buffer on this thread as
   * well as the one in WASM. The handle is a number because that is all that
   * survives `postMessage`.
   *
   * It is claimed by `gifBegin`, fed by `gifFrame`, and consumed by exactly one
   * of `gifFinish` or `gifAbandon`; both free the WASM handle, and a handle that
   * reaches neither is linear memory held until the worker dies.
   * `ui/export/animated.ts` is the only caller and it abandons in a `finally`.
   *
   * Outside the render queue, like `trace`, and for the same reason: LZW touches
   * neither the device nor the node cache. Unlike `trace` it is not one long
   * call — one short message per frame — so a GIF encode interleaves with
   * preview renders instead of blocking them.
   */
  gifBegin(params: { width: number; height: number }): Promise<number>;
  /**
   * One frame's index map, one byte per pixel, row-major.
   *
   * **Copied, not transferred.** `replicateIndices` returns its input unchanged
   * at scale 1, so the array handed over can be one the palette builder still
   * owns; detaching it would leave the encoder reading a zero-length array on
   * the next frame.
   */
  gifFrame(params: { handle: number; indices: Uint8Array }):
    Promise<{ frames: number; bufferedBytes: number }>;
  /** `paletteRgb` becomes the global colour table verbatim — there is nowhere to quantize. */
  gifFinish(params: {
    handle: number; paletteRgb: Uint8Array; delayCentiseconds: number;
    loopForever: boolean; transparentIndex: number;
  }): Promise<GifFinishResult>;
  /** Never rejects: the only correct place to call it is a `finally`. */
  gifAbandon(handle: number): Promise<void>;

  dispose(): Promise<void>;
}

interface RenderParams {
  readonly document: DitherDocument;
  /** Render up to and including this node (F-ST-02). */
  readonly solo: string | null;
  readonly quality: "preview" | "full";
  /** Fraction of document resolution to render at, in (0, 1] — F-UI-03. */
  readonly factor: number;
  readonly lane: "preview" | "export";
  readonly present: "bitmap" | "bytes";
}

interface RenderResult {
  /** `bitmap` is transferred and has exactly one owner; `bytes` are the samples. */
  readonly image:
    | { readonly kind: "bitmap"; readonly bitmap: ImageBitmap }
    | { readonly kind: "bytes"; readonly data: Uint8ClampedArray };
  /** The extent the graph ran at. Below the document's when degraded. */
  readonly width: number;
  readonly height: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
  readonly quality: "preview" | "full";
  readonly correlationId: string;
  /** Absent when the stack was empty and the source itself is the picture. */
  readonly stats: RenderStats | null;
  readonly diagnostics: RenderDiagnostics | null;
  readonly totalMs: number;
  /** Of which, presenting: readback, sRGB encode, bitmap. */
  readonly presentMs: number;
  /** Bytes the reply carries across the worker boundary. */
  readonly transferBytes: number;
}

interface RenderStats {
  readonly frame: number;
  readonly ms: number;
  readonly nodesExecuted: number;
  readonly cacheHits: number;
  /** Bytes moved across the GPU/CPU boundary — the known perf ceiling. */
  readonly boundaryBytes: number;
}
```

**Two rules a caller has to know.**

1. **An abandoned render is not an error.** `render()` rejects with
   `RenderAbandoned` (test it with `isAbandoned`) when a newer preview replaced
   this one or somebody cancelled it. That is an ordinary outcome of an
   interactive editor and must not reach the UI as a failure. Everything else
   that rejects is real: a document the renderer refuses, a lost device, an
   effect the catalogue does not have.
2. **A transferred `ImageBitmap` has exactly one owner.** Hand it to the
   viewport, which closes it when it is replaced (`viewport/frame.ts`,
   "Ownership"), or close it yourself. Dropping one leaks GPU memory that
   nothing in the JS heap accounts for.

**The lanes** (`worker/queue.ts`, and unit-tested there without a device):

| | preview | export |
| --- | --- | --- |
| A newer preview arrives | aborted and rejected `superseded`; at most one waits | unaffected |
| An export arrives | aborted and **re-queued** — it still resolves with a frame, after the export | queued in arrival order |
| `cancel(id)` | rejected `cancelled` | rejected `cancelled` |

That is both halves of "preview must not block export" and "export must not
degrade preview". `cancel()` actually stops the worker; it does not merely stop
reporting — `graph/render.ts` checks the abort signal before every plan step,
which is every cancellation point a graph execution has.

**Not yet on this interface:** `play(fps)`, animated export and batch. Animated
export will re-evaluate only **bound** nodes per frame — unbound nodes render
once and are reused across all frames, which is what `RetainPolicy` in
`graph/render.ts` already exists for.

---

## 10. Capability report

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

## 11. Logging

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
