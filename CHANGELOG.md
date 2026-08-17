# Changelog

What changed, for someone deciding whether they care. Newest first.

Dates are the day the change reached <https://dither.orkcom-tech.cc>, which is
also the day it landed on `main` — every push that passes CI deploys itself.

## Unreleased

### Added

- **Generators — three effects that take no image, so a document can exist
  without a photograph.** `Noise field`, `Gradient` and `Shape` sit in a new
  `source` slot and make their picture from their parameters alone. **new
  canvas** in the toolbar starts an empty document at a chosen size, and from
  there the whole application works as it always did: the stack goes on top,
  the palette applies, animation binds, export writes a file.

  - **Noise field** — value, gradient (Perlin), simplex, Worley and Worley
    edges, layered as fractional Brownian motion with octaves, octave step,
    falloff and a ridge fold. Every field is three-dimensional, and the third
    coordinate is `Evolve`: animate that and the texture boils in place instead
    of sliding past, which is what a noise source is animated for.
  - **Gradient** — linear, radial or conical, shaped by the same transfer curve
    the Curves node uses, with repeats and mirroring for bands.
  - **Shape** — circle, rectangle, polygon or star, drawn from a signed distance
    field. One `Softness` control covers both looks it is reached for: around a
    pixel it is a crisp antialiased figure, in the hundreds it is a soft haze of
    that shape, because the tone fades across real distance rather than across a
    boolean edge.

  All three are greyscale on purpose — put `Gradient map` after one for colour,
  which gives a real colour picker rather than six numbers pretending to be two
  colours. All of them close their loops: unlike feedback, a generator has no
  reason to stop a document looping, and a noise field animated on `Evolve`
  passes the seam check.

  **Where a generator sits is visible rather than refused.** At full opacity in
  normal blend it replaces the picture outright, and the stack panel dims every
  row above it and says which node is throwing their work away. At any other
  opacity or blend it is composited over what came before — a gradient at 40% in
  multiply over a photograph — which is why the position is not an error.

- **A shared signed distance field (F-INF-01), the analytic half.**
  `web/src/gpu/sdf.ts` fixes what a distance field *is* here — one value per
  pixel, in working-resolution texels, negative inside — so that outline, glow,
  dilate/erode and the wave field can later read one without each inventing its
  own. The closed-form primitives ship and are diffed mechanically against every
  shader that copies them. The other half — a distance transformed *out of the
  picture*, which is what F-PT-10 needs — is not built, and `docs/ARCHITECTURE.md`
  says exactly what it would take.

- **Feedback — the 68th effect, and the first that reads the previous frame.**
  A `Feedback` node composites its own output from the frame before back over
  the current one, decayed and optionally drifting, zooming or spinning. That
  one node is where trails, smear, endless zoom, spirals and most "living"
  texture come from. Controls: decay, blend, trail opacity, drift X/Y, zoom,
  spin. Its history buffer is cleared to transparent black at frame 0, so with
  the default `screen` blend the first frame of a feedback document is its input
  exactly.

  Three things about it are true and are said out loud wherever they bite,
  because each narrows something the application previously guaranteed:

  - **This node and everything after it stop being cached.** A content hash
    cannot describe a picture that depends on every frame before it. Everything
    *upstream* caches exactly as it did — on a `blur → feedback` stack, every
    frame after the first executes one node and takes one cache hit — and the
    excluded nodes are named in the log per render.
  - **A document containing it does not loop.** Animated export reports that
    before you commit to encoding, and the note travels with the finished file,
    rather than failing a seam check the document was never going to pass.
    Every per-modulator check keeps its full strength.
  - **Frames render in order.** Scrubbing backwards re-renders from frame 0,
    with the existing preview badge up and a "replaying k/n" counter on the
    transport bar. Nothing anywhere shows a frame the export would not produce:
    a frame the store cannot serve is refused rather than faked.

## 2026-08-08

### Fixed

- **Surprise Me left the picture frozen when an aspect was locked.** Pressing
  SURPRISE with a lock set updated the panel — new seed, new stack — and left the
  old image on screen. It looked like the generator had stopped working.

  The cause was two correct behaviours meeting badly. A reroll re-uses node ids
  (`n1..nN`) rather than minting new ones, so a binding retained by the animation
  lock still named a node that existed — but that node was now a different effect,
  and the parameter the binding drove was one it had never declared. Planning the
  animation threw on the unknown parameter, the timeline dropped the track and
  stopped driving frames, and the render session was meanwhile skipping its own
  render because the document still carried bindings. Neither one drew anything.

  A retained binding is now kept only when the node it names still declares that
  parameter.

- **Playback could be left running with nothing to play.** Adopting a document
  with no bindings kept the transport running over an empty track list, so the
  clock advanced and redrew a frame nobody had asked for. Playing now implies
  something to play, enforced in both directions.

### Added

- **An exclude for animation, beside the locks.** A lock keeps an aspect across
  rerolls; an exclude leaves it out entirely. Excluding animation produces a
  document with no bindings — nothing moves, and the timeline has no tracks.
  This is the off-switch that was missing: the animation *lock* pinned animation
  on, which is the opposite of what someone reaching for it usually wants.

  Only animation has an exclude, and that is deliberate. An exclude is offerable
  where the absence is a state a document can actually be in: a document with no
  animation is ordinary, while a document with no stack is not a surprise and a
  document with no palette cannot be drawn.

- **The locks now say what they do.** Hover help on each control, through the
  same mechanism the rest of the application uses, because "it is not clear what
  the locks mean" was a fair complaint about a control with four unlabelled
  states.

## 2026-08-07

### Added

- **First public release.** 67 effects in a reorderable stack, 15 hardware
  palettes plus extraction, animation with loops that close by construction,
  Surprise Me, batch, and export to PNG, JPEG, WebP, SVG, GIF, APNG, WebM/MP4,
  PNG sequences and sprite sheets.
- Rendering, the SVG tracer and the animated encoders moved into a web worker,
  so the window stays responsive while a large image renders.
- Contextual help on hover and a seven-chapter guide whose effect catalogue is
  generated from the registry rather than written by hand.
- Published at <https://dither.orkcom-tech.cc>, with documentation at
  <https://orkcom-tech.github.io/dither-ork/>.

### Fixed

- **The deployed application did not start.** Cloudflare Pages had no 404 page,
  so it answered any unmatched path with `index.html` at HTTP 200 — and a module
  worker handed HTML fails with an error carrying no message at all. During a
  deploy, a page loaded a moment before the alias moved would ask for assets that
  no longer existed and get the application's own HTML instead of JavaScript.
  A missing path is now a 404, asserted on every deploy, and a check that the
  built bundle actually boots runs in CI and again against the live URL.
