# dither-ork

A free, open-source dithering application that runs in the browser.

Load an image, stack dither and glitch effects in a reorderable pipeline, bind
any parameter to a modulator, and export a seamless animated loop — or a still,
or a vector file for print and cutting.

**Status: scaffold.** The colour core, the first error-diffusion kernels, the
capability check and the local development environment exist. The application on
top of them does not yet.

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

AGPL-3.0-or-later. See [LICENSE](LICENSE).
