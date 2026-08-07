# dither-ork

A free, open-source dithering application that runs in the browser.

Load an image, stack dither and glitch effects in a reorderable pipeline, bind
any parameter to a modulator, and export a seamless animated loop — or a still,
or a vector file for print and cutting.

**Status: it animates, work leaves the browser, and it explains itself.**
`docker compose up` then <http://localhost:5173> gives you an editor you can
finish something in:

- open a picture, build a stack out of 67 effects, reorder it, edit every
  parameter, solo any node, set per-node opacity and blend mode, change or
  extract the palette, compare against the source, zoom and pan, undo and redo
  without limit;
- **animate it** — bind any numeric parameter to a modulator (sine, triangle,
  saw, square, smooth noise, stepped random) or draw a keyframe track with five
  interpolations, then play the loop in the viewport. Loops close **by
  construction**: cycles-per-loop is a positive integer in the type system, so
  frame *N* is frame 0 — the same bits, not a value within a tolerance;
- **export a still** — PNG (indexed automatically when the picture has 256
  colours or fewer), JPEG, WebP, or **SVG** traced into one layer per colour for
  a cutter or an embroidery machine — with an integer nearest-neighbour scale
  for the raster formats, a measured size estimate before you commit, progress
  with a cancel that stops work, and copy-to-clipboard;
- **export the loop** — GIF, APNG, animated WebP, WebM/MP4, a PNG sequence or a
  sprite sheet, with the loop checked before anything renders and any binding
  that would break it named on screen;
- **run one recipe over many images** — a batch queue with per-item status, a
  name template, a ZIP or a directory, and a cancel that stops the workers. One
  unreadable file fails on its own and the rest of the run continues;
- **Surprise Me** — a seeded random document generator with locks, a chaos
  slider and a history strip. The same seed reproduces the same document;
- **save and open `.dork` documents**, with or without the picture inside them;
  save, apply and share presets, including six starter presets and a share link
  that carries the whole recipe in the URL fragment and no image at all;
- the document autosaves and comes back on reload;
- **find the effect you mean, and be told when it is not here.** The picker
  searches everything an effect says about itself, not its name — the glow
  effect is called *Epsilon glow*, so a name search finds nothing and every
  reader concludes there is no glow — and it shows *why* each row matched. When
  a query names something the specification has and this build does not, it says
  so, names the requirement, gives the reason, and offers the closest built
  effects. Four such gaps are declared, and a test fails the build if one of
  them ever becomes a real effect;
- **read what a control does before you move it.** Rest on any parameter for
  700 ms, or focus it and press <kbd>F1</kbd>. Every word of it is the text
  stored beside the shader, so there is no second copy to go stale — a
  descriptor with a missing description, or one that only restates its own
  label, fails the catalogue and the application refuses to start;
- **a user guide in the application** — seven written chapters (getting started,
  the stack and why order matters, what a palette is here, linear light, the
  index map, animation, export) and a searchable catalogue of all 67 effects
  **generated from the registry**, so an effect added today is documented today
  in its own author's words.

The chrome is neutral graphite and the image is the only saturated thing on
screen. That is not a style preference: this tool's whole subject is what happens
to a picture when colour is taken away from it, and the eye adapts to whatever
surrounds what it is looking at, so a coloured interface biases every palette
decision made inside it. Green is kept for one meaning — *this is live*. Light
and dark are both there; dark is the committed default.

The render loop, the SVG tracer and the GIF encoder run in a **web worker** that
owns the GPU device and the Rust core, so the window stays live while a big
picture renders. Measured on this machine: a 2400x1800 image through a seven-node
stack including four serial diffusion kernels occupied the worker for 5.5
seconds, during which the main thread logged **zero long tasks over 50 ms**, and
845 real interface interactions completed with a median latency of 0.13 ms.
While you drag, the preview renders at reduced resolution and says so in a badge;
it goes back to full when you let go.

### What is not built, and is left out rather than stubbed

- **Temporal variation (F-AN-04)** — stepping a node's *seed* or pattern offset
  per frame, as opposed to interpolating a parameter. The evaluator is written
  and tested (`web/src/animation/temporal.ts`); nothing in the UI reaches it and
  `.dork` has no field for it.
- **Keyframe tracks do not survive a save.** Modulator bindings do —
  `document.bindings` is their field and they round-trip through `.dork`,
  autosave and share links. Keyframes have no place in the schema yet, so they
  live in the timeline for the session and are gone on reload. This is stated in
  the timeline panel.
- **Hue-targeted recolour**.
- Four requirements the specification names and this build does not implement.
  They are declared in `web/src/registry/unbuilt.ts` and **the search box names
  them** rather than coming back empty: **JPEG glitch (F-GL-06)**, which needs a
  JPEG encoder in the render path; the **luminance-displaced line screen
  (F-PT-09)**, the *Unknown Pleasures* ridgeline, which needs a displacement
  driven by the picture itself; the **wave field with obstacle interaction
  (F-PT-10)**, which needs a signed distance field that four other things also
  want and that should be built once; and **node masking (F-PP-08)**, which is a
  second image edge on a graph that carries one per node.
- **Node groups** — the graph carries the edges; nothing builds them.

Everything below under "What it will do" that is not in the lists above is still
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

There is also a manual browser probe in `web/test/probe/` — it drives the running
application from the console and measures the things a unit test cannot, such as
whether the main thread stays free during a large render. See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Requirements

A browser that ships WebGPU: Chrome/Edge 113+, Safari 26+, Firefox 141+ on
Windows or 145+ on macOS.

**There is no WebGL2 fallback.** Target platforms are macOS and Windows, where
every major browser ships WebGPU. The reasoning, and what a fallback would have
cost, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What it will do

- **67 effects, built** — 15 error diffusion, 6 ordered, 8 pattern, 16 glitch,
  16 special, 6 preprocess. Every one of them carries its own description and
  search keywords, and the catalogue refuses to load without them. Four of the
  specification's named requirements are absent and are listed above
- **A stackable, reorderable pipeline, built** — any effect, any number of
  times, in any order, each with its own opacity and blend mode
- **Full colour** — automatic palette extraction, a hardware palette library
  and CMYK halftone are built; hue-targeted recolour is not
- **Animation, built** — a timeline editor with keyframes, parameter modulators,
  live playback, and loops that are seamless by construction rather than by
  luck. Temporal variation (stepping a seed per frame) is written but not
  reachable
- **Surprise Me, built** — a seeded random document generator with locks, a
  chaos slider and reproducible seeds, which will animate what it makes
- **Export, built** — PNG, JPEG, WebP and SVG with per-colour groups for cutting
  and embroidery; GIF, APNG, animated WebP, WebM/MP4, PNG sequence and sprite
  sheet
- **Documents and presets, built** — `.dork` files, a preset library, starter
  presets and share links
- **Batch, built** — one pipeline over many images, to a ZIP or a directory
- **It explains itself, built** — search over what an effect *is*, hover help on
  every parameter, an in-app guide whose effect catalogue is generated, and one
  home for every sentence: the descriptor beside the shader

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
