# dither-ork

[![CI](https://github.com/orkcom-tech/dither-ork/actions/workflows/ci.yml/badge.svg)](https://github.com/orkcom-tech/dither-ork/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/images/hero.gif" alt="One illustration of a cybernetic orc, cycling through six dithered variants: a cyan and magenta halftone, a sepia one, a green one, an RGB-shift glitch, a teal displacement, and a melted smear." width="760">
</p>

### **[Try it now →](https://dither-ork.pages.dev)**

Free, no account, nothing to install. Your images never leave your machine —
there is no server, and the whole pipeline runs in the page.

A dithering application that runs in the browser. Open an image, wire effects
into a node graph, animate any parameter, and export a still, a seamless loop, or
a vector file. Nothing is uploaded: there is no server.

<p align="center">
  <img src="docs/images/before-after.png" alt="The source illustration beside the same illustration reduced to a cyan and magenta halftone." width="880">
</p>

<p align="center"><em>Source, and one output.</em></p>

## What it does

- **73 effects** you can reorder and wire — 15 error diffusion, 6 ordered, 13
  pattern, 16 glitch, 17 special, 6 preprocess. Any effect, any number of times,
  each with its own opacity and blend mode.
- **A node graph, not a list.** A document is nodes plus edges: a branch can be
  fed from a generator instead of the photograph, and two branches can converge
  on one node. The node editor draws it, and every illegal connection is refused
  with the reason before you commit it. Documents written before the graph load
  as the chain their order implied, and re-save as the same picture.
- **Sources** — three of those take no image at all: noise (value, Perlin,
  simplex, Worley, fractal), gradients (linear, radial, conical) and shapes
  (circle, rectangle, polygon, star, from a signed distance field). Press **new
  canvas** and a document can start from nothing instead of from a photograph.
- **Palettes** — extract one from the image, or use one of 15 built-in hardware
  palettes (Game Boy DMG and Pocket, six CGA modes, EGA, C64, ZX Spectrum,
  PICO-8, Teletext, 1-bit). Import your own at runtime.
- **Animation** — bind any numeric parameter to a modulator (sine, triangle,
  saw, square, smooth noise, stepped random) or draw a keyframe track, then play
  it in the viewport. Loops close by construction: cycles-per-loop is an integer
  in the type system, so the last frame *is* frame 0, bit for bit.
- **Export** — PNG (indexed automatically at 256 colours or fewer), JPEG, WebP,
  and SVG traced into one layer per colour for a cutter or an embroidery
  machine. Animated: GIF, APNG, animated WebP, WebM/MP4, PNG sequence, sprite
  sheet. Size is estimated before you commit and cancel actually stops the work.
- **Surprise Me** — a seeded random document with a chaos slider, a history
  strip, and a mode per aspect: reroll it, keep it as it is, or — for animation
  — leave it out so nothing moves. The same seed gives the same document.
- **Batch** — one recipe over many images, to a ZIP or a directory. One
  unreadable file fails alone; the run continues.
- **Documents** — `.dork` files with or without the image inside, a preset
  library, and share links that carry the whole recipe in the URL fragment and
  no image at all. The document autosaves and returns on reload.
- **Help in place** — rest on any parameter for 700 ms or press <kbd>F1</kbd>.
  A seven-chapter guide ships with the app, and its effect catalogue is
  generated from the registry, so a new effect is documented the day it lands.

Rendering, the SVG tracer and the animated encoders run in a web worker that
owns the GPU device and the Rust core, so the window stays responsive while a
large image renders.

### Nine outputs from that one source

<p align="center">
  <img src="docs/images/contact-sheet.png" alt="A three-by-three grid of nine dithered versions of the same illustration, each in a different palette and style." width="880">
</p>

Nine Surprise Me documents, same input, no hand-tuning. Six of them are the
animation at the top.

## Run it

```bash
docker compose up
```

Then <http://localhost:5173>. That is the whole setup — Rust, `wasm-pack` and
Node live inside the images. First run takes several minutes because it builds a
Rust toolchain; after that the cargo registry, git cache and target directory are
named volumes and survive `down`.

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) describes what you should see and what
to do when you do not.

## Requirements

| | |
| --- | --- |
| Browser | Chrome/Edge 113+, Safari 26+, Firefox 141+ (Windows) or 145+ (macOS) |
| OS | macOS or Windows |
| Host tooling | Docker with Compose v2 |

**WebGPU is required and there is no WebGL2 fallback.** WebGL2 has no compute
shaders and no storage buffers; the reasoning and what a fallback would have cost
are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Linux is not a target.** Chrome on Linux ships WebGPU only on Intel Gen12+ and
NVIDIA under Wayland, and Firefox on Linux is Nightly-only.

The page must be cross-origin isolated — WASM threads need `SharedArrayBuffer`,
which needs COOP and COEP. The dev server sends both headers and the production
build ships a `_headers` file; CI fails if either goes missing.

## What it cannot do

- **No video editing.** Animated *output* is in scope. Video *input* is not, and
  it is a separate application rather than a backlog item.
- **No server and no API.** Everything happens in the page. A CLI is planned and
  does not exist.
- **No general image editing** — no layer stack, no selections, brushes or text
  tools. Nodes are not composited in list order onto a canvas and there is no
  per-layer transform: a node's opacity, blend and mask compose it against *its
  own input*, and the wiring is the only compositing order there is.
- **No node that takes a second picture.** The graph carries as many input ports
  as an effect declares, and today no effect declares one: of 73 effects, every
  one has a single image input and only `feedback` has a second port, its own
  previous frame. So two branches can meet on a node's **mask** port and nowhere
  else. Blending two chains as colour, and displacing one picture by another,
  need a node that does not exist yet.
- **Masking has one control of the three it specifies.** F-PP-08 asks for
  coverage from a luminance range, a colour range, or a picture. All three are
  implemented and produce identical numbers on the GPU and CPU paths, but only
  the picture can be reached: you wire a branch into a node's mask port. There is
  no channel picker, no invert, and no way to set a luminance or colour mask
  except by editing the document by hand.
- **No accounts, no collaboration, nothing generative.**
- **Keyframe tracks do not survive a save.** Modulator bindings do; they
  round-trip through `.dork`, autosave and share links. Keyframes have no field
  in the schema yet, so they last the session. The timeline panel says so.
- **One named requirement is declared absent rather than stubbed.** It is listed
  in `web/src/registry/unbuilt.ts`, and searching for it returns the requirement,
  the reason and the nearest built effects instead of nothing. A test fails the
  build if it ever becomes real. F-PT-09 and F-PT-10 left this table by becoming
  real, which is the direction it is supposed to move in:

| Requirement | What it would do | Why it is not built |
| --- | --- | --- |
| F-GL-06 JPEG glitch | Re-encode as JPEG at a chosen quality, corrupt the compressed bytes | Needs a JPEG encoder in the render path. Every node is a compute pass or a serial CPU kernel; this would be a third execution kind |

## Tests

```bash
docker compose exec -T web sh -c 'npm test -- --run'                                # 2188 tests, 133 files
docker compose run --rm --entrypoint bash wasm -c 'cd /app/core && cargo test --all' # 157 tests
```

CI runs both, plus `cargo fmt`, `clippy -D warnings`, a typecheck, a production
build, a check that the production build actually boots, and a GPU golden-image
comparison against a pinned Chrome for Testing build on SwiftShader — 121 stored
renders, every GPU effect at its defaults and at the far end of its declared
surprise range, plus a third parameter set for the five that open on the
identity and would otherwise store a picture of the input.

## Documentation

| File | What is in it |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it is built, and why |
| [docs/API.md](docs/API.md) | The contracts between layers |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Running it locally |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The `core/` boundary rule, and adding an effect |
| [SECURITY.md](SECURITY.md) | What the attack surface is, and is not |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and when it reached production |

## Prior art

Dithering algorithms are published academic and industry work from the 1970s
onward, implemented here from their descriptions. The feature set is modelled on
[Dither Boy](https://studioaaa.com/product/dither-boy/) by Studio AAA, a
commercial desktop application worth its price.

The bundled palettes are factual hardware colour specifications and nothing else.
A palette whose real values could not be established is left out rather than
shipped with invented numbers — the NES and Apple II are the two omissions, both
because their RGB tables are measurements of composite output rather than
specifications. Curated community palettes are not redistributed; import them at
runtime.

## License

Copyright (C) 2026 ORKCOM. GNU Affero General Public License v3.0 or
later — see [LICENSE](LICENSE). No warranty.
