# dither-ork

A free, open-source dithering application that runs in the browser.

Load an image, stack dither and glitch effects in a reorderable pipeline, bind
any parameter to a modulator, and export a seamless animated loop — or a still,
or a vector file for print and cutting.

**Status: scaffold.** What exists: the colour core in linear light, all 15
error-diffusion kernels against golden images, 48 more effects running as WebGPU
compute passes and pinned by their own golden set in a pinned browser, the
hardware palette library, automatic palette extraction, the render graph and
node cache headless, the node registry with startup validation, and the local
development environment. What does not: any user interface. `docker compose up`
serves a proof page, not an application — there is nothing yet to load an image
into.

---

## Run it

```bash
docker compose up
```

Open <http://localhost:5173>. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for
what you should see and what to do when you do not.

## Requirements

A browser that ships WebGPU: Chrome/Edge 113+, Safari 26+, Firefox 141+ on
Windows or 145+ on macOS.

**There is no WebGL2 fallback.** Target platforms are macOS and Windows, where
every major browser ships WebGPU. The reasoning, and what a fallback would have
cost, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What it will do

- **63 effects** — 15 error diffusion, 5 ordered, 8 pattern, 17 glitch, 16
  special, plus epsilon glow and temporal variation
- **A stackable, reorderable pipeline** — any effect, any number of times, in
  any order, each with its own blend mode and opacity
- **Full colour** — automatic palette extraction, a hardware palette library,
  CMYK halftone, hue-targeted recolour
- **Animation** — a timeline editor with keyframes, parameter modulators, live
  playback, and loops that are seamless by construction rather than by luck
- **Surprise Me** — a seeded random document generator with locks and a chaos
  slider, built to produce usable results rather than noise
- **Export** — PNG, JPEG, WebP, GIF, APNG, MP4/WebM, PNG sequence, sprite
  sheet, and SVG with per-colour groups for cutting and embroidery
- **Batch** — one pipeline over many images

Every requirement is numbered in the project specification.

## What it will not do

- Video editing. That is a separate future application. Animated *output* is in
  scope; video *input* is not.
- General image editing — layers with independent sources, selections, brushes,
  text or shape tools.
- Cloud accounts, server-side rendering, collaboration.
- Anything AI or generative.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it is built and why
- [docs/API.md](docs/API.md) — the contracts between layers
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — running it locally

## Prior art

Dithering algorithms are published academic and industry work from the 1970s
onward and are implemented here from their descriptions.

The feature set is modelled on [Dither Boy](https://studioaaa.com/product/dither-boy/)
by Studio AAA, which is a commercial desktop application and worth its price.

Bundled palettes are factual hardware colour specifications. Curated community
palettes are not redistributed — import them at runtime.

## License

Copyright (C) 2026 Eduard Lugovtsov

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.

Full text: [LICENSE](LICENSE).
