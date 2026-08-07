# dither-ork

A free, open-source dithering application that runs in the browser.

Load an image, stack dither and glitch effects in a reorderable pipeline, bind
any parameter to a modulator, and export a seamless animated loop — or a still,
or a vector file for print and cutting.

**Status: it is a still-image application, and work leaves the browser.**
`docker compose up` then <http://localhost:5173> gives you an editor you can
finish something in:

- open a picture, build a stack out of 67 effects, reorder it, edit every
  parameter, solo any node, set per-node opacity and blend mode, change or
  extract the palette, compare against the source, zoom and pan, undo and redo
  without limit;
- **export** PNG (indexed automatically when the picture has 256 colours or
  fewer), JPEG, WebP, or **SVG** traced into one layer per colour for a cutter
  or an embroidery machine — with an integer nearest-neighbour scale for the
  raster formats, a measured size estimate before you commit, progress with a
  cancel that stops work, and copy-to-clipboard;
- **save and open `.dork` documents**, with or without the picture inside them;
  save, apply and share presets, including six starter presets and a share link
  that carries the whole recipe in the URL fragment and no image at all;
- the document autosaves and comes back on reload.

What is **not** built, and is left out rather than stubbed: **animation** — no
timeline, no modulators, no playback, and therefore none of the animated export
formats (GIF, APNG, MP4/WebM, sprite sheet, PNG sequence). Nor is there Surprise
Me, batch, or hue-targeted recolour. The render loop runs on the **main thread**
rather than in a worker, which a long stack at a large size will show you; an
SVG trace of a large image blocks it for the length of the trace for the same
reason.

Everything below under "What it will do" that is not in the list above is still
a plan.

---

## Run it

```bash
docker compose up
```

Open <http://localhost:5173>. First run takes several minutes — it builds a Rust
toolchain. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for what you should
see and what to do when you do not.

`/proof.html` beside it is a development page, not part of the product: it
renders the whole catalogue end to end and states per effect how much of the
frame moved. It is how a shader that compiles but does not do what its name says
gets caught.

## Requirements

A browser that ships WebGPU: Chrome/Edge 113+, Safari 26+, Firefox 141+ on
Windows or 145+ on macOS.

**There is no WebGL2 fallback.** Target platforms are macOS and Windows, where
every major browser ships WebGPU. The reasoning, and what a fallback would have
cost, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What it will do

- **67 effects, built** — 15 error diffusion, 6 ordered, 8 pattern, 16 glitch,
  16 special, 6 preprocess. One of the specification's named effects is
  deliberately absent: JPEG glitch, which needs an encoder in the render path
- **A stackable, reorderable pipeline, built** — any effect, any number of
  times, in any order, each with its own opacity and blend mode
- **Full colour** — automatic palette extraction, a hardware palette library
  and CMYK halftone are built; hue-targeted recolour is not
- **Animation** — a timeline editor with keyframes, parameter modulators, live
  playback, and loops that are seamless by construction rather than by luck
- **Surprise Me** — a seeded random document generator with locks and a chaos
  slider, built to produce usable results rather than noise
- **Export** — PNG, JPEG, WebP and SVG with per-colour groups for cutting and
  embroidery are built; GIF, APNG, MP4/WebM, PNG sequence and sprite sheet wait
  on animation
- **Documents and presets, built** — `.dork` files, a preset library, starter
  presets and share links
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
