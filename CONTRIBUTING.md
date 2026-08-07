# Contributing

## Build and test

```bash
docker compose up                                     # http://localhost:5173
```

Rust, `wasm-pack` and Node live in the images; nothing is installed on the host.
The `wasm` service watches `core/` and rebuilds the WebAssembly package on
change, and Vite hot-reloads `web/`.

Everything below runs against the same containers:

```bash
docker compose exec -T web sh -c 'npm run typecheck'
docker compose exec -T web sh -c 'npm test -- --run'
docker compose exec -T web sh -c 'npm run build'
docker compose run --rm --entrypoint bash wasm -c 'cd /app/core && cargo test --all'
docker compose run --rm --entrypoint bash wasm -c 'cd /app/core && cargo fmt --all && cargo clippy --all-targets -- -D warnings'
```

CI runs all of these, plus a GPU golden-image comparison against a pinned Chrome
for Testing build on SwiftShader. `clippy` runs with `-D warnings`, so a warning
is a failure.

## The `core/` boundary

**Nothing in `core/` may know a browser exists.** It is a Rust workspace —
`dither-core` is the algorithms, `dither-wasm` is the only crate that mentions
`wasm-bindgen`. No DOM, no canvas, no fetch, no `web-sys` in `dither-core`.

The split is not stylistic. Error diffusion is serial — each pixel depends on
error propagated from pixels already processed — so it cannot be a shader, and it
lives in Rust. Everything else is per-pixel independent and is a WGSL compute
pass. Those are the only two execution kinds, and adding a third is an
architecture decision, not a patch.

Two more one-way rules, for the same reason:

- `web/src/export/` may not know that a document store, a renderer or a session
  exists. It is handed frames.
- The web layer does not keep a copy of anything the core enumerates — kernels,
  hardware palettes. It reads them across the boundary. A parallel list drifts.

## Adding an effect is one file

Create `web/src/effects/<id>.effect.ts` — nested folders are fine — and
default-export a descriptor:

```ts
import { defineEffect } from "../types/registry";

export default defineEffect({
  id: "pixel-sort",
  name: "Pixel Sort",
  summary: "Sorts runs of pixels along a row or column, smearing the picture into clean streaks.",
  description: "A span is a run of consecutive pixels whose sort key clears the threshold …",
  keywords: ["pixel sort", "streak", "smear", "databend"],
  concept: "glitch",
  requirement: "F-GL-01",
  slot: "postprocess",
  family: "glitch",
  execution: "gpu",
  surpriseWeight: 0.8,
  producesIndexMap: false,
  requiresIndexMap: false,
  params: [ /* ... */ ],
});
```

That is the whole procedure. No registration call, no import into a central
list — `discovery.ts` finds it with `import.meta.glob`. See
[`web/src/registry/README.md`](web/src/registry/README.md) for the field
reference.

Two things the build enforces, so find out here rather than in review:

- **`summary`, `description`, `keywords` and every parameter's `description` are
  required.** Hover help, the effect picker and the in-app guide all read them.
  A descriptor missing one, or whose description only restates its own label,
  fails validation and the application refuses to start.
- **`web/src/registry/catalogue.test.ts` asserts the per-family, per-execution
  and per-slot counts.** Adding an effect means updating those numbers in the
  same commit. That is the point: an effect that silently stops being discovered
  is invisible in every other way.

## Pull requests

- One change per PR. Say what it does and how you checked it.
- Typecheck, both test suites and `clippy` pass before you open it.
- New behaviour comes with a test. There are 1826 on the web side and 157 in the
  core; one more is not a burden.
- Comments explain **why**. What the code does is already in the code.
- No mocks, no stubs, no placeholder content. If something cannot be done, leave
  it out and say so in the PR.

## What is unlikely to be merged

- A WebGL2 fallback. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Video input, cloud sync, accounts, or anything generative — see the README's
  "What it cannot do".
- Curated community palettes bundled into the repo. Only factual hardware colour
  specifications ship; the rest is imported at runtime.
