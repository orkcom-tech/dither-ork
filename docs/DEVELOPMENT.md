# Development

## Requirements

- Docker with Compose v2 (`docker compose`, not `docker-compose`)
- A browser that ships WebGPU: Chrome/Edge 113+, Safari 26+, Firefox 141+ on
  Windows or 145+ on macOS

Nothing else. Rust, `wasm-pack` and Node all live inside the images.

## Run it

```bash
docker compose up
```

Then open <http://localhost:5173>.

First run takes several minutes — the `wasm` image installs a Rust nightly
toolchain and builds `wasm-pack` and `cargo-watch` from source. Subsequent runs
are fast: the cargo registry, the git cache and the build target directory are
all named volumes and survive `down`.

### What you should see

The application: a toolbar reading **open image · undo · redo · fit · 100% ·
save · open · presets · export · batch · surprise me** on the left and
**guide · dark** on the right, a stack panel on the left, a viewport in the
middle, properties and palette on the right, a timeline and a **node editor**
along the bottom, and a status bar reading `effects 73` with the GPU adapter
beside it and **source · docs · Made by ORKCOM** at its right end. Press **open
image**, choose a picture, press **add node**, and pick an effect.

The chrome is neutral graphite and the green is a state colour — selected,
moving, playing, live. **If green appears anywhere that is not a state, that is
a bug in the stylesheet that put it there** (see `web/src/ui/theme/tokens.css`,
which is the only file holding a colour value).

To check the whole application in one pass: open an image, add
brightness/contrast then Floyd-Steinberg, press **export** and write a PNG;
raise the scale to 4x and write another; switch the format to **SVG** and write
that; press **save** for a `.dork`, reload the page, press **open** and load it
back — the picture should return exactly. Every one of those is a path a person
takes, and none of them is covered by any of the three test suites.

Since the graph landed there is a second pass worth taking, because the wiring
has failure modes a chain did not. In the **node editor**: press **add node**
twice, select the second node and press **X** to detach it — the stack panel
should mark it *off-graph* rather than leaving it silently doing nothing. Select
a detached source, press **C** to start a connection, step the target with the
arrow keys and read the line under the graph: it names what the drop will do, and
on an illegal target it shows the refusal instead. Step to a node's **Mask** port
and press **Enter** — that is the whole of the masking UI, and it sets the
node's coverage and draws the edge as one undo step. Then save, reload, and check
the node editor lays the graph out in the same places: layout is derived from the
wiring, so a document that moves between two loads is a bug in `ui/graph/layout.ts`.

Three more that are equally uncovered, because they are about what the interface
*says* rather than what it computes:

- **Search finds an effect by what it is, not by its name.** Press **add node**
  and type `glow`; Epsilon glow should be first, and the panel under the list
  should explain that a dark two-colour palette is what makes it the neon one.
  Type `wavy`; wave warp should appear, matched on a keyword rather than on its
  name.
- **Search admits its gaps.** Type `jpeg`. The picker should say that *JPEG
  glitch (F-GL-06) is specified but not built*, give the reason, and offer the
  closest built effects. That table is `web/src/registry/unbuilt.ts`, and
  `search.test.ts` fails the build if an entry in it ever becomes a real effect —
  which is how F-PT-09 and F-PT-10 left it. Type `radio` or `unknown pleasures`
  now and you get `wave-field` and `ridgeline` instead of an explanation.
- **Hover help describes what a control does to the picture** (F-UI-13). Rest the
  pointer on a parameter for 700 ms, or focus it and press **F1**. The panel's
  prose comes off the descriptor and nowhere else, so a control with no help is
  a descriptor that would have failed validation. Escape closes it.

**guide** opens the user guide (F-UI-14): seven written chapters, then *Every
effect*, which is generated from the sealed registry rather than written — so an
effect added today is documented today, in its own author's words. Its search box
consults the same unbuilt table the picker does, so `jpeg` gives the same answer
in both places.

If instead you get one full-page screen naming a missing capability, that is
F-UI-12 and it is working: WebGPU and `SharedArrayBuffer` are hard requirements
and there is no degraded path. If you get a screen listing registry issues, the
effect catalogue in this build does not validate and the application refuses to
start rather than render documents wrongly — see "Troubleshooting".

### The proof page

<http://localhost:5173/proof.html> is a development page, not part of the
product. It renders the whole catalogue end to end through the real WASM and
WebGPU paths and states, per effect, how much of the frame moved, what it did to
mean luminance and standard deviation, and how far it rotated hue.

Read those numbers against the effect's **name**. That is the check no golden
image makes: a golden pins what an effect does, not that what it does matches
what it is called, so a levels node that does not move the tone scale and a hue
control that rotates nothing both pass every golden and both are wrong. The page
currently reports four effects that are the identity at their declared defaults.

Vite builds `index.html` only, so `proof.html` is served in development and is
not in `dist/`. Its scheduler is hand-rolled and older than two features the
real render path has — resolved output extents and per-node instance data — so
`internal-resolution`, `nn-upscale` and `curves` fail on the page while working
in the application. That is the page's bug, not the engine's.

## Pinned toolchains

Every toolchain version lives in `docker/wasm.Dockerfile` and nowhere else:

| Pin | Where |
| --- | --- |
| Rust stable | the `FROM rust:<version>-bookworm` line |
| Rust nightly | `ARG RUST_NIGHTLY` |
| `wasm-pack` | `ARG WASM_PACK_VERSION` |
| `cargo-watch` | `ARG CARGO_WATCH_VERSION` |

One pin lives elsewhere, and has to: `web/test/gpu-golden/chrome-version.txt`
holds the Chrome for Testing build the GPU reference images are valid for. It is
not a toolchain — nothing builds with it — it is the environment a stored picture
was produced in, and changing it means re-blessing the set. Its own Dockerfile
and the CI job both read that file, so the same rule applies: local and CI cannot
drift apart without the drift being a reviewable commit.

Node's own pins live in `web/package-lock.json`, which is committed and installed
with `npm ci`. `vitest` is pinned to an exact version rather than a range in
`web/package.json`, because a test runner that resolves differently on two
machines turns "the tests pass here" into a statement about the machine.

The nightly pin is the one that matters. The WASM build needs nightly only for
`-Z build-std`, and an unpinned `nightly` means a compiler released overnight
can break the build with nothing in the repository having changed — a failure
that is expensive to diagnose precisely because there is no local change to
blame. CI reads these same values straight out of the Dockerfile, so local and
CI cannot drift apart without the drift being a reviewable commit.

To bump: edit the value, run `docker compose up --build`, and confirm
`/proof.html` still reaches the end.

What that page shows, in order:

1. **Capabilities** — four rows. WebGPU and SharedArrayBuffer must both read
   `OK`. If SharedArrayBuffer reads `FAIL`, the dev server is not sending
   COOP/COEP; check `web/vite.config.ts`.
2. **Node registry** — `validated`, with the effect count split by execution
   kind, and a row per effect. A rejected catalogue stops the page here and
   lists every issue; nothing below it runs.
3. **Core** — `loaded`, with the core version, the kernel count and the built-in
   palette count.
4. **Source** — the generated test image.
5. **Error diffusion** — one result per registered kernel, Game Boy DMG,
   nearest-neighbour upscaled.
6. **Hardware palettes** — the same image through a selection of the built-in
   library, each with its swatches.
7. **Automatic palette extraction** — median cut, Wu and k-means at K=8, each
   with the palette it produced and the extraction report.
8. **The parallel catalogue by family** — every ordered, pattern, preprocess,
   special and glitch effect through the real WebGPU compute path, at its
   declared defaults and at the far end of its surprise range, each captioned
   with what it did to the frame and with the bytes and milliseconds of its
   readback.

That page is the end-to-end proof of the *engine*: headers, cross-origin
isolation, registry validation, the WASM boundary, the linear-light colour path,
WGSL compilation, compute dispatch and the GPU↔CPU boundary. It is not a proof
of the application — for that, use the application. A section that cannot run
says so in place, with the error that stopped it; a blank gap would read as
"nothing to see here", which is the one thing it must never mean.

The browser console carries the same run in full, on both pages: one line per
pass compiled, per batch submitted, per boundary crossing with its byte count
and duration, and — in the application — one per node executed with its cache
hit or miss.

## Watching

Both services watch by default.

- Editing anything under `core/` triggers a WASM rebuild (`cargo watch`), which
  writes into `web/src/wasm/pkg` and makes Vite hot-reload.
- Editing anything under `web/` hot-reloads directly.

File watching uses polling, because native filesystem events do not cross the
Docker bind mount reliably on macOS and Windows hosts.

## Tests

Four suites. Two of them — Rust and web — run inside the container that owns
their toolchain and need no browser: the Rust core has no web dependencies, and
everything the web suite covers — the node registry, content hashing, the node
cache, the document store and history, the image intake, the pure halves of the
viewport and of every panel — is deliberately free of `document`, `navigator`
and `GPUDevice`. A test that starts needing a DOM is a signal that a layer has
grown one.

**What none of the three covers is the assembled application.** Every panel's
model is unit-tested and every render stage is tested; a click reaching a
mutation reaching a frame is checked by a person with a browser and by nothing
else. Before claiming a UI change works, open the page and use it — that is the
acceptance test, and it is where this round's defects were found. The manual
probe below is the tool for the parts of that you cannot see by looking.

The third is the **GPU golden set**, and it needs a browser because a WGSL
compute pass has nowhere else to run. It is documented under "GPU golden images"
below, kept out of the two suites above on purpose: nothing in `vitest` should
start depending on a browser being installed.

The fourth is the **production boot check**, and it exists because none of the
other three loads `web/dist`. See "Does the built app start?" below. If you
change how anything is bundled — the worker entry, the WASM package, the
`base`, `_headers` — that check is the one that will tell you.

```bash
# web — one shot, the form CI runs
docker compose exec -T web sh -c 'npm test -- --run'

# web — watch mode; re-runs the affected files as you edit
docker compose exec web npm test

# web — one file
docker compose exec -T web sh -c 'npm test -- --run src/graph/cache.test.ts'

# web — types, which the test files are checked by too
docker compose exec -T web sh -c 'npm run typecheck'

# core
docker compose run --rm --entrypoint bash wasm -c 'cd /app/core && cargo test --all'
```

`npm test` is `vitest`, so the bare form watches and `-- --run` is the one-shot.
Configuration is in `web/vitest.config.ts`, kept separate from `vite.config.ts`
because everything that file sets up is about *serving* the app — cross-origin
isolation headers, polled watching, the WASM package exclusion — and none of it
should be able to change how tests run. Vitest prefers `vitest.config.ts` when it
exists, so the two never merge.

Test files live next to what they test, as `*.test.ts` under `web/src/`. There is
no `tests/` directory and no separate tsconfig: `npm run typecheck` covers the
tests at the same strictness as the source, which is why no file uses vitest's
globals — `describe`, `it` and `expect` are imported.

What the web suite covers today:

| File | What it pins down |
| --- | --- |
| `src/registry/registry.test.ts` | Every way the node registry can reject a descriptor, and that one bad descriptor rejects the whole catalogue |
| `src/registry/params.test.ts` | Defaults, validation and coercion of parameter *values* — what happens to a `.dork` file written by an older build |
| `src/graph/hash.test.ts` | Content hashing: stable across key order and runs, changes for anything that changes pixels, changes for nothing else |
| `src/graph/cache.test.ts` | The byte budget, LRU and transient eviction order, pinning, and the ownership rule that the cache frees each buffer once |
| `src/graph/sha256.test.ts` | The published SHA-256 vectors, and both sides of every padding boundary |
| `src/registry/catalogue.test.ts` | The **acceptance gate**: the real startup validator over the real shipped descriptors, plus the asserted counts by family, execution and slot |
| `src/registry/gpu-effects.test.ts` | That every `gpu` effect resolves to passes and every source belongs to a registered effect |
| `src/registry/stack.test.ts` | Stack grammar: slot order, that an index-map reader sits downstream of a quantizer, and that a resampler is refused where an index map is live unless it carries the map |
| `src/registry/document-round-trip.test.ts` | A `.dork` parameter set survives save and load |
| `src/graph/blend.test.ts` | The twelve blend formulas, in linear light, and that full opacity in normal is the identity |
| `src/export/png.test.ts`, `zlib.test.ts`, `crc32.test.ts` | The PNG encoder written here: chunk framing, filters, bit depths 1/2/4/8, `tRNS`, and a deflate stream a real inflater accepts |
| `src/export/census.test.ts` | F-EX-01's "is the output indexed" — the colour count, the bail past 256, the palette order, and index replication under the scale multiplier |
| `src/export/trace.test.ts` | The vector path either side of the WASM call: index widening, the palette flatten in linear light, the clamps that keep a slider off a value the core throws on, and that a >256-colour frame is refused rather than quantized again |
| `src/export/estimate.test.ts` | That the estimate below the budget *is* the file size, and above it lands close |
| `src/io/document/*.test.ts` | `.dork` in and out including the self-contained variant, presets, the preset library, share fragments, and the starter set validated against the **real** catalogue |
| `src/io/document/migrate.test.ts` | The schema 1 → 2 migration: a linear stack becomes the chain its order implied, every parameter survives, and a re-save is byte-identical to what the graph build would have written |
| `src/graph/topology.test.ts` | Cycle rules — that a feedback edge may close a loop and nothing else may, that the refusal names the stuck nodes, and that the scheduling order is the same on every run |
| `src/graph/edit.test.ts` | The editing surface: every refusal code and the sentence it carries, and that removing a node heals the graph rather than leaving it unrenderable |
| `src/graph/mask.test.ts` | The three coverages, and that the CPU formulas and the WGSL agree on ordinals and channels |
| `src/registry/graph.test.ts` | The grammar over a graph rather than a list: what a node may read, and what combination of effects is refused |
| `src/ui/graph/*.test.ts` | The node editor's model, geometry, keyboard wiring and layout — including that the same document lays out identically twice |
| `src/state/wiring.test.ts` | The store's wiring mutations, including that masking a node with a picture is one undo step |

`registry.test.ts` ends with a coverage assertion built on a
`Record<RegistryIssueCode, true>`: adding a rejection code to the validator
without adding a test for it stops the file type-checking. Those codes are the
guard rails the whole effect catalogue is written against, so an untested one is
a rail that might not be there.

**The counts in `catalogue.test.ts` are the thing to update when the catalogue
changes, and the thing never to delete.** They are asserted rather than reported
because an effect that disappears is silent in every other way. Adding an effect
means editing four numbers in that file and the matching table in docs/API.md;
if the temptation is ever to remove the assertion instead, that is the moment it
was doing its job.

## The manual browser probe

`web/test/probe/` drives the **running application** from the browser console.
It is not part of any suite and not part of the build; it exists for the claims
a `vitest` run structurally cannot make — whether the main thread stays free
during a real render, whether a modulator's movement reaches actual pixels,
whether the bytes an export produced are a valid file.

Stage it (it writes into `web/public/probe/`, which is gitignored, because
everything in `public/` is copied into `dist/` and the fixtures are megabytes of
test images):

```bash
docker compose exec -T web sh -c 'cd /app/web && node test/probe/stage.cjs'
```

Then, in the console on <http://localhost:5173>:

```js
await import("/probe/probe.js");

// Each step is started, not awaited: a driver that awaits a long call over a
// remote debugging channel loses the answer when the channel drops.
__probe.startAll([
  ["reset"],
  ["openImage", "/probe/images/big.png", "big.png"],
  ["responsiveness", ["brightness-contrast", "floyd-steinberg", "scanlines"]],
  ["animates"],
  ["roundTrip"],
  ["seam"],
  ["gif"],
  ["batch"],
]);

__probe.state;    // { running, done, failed }
__probe.results;  // every answer so far, also logged as `PROBE <step> <json>`
```

The steps, and what each is evidence *of*:

| Step | Evidence |
| --- | --- |
| `responsiveness` | The render is off the main thread. Two independent instruments: a `MessageChannel` ticker and a `PerformanceObserver` on `longtask`. It also busts the node cache first, so what is timed is a render and not a cache walk, and performs real DOM reads and store writes throughout. |
| `animates` | A bound parameter reaches the picture — the values at four frames, *and* the count of differing pixels between two rendered frames. |
| `playback` | The transport advances and the timeline owns the viewport. |
| `roundTrip` | A track made in the editor survives `encodeDorkFile` → `parseDorkFile` → `loadDocument` and becomes a track again. |
| `seam` / `brokenSeam` / `seamValidatorDirect` | F-AN-06 at all three layers: the plan builder, the timeline's `planError`, and the export gate — each naming the binding. |
| `surpriseSeed` | The same seed reproduces the same document, and a different seed does not. |
| `gif` | The exported bytes parse as a GIF, with the expected frame count, delay and global colour table — read by a parser written inside the probe, because verifying the encoder with the encoder's own report proves nothing. |
| `batch` | Per-item status, and that one unreadable file fails alone. |

Two things to know when reading its numbers:

- **`requestAnimationFrame` is useless as an instrument here.** A window that is
  not being painted — a background tab, or a remote-controlled pane whose stream
  has stopped — reports zero frames and measures nothing. That is why the probe
  uses a `MessageChannel`, which is an ordinary macrotask and is not tied to
  compositing.
- **`setTimeout` is clamped to about a second in a hidden tab**, so any timing
  that goes through `sleep()` is a floor and not a measurement. This is the same
  clamp that made the export yield a defect — see "Known technical risks" in
  docs/ARCHITECTURE.md.

## GPU golden images

Every effect the registry reports as `execution: "gpu"` is rendered through the
real compute path against a generated fixture and compared to a stored PNG. The
harness is `web/test/gpu-golden/`; the references are `web/fixtures/gpu/`. It is
the parallel half of what `core/crates/dither-core/tests/golden.rs` does for the
serial half, and it is deliberately the same shape: generated fixture, stored
outputs, a stated tolerance, a loud re-bless mode, and orphan detection.

**121 images**: the 58 GPU effects at their declared defaults and at the far end
of every declared surprise range, plus a third **engaged** render for the five
that open on the identity. Those five — `brightness-contrast`, `channel-swap`,
`curves`, `hsl` and `levels` — are corrections before they are looks, so their
`defaults.png` was byte-identical to the source fixture and recorded nothing
about the shader behind it. `ENGAGED_PARAMS` in `harness.ts` is the parameter set
each is rendered at instead, and it is the one table in the harness that names
effects: an effect that is the identity at defaults and is *not* in it fails the
run, and an entry whose effect is not the identity at defaults fails as stale.
Adding an effect that opens as a no-op therefore fails loudly with a message
naming what to add, rather than silently blessing a picture of the fixture.

Why it exists: a transposed coefficient in a halftone screen and an off-by-one in
a displacement kernel both compile, both validate, and both produce a picture.
Nothing but a stored reference catches either. Before this, the parallel
catalogue was checked by a human reading `web/src/main.ts`.

### Running it

```bash
# 1. build the harness page — from the container that owns node_modules
docker compose exec -T web sh -c 'npx vite build --config test/gpu-golden/vite.config.ts'

# 2. build the pinned browser image, once
docker build -t dither-ork-gpu-golden web/test/gpu-golden

# 3. compare against the reference set
docker run --rm -v "$PWD/web:/app/web" dither-ork-gpu-golden
```

Around fifteen seconds for the whole catalogue. Step 2 is only needed again when
`chrome-version.txt` changes.

On an Apple Silicon host add `--platform linux/amd64` to both docker commands.
The image declares that platform anyway — Chrome for Testing ships no
linux-arm64 build, and one reference set is the point — so it runs under
emulation and is still fast.

### When the page fails to start

The harness is two processes with a WebSocket between them, and the browser half
has no stderr of its own. Everything it does has to be *subscribed to* or it is
lost. The rule the driver now obeys:

**Nothing in the harness document can happen before something is listening for
it.** The browser is launched on `about:blank`; `chrome.mjs` enables `Runtime`,
`Log`, `Network` and `Page`, installs page-side `error` and `unhandledrejection`
hooks with `Page.addScriptToEvaluateOnNewDocument`, and only then navigates and
waits for `load`. `Log.enable` also replays what the browser buffered before the
driver connected.

What that buys, concretely:

| The page does | You see |
| --- | --- |
| throws during top-level module execution | `UNCAUGHT <error>` with file, line and stack, then a failure naming the missing global |
| rejects a promise nobody catches | `UNCAUGHT` plus `unhandled rejection:` from the page-side hook |
| fails to load a script, a `.wasm`, anything | `network: FAILED <url> — <errorText>`, with `blockedReason` when COEP refused it |
| gets a 404 under the relative base | `network: HTTP 404 for <url>` |
| logs anything at all | `console.<level>: …`, with the stack for errors |

Every startup failure prints the same block regardless of which path reached it:
the page's URL, `document.readyState`, `crossOriginIsolated`, `isSecureContext`,
whether `SharedArrayBuffer` and `navigator.gpu` exist, the scripts it loaded, and
the whole transcript in order. Live echo drops to problems-only once the plan is
in hand, because a hundred and twenty-one renders times three debug lines is a
log nobody reads — but nothing stops being *recorded*, and a failure quotes all of it.

Cross-origin isolation is asserted rather than inferred, on both sides: `run.mjs`
refuses if the page reports `crossOriginIsolated !== true`, and `harness.ts`
refuses before it calls `init()`. The core is compiled with `+atomics`, so its
memory is shared, so `WebAssembly.instantiate` will not accept it without
`SharedArrayBuffer` — and diagnosed from the inside that arrives as an
instantiation error that never mentions a header.

This section exists because the job once failed with

```
TypeError: Cannot read properties of undefined (reading 'init')
```

and nothing else. The driver had evaluated `window.__ditherOrkGolden.init()` as
soon as it had a socket, without waiting for the document — a race it won on an
emulated laptop and lost on a native runner — and `Runtime.enable` had been
called too late to catch anything that went wrong on the way. If you are ever
tempted to reach for a `try`/`catch` that lets the run continue, this is the
alternative: make the failure say what happened.

### Re-blessing

```bash
docker run --rm -e DITHER_ORK_BLESS=1 -v "$PWD/web:/app/web" dither-ork-gpu-golden
```

Same environment variable as the Rust harness, and it prints the same kind of
banner on the real stderr. It clears the tree first, so an effect that has been
renamed does not leave a stale reference behind. **Look at the diff.** A
re-bless is a statement that the new pictures are the right pictures.

A bless run still refuses — non-zero exit, images written so you can look at
them — if an effect returned its input unchanged at both its defaults *and* the
far end of its surprise range, or rendered an almost black frame in both. Those
are the two ways a reference can be blessed against a broken shader and pass
forever afterwards.

### Which environment is authoritative

**CI is.** The gate runs on GitHub's `ubuntu-latest` x86-64 runners, and that is
where a red build stops a merge, so if a local run and CI disagree about a
picture, CI is right by definition and the committed set has to be the CI one.

A local run is a fast smoke test, not a verdict, and on an Apple Silicon host it
is a smoke test through two layers of translation: the image is
`--platform=linux/amd64`, so the whole container is emulated, and SwiftShader's
JIT then emits code for whatever CPU it believes it is running on. The emulated
CPU advertises a narrower feature set than a native runner's — no guarantee of
FMA, for one — and the tolerance section below exists precisely because that can
land a smooth gradient one code value either side of a rounding boundary.

The gap is not only about pixels. The emulated container is *slower in a
different shape* than a runner: measured on this repository, the browser's
debugging port answers about 2.2 s after spawn under emulation and about 0.45 s
on a runner, while the page load that follows is barely quicker. Any timing
assumption a local run gets away with is one a runner will punish — which is
exactly how the harness once shipped a load race that passed here every time and
failed there every time. Treat a green local run as "nothing obviously broke".

**Re-blessing on CI.** Run the CI workflow manually with
**`bless_gpu_goldens`** checked:

```bash
gh workflow run ci.yml --ref <your-branch> -f bless_gpu_goldens=true
```

It renders the set on the runner and uploads it as the `gpu-golden-blessed`
artifact. Nothing is committed from CI: you download it, replace
`web/fixtures/gpu` with it, look at the pictures, and commit — because a
reference changing has to be a decision somebody made.

```bash
gh run download <run-id> -n gpu-golden-blessed -D web/fixtures/gpu
git status --short web/fixtures/gpu   # then look at the diff, then commit
```

After that, a run on the emulated host may legitimately disagree with the
committed set. That is the set being right and the laptop being approximate; do
not re-bless locally to make it quiet.

### The environment, and why it is this one

The reference set is valid for **one Chrome for Testing build driven onto
SwiftShader**. The version is `web/test/gpu-golden/chrome-version.txt` and
nowhere else; the Dockerfile reads it, and the harness asserts at runtime that
the adapter really is the software one and refuses to run otherwise. A set
blessed on a real driver would encode that driver's behaviour — docs/ARCHITECTURE.md,
"Determinism", records that WebGPU implementation variance across drivers is
real, which is exactly why the goldens need a pinned environment.

Two flags carry that: `--use-webgpu-adapter=swiftshader` picks the CPU
rasteriser, and `--enable-unsafe-webgpu` is required with it, because Chromium
reports `webgpu: unavailable_software` and hands back no adapter at all when the
GPU stack is software-only. Measured, not guessed — without the second flag
`requestAdapter()` resolves to `null` every time.

The alternatives were real and were not taken:

- **Deno's built-in WebGPU** runs on ubuntu-latest with no browser, but it is
  `wgpu` rather than Dawn — a different implementation from the one the product
  targets — and its software path is Mesa's Lavapipe, whose version comes from
  whatever the runner image happens to ship. It also does not run Vite, and the
  registry finds effects with `import.meta.glob` while every effect imports its
  WGSL with `?raw`, so it would need a bundling step that made the test a test of
  a different module graph.
- **Node with Dawn bindings** is the right implementation and needs a prebuilt
  native module pinned outside `package-lock.json`, which is a second pinning
  mechanism for the one thing that must not drift.
- **The runner's own Chrome** drifts with the GitHub Actions image, and a golden
  set that silently re-means itself when a runner image updates is worse than
  none.

Building the image from the committed Dockerfile is what makes a local run and
the CI job the same run.

### The tolerance

Every channel of every pixel must be within **1 of 255** of its reference.

Not zero, unlike the CPU set, and the difference is not laziness. Every pixel the
CPU harness compares is a palette colour, so the only thing that can differ there
is a decision, and decisions do not differ by a little. Half of the parallel
catalogue writes continuous colour through `exp`, `pow`, `sqrt` and trigonometry
in `rgba16float`, and SwiftShader's JIT emits code for whatever instruction set
it finds at runtime, so a runner with FMA and one without can legitimately land a
smooth gradient one code value either side of a rounding boundary.

Measured today: the whole set matches **byte for byte**, so the tolerance is pure
headroom rather than something being spent. Any image that differs at all is
printed even when it passes, so drift is visible in the log before it becomes a
failure.

### Proving it can fail

A reference set that cannot fail is worse than none. `perturb.mjs` makes the
proof reproducible rather than a claim:

```bash
docker compose exec -T web sh -c 'node test/gpu-golden/perturb.mjs list'
docker compose exec -T web sh -c 'node test/gpu-golden/perturb.mjs apply halftone-screen-transpose'
docker compose exec -T web sh -c 'npx vite build --config test/gpu-golden/vite.config.ts'
docker run --rm -v "$PWD/web:/app/web" dither-ork-gpu-golden   # must fail
docker compose exec -T web sh -c 'node test/gpu-golden/perturb.mjs restore'
docker compose exec -T web sh -c 'npx vite build --config test/gpu-golden/vite.config.ts'
```

`apply` keeps an untouched copy of the shader in `.perturb-backup/` and refuses
to run if one is already there, so a crashed run leaves a state a single
`restore` fixes. Three perturbations are defined, each a mistake somebody could
actually make; measured, they move 2.8%, 76% and 25% of the frame at deltas of
170, 255 and 170 code values, against a tolerance of 1.

### What it does *not* cover

- **Only the defaults and one end of each surprise range.** Two parameter sets
  per effect, both derived mechanically from the descriptor. The space between
  them is not swept.
- **No animation.** Every frame is rendered at normalized time 0. The loop seam
  has its own test to be written.
- **One fixture, one palette** (`cga-16`), one seed, one resolution.
- **Multi-node stacks are not exercised.** Each effect renders alone, except the
  two index-map consumers, which get a Bayer 4×4 quantizer upstream because they
  have nothing to read otherwise.
- **It cannot tell you an effect is not the effect it is named after.** A stored
  reference pins what a shader does; it says nothing about whether that matches
  the name on the node. A levels node that never touches the tone scale and a
  hue control that rotates nothing would both be blessed and would both pass
  forever. That reading is the proof page's job — `web/src/main.ts` states, per
  effect, how much of the frame moved, what happened to mean luminance and to
  its standard deviation, and how far hue rotated, so the question can be asked
  against the name.
- **A cyclic parameter's surprise end is its own identity, and nothing notices.**
  Both this harness and the proof page take the end of a declared surprise range
  furthest from the default. For HSL's hue that range is `[0, 1]` in *turns* with
  a default of 0, so the far end is one full turn — exactly the default. The hue
  rotation is therefore never exercised by either. The control does work
  (measured directly: 0.1 turn → 37.6°, 0.25 → 85.3°, 0.75 → −87.8°, 1.0 → 0°),
  but a hue control wired to nothing would pass every check in the repository.
  The fix is a `cyclic` flag on `ParamDescriptor` so a caller can pick a half
  turn instead of a whole one; it is not written.

## Does the built app start?

`web/test/boot/run.mjs`. Serve the real `web/dist`, open it in the pinned
browser, and require that the application reaches a running editor session.

```bash
# 1. build the production bundle
docker compose exec -T web sh -c 'npm run build'

# 2. the browser image — the GPU goldens', there is only one pinned Chrome here
docker build -t dither-ork-gpu-golden web/test/gpu-golden

# 3. check that what was built actually boots
docker run --rm -v "$PWD/web:/app/web" dither-ork-gpu-golden node test/boot/run.mjs

# the same assertion against a deployed origin — this is how a deploy is verified
docker run --rm -e DITHER_ORK_BOOT_URL=https://dither.orkcom-tech.cc \
  dither-ork-gpu-golden node test/boot/run.mjs
```

### Why it exists

Every other suite runs against the *source tree*. `npm test` resolves modules
through Vite, the GPU goldens build a harness bundle of their own, and `cargo
test` never sees the web. **None of them loads the built application**, so the
entire class of defect that only appears after bundling was invisible to all of
them — and one shipped.

The one that shipped: `worker/client.ts` used to construct the render worker
from a `new URL(...)` expression held in a local variable. Vite recognises a
worker only from the exact inline `new Worker(new URL("...", import.meta.url))`
shape; lifted into a local, the expression falls through to plain asset handling
and the **raw TypeScript file** is copied into `dist/assets/` untouched. The
build succeeds, the typecheck succeeds, all 1845 unit tests pass, and the
deployed application asks the browser to execute `.ts` as a module. It cannot,
so it fires a bare `error` event carrying no message at all, and the app dies at
startup. `client.ts` now imports `./render.worker.ts?worker&url`, which asks for
the same thing in a form that cannot be silently downgraded — and this check is
what proves it, per build.

### What it asserts

1. **No startup screen.** Both `StartupFailureScreen` and `UnsupportedScreen`
   render an `h1.screen__title`; its presence is the failure and its text is
   quoted into the report.
2. **`.shell` rendered** — `App`'s root. A page that renders nothing at all
   would otherwise pass a "no failure screen" check.
3. **`editor session ready` was logged.** The shell mounts before the render
   worker is up. That line is emitted only after the worker started, its device
   came up and the core reported its version, so it is the statement that a
   render path exists.
4. **Nothing failed on the wire and nothing was uncaught** — a 404 on a chunk, a
   COEP refusal, a top-level throw. `/favicon.ico` and `/cdn-cgi/` are ignored:
   the browser and the host ask for those, the build does not.

The cross-origin isolation headers it serves are read out of `dist/_headers`
rather than hard-coded, so the file production is configured by is the file the
check is run under. Without them `SharedArrayBuffer` is absent, the capability
gate fails, and you would be chasing a different bug — which is also why a plain
static server is not a substitute for this.

### What it does *not* cover

It boots the application; it does not use it. Opening an image, adding an
effect, exporting a file — still a person with a browser, as above. The check
answers exactly one question, which is the one nothing else was answering: does
the thing that was built start.

It also cannot see the **deploy window**. Assets ship under content-hashed
names and Pages serves one deployment at a time, so for a few seconds after an
upload a page fetched from the edge can reference files from the other
deployment. Before `web/public/404.html` existed, Pages answered those requests
with `index.html` at **HTTP 200 and `text/html`** — and a module worker handed
HTML fails with a `Worker` `error` event carrying no message at all, which is
where `render worker error: undefined` came from. The 404 page makes the host
answer honestly; the window itself is a property of hashed assets on a
single-deployment host and reloading is what closes it. The deploy job retries
its boot check three times for exactly this reason.

### Adding a dependency to a running stack

`node_modules` is a named volume and the `web` entrypoint reinstalls it only at
container start, when the lockfile hash stops matching the one recorded inside
the volume. Restarting compose to pick up a new dependency is disruptive if
anything else is mid-run, so do it in place instead:

```bash
# 1. edit web/package.json on the host
# 2. resolve it inside the running container — this rewrites the bind-mounted
#    lockfile, so the host copy is updated too
docker compose exec -T web sh -c 'npm install --no-audit --no-fund'
# 3. record the new hash so the entrypoint does not reinstall on next start
docker compose exec -T web sh -c \
  'sha256sum /app/web/package-lock.json | cut -d" " -f1 > /app/web/node_modules/.dither-ork-lock-hash'
```

Step 3 is bookkeeping, not correctness: skipping it costs one `npm ci` the next
time the container starts. Skipping step 2 and editing the lockfile by hand does
not work at all — the volume would still hold the old tree.

## Useful commands

```bash
docker compose up wasm              # build the core only, then watch
docker compose up --build           # after changing a Dockerfile
docker compose run --rm wasm cargo test --manifest-path /app/core/Cargo.toml
docker compose run --rm web npm run typecheck
docker compose exec -T web sh -c 'npm test -- --run'
docker compose exec -T web sh -c 'npx tsc -p test/gpu-golden'   # harness types
docker run --rm -v "$PWD/web:/app/web" dither-ork-gpu-golden    # GPU goldens
docker compose down -v              # also drops the cargo and node_modules caches
docker compose logs -f wasm         # watch the build
```

## Without Docker

Supported, but you own the version pins yourself — read them out of
`docker/wasm.Dockerfile` and match them, or expect to debug a difference the
container does not have.

Run these from the repository root.

```bash
# core — tests run on stable, on the host target
cargo test --manifest-path core/Cargo.toml --all

# wasm — nightly, because of -Z build-std
rustup toolchain install nightly-2026-08-01 --profile minimal --component rust-src
rustup target add wasm32-unknown-unknown --toolchain nightly-2026-08-01
cargo install wasm-pack --locked --version 0.15.0
```

```bash
RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals' \
rustup run nightly-2026-08-01 wasm-pack build core/crates/dither-wasm \
  --target web --out-dir ../../../web/src/wasm/pkg --out-name dither_wasm \
  -- -Z build-std=panic_abort,std
```

```bash
# web — `ci`, not `install`, so what gets installed is the committed lockfile
cd web && npm ci && npm run dev

# web tests, same runner and same pinned version as in the container
cd web && npm test -- --run
```

`--out-dir` is resolved relative to the **crate** directory, not the working
directory, which is why it climbs three levels and not two.

`cargo test` runs on the host target, not WASM — the core has no web
dependencies, which is the point of that boundary.

`npm run dev` outside Docker still sends COOP/COEP; those come from
`web/vite.config.ts`, not from the container.

## Threads

The build script sets the atomics, bulk-memory and mutable-globals target
features and builds on nightly with `-Z build-std`, which is what
`wasm-bindgen-rayon` needs. The scaffold does not yet spawn a pool; the build is
configured for it so turning it on later is not a toolchain migration.

The browser side of that requirement is cross-origin isolation, which the dev
server provides. **Production hosting must send the same two headers** — see
`docs/ARCHITECTURE.md`, "Hosting". GitHub Pages cannot, so it is not an option.

## Deploy

The application is on Cloudflare Pages, project `dither-ork`. Cloudflare builds
nothing — the project has no git connection, and `.github/workflows/deploy.yml`
uploads a tree the workflow built itself.

| Setting | Value |
| --- | --- |
| Pages project | `dither-ork` |
| Root directory | `web` |
| Build command | `npm ci && npm run build` |
| Output directory | `web/dist` |
| Production branch | `main` |
| Cloudflare alias | <https://dither-ork.pages.dev> |
| Custom domain | <https://dither.orkcom-tech.cc> |
| Repository secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |

### Why the app has a Pages project of its own

`web/public/_headers` sets `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, without which there is no
`SharedArrayBuffer` and the capability check refuses to start. Cross-origin
isolation is a property of an origin and cannot be scoped to a path, so the app
cannot live in a directory of a site that hosts anything else. The documentation
site is on GitHub Pages, which sets no response headers at all — see
`.github/workflows/pages.yml`.

### What the workflow does

It runs on `workflow_run` when CI succeeds on `main`, not on the push itself. A
push-triggered deploy races the suite and can put a red commit in front of every
visitor before the run that would have caught it has finished.

`web/src/wasm/pkg` is generated and not committed, so it has to exist before
`npm run build`. On the CI-triggered path the workflow downloads the `wasm-pkg`
artifact from the run that triggered it: the bytes that were tested are the
bytes that ship, and Rust is built once per commit instead of twice. On
`workflow_dispatch` there is no such run, so it builds the package from the pins
in `docker/wasm.Dockerfile`.

Two header checks run, and they fail for different reasons. The first greps
`web/dist/_headers` and catches a typo in the file. The second issues `curl -I`
against the production alias after the upload and catches Cloudflare having
dropped a rule it could not parse — Pages does not reject a malformed
`_headers`, it ignores the line, and the only symptom is every visitor getting
the unsupported screen.

### The secrets

Set once, by a repository admin, from the repository root:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

Both prompt for the value rather than taking it as an argument, so neither ends
up in shell history. The token needs `Account / Cloudflare Pages / Edit`;
nothing in the workflow uses anything else.

### DNS

The custom domain is attached to the Pages project. It resolves once the
`orkcom-tech.cc` zone has this record:

| Type | Name | Target | Proxy |
| --- | --- | --- | --- |
| CNAME | `dither` | `dither-ork.pages.dev` | proxied |

Cloudflare validates the domain and issues the certificate on its own once that
record answers. The `.pages.dev` alias works either way and is what the
workflow's header check measures.

### Deploying by hand

The same upload the workflow performs. Needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment.

```bash
docker compose exec -T web sh -c 'npm run build'
rm -rf web/dist/probe
npx wrangler@4 pages deploy web/dist --project-name=dither-ork --branch=main
```

Wrangler writes `.wrangler/cache/pages.json` into the repository root as it
runs, and that file carries the account id. The repository is public: keep
`.wrangler/` in `.gitignore`, and delete the directory rather than committing it
if it is not there yet.

`web/public/probe/` is git-ignored, so it is never in a CI checkout and the
workflow has nothing to remove. Vite copies whatever is in `public/`, though, so
on a machine that has run the probe stager that directory is six megabytes of
test fixtures headed for production.

`--branch=main` is what makes an upload a production deployment. Any other value
produces a preview on its own hostname and leaves production untouched, which is
how you look at a build before it is live.

### Rollback

```bash
npx wrangler@4 pages deployment list --project-name=dither-ork
```

`git revert` on `main`, then let CI and the deploy run, is the only route that
leaves the repository and production saying the same thing, and it is the
default. When it has to be faster than a CI run, check out the last good commit,
build, and upload by hand as above — the result is a new deployment carrying old
bytes, which is a rollback that is still a deployment record.

Cloudflare's dashboard also has a per-deployment rollback control. It is the
fastest and the one that leaves `main` ahead of what is live, so whatever made
it necessary still has to be reverted afterwards.

### robots.txt

`web/public/robots.txt` allows everything. That is a per-project decision and
not a per-domain one: `orkcom-tech.cc` carries development sites as well as this
one, `robots.txt` is per-origin, and every Pages project is its own origin. A
site on that domain that should stay out of search ships its own `robots.txt`
saying so. A blanket rule for the domain would take dither-ork with it.

## Troubleshooting

**`SharedArrayBuffer: FAIL`, or `crossOriginIsolated` is false.**
The two headers are missing. In dev they come from `web/vite.config.ts`; if you
are behind a proxy, it must pass them through unmodified.

**`WebGPU: FAIL` with "no adapter was returned".**
`navigator.gpu` exists but the driver or GPU is blocklisted. On Linux this is
expected — Linux is not a target platform.

**The page is blank, or the panels are missing.**
Open the console. Startup logs one line per stage on the `app` channel; a panel
that failed to register logs a `DuplicateSlotError` naming the id, and a session
that could not be built replaces the whole page with the reason. A blank page
with no log at all usually means the module graph failed to load — check the
Network tab for a 404 on `src/wasm/pkg/dither_wasm.js`, which means the next
entry applies.

**Core reads `not built`.**
`web/src/wasm/pkg` is empty. Run `docker compose logs wasm` and look for the
build error; the `web` service waits on a healthcheck for the `.wasm` file, so
this usually means the Rust build failed.

**Rust rebuilds everything every time.**
The `cargo-target` volume was dropped, most likely by `docker compose down -v`.

**A dependency was added to `package.json` but the web service cannot find it.**
It should not happen: `node_modules` is a named volume, and Docker only seeds a
named volume while it is empty, so a first-run install would otherwise stick
forever. The `web` entrypoint hashes `package-lock.json` against the hash
recorded at install time and reruns `npm ci` when they differ — check the `[web]`
lines at the top of `docker compose logs web` to see which branch it took. If it
reports "up to date" when it should not, the lockfile was not regenerated. Note
that the check only runs at container *start*; to add a dependency to a stack
that is already up, see "Adding a dependency to a running stack" above.

**The GPU golden harness says "the harness is not built".**
`web/test/gpu-golden/dist` is missing or stale. It is a build output and is not
committed; rebuild it with step 1 above. The harness deliberately refuses rather
than running against whatever was there last.

**The GPU golden harness says the page failed to start.**
Read the block underneath it before anything else — it prints the page's URL,
`readyState`, `crossOriginIsolated`, whether `SharedArrayBuffer` and
`navigator.gpu` exist, the scripts it loaded, and every line the page produced in
order, including uncaught exceptions with file and line. See "When the page fails
to start" above for what each class of failure looks like. If that block is empty
and it says the module never ran, the bundle is not being served: check the
`network:` lines for a 404 under the relative base.

**The GPU golden harness says the adapter is not `swiftshader`.**
The browser found a real GPU. That is a refusal, not a failure: reference images
are only reproducible on the software rasteriser. Either the flags in
`chrome.mjs` were changed, or `DITHER_ORK_CHROME` points at a browser that does
not honour them.

**Every GPU reference fails after a browser bump.**
Expected, and it is why the version is pinned in one file. Chrome's WGSL compiler
and SwiftShader's code generation both move between releases. Look at a few of
the uploaded pictures, satisfy yourself the change is a rendering difference and
not a defect, then re-bless in the same commit as the version bump so the two are
reviewed together.

**`vitest: not found`, or a test run that cannot resolve an import.**
The `node_modules` volume predates the dependency. Run the three steps in
"Adding a dependency to a running stack", or restart the stack and let the
entrypoint reinstall.

## Conventions

- **Nothing in `core/` may know a browser exists.** Web-facing code goes in
  `dither-wasm`.
- **No silent behaviour.** Every operation, error path and state change logs.
  No empty `catch`, no swallowed errors.
- **No fallbacks or mocks by default.** Degradation is stated in the UI or it
  does not happen.
- **No unseeded randomness in the pipeline.** Every stochastic node takes an
  explicit seed from the document. `Math.random()` in a render path is a defect.
- **Adding an effect** means adding a registry descriptor with its surprise
  metadata **and its prose**: a `summary`, a `description` and `keywords`.
  Registry validation fails the build without any of them, and it also fails a
  description that only restates the label — `unhelpful-description`. The same
  rule applies to every parameter. This is F-UI-15, and it is enforced rather
  than requested because the hover help, the picker and the guide all read that
  one copy; there is nowhere else for the words to be written.
- **Descriptive text has exactly one home.** For an effect or a parameter that
  home is the descriptor. For an interface idea with no descriptor behind it —
  what a slot is, what the colour metric changes — it is
  `web/src/ui/help/concepts.ts`, and for a family idea it is `EFFECT_CONCEPTS`
  in `web/src/types/registry.ts`. A fourth copy anywhere is a bug.
- **A behavioural claim that is not in a test file is not a claim.** Tests live
  beside what they test as `web/src/**/*.test.ts` and `#[cfg(test)]` modules in
  `core/`, and both suites run without a browser. See "Tests" above.
- **A UI claim that has not been made in a browser is not a claim either.** The
  suites cover the models, not the wiring. Open the page and do the thing.
- **The shell imports no panel.** A panel registers itself into a slot
  (`app/slots.ts`); the integration is one import from `app/main.tsx`. Nothing
  central is edited, so two panels written in parallel cannot conflict.
- **A control that cannot work is left out, not disabled with a tooltip.**
  Per-node opacity and blend used to be the standing example — in the schema,
  refused by both backends, and absent from the stack row. They are now
  implemented and the controls are back, which is how that rule is supposed to
  end. The rule still holds on the same node: the two controls are **hidden** on
  a node that resamples, because its output and its own input are different
  pixel grids and there is nothing a person could change to make a composite
  apply. Hidden rather than disabled, for exactly that reason.
- **A control that would do nothing in a given mode is hidden, not shown inert.**
  The export panel is the other example: no scale multiplier for SVG, which has
  no pixel grid; no quality slider for a lossless format; no tolerance slider
  outside the simplified trace mode; no stroke width unless outlines are on.
- **Every refusal names the thing and the way out.** "This picture has more than
  256 distinct colours, so it cannot be traced to SVG. Put a quantizing node in
  the stack, or export PNG" is the shape — not "unsupported".
