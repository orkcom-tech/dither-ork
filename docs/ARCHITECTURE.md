# Architecture

dither-ork is a browser application that reproduces the Dither Boy feature set
for still images: the spec's 63 named effects in a stackable reorderable
pipeline, full colour with palette extraction, CMYK halftone, timeline animation
with live playback, batch processing, and PNG / JPEG / SVG / GIF / MP4 export.

**62 of those 63 are built and registered, plus 7 of the 8 preprocessing nodes
(F-PP), plus four the spec does not name at all: 73 effects in the catalogue.**
By family: 15 error diffusion, 6 ordered, 13 pattern, 16 glitch, 17 special, 6
preprocess. By execution: 15 WASM, 58 WebGPU. By slot: 3 source, 18 preprocess,
31 dither, 21 postprocess. One of the 63 is absent on purpose and it is recorded
where the decision was made — F-GL-06 JPEG glitch, which needs an encoder and
therefore an execution kind that does not exist. The one remaining F-PP gap is
F-PP-08, masking, and it is now **partly** built: a mask is a second image edge,
the graph carries as many edges per node as the effect declares, and the coverage
taken from a wired picture works end to end. The luminance-range and colour-range
coverages the requirement also names are implemented and agree between the two
backends, but nothing in the interface sets them — see "Multiple inputs, and node
masking" below. The four that are not in the numbered spec
all come from `docs/dither-ork-node-graph.md`: **`feedback` (F-FB-01)**, the only
node in the catalogue that is not a pure function of its inputs — see "Feedback"
below — and the three **generators** (`gen-noise` F-GN-01, `gen-gradient`
F-GN-02, `gen-shape` F-GN-03), the only nodes that take no image at all. See
"Source nodes" below. The counts are asserted by
`web/src/registry/catalogue.test.ts`, so an effect that silently stops being
discovered fails the build rather than the eye.

**It is an application.** `web/src/app/main.tsx` boots it: capability gate,
registry validation, editor session, panels, viewport. The proof page that used
to be the entry point is still there and still earns its place — see "The proof
page" below.

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
- **58 parallel effects** run on the GPU as WebGPU compute passes.
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
| Threading | Web Workers + `OffscreenCanvas`, typed `postMessage` RPC | The render loop never runs on the main thread. Comlink was named here and is not used; see "The render worker" for the three properties this seam needs that a call proxy cannot express. |
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

- A document compiles to a DAG. It **is** one now rather than being typed as one
  in advance: a document is nodes plus edges, a node has an input port per role
  its effect declares, and two branches may converge. The prediction this line
  used to make — "typed as a DAG so node groups and masking do not need a new
  engine" — held: masking landed without a second engine.
- Every node exposes a **content hash** over its parameters, seed and input
  hash. Node outputs are cached against it. Editing a parameter invalidates that
  node and everything downstream; nothing upstream re-runs.
- **Preview and export share one graph**, differing only in resolution and
  whether adaptive degradation is allowed. There is no second rendering path,
  because two paths means two different-looking outputs.
- **Animated export** walks `t` across the loop and re-evaluates only bound
  nodes. Unbound nodes render once and are reused for all `N` frames, which is
  why an `N`-frame export is far cheaper than `N` renders.

## Multiple inputs, and node masking

Step 3 of `docs/dither-ork-node-graph.md`. A node's input ports are a property of
its **effect**, declared as `EffectDescriptor.inputs` and resolved for everybody
by `web/src/graph/ports.ts`. Three rules are folded in there rather than repeated:
an effect that declares nothing still takes one image on `in`; every node gets a
`mask` port for free, so no effect can become unmaskable by forgetting to declare
one; and a node that resamples gets no `mask` port at all, because it has no
pixel-for-pixel correspondence with its own input for coverage to be *of*.

**Port order is load-bearing.** A node's content hash folds in its inputs' hashes
"in port order", so the order has to be a property of the code rather than of
however a document happened to list its edges — otherwise two documents that are
the same graph hash differently and neither reuses the other's cache. It is stated
once, in `portOrder`: declared ports in declaration order, then `mask`.

**Cycles.** "No cycles" stopped being an invariant and became a property exactly
one kind of edge may violate. An edge into a port whose role is `feedback` reads
the producer's previous frame, so it contributes nothing to in-degree; Kahn's
algorithm runs on the feedback-free subgraph and every other cycle is still
refused, naming the nodes that could not be ordered. A feedback edge's producer is
always the consumer itself, because the frame store is keyed by node id: a general
delay edge — B reading A's previous frame — is refused rather than rendered from
pixels nobody kept.

**Scheduling is deterministic by construction.** A DAG has no single topological
order, and the project guarantees one picture per document, so the order is fixed
by two rules in sequence: prefer the execution kind just scheduled (every switch
between the WASM and WebGPU paths costs a readback plus an upload), then the
node's position in `document.stack`. Neither consults a `Set` or `Map` iteration
order — those are deterministic today for reasons nobody wrote down.

**A mask is spatially-varying opacity and nothing else.** Not an effect, not a
node, not a layer: it is the number the composite already applies, with a value
per pixel. Mask and opacity multiply, because they answer different questions —
how much of this node overall, and where. `web/src/graph/mask.ts` is the
definition and `web/src/shaders/_composite.wgsl` is a transcription of it; both
must produce the same numbers or preview and export stop matching, so the two are
kept in the same order and `mask.test.ts` pins the ordinals and channels.

### What is built, and what is not

The engine takes any number of input ports. **The catalogue declares almost
none.** Of 73 effects, every one has a single `image` input and exactly one —
`feedback` — declares a second port, which is its own previous frame. The `layer`
and `displace` roles are defined, documented and unused.

The consequence is worth stating plainly rather than leaving to be discovered:
**two branches can converge on a node's `mask` port and nowhere else.** Blending
two chains as colour, and displacing one picture by another — two of the three
things multi-input was built for — need a node that does not exist yet. What
multi-input delivered is the machinery and masking.

Masking itself is half-exposed. `store.setNodeMask` can set any of the three
coverages, and no control calls it. The only masking gesture is wiring a picture
into a mask port, which sets the `image` coverage on its luminance channel as one
undo step; there is no channel picker, no invert, and no way to reach a
luminance-band or colour mask except by writing the document by hand. This is a
gap in the interface, not in the pipeline, and it is recorded here, in
`web/src/ui/graph/model.ts` beside the constant that hard-codes the choice, and in
`web/src/registry/unbuilt.ts`.

### The schema, and every document written before it

`.dork` went to **schema 2**: a stack of nodes became nodes plus `edges` and
`output`. Schema 1 wrote the wiring nowhere — it *was* the array order — so the
migration in `web/src/io/document/migrate.ts` writes down what the order implied:
one edge per adjacent pair on the `in` port, no edge into the first node, output
is the last node. It runs on the raw JSON before any shape is asserted, so the
validator describes the current schema and only the current schema.

The migration adds what the new schema needs and changes nothing else — no
parameter touched, no id rewritten, no node dropped. The property that matters,
and the one `migrate.test.ts` holds: **a schema-1 document loads as a chain, and
re-saving it produces schema-2 bytes that are the same picture.** Share links are
covered by the same path, because a link carries a preset and a preset carries a
document; the link's own encoding version is unchanged, so links made before the
graph decode and then migrate.

## Feedback

**One node reads the previous frame's output at its own position in the stack**
— `feedback` (F-FB-01), the first step of `docs/dither-ork-node-graph.md`. It is
where trails, decay, growth, smear, endless zoom and spirals come from, and it
is the only thing in the catalogue that is not a pure function of its inputs.
Everything below follows from that one sentence, and all three were decided in
that note before any code was written.

- **It did not need a node graph.** Feedback shipped as a node in the linear
  stack, with the schema-1 `.dork` and no node editor — which is what made it
  step 1 rather than step 3. What it needed from the pass model is one new
  binding role, `feedback-color` (`web/src/types/gpu.ts`), legal only on an
  effect declaring `readsFeedback`, checked in both directions by
  `gpu/compiler.ts`. Multi-input has since landed and the editor **draws** the
  loop, from the descriptor rather than from an edge: no document stores a
  feedback edge, so a node that behaves as though it reads itself visibly does.
- **The buffer is a stated value at frame 0, not whatever the pool held.**
  `gpu/feedback.ts` clears it to transparent black through a render pass, which
  is why `RENDER_ATTACHMENT` is in the texture pool's usage set. With `screen`,
  `add`, `lighten`, `difference` or `exclusion` that makes frame 0 the node's
  input exactly.
- **The store holds two slots per node, not one.** `history` is what frame `F`
  reads and `pending` is what `F+1` will read, so **re-rendering the same frame
  is idempotent** — which it has to be, because the viewport re-renders one
  frame every time the preview scale changes. Chains are keyed per node *and*
  per extent: a trail accumulated at 68% is not the trail at 100%.

### The three consequences

1. **The cache.** A feedback node and everything downstream of it are excluded
   from the content-hash cache (`graph/feedback.ts`); the hash is the same on
   every frame and the pixels are not, so a hit there would be a wrong picture
   with a hit logged against it. Everything **upstream** caches exactly as it
   did, which is most of the work in a real stack — measured in the browser on a
   `blur → feedback` stack: frame 0 executes two nodes with no hits, and every
   frame after it executes **one** node with **one** cache hit. The excluded set
   is logged per render, because "the tail of this stack re-renders every frame"
   is a cost that should be readable rather than mysterious. Buffers the cache
   refuses are owned by the render itself and released by it; the one that
   leaves is flagged `RenderOutcome.ownsBuffer`.
2. **Loop closure.** A document containing an enabled feedback node is **marked
   non-looping** (`AnimationPlan.loops`). F-AN-03 keeps its full strength
   everywhere else — every per-binding phase check still runs, and a fractional
   cycles-per-loop is still an error — but the frame-hash comparison is skipped
   rather than reported as a failure the document was never going to pass, and
   `validateLoopSeam` emits a `does-not-loop` issue at a third severity, `info`,
   which does not clear `ok`. The animated export panel says it before the
   button is pressed and the note travels with the finished file.
3. **Determinism.** Frame N is the product of frames 0..N. The frame store
   **refuses** a frame it cannot serve, naming the frame it can, rather than
   inventing a history — so nothing anywhere can show a frame the export would
   not produce. Rendering from zero is the caller's job, because only the caller
   can resolve the document at each intermediate frame: `ui/timeline/preview.ts`
   replays for the preview and `ui/export/animated.ts` for a sampled export.
   The replay's visible state **reuses the adaptive-preview mechanism** — it
   declares an interaction on the viewport, so the existing degraded badge comes
   up — plus a "replaying k/n" counter on the transport bar beside the one
   playback already had. Measured: replaying frames 0..2 after a scrub back from
   frame 7 reproduces all three **byte-identically**.

## Source nodes

Every effect in the catalogue but three takes one image and returns one. A
**source node** takes none: it produces its picture from its parameters alone,
which is what lets a document exist without a photograph. `gen-noise` (F-GN-01),
`gen-gradient` (F-GN-02) and `gen-shape` (F-GN-03) are the three, and they are
also from `docs/dither-ork-node-graph.md` rather than from the numbered spec.

**It is a `NodeSlot`, not a new kind and not an undeclared convention.** The
fact being declared is positional — a node that ignores the picture handed to it
belongs at the head — and `slot` is already the vocabulary every positional
reader consults: Surprise Me's grammar, the picker's filter chips, the row
badge, the guide. A boolean beside `slot` would be a second positional answer
those readers could disagree about. `execution` still says `gpu`, because that
is still true and still what it costs.

Three declarations follow, and each is checked rather than trusted:

- `types/registry.ts` refuses a source node that runs serially (the WASM backend
  transforms a surface it is handed; there is no such surface), that reads the
  index map (nothing quantizes in front of it and it reads no image), or that
  resamples (a `PassExtent` is relative to an input it does not have).
- `gpu/compiler.ts`'s `validateSourceDeclaration` refuses a `source` effect whose
  **first** pass binds `input-color`, and a non-source effect whose first pass
  binds none — the same two-way check `readsFeedback` gets, and for the same
  reason: both directions of drift are silent. A later pass may bind
  `input-color` freely; it is reading what the pass before it wrote into this
  node's own surface chain.
- `registry/stack.ts`'s `analyseSources` computes what a source node **discards**.

### The discard is visible, not refused

A source node is legal anywhere in the stack, and deliberately so. A node's
output is composited against its own input (F-ST-03), so a gradient at 40% in
`multiply` over a photograph is a real thing to want and the existing composite
path already does it. The discard is therefore not a property of the node — it
is a property of the node **at full opacity in normal blend**, which is exactly
the case where `graph/plan.ts` makes the composite `null` because it is the
identity.

So the rule is visibility rather than refusal: `analyseSources` names the live
nodes a later replacing source throws away and the node throwing them, and the
stack panel dims those rows and prints the sentence. `validateStack` stays a
pure error channel — Surprise Me uses it as an accept/reject gate, and a warning
in there would make it discard every stack containing a generator.

### A blank canvas is what gives a sourceless document its size

A generator needs no photograph but the pipeline still needs an **extent**:
every buffer size derives from the source's, the preview renders a fraction of
it (F-UI-03), and export writes it. `io/source.ts`'s `blankSource` produces a
real `SourceImage` — transparent black, a stated name, a hash over
`blank:WxH` — and it goes through the ordinary intake, so no layer below has a
branch on "is there a source". The toolbar's *new canvas* is the only thing that
creates one; nothing substitutes it for a failed load.

**It does not survive a reload.** `.dork` schema 1 records a source as a name
and a size, with no way to say the pixels were generated rather than loaded, and
inferring it from the name would be a guess. Autosave therefore restores the
stack and not the canvas, exactly as it does for a document whose file is gone.
Recording it is a schema change and belongs with the one the node editor needs.

### Loop closure

Unlike feedback, a generator has no reason to break it and does not. Every
animatable parameter is an ordinary document value, `cyclesPerLoop` stays
integral (F-AN-03), and no generator shader reads a clock or `normalized-time`.
A noise field animated on `evolve` — the third coordinate of a 3D field, which
is why the fields are 3D — passes F-AN-06's seam hash: *the loop closes, frame
48 is frame 0*, measured in the browser.

### F-INF-01, and both halves of it

`gpu/sdf.ts` is the shared signed-distance-field contract F-INF-01 asks for: one
`f32` per pixel, **distance to the nearest boundary in working-resolution
texels, negative inside**, plus the gradient of that signed distance, the channel
layout for carrying a field in the ordinary colour buffer, and the canonical WGSL
for **both producers**. `sdf.test.ts` diffs the fenced copies in every shader
against the canonical text — which is the first time `CONVENTIONS.md`'s "so the
copies can be diffed mechanically" is actually a check.

**Both halves are now built.** A field can come from parameters (`SDF_WGSL`:
closed form, exact, no extra passes — `gen-shape` uses it) or **from the
picture** (`SDF_TRANSFORM_WGSL`: a subject mask, then a jump flood, which is the
construction F-INF-01 names — `wave-field` uses it).

This section used to say the transform "needs a scratch *texture* — a role
`ScratchSize` does not have", and that sentence is what kept it unbuilt for a
phase. It was wrong. A jump flood carries a packed seed **coordinate** per texel
rather than a colour, and a `u32` in a storage buffer holds one exactly: no
format, no filtering, and no ping-pong of textures the scheduler would have to
know about. The missing role was never a texture; it was writing down that the
seed is an integer.

The schedule is eighteen passes, built by `sdfTransformPasses` and put in front
of the consumer's own: **two to smooth the mask, one to seed its boundary,
fifteen to flood.** Three of those deserve their reasons stated here because each
was measured rather than assumed.

- **The smoothing is not optional.** A per-texel luminance threshold on a
  photograph is not a subject; it is a few hundred islands, each with its own
  closed boundary and its own field around it. A wave field over that comes out
  as fragments following the jacket seams. The mask is therefore box-averaged
  along each axis first — a running sum per line, so it is O(1) per texel at any
  radius — and the radius is a control whose zero is the identity.
- **The flood's step is computed from the extent, not baked into the pass.** A
  pass list is static, so the level count has to cover the largest extent this
  build can reach; deriving `longest >> (level + 1)` in the shader means no pass
  is ever a no-op copy at preview resolution, and levels past log₂(extent) become
  JFA+1 refinement rounds instead of waste.
- **Fifteen levels, and the count must stay odd.** Even levels read buffer A and
  write B, so an odd count leaves the answer in B — which is the buffer
  `sdf_field` reads. An even one would leave a field that is one round stale
  everywhere and right nowhere; `sdfTransformPasses` asserts it.

**A jump flood is approximate and that is stated where it is used.** Its error is
a few texels taking a seed that is not quite their nearest; it is deterministic,
because every pass reads one buffer and writes the other, so nothing observes
another invocation's write. The exact alternative is a Felzenszwalb envelope scan
per axis — two passes instead of fifteen — and it is not the construction the
requirement names, so it is not what is built. Consumers read `sdf_field`, so
swapping it later changes nothing above.

**One source F-INF-01 names is not implemented: a selection over the index map.**
A pass may bind `input-index` only if its effect declares `requiresIndexMap`, and
that is a property of the whole effect rather than of one parameter, so offering
it would make *every* consumer of the transform illegal in front of a dither —
including a wave field over an unquantized photograph, which is the case the
requirement was asked for. The cost is real and named in `gpu/sdf.ts`: a subject
the same brightness as its background cannot be separated.

Outline (F-SP-10) and dilate/erode (F-SP-11) still ship reading the index map
directly and are exact for a one-texel neighbourhood; what they would gain from a
field is a width in pixels rather than in taps, and the transform is now there
for them to take.

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
    src/trace.rs          index map -> SVG: region labelling, contour following,
                          Douglas-Peucker, the minimum feature filter (F-EX-08..10)
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
  src/app/                the shell: boot gate, docked regions, panel and toolbar
                          slots, theme. It imports no panel — see "Slots" below
  src/io/                 image intake: sniff, probe, decode, linear light, limits
  src/io/document/        .dork files, presets, the preset library on OPFS, the
                          starter set, share links, download/read/clipboard
  src/export/            the picture out: colour census, PNG encoder, zlib, the
                          canvas encoders, the SVG tracer contract, nearest scale,
                          matte flatten, size estimate, destination, job
  src/state/              the live document — mutations, history, autosave,
                          .dork serialisation — and state/render/, which is
                          document -> graph -> frame against the real backends
  src/ui/theme/           the only colours in the application: tokens.css, plus
                          the element base and the shared primitives. Nothing
                          else anywhere may hold a literal colour (F-UI-09)
  src/ui/stack/           the stack editor — the document as a list, and
                          graph-view.ts, which says per row where that node sits
                          in the wiring once the list stopped being it
  src/ui/graph/           the node editor: the deterministic layout (positions
                          are computed from the wiring, never stored), the view
                          transform and the forgiving port snap, the drop
                          judgement, and the keyboard path. Beside the stack
                          panel rather than in place of it — see its index.ts
  src/ui/picker/          the effect picker: the matcher that says why a row is
                          on screen, the model that groups and judges the
                          catalogue, and the component. Split out of stack/
                          because nothing about it is specific to that panel
  src/ui/properties/      the properties panel, generated from the descriptor
  src/ui/palette/         the palette system: editor, library, extraction
  src/ui/timeline/        the timeline: tracks, keyframes, playhead, and the
                          preview pump it becomes while a track exists
  src/ui/export/          the export dialog, and the adapter that satisfies
                          export/'s two interfaces from the editor session
  src/ui/batch/           the batch queue over many images
  src/ui/surprise/        Surprise Me: seed, chaos, the per-aspect modes
                          (reroll/keep/off), history
  src/ui/documents/       save/open/presets/share, as a toolbar item and a dialog
  src/ui/help/            contextual help (F-UI-13): the `data-help` token, the
                          dwell machine, the placement solver, the article
                          resolver that reads the descriptor, and `concepts.ts`
                          — the interface ideas no descriptor is about
  src/ui/guide/           the user guide (F-UI-14): seven written chapters, and
                          an effect catalogue **generated** from the sealed
                          registry. No effect is named in that directory
  src/viewport/           the canvas. Not React; owns its own canvas and overlay
  src/worker/             the render worker: the wire format both sides import,
                          the preview/export queue and its cancellation policy,
                          the fractional preview resampler F-UI-03 needed, the
                          worker itself, and `RenderService` — the main thread's
                          one way to ask for a picture
  src/main.ts             the proof page's module — reached at /proof.html in
                          dev, not an entry point of the production build
  index.html              the application
  proof.html              the proof page. Vite builds index.html only, so this
                          is served in development and is not shipped
  vite.config.ts          COOP/COEP for the dev server
docker/                   build images, the wasm build script, the web entrypoint
docs/                     this file, API.md, DEVELOPMENT.md
.github/workflows/        CI
```

Directories the build order will add and that do not exist yet: `core/gen`
(surprise generator) and `core/encode` (the animated formats).
`web/src/worker` now exists and holds the render worker, its wire format, the
preview/export queue and the preview resampler. The tracer landed as
`dither-core/src/trace.rs` rather than as
a crate of its own, because it shares the palette and colour types with
everything else in that crate and a second crate would have been a re-export
with a `Cargo.toml`. The starter presets ship as code (`io/document/starter.ts`)
rather than as a `presets/` directory of files, so that `starter.test.ts` can
build them against the **real catalogue** and run `validateStack` over every
one — an effect id that disappears fails the build rather than shipping a
library entry that refuses to render when somebody clicks it. `palettes/` is
likewise absent: the hardware palettes are facts in `core/…/palette.rs` and
reach this side through `builtinPalettes()`.

Nothing in `core/` may know a browser exists.

## How the application is assembled

`app/main.tsx` runs five steps in an order that each of them forces, and three
of the five can end the run with a screen of their own:

1. **Theme**, unconditionally, so even a failure screen is the right colour.
2. **The capability gate** (F-UI-12). WebGPU and `SharedArrayBuffer` are fatal.
3. **Registry validation**, which is terminal — a build whose catalogue is wrong
   renders wrong documents convincingly, so it stops and lists every issue.
4. **The editor session** — `state/session.ts`, which starts the render worker
   (and so, indirectly, acquires the GPU device and the Rust core, on that
   thread), restores the autosave, builds the document store, bridges the
   palette, installs the image intake and subscribes the renderer.
5. **Registration**, then React. In the order a person reaches them: the stack
   panel, the properties panel, the toolbar (open, undo, redo, fit, notices),
   the documents toolbar (save, open, presets, share), the timeline panel, the
   export action, batch, Surprise Me, the guide, the history shortcuts, and
   contextual help. The palette panel registers on import and so has no call.

   Two of those are not panels and do not take a slot in a region. The **guide**
   registers a toolbar item, because a guide is something you open, read and
   close rather than a fifth column — `app/slots.ts` closes the panel ids to the
   four names F-UI-08 gives. **Contextual help** registers nothing at all: it
   mounts a React root of its own on `document.body` and delegates from the
   document, because it describes controls drawn by panels that mount and
   unmount underneath it, and a panel inside one of those regions would be
   unmounted along with it.

**Everything up to step 5 happens before React renders anything.** That is not
tidiness. Panels register themselves into slots and a duplicate registration
throws, which is what stops one of two panels from being silently invisible;
React in development mounts every effect twice to prove it is clean. Registering
from inside the tree would therefore throw on the second mount. The one thing
that does happen twice is the viewport, and `attachViewport` takes a viewport
that can arrive, leave and arrive again.

### Slots

The shell imports no panel. `app/slots.ts` holds two registries — panels and
toolbar items — and a panel module calls `registerPanel` at import time. A
region nothing registered into is not rendered: no empty box and no "coming
soon". This is the same arrangement the effect catalogue uses, for the same
reason, and it is what let the shell, the stack editor, the properties panel and
the palette editor be written in parallel by people who never edited a shared
file.

### Where the words live (F-UI-13, F-UI-14, F-UI-15)

Three surfaces explain the application to the person using it: the picker's
result list, the hover help, and the guide. **All three read the same text, and
none of them contains any.** The descriptor next to the shader carries the
effect's `summary`, `description` and `keywords`, and each parameter carries a
`description`; `types/registry.ts` fails the whole catalogue when one is missing
*or when it only restates the label*. That is the mechanism, and it exists
because the alternative had already happened elsewhere: three hand-written
copies of one sentence, two of which are wrong by the second release.

Two kinds of text have no descriptor to live on, and each has exactly one home.
Family ideas — error diffusion, the index map, working resolution — are
`EFFECT_CONCEPTS` in `types/registry.ts`, beside the descriptors that declare
`producesIndexMap`. Interface ideas — what a slot is, what solo does, what the
colour metric changes — are `ui/help/concepts.ts`. Help reaches all four kinds
through one attribute, `data-help="param:blur.radius"`, resolved with
`closest()`, which is why annotating a control is one attribute and not a
wrapper, a ref or a provider.

Search is the other half of the same problem. `registry/search.ts` matches over
everything an effect says about itself rather than over its name — the glow
effect is called *Epsilon glow*, so a name search does not find "glow" and every
reader concludes the tool has none — and it reports *why* each row matched, so a
result that came from a keyword is not an unexplained row. When it finds
nothing, `registry/unbuilt.ts` is consulted: four requirements the spec names and
this build does not implement, each with the reason and the closest built
alternatives. `search.test.ts` asserts that none of the four is a registered
effect, so an entry that becomes real fails the build rather than going on
telling people a shipped effect does not exist.

### The one piece of state, and the palette's exception

`state/store.ts` is the only mutable state in the application. Panels read it
through `useSyncExternalStore` and change it by calling a command; the renderer
subscribes to it and to nothing else. Two things live on the store rather than
in the document because they are ways of *looking* at a document rather than
part of one — the selection and the solo point. Solo saved in a `.dork` would
reopen as a truncated stack with no visible reason.

The palette is the exception and it is bridged rather than owned. `ui/palette`
holds the editor's state — swatches, locks, output mode, extraction settings —
which is more than a colour list; the document holds the `Palette` a render
reads and a `.dork` writes, which has to be undoable with everything else.
`session.ts` keeps the two in step in both directions, with a re-entrance guard,
because each direction's write is the other's notification.

### The render worker

**The render loop does not run on the main thread.** `web/src/worker/` owns the
WebGPU device, the WASM core, the effect registry, the node cache, the
`DocumentRenderer` and the SVG tracer. `session.ts` holds a `RenderService` and
posts to it; the main thread keeps the UI, the input, the panel state and the
undo stack.

Measured on this machine, on a 2400x1800 image with a stack of blur →
Floyd-Steinberg → halftone: 124 parameter changes over a two-second drag, with a
render issued for every one of them, and the longest main-thread block was
**16.98 ms**, with **zero** `longtask` entries over 7.4 seconds.

**Comlink is named in the stack table and is not used.** Three properties this
seam needs are ones a call proxy cannot express, and all three are load-bearing:
abandoning a call that is already running (a drag issues renders faster than
they complete); transferring an object produced *inside* a call out of it (the
finished frame, so it moves rather than being copied, and so the move can be
measured); and a lane discipline between preview and export over one device,
which is worker-side state rather than a remote object graph. The shape of the
RPC is otherwise what docs/API.md section 9 describes, written out.
`worker/protocol.ts` carries the full argument.

**What crosses, and in which direction.**

- **In, once per image open:** the decoded source, **copied**. It is the one
  large copy in the design — 69 MB for a 2400x1800 image, measured and logged on
  both sides — and it is a copy rather than a transfer because the main thread
  needs the same pixels for the before/after reference (F-UI-04) and for palette
  extraction (F-CO-02). The decode staying on the main thread is what forces it;
  moving extraction into the worker would let the surface be transferred, and
  that is the next thing to do here, not something to pretend is already done.
- **In, per render:** the document. Kilobytes.
- **Out, per preview frame:** an `ImageBitmap`, **transferred**. The worker
  encodes the frame to sRGB and paints it into an `OffscreenCanvas`; the
  viewport draws the result with one `drawImage` and never touches a pixel.
  Before this the main thread paid a full-frame `putImageData` per frame.
- **Out, per export frame:** the samples themselves, transferred, because an
  encoder needs them.

**Two things stay on the main thread deliberately.** The viewport's canvas is
not transferred: it is not a render target but a compositor for a frame, a
checkerboard, a reference image and a split divider, driven directly by pointer
events, and moving it would put every pan and zoom through a message queue to
remove a `drawImage` that costs nothing. `OffscreenCanvas` earns its place at
the frame boundary instead, where it removes real per-frame work. The image
decode stays for the reason above.

**The GPU readback to present is still paid** when the frame is GPU-resident — a
2D context cannot draw a WebGPU texture — but it is paid in the worker.

### Cancellation, and one queue for two callers

`DocumentRenderer` holds one node cache, one surface pool and one GPU backend,
and none of it is re-entrant; it had two callers, and they were kept apart by a
promise chain in the export adapter that could only serialise export against
itself. `worker/queue.ts` is now the one queue both go through, and the renderer
throws on re-entry rather than documenting the rule in a comment.

- A **preview** is superseded by a newer preview: at most one waits, and one
  already running is *aborted* — `graph/render.ts` checks the signal before each
  plan step, which is every cancellation point a graph execution has, since a
  compute submission and a diffusion kernel are each one indivisible call.
- An **export** preempts a running preview and is never superseded. The
  preempted preview is **re-queued**, not failed, so its caller still gets a
  frame and the screen ends up where the viewport asked for it to be. That is
  both halves of "preview must not block export" and "export must not degrade
  preview".
- Export's cancel reaches the worker by call id, so F-EX-13's "a cancel that
  stops the worker" is now literally that.

### Adaptive preview resolution (F-UI-03) is honoured

The viewport computes a factor (`viewport/quality.ts`, `previewScaleFactor`) and
emits it on its `request` event; `session.ts` subscribes and carries the quality
and the factor into every render. Below 1 the worker resamples the **source** to
the reduced extent (`worker/resample.ts`, an area-average box filter in linear
light — point sampling would alias a dither into a pattern that is not in the
picture) and the whole graph runs there. The graph needed nothing:
`graph.width`/`graph.height` are already in every content hash, so a preview and
a full render key to different cache entries by construction.

The badge therefore describes something that happens. Measured: at 100% zoom on
a 2400x1800 document the drag frames are 1633x1225 and the badge reads
`PREVIEW 68%` — the 2-megapixel budget, which is the ceiling that bites on a
large image — and the idle frame is 2400x1800 with the badge gone.

## Export

**Preview and export do not merely share a graph — they share a frame.** The
export panel calls `renderer.render` for the document that is on screen and
encodes the `ImageData` the viewport was given, so the file cannot disagree with
the picture. The size estimate encodes that same frame, which is why F-EX-14's
number is measured rather than modelled: there is no formula for the size of a
deflated dither, and a number that is wrong by a factor of three is worse than
no number because it is believed.

Two consequences follow and both are load-bearing:

- **A solo point is part of what is on screen, so it is part of the export.**
  The panel says out loud that it is happening rather than silently rendering
  the whole stack.
- **The scale multiplier is applied to the finished frame, never to the
  render.** Re-running the graph at 4x would be a *different picture* — a dither
  is a function of the pixel grid it ran on — so every output pixel is a copy of
  a pixel that was on screen (F-EX-12).

### "Indexed" is a fact about the pixels, not about the graph

The graph carries an index map after a quantizing node, and it is the wrong
thing to export. It describes the frame *at the quantizer*, and a stack can put
a dozen postprocess nodes after it, each writing continuous colour over the top.
So `export/census.ts` counts the colours in the finished frame: 256 or fewer and
an indexed PNG holds it *exactly*, because the palette is built from the values
that are there. The census bails the moment it sees a 257th colour, so a
photograph pays for a few hundred pixels of it.

That same census is the **SVG tracer's input**, which is what makes an SVG and a
PNG of the same picture agree by construction rather than by two code paths
being kept in step. The tracer itself is Rust (`dither-core/src/trace.rs`) and
emits one `<g>` per colour, marked as an Inkscape layer, on integer pixel
corners so adjacent colours share their boundary with no seam. The consequence
worth stating: **a frame of more than 256 distinct colours cannot be traced**,
and it is refused rather than quantized a second time behind the user's back.

### Who writes what

PNG is written here (`export/png.ts` over `export/zlib.ts`), because no browser
will write a palette PNG. JPEG and WebP are the browser's, because nobody should
write a JPEG encoder. SVG is the core's. `export/encode.ts` is the only file
that knows which is which.

### The layering

`web/src/export/` may not know that a document store, a renderer or a session
exist. It states what it needs as two interfaces in its own vocabulary —
`ExportImageSource` (a frame, a subject, a change notification) and
`VectorTracer` (an index map in, an SVG document out) — and
`web/src/ui/export/session.ts` is the single adapter that satisfies both from an
`EditorSession`. That is the same arrangement the panels used while the document
store was being written, and it is why the export module is testable without a
browser, a GPU or a WASM build.

## The proof page

`web/src/main.ts` with `web/proof.html`, at `/proof.html` in development. It is
not the application and it is not a component gallery: it renders the entire
catalogue end to end through the real WASM and WebGPU paths and states, per
effect, how much of the frame moved, what it did to mean luminance and standard
deviation, and how far it rotated hue.

Those numbers are what a human reads against the effect's *name*, and that is
the one check no golden image can make — a golden pins what an effect does, not
that what it does matches what it is called. A levels node that does not move
the tone scale and a hue control that rotates nothing both pass every golden.
The page currently names four such judgements, including `channel-swap` being
the identity at its declared defaults.

It is kept, and it is kept honest about its own limits. Its scheduler is
hand-rolled and predates two features the real render path has: resolved output
extents and per-node instance data. So `internal-resolution`, `nn-upscale` and
`curves` fail *on the page* while working in the application. That is a defect
of the page, not of the engine, and it is the page's next job.

## Testing

The list below is the strategy. What is built today: 157 Rust tests including
golden images for all 15 registered diffusion kernels across four fixtures and
two palettes, and the GIF encoder's own set; 2,188 TypeScript tests including the
catalogue test that runs the startup validator over the shipped descriptors and
asserts the counts above, the `.dork` round trip, the document store and its
history, the image intake, the animation core's clock, modulators, seam and
plan, the timeline's keyframes and playback arithmetic, the batch queue and
naming, the animated containers, and the pure halves of the viewport and every
panel; and 121 golden images for the parallel catalogue — two parameter sets for
each of the 58 GPU effects, and a third for the five whose defaults are the
identity.

**What no automated test covers, and it is still the important gap:** nothing
*automated* drives the assembled application. Every panel's model is unit-tested
and every render stage is tested; the wiring between them — a click reaching a
mutation reaching a frame — is checked by a person with a browser.

`web/test/probe/` is the harness that person uses. It is a plain ES module
loaded from the console against the DEV debug handle, and it imports the real
source modules from the dev server rather than restating any of them, so what it
exercises is the wiring and not a copy of it. It measures the things a unit test
structurally cannot:

- **Main-thread occupancy during a render**, from two independent instruments: a
  `MessageChannel` ping-pong (not clamped by tab visibility, unlike `setTimeout`,
  and not tied to compositing, unlike `requestAnimationFrame`) and a
  `PerformanceObserver` on `longtask`.
- **That a bound parameter reaches the picture**, by rendering two frames of the
  loop and counting differing pixels rather than trusting that the number moved.
- **That an exported GIF is a GIF**, with a container reader written inside the
  probe — verifying the encoder against the encoder's own report would prove
  nothing about the file.

It is not a substitute for an automated run. A headless browser driving the real
page is still the next thing the test strategy needs; the probe is what makes
that run's assertions obvious once somebody writes it.

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
- **Two parameter sets per effect, and a third where two are not enough** — the
  declared defaults, and the far end of every declared surprise range. Defaults
  alone would record the identity for the handful of effects that legitimately
  open as one; the surprise end alone would leave unprotected the state most
  renders actually use. Five effects — `brightness-contrast`, `channel-swap`,
  `curves`, `hsl` and `levels` — are corrections before they are looks, so they
  open on the identity and their `defaults` reference was byte-identical to the
  source fixture: it recorded the fixture rather than the shader. Each now also
  carries an **engaged** render at a written-down parameter set, `ENGAGED_PARAMS`
  in `web/test/gpu-golden/harness.ts`. That table is the only per-effect
  knowledge in the harness and it cannot be derived — the interesting second
  setting for a channel swap is a *rotation*, which no arithmetic over an enum's
  declared options produces.
- **A vacuity check that runs in bless mode too, judged per variant.** An effect
  that returns its input, or that renders an almost black frame, fails the run
  instead of having that output stored as the truth forever. It is the one
  failure a golden set cannot otherwise catch, because it is the failure that
  was present when the set was blessed. It used to take the *best* of an
  effect's variants, which is how the five identity references passed on the
  strength of their surprise render; now every variant is judged on its own and
  the legitimate identity is handled by being named. The check runs both ways:
  an effect that is the identity at defaults and has no `engaged` entry fails,
  and an `engaged` entry for an effect whose defaults are *not* the identity
  fails as stale — because a declaration nobody re-reads is how the hole opened.

**Two references are weak and the reason is geometric, not a defect.** The
fixture is 100x76, and the surprise derivation pushes every parameter to the far
end of its declared range — which for the two line-drawing effects means a period
comparable to the frame. `ridgeline/surprise` runs at pitch 40 on a 76-pixel-tall
fixture, so two rows fit; `wave-field/surprise` runs at wavelength 90 on a
100-pixel-wide one, so barely one wavefront does, and both take `invert: true`,
which makes the remaining ground white. Measured, 90.8% and 89.5% of those two
frames sit in a single 1/255 luminance bucket. They are correct renders and they
still move when the shader moves — 90% of pixels differ from the fixture — but a
reader cannot tell a right wave field from a wrong one by looking at that image,
so the diagnostic weight for both effects rests on their `defaults` reference.
Not papered over: narrowing a declared surprise range to suit the fixture would
change what Surprise Me produces in the product, which is not a decision the test
harness gets to make, and widening the fixture would re-bless all 121 images.

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

**Where the repository is: steps 1 to 7 are done, and step 5 is what made it an
application.**

Steps 1 and 2: all fifteen kernels are built and pinned by goldens, Ostromoukhov
(F-ED-14) included — its table is transcribed from Appendix I of the paper and
the transcription is checked against the paper's own construction rather than
against a second copy of the numbers, in exact rational arithmetic.

Step 3 is built and is now driven by a document: `state/render/graph.ts`
compiles a `.dork` stack to the DAG, and the cache lives across renders, which
is the whole of F-ST-01's "re-render begins at the earliest changed position" —
editing node 7 leaves nodes 1–6 with unchanged hashes and the backwards walk
stops immediately.

Step 4 is done, with boundary instrumentation.

**Step 5 is done**: the shell, the viewport, image intake, the document store
with unlimited undo, the stack editor and the properties panel. Step 6 is done
bar the palette-side index-map operations (F-CO-07 and F-CO-09 through 12): the
editor, the hardware library, extraction with all three algorithms, sorting,
OKLab ramps, output modes and the metric are built, and the two index-map *stack*
nodes (outline F-SP-10, dilate/erode F-SP-11) were already there. Step 7 is done
bar JPEG glitch (F-GL-06); F-SP-14 nearest-neighbour upscale, previously
recorded here as deliberately absent, is built — as the second half of the
F-PP-01 pair, which is what made it a pass rather than a resampling stage.

**Still export, the tracer, documents and presets are done, out of order.** They
sit at steps 10 to 12 in the list above, and they were taken ahead of the clock
and the timeline for one reason: an application that can make a picture and
cannot give it to you is not an application. What is built is PNG (indexed
automatically), JPEG, WebP and SVG with per-colour layers, an integer
nearest-neighbour scale, a measured size estimate, progress with a cancel that
stops work, clipboard, `.dork` save and open in both variants, the preset
library on OPFS with a starter set, and share links.

**Steps 8, 9, 13 and 14 are now built too** — the clock, the modulators, the
timeline, batch and Surprise Me — and with them the **animated** half of export
(F-EX-04 through F-EX-07, plus the PNG sequence and the sprite sheet).

Three seams were left open when those landed in parallel, and all three were the
same shape — a module built correctly against an interface nobody had joined:

- **`state/render/graph.ts` refuses a document carrying bindings, permanently and
  by design.** It compiles a document to a graph, and a binding is not a value it
  can compile. `animation/plan.ts`'s `documentAtFrame` resolves bindings to
  concrete numbers and hands over a document carrying none, so the refusal is
  what *guarantees* the animated path was taken rather than something the
  animated path had to get past. What did not exist was the other half: the
  session's own render pump kept handing the raw document over and putting a
  spurious failure on screen, so it now leaves an animated document to the
  timeline, which is its pump (`state/session.ts`, `request()`).
- **Surprise Me's capability probe asked the wrong question.** It asked whether
  `buildRenderGraph` accepts bindings — it does not and never will — and
  concluded the build had no modulators, so F-SM-09 was disabled in a build where
  animation works. It now probes the real path: `planAnimation`, then
  `documentAtFrame` at two frames, then compile, then check the value actually
  moved.
- **The timeline was a one-way street.** A document arriving with bindings became
  tracks; a track a person made never became a binding, so saving a `.dork`,
  autosaving or copying a share link silently discarded the whole animation.
  `TimelineStore` now writes its modulator tracks back through
  `store.setBindings`, guarded on the tracks array's identity so playback's
  per-frame dispatches do not commit, and claiming the array as adopted before
  handing it over so the notification does not loop.

What remains of animation is **F-AN-04, temporal variation** — stepping a node's
seed or pattern offset per frame rather than interpolating a parameter. The
evaluator is written and tested (`animation/temporal.ts`, `TEMPORAL_MODES`);
nothing in the UI reaches it and `.dork` has no field for it, so it is a plan
option that no caller sets.

`graph/animate.ts`'s `renderAnimation` is also **not used**, and the reason is
structural rather than an oversight. It hashes every frame up front, identifies
the nodes whose hash never changes, and *pins* them so an LRU under budget
pressure cannot evict the shared prefix to hold one frame's throwaway tail. Its
interface is a `graphForFrame` callback in and an `onFrame` callback out, and
neither survives `postMessage`. Using it would mean moving the animation planner
into the render worker and adding a streaming channel to a protocol that is one
message per call. The animated export instead renders each frame as an ordinary
`lane: "export"` call, which gets the cache hits — `ContentHashInput` excludes
the frame index and `DocumentRenderer` retains every node's output, so a node
that did not move is a hit — but not the pinning guarantee.

Two gaps this section used to record are closed. **Nothing resolved an effect id
to its `GpuEffect`**: now every `gpu` effect module exports
`const gpu: GpuEffectSource` beside its descriptor, `loadGpuEffects()` collects
them with the same glob that collects the descriptors, and a `gpu` descriptor
with no source fails the catalogue the way a missing surprise range does. And
**nothing was an application**: `app/main.tsx` is now the entry point and
`web/src/main.ts` is the proof page it used to be pretending not to be.

Two gaps this section used to add are now closed.

**The stack grammar knows about extents.** `EffectDescriptor.resamples` names
the two nodes that write a different extent than they read, and
`registry/stack.ts` refuses one placed where an index map is live *unless it
produces the map it leaves behind*. That distinction is the whole rule and it is
a fact about palette indices rather than a gap in the code: an index is a name,
not a quantity, so no filter means anything applied to one — nearest is the only
coherent rule, and it only lines up with the colour when the colour is resampled
by nearest at the same integer factor. That is exactly `nn-upscale`, which
carries colour and index across together and therefore declares
`producesIndexMap`; `internal-resolution` offers box and Lanczos and writes no
map, so after a dither it is refused in the picker, naming both nodes, before
the node is added. The declaration cannot drift from the passes:
`gpu/compiler.ts` checks the two agree, both ways, every time an effect is
compiled.

**Per-node opacity and blend (F-ST-03) is implemented, for both execution
kinds.** The formulas are defined once in `graph/blend.ts` and applied by each
backend in its own — a compute program in `gpu/composite.ts` over
`shaders/_composite.wgsl`, and planar `f32` arithmetic in the WASM backend — so
a composite costs no boundary crossing on either side, and a diffusion node at
60% opacity looks like a blur at 60% opacity. Blending is in linear light, which
is correct for the multiplicative and comparative modes and deliberately
different from a gamma-space compositor for the three pivoted ones; the argument
is at the top of `blend.ts`. Twelve modes. Two consequences are recorded where
they are enforced rather than discovered: a node that resamples cannot carry a
composite, because its output and its own input are different pixel grids
(`graph/plan.ts` refuses it, the stack row hides the controls); and the index
map is carried across a composite untouched, because it records which palette
entry the node chose and opacity changes how much of that decision is shown
rather than what it was.

## Known technical risks

- **GPU↔CPU boundary cost** scales with the number of serial nodes in a stack.
  Mitigated architecturally, but the ceiling is real and should be surfaced in
  the UI rather than hidden.
- **Memory**: float buffers plus index maps plus a node cache at high
  resolution. Requires the explicit cache budget.
- **GIF compresses dither noise poorly** — LZW hates high-entropy data, which is
  exactly what a dither produces. Measured: a 640x480 two-colour 48-frame loop
  is 622 kB, about 13 kB a frame, against roughly 15 kB for the PNG of one
  frame — so the LZW is doing something, but a dither is close to its worst
  case. Managed by writing the smallest legal code width (a two-colour picture
  gets a 2-bit minimum code size, not 8), by cropping frames to what changed
  when the animation has no transparent index, and by offering APNG/WebP/MP4.
  The animated panel deliberately does **not** show a size estimate: the honest
  one costs three real renders through the real encoder every time a control
  moves, and there is no formula for the size of an LZW-compressed dither to
  model instead.
- **A long export or batch used to crawl in a background tab, and did not have
  to.** The encoders yield every 8 ms of work so a progress bar can move, and
  the yield was `setTimeout(resolve, 0)` — which browsers clamp to about one
  second when the tab is hidden. Measured before the fix: a five-image batch
  where two items took 26 s and 36 s and one never finished at all. The yield is
  now `scheduler.yield()` where it exists and a `MessageChannel` message
  otherwise, neither of which is clamped; the same batch finishes in 4.8 s. The
  risk this records is the general one: **any cooperative yield built on a timer
  stops being a yield the moment the tab loses focus**, which is exactly when a
  long job is running.
- **SVG trace output size** in pixel-perfect mode — real and measured: a
  160x120 four-colour Floyd-Steinberg traces to 3210 contours and 16144 points,
  64.6 kB. Managed by the minimum-feature-size filter (the same picture at 64
  px² is 6.0 kB) and the simplified mode (2.5 kB at a 2 px tolerance), both of
  which report what they cost — how many regions were removed and what
  percentage of the picture they left bare.
- **A large SVG trace cannot be interrupted.** The tracer is one synchronous
  WASM call with no cancellation point inside it, so once it starts it runs to
  completion; the export job's cancel stops on either side of it and no file is
  written. It no longer blocks the *main* thread — it runs in the render worker
  — but it does occupy that worker, so a render cannot start while one is in
  flight. Measured on a 2400x1800 four-colour index map: 397 ms of tracer, and
  the main thread served 217,247 tasks during it with a longest block of 9.2 ms.
  The same call made on the main thread served **zero**.
- **The preview resample is a JS loop.** Reducing a 2400x1800 source to 68% of
  itself costs about 190 ms in the worker, paid once per interaction rather than
  once per frame (the result is cached against the extent, and the viewport
  raises a factor at the start of a drag and again when it ends). It delays the
  *first* degraded frame of an interaction and nothing else. A compute program
  would remove it; it is a JS loop today because that is the version whose
  correctness is provable in a unit test with no device.
- **WebGPU implementation variance** across browsers and drivers produces small
  visual differences; goldens run on a pinned environment.
- **No fallback means the unsupported screen is a real user-facing surface** —
  for those visitors it is the entire product.
