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

What you should see:

1. **Capabilities** — four rows. WebGPU and SharedArrayBuffer must both read
   `OK`. If SharedArrayBuffer reads `FAIL`, the dev server is not sending
   COOP/COEP; check `web/vite.config.ts`.
2. **Core** — `loaded`, with the core version and the registered kernel ids.
3. **Smoke test** — the source gradient plus one dithered result per kernel, in
   the Game Boy DMG palette, nearest-neighbour upscaled.

That page is the end-to-end proof: headers, cross-origin isolation, the WASM
boundary and the linear-light colour path all working.

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

```bash
# core
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
cd core && cargo test
wasm-pack build crates/dither-wasm --target web \
  --out-dir ../../web/src/wasm/pkg --out-name dither_wasm

# web
cd web && npm install && npm run dev
```

`cargo test` in `core/` runs on the host target, not WASM — the core has no web
dependencies, which is the point of that boundary.

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
