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

To bump: edit the value, run `docker compose up --build`, and confirm the page
still reaches the smoke test.

What you should see, in order down the page:

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
8. **Ordered dithers** — the five ordered dithers through the WebGPU compute
   path, each captioned with the bytes and milliseconds of its readback.

That page is the end-to-end proof: headers, cross-origin isolation, registry
validation, the WASM boundary, the linear-light colour path, WGSL compilation,
compute dispatch and the GPU↔CPU boundary, all working. A section that cannot
run says so in place, with the error that stopped it — a blank gap would read as
"nothing to see here", which is the one thing it must never mean.

The browser console carries the same run in full: one line per pass compiled,
per batch submitted, per boundary crossing with its byte count and duration.

## Watching

Both services watch by default.

- Editing anything under `core/` triggers a WASM rebuild (`cargo watch`), which
  writes into `web/src/wasm/pkg` and makes Vite hot-reload.
- Editing anything under `web/` hot-reloads directly.

File watching uses polling, because native filesystem events do not cross the
Docker bind mount reliably on macOS and Windows hosts.

## Tests

Three suites. Two of them — Rust and web — run inside the container that owns
their toolchain and need no browser: the Rust core has no web dependencies, and
everything the web suite covers — the node registry, content hashing, the node
cache — is deliberately free of `document`, `navigator` and `GPUDevice`. A test
that starts needing a DOM is a signal that a layer has grown one.

The third is the **GPU golden set**, and it needs a browser because a WGSL
compute pass has nowhere else to run. It is documented under "GPU golden images"
below, kept out of the two suites above on purpose: nothing in `vitest` should
start depending on a browser being installed.

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
| `src/registry/stack.test.ts` | Stack grammar: slot order, and that an index-map reader sits downstream of a quantizer |
| `src/registry/document-round-trip.test.ts` | A `.dork` parameter set survives save and load |

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

## GPU golden images

Every effect the registry reports as `execution: "gpu"` is rendered through the
real compute path against a generated fixture and compared to a stored PNG. The
harness is `web/test/gpu-golden/`; the references are `web/fixtures/gpu/`. It is
the parallel half of what `core/crates/dither-core/tests/golden.rs` does for the
serial half, and it is deliberately the same shape: generated fixture, stored
outputs, a stated tolerance, a loud re-bless mode, and orphan detection.

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
in hand, because ninety-six renders times three debug lines is a log nobody
reads — but nothing stops being *recorded*, and a failure quotes all of it.

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

**Blessing from CI.** The browser is pinned, but SwiftShader's JIT emits code for
whatever instruction set it finds, so a laptop and a CI runner are not guaranteed
to agree in the last bit — and on an Apple Silicon host the emulated CPU exposes
a narrower set than a native x86-64 runner does. CI is the machine the gate runs
on, so it is the environment the set should ultimately be blessed in. Run the CI
workflow manually with **`bless_gpu_goldens`** checked; it renders the set there
and uploads it as the `gpu-golden-blessed` artifact. Nothing is committed from
CI: you download it, put it in a commit, and review the pictures, because a
reference changing has to be a decision somebody made.

The set committed today was blessed locally on an emulated x86-64 container. If
the first CI run disagrees, that is what the manual bless is for — and the size
of the disagreement is itself worth reading before you replace anything.

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

## Troubleshooting

**`SharedArrayBuffer: FAIL`, or `crossOriginIsolated` is false.**
The two headers are missing. In dev they come from `web/vite.config.ts`; if you
are behind a proxy, it must pass them through unmodified.

**`WebGPU: FAIL` with "no adapter was returned".**
`navigator.gpu` exists but the driver or GPU is blocklisted. On Linux this is
expected — Linux is not a target platform.

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
  metadata. Registry validation fails the build without it.
- **A behavioural claim that is not in a test file is not a claim.** Tests live
  beside what they test as `web/src/**/*.test.ts` and `#[cfg(test)]` modules in
  `core/`, and both suites run without a browser. See "Tests" above.
