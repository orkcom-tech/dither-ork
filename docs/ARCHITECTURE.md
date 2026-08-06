# Architecture

dither-ork is a browser application that reproduces the Dither Boy feature set
for still images: the spec's 61 named effects in a stackable reorderable
pipeline, full colour with palette extraction, CMYK halftone, timeline animation
with live playback, batch processing, and PNG / JPEG / SVG / GIF / MP4 export.

**59 of those 61 are built and registered, plus 4 of the 8 preprocessing nodes
(F-PP): 63 effects in the catalogue.** By family: 15 error diffusion, 5 ordered,
8 pattern, 16 glitch, 15 special, 4 preprocess. By execution: 15 WASM, 48
WebGPU. By slot: 16 preprocess, 28 dither, 19 postprocess. Two of the 61 are
absent on purpose and each is recorded where the decision was made — F-GL-06
JPEG glitch and F-SP-14 nearest-neighbour upscale. Of the F-PP group, F-PP-01 is
the internal-resolution stage rather than a stack node, F-PP-05 needs a spline
control the parameter vocabulary does not have, and F-PP-07/08 take an uploaded
image; none of the four is an effect descriptor. The counts are asserted by
`web/src/registry/catalogue.test.ts`, so an effect that silently stops being
discovered fails the build rather than the eye.

Video editing is out of scope and is a separate future application. Animated
output is in scope, because frames are generated from a still source — that
needs an encoder and no decoder.

## The constraint everything follows from

**Error diffusion is inherently serial.** Each pixel's value depends on error
propagated from pixels already processed, so the entire family — Floyd-Steinberg
through Ostromoukhov — cannot be expressed as a shader. Every other effect in
the catalogue is per-pixel independent.

That splits the renderer in two. **Those two are the only execution kinds**, and
the catalogue as built needs no third: everything that is not error diffusion is
a compute pass. The one effect that would have forced a third — F-GL-06, JPEG
glitch, which needs an encoder to re-compress and corrupt — is not implemented
for exactly that reason, and adding it is a decision about the execution model
rather than one more shader.

- **15 serial kernels** run on the CPU in WebAssembly, compiled from Rust.
- **48 parallel effects** run on the GPU as WebGPU compute passes.
- **The boundary between them is the performance ceiling.** Each serial node
  costs a GPU readback plus an upload. Two mitigations, both also correct for
  the look: consecutive parallel nodes are coalesced into a single GPU pass, and
  diffusion runs at the internal resolution set by the detail-crush node, which
  the aesthetic wants anyway.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Core algorithms | Rust → WebAssembly (`wasm-bindgen`), SIMD128 + threads via `wasm-bindgen-rayon` | Diffusion kernels, quantizers and the tracer are the hot path; hand-written TS is 5–10× slower and decides whether preview feels live. The core has zero web dependencies, so a native or CLI build later is packaging, not a rewrite. |
| Parallel effects | WebGPU compute passes, WGSL | Compute gives workgroup control and storage buffers that fragment shaders do not. Required for pixel sort, block shuffle, histograms and every index-map operation. |
| App | TypeScript + Vite + React | The stack editor, timeline and palette editor are DOM-heavy UI. The viewport is not React — it owns its canvas. |
| Threading | Web Workers + `OffscreenCanvas`, Comlink RPC | The render loop never runs on the main thread. |
| Storage | OPFS for documents, autosave and libraries; IndexedDB for small key-value | OPFS gives synchronous access handles inside workers and handles large batch intermediates. |
| File I/O | File System Access API where available | Batch reads a folder and writes results back; elsewhere it degrades to multi-select in and ZIP out, stated in the UI. |
| Encoders | Rust GIF/APNG/ZIP in core; WebCodecs `VideoEncoder` for MP4/WebM | No ffmpeg anywhere. Animated output is encode-only. |

## Platform support policy

**Target platforms are macOS and Windows. WebGPU is a hard requirement; there is
no WebGL2 fallback.**

On both target platforms every major browser ships WebGPU: Chrome and Edge from
113, Safari from 26, Firefox from 141 on Windows and 145/147 on macOS. The
decision therefore costs nothing where it matters.

What the alternative would have cost: WebGL2 has no compute shaders, no storage
buffers and no atomics, so roughly a dozen effects — pixel sort, block shuffle,
slice repeat, row/column displacement, palette histograms, and every index-map
operation (dilate/erode, outline, hue-targeted recolour) — plus the SVG tracer
could not run on it at all. The remaining ~36 would each need a second GLSL ES
3.0 implementation, a second graph branch, a second golden-image set and a
second queue of driver bugs, paid on every future change.

Accepted consequences:

- Linux is not a target. Chrome on Linux ships WebGPU only on Intel Gen12+ and
  NVIDIA under Wayland; Firefox on Linux is Nightly-only.
- Firefox on Android and Windows ARM64 are likewise not targets.
- The unsupported path is **one explicit screen** naming the requirement.
  Never a silent slow path, never a degraded subset of effects.
- `wgpu` is therefore not used; the GPU layer is written directly against the
  WebGPU API in TypeScript. Had a fallback been required, `wgpu` compiled to
  WASM would have been the way to get one — one WGSL source, two backends via
  `naga` — and that choice had to be made before the GPU path was built.

## Cross-origin isolation

**Mandatory.** WASM threads need `SharedArrayBuffer`, which needs
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`.

The dev server sets both (see `web/vite.config.ts`). Production must too.

Cross-origin isolation also blocks loading cross-origin subresources without
CORP headers. The app loads none — no CDN fonts, no third-party scripts, no
external images — so this costs nothing, and it must stay true.

## Hosting

**Cloudflare Pages.** The requirement is a static host that can set arbitrary
response headers; Cloudflare Pages does it from a `_headers` file on the free
tier. Netlify and Vercel also qualify.

The file is `web/public/_headers`. Vite copies `public/` verbatim into `dist/`,
so it ships at the site root where Pages reads it. It has no schema and no
validation, so a typo in it fails silently in production — the only symptom
being the capability check rejecting the app for every visitor. CI therefore
asserts both headers are present in the build output rather than trusting it.

Build settings: build command `npm ci && npm run build`, output directory
`web/dist`, root directory `web`.

**GitHub Pages does not** — it serves no custom headers, so it cannot host this
app with threads enabled. Recorded because it is the obvious default for an
open-source project and it is the one that does not work.

## Render graph

- A document compiles to a DAG. Linear today; typed as a DAG so node groups and
  masking do not need a new engine.
- Every node exposes a **content hash** over its parameters, seed and input
  hash. Node outputs are cached against it. Editing a parameter invalidates that
  node and everything downstream; nothing upstream re-runs.
- **Preview and export share one graph**, differing only in resolution and
  whether adaptive degradation is allowed. There is no second rendering path,
  because two paths means two different-looking outputs.
- **Animated export** walks `t` across the loop and re-evaluates only bound
  nodes. Unbound nodes render once and are reused for all `N` frames, which is
  why an `N`-frame export is far cheaper than `N` renders.

## Data layout

- Working buffers: `RGBA16F` textures on the GPU, `f32` planar in WASM. Linear
  light throughout.
- After a quantizing node the pipeline carries **both** an RGBA buffer and an
  **index map** (one palette index per pixel). The index map is what makes
  hue-targeted recolour, index remap, outline, dilate/erode and the SVG tracer
  lossless and cheap. Carrying it is a deliberate memory cost.
- The node cache has an explicit byte budget with LRU eviction and a logged
  eviction event, not an out-of-memory crash.

## Colour

Everything works in **linear light**. sRGB transfer is removed on load and
reapplied on export.

Diffusing error in sRGB instead of linear light is the single most common reason
naive dither implementations look muddy, and it is checked by a unit test: a
flat mid-grey dithered to 1-bit must average back to its own luminance.

Palette matching uses **OKLab** by default. Plain sRGB Euclidean distance is
also exposed — not as a fallback but as a look control, since it reproduces what
period-accurate tools did.

One consequence of working in linear light is worth stating because getting it
wrong is invisible in every aggregate measure. **Ostromoukhov's variable
coefficient table (F-ED-14) is indexed by the linear value, not by the sRGB code
value.** A row of that table is the triple solved so that a field of a given
*dot coverage* comes out blue-noise, and in a linear-light pipeline the coverage
a flat field settles at is its linear value. Indexing by the display-referred
code instead selects a row solved for a different coverage; it leaves the mean
level correct and every kernel-agnostic test passing, and it puts visible
vertical stripes through the upper mid-tones. The measurement, the cause and the
regression test that pins it are in `level_index` in `core/.../diffusion.rs`.

## Surprise generator

Lives in `core/gen`, driven by a seeded PCG PRNG so a seed reproduces
byte-identically on every platform and inside batch workers.

The **node registry is the generator's data source**: each effect declares its
parameters with legal range, surprise range, sampling distribution and selection
weight, plus its slot in the stack grammar. The generator contains no per-effect
logic, so a newly added effect becomes eligible automatically, and missing
surprise metadata is a registry validation failure rather than a runtime
surprise.

Palette synthesis works in OKLab so random schemes come out with even perceptual
lightness spacing instead of clumping.

## Determinism

- Every stochastic node reads an explicit seed from the document. No
  `Math.random()`, no wall-clock reads inside the graph.
- Animation noise is precomputed and periodic in `frame mod N`.
- Modulator frequency is an integer number of cycles per loop, so frame `N`
  equals frame `0` by construction. A hash comparison of the two blocks any
  animated export that would not loop.
- Same document + same frame index + same build + **same platform** =
  byte-identical output on the CPU path.

  The platform qualifier is not hedging, and it was measured rather than
  assumed. `srgb_to_linear` and `linear_to_oklab` call `powf` and `cbrt`, so
  they are on every render path, and the C library is not required to round
  those correctly — implementations do differ between platforms and versions.
  The seeded integer draws feeding them are bit-identical; the transforms are
  not.

  What that costs in practice is small and is now known: the golden set is
  blessed on aarch64 and passes on x86_64 in CI, within the harness tolerance.
  So results are reproducible to within a rounding difference across platforms
  and byte-identical on one. Anything that must be exact across platforms —
  a share URL reproducing a seed, a batch worker matching the preview — is
  exact because it re-runs the same pipeline on the same machine, not because
  the floating point agrees everywhere.

  The alternative, committing to correctly-rounded implementations of the
  handful of transcendentals involved, buys byte-equality across platforms at
  the cost of owning that code forever. Not taken; revisit only if a real
  requirement needs cross-platform byte-equality.

- GPU results are deterministic per device. Golden-image tests for the CPU path
  run anywhere; the GPU goldens need a pinned environment, since WebGPU
  implementation variance across drivers is real. **That environment now exists
  and is part of the repository**: `web/test/gpu-golden/` builds one pinned
  Chrome for Testing build (`chrome-version.txt`) into a `linux/amd64` image and
  drives it onto SwiftShader, and the runner refuses to compare anything if the
  adapter it gets back is not the software rasteriser. See DEVELOPMENT.md for
  how to run and re-bless it.

## Logging

Structured, levelled, namespaced by channel — `app`, `graph`, `gpu`, `wasm`,
`export`, `batch`, `io` — with a per-render correlation id.

- Every node execution logs id, kind, cache hit/miss, dimensions, duration.
- Every GPU↔CPU crossing logs transfer size and duration; the known perf trap
  must be readable from the console rather than by profiling.
- Export logs per frame; batch logs per file.
- No empty catch blocks. Every error path logs before surfacing and carries the
  correlation id.
- Preview degradation transitions are logged and shown in the UI.

## Repository layout

This section describes the repository **as it is**, not as it will be. It is the
single source of truth for layout; the vault-side architecture note carries the
decisions and their reasoning and does not duplicate this.

```
core/                     Rust workspace, zero web dependencies
  crates/dither-core/
    src/color.rs          sRGB <-> linear, OKLab, distance
    src/palette.rs        palettes, nearest-colour matching, hardware built-ins,
                          sorting and OKLab ramps
    src/diffusion.rs      error-diffusion kernels and the shared machinery
    src/quantize.rs       palette extraction: median cut, Wu, k-means
    src/noise.rs          Bayer and void-and-cluster tiles, seeded noise fields
    src/rng.rs            PCG32; the only source of randomness in the core
    src/fixture.rs        the generated test images the goldens are taken from
    tests/                golden-image and colour-correctness harnesses
  crates/dither-wasm/     wasm-bindgen bindings — the only web-aware crate
  fixtures/source/        the fixture images, as PNG
  fixtures/golden/        reference renders, one per fixture x palette x kernel
web/
  public/_headers         COOP/COEP for production; shipped to the site root
  fixtures/gpu/           the parallel catalogue's reference set: one generated
                          source and two renders per gpu effect
  test/gpu-golden/        the harness that produces and checks it — a Dockerfile
                          pinning one Chrome for Testing build, the browser-side
                          renderer, the Node-side comparator, and perturb.mjs,
                          which damages a shader on purpose to measure what the
                          set would catch
  src/effects/            one file per effect; the registry finds them by glob.
                          A parallel effect's file carries four things that must
                          agree byte for byte and therefore may not be separated:
                          the registry descriptor, the uniform layout, the
                          `GpuEffect` its passes live in, and the `gpu` export
                          that resolves its id to those passes. The WGSL is the
                          fifth and sits in src/shaders/ under the same id
  src/registry/           discovery, validation, search over the catalogue
  src/graph/              DAG scheduling, content hashing, node cache
  src/gpu/                device, compiler, resources, boundary, scheduler
  src/gpu/effects/        pass definitions shared by a whole family — today only
                          the five ordered dithers, which are one program with
                          five tiles and would otherwise be five copies
  src/shaders/            WGSL, one file per effect, plus CONVENTIONS.md
  src/lib/                logging, capability check
  src/types/              .dork document schema, registry, graph and GPU contracts
  src/wasm/pkg/           generated by the wasm build; not committed
  src/main.ts             the scaffold page: capability check, registry
                          validation, and the end-to-end WASM and GPU proof
  vite.config.ts          COOP/COEP for the dev server
docker/                   build images, the wasm build script, the web entrypoint
docs/                     this file, API.md, DEVELOPMENT.md
.github/workflows/        CI
```

Directories the build order will add and that do not exist yet: `core/gen`
(surprise generator), `core/trace`, `core/encode`, `web/src/worker`,
`web/src/ui`, `web/src/viewport`, `web/src/io`, plus `palettes/` and
`presets/`. They are named here so the target shape is on record without
pretending it already exists.

Nothing in `core/` may know a browser exists.

## Testing

The list below is the strategy. What is built today: golden images for all 15
registered diffusion kernels across four fixtures and two palettes, golden
images for all 48 parallel effects at two parameter sets each, the colour
correctness tests, determinism across threads, and the catalogue test that runs
the startup validator over the shipped descriptors and asserts the counts above.
The loop seam, the perf budget and the document round trip have nothing to test
yet — there are no modulators, no timeline and no document loader.

**Both halves of the catalogue now have goldens.** The CPU set is
`core/fixtures/golden/`, compared byte for byte. The GPU set is
`web/fixtures/gpu/`, produced by `web/test/gpu-golden/` inside the pinned
browser image and compared within one 8-bit code value — a tolerance the CPU set
does not need and the GPU set does, because half the parallel catalogue writes
continuous colour through `exp`, `pow` and trigonometry, which a JIT may
legitimately contract differently on two machines.

Three properties of the GPU harness are worth knowing because they are what make
it a check rather than a ritual:

- **The plan is enumerated from the registry**, never listed. An effect added
  next week is rendered without the harness being edited; an effect that stops
  being discovered leaves its reference behind and the run fails on the orphan.
- **Two parameter sets per effect** — the declared defaults, and the far end of
  every declared surprise range. Defaults alone would record the identity for
  the handful of effects that legitimately open as one; the surprise end alone
  would leave unprotected the state most renders actually use.
- **A vacuity check that runs in bless mode too.** An effect that returns its
  input at both parameter sets, or that renders an almost black frame, fails the
  run instead of having that output stored as the truth forever. It is the one
  failure a golden set cannot otherwise catch, because it is the failure that
  was present when the set was blessed.

What remains outside CI is the proof page's own judgement: `web/src/main.ts`
renders the catalogue and states per effect how much of the frame moved, what it
did to mean luminance and to its standard deviation, and how far it rotated hue.
Those numbers are what a human reads against the effect's *name* — a levels node
that does not move the tone scale and a hue control that rotates nothing both
pass every golden, because a golden pins what an effect does, not that what it
does matches what it is called.

- **Golden images per algorithm** — all of them, fixed inputs, stored
  references. The only defence against a plausible-looking coefficient typo.
- **Colour correctness** — a linear ramp dithered to 1-bit must average back to
  input luminance within tolerance.
- **Loop seam** — a document with every modulator kind bound asserts
  `hash(frame 0) == hash(frame N)`.
- **Determinism** — the same frame rendered in two workers, byte-equal.
- **Perf budget in CI** — a fixed document at fixed resolution under a stated
  millisecond budget; regressions fail the build.
- **Document round-trip** — save, load, re-render, byte-equal, plus a migration
  test per schema version.

## Build order

1. Colour core plus one kernel, headless, with the golden-image harness.
2. The remaining diffusion kernels against goldens.
3. Render graph and cache, headless, with hashing.
4. WebGPU path: ordered dithers and halftone in WGSL, pass coalescing, boundary
   instrumentation.
5. Viewport and stack UI — first point at which it is an app.
6. Palette system: extraction, library, editor, index map, hue-targeted
   recolour.
7. Pattern dithers, then special effects, then glitch effects — each with
   goldens.
8. Clock, modulators, temporal variation, seam validation, live playback.
9. Timeline editor and keyframes.
10. Export: stills → GIF/APNG → MP4/WebM → PNG sequence.
11. SVG tracer and embroidery/cutting preparation.
12. Presets, documents, autosave, sharing.
13. Batch.
14. Themes, shortcuts, layout persistence.

Steps 1–2 are where the look is decided, so they come before any UI.

**Where the repository is:** steps 1 and 2 are done. All fifteen kernels are
built and pinned by goldens, Ostromoukhov (F-ED-14) included — its table is
transcribed from Appendix I of the paper and the transcription is checked
against the paper's own construction rather than against a second copy of the
numbers, in exact rational arithmetic. Step 3 is built headless — hashing,
cache, plan, animate — and is not yet driven by a document. Step 4 is done: the
WebGPU layer, all five ordered dithers and all eight pattern dithers run end to
end with boundary instrumentation. Step 7 is done bar JPEG glitch (F-GL-06) and
nearest-neighbour upscale (F-SP-14) — all 16 remaining glitch effects and all 15
remaining special effects are registered, render, and **now have goldens**,
which the previous revision of this section recorded as the outstanding item.
The tone front of the stack has started: F-PP-02, 03, 04 and 06 are registered
as the `preprocess` family. Step 6's extraction half exists in the core and at
the WASM boundary; the library, editor and the palette-side index-map operations
do not, though the two index-map *stack* nodes (outline F-SP-10, dilate/erode
F-SP-11) do. Nothing from step 5 onward is an application yet —
`web/src/main.ts` is a proof page, not a UI.

The gap this section used to record — **nothing resolves an effect id to its
`GpuEffect`** — is closed. Every `gpu` effect module exports
`const gpu: GpuEffectSource` beside its descriptor, `loadGpuEffects()` collects
them with the same glob that collects the descriptors, and a `gpu` descriptor
with no source fails the catalogue the way a missing surprise range does. The
proof page and the golden harness both enumerate the registry through it and
name no effect by hand. See "GPU pass layer" in docs/API.md for the contract.

## Known technical risks

- **GPU↔CPU boundary cost** scales with the number of serial nodes in a stack.
  Mitigated architecturally, but the ceiling is real and should be surfaced in
  the UI rather than hidden.
- **Memory**: float buffers plus index maps plus a node cache at high
  resolution. Requires the explicit cache budget.
- **GIF compresses dither noise poorly** — LZW hates high-entropy data, which is
  exactly what a dither produces. Managed by the pre-export size estimate and by
  offering APNG/WebP/MP4.
- **SVG trace output size** in pixel-perfect mode. Managed by the
  minimum-feature-size filter and a simplified mode.
- **WebGPU implementation variance** across browsers and drivers produces small
  visual differences; goldens run on a pinned environment.
- **No fallback means the unsupported screen is a real user-facing surface** —
  for those visitors it is the entire product.
