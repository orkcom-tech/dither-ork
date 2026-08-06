# Architecture

dither-ork is a browser application that reproduces the Dither Boy feature set
for still images: 63 effects in a stackable reorderable pipeline, full colour
with palette extraction, CMYK halftone, timeline animation with live playback,
batch processing, and PNG / JPEG / SVG / GIF / MP4 export.

Video editing is out of scope and is a separate future application. Animated
output is in scope, because frames are generated from a still source — that
needs an encoder and no decoder.

## The constraint everything follows from

**Error diffusion is inherently serial.** Each pixel's value depends on error
propagated from pixels already processed, so the entire family — Floyd-Steinberg
through Ostromoukhov — cannot be expressed as a shader. Every other effect in
the catalogue is per-pixel independent.

That splits the renderer in two:

- **~15 serial kernels** run on the CPU in WebAssembly, compiled from Rust.
- **~48 parallel effects** run on the GPU as WebGPU compute passes.
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
- Same document + same frame index + same build = byte-identical output on the
  CPU path. GPU results are deterministic per device; golden-image tests run on
  a pinned environment.

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

```
core/                     Rust workspace, zero web dependencies
  crates/dither-core/     colour, diffusion kernels, palettes, quantizers
    src/color.rs          sRGB <-> linear, OKLab, distance
    src/palette.rs        palettes, nearest-colour matching, hardware built-ins
    src/diffusion.rs      error-diffusion kernels and the shared machinery
  crates/dither-wasm/     wasm-bindgen bindings — the only web-aware crate
web/
  src/lib/                logging, capability check
  src/types/              .dork document schema
  src/wasm/pkg/           generated by the wasm build; not committed
  vite.config.ts          COOP/COEP headers live here
docker/                   build images and the wasm build script
docs/                     this file, API.md, DEVELOPMENT.md
```

Nothing in `core/` may know a browser exists.

## Testing

- **Golden images per algorithm** — all 63, fixed inputs, stored references. The
  only defence against a plausible-looking coefficient typo.
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
2. The remaining 14 diffusion kernels against goldens.
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
