# Changelog

What changed, for someone deciding whether they care. Newest first.

Dates are the day the change reached <https://dither.orkcom-tech.cc>, which is
also the day it landed on `main` — every push that passes CI deploys itself.

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
