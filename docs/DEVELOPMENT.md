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

## Useful commands

```bash
docker compose up wasm              # build the core only, then watch
docker compose up --build           # after changing a Dockerfile
docker compose run --rm wasm cargo test --manifest-path /app/core/Cargo.toml
docker compose run --rm web npm run typecheck
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
reports "up to date" when it should not, the lockfile was not regenerated.

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
