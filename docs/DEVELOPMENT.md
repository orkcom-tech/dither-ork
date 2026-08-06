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

Two suites, one per language, each run inside the container that owns its
toolchain. Neither needs a browser: the Rust core has no web dependencies, and
everything the web suite covers — the node registry, content hashing, the node
cache — is deliberately free of `document`, `navigator` and `GPUDevice`. A test
that starts needing a DOM is a signal that a layer has grown one.

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

`registry.test.ts` ends with a coverage assertion built on a
`Record<RegistryIssueCode, true>`: adding a rejection code to the validator
without adding a test for it stops the file type-checking. Those codes are the
guard rails the whole effect catalogue is written against, so an untested one is
a rail that might not be there.

> **Not yet wired into CI.** The `web` job in `.github/workflows/ci.yml` runs
> `npm run typecheck` and `npm run build`; it needs an `npm test -- --run` step
> between them. Until that lands, the web suite only runs where someone runs it.

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
