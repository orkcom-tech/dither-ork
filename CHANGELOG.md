# Changelog

What changed, for someone deciding whether they care. Newest first.

Dates are the day the change reached <https://dither.orkcom-tech.cc>, which is
also the day it landed on `main` — every push that passes CI deploys itself.

## Unreleased

### Added

- **The look the catalogue could not make: lines that read the picture.** Two
  effects and the shared infrastructure the second one needed.

  **Ridgeline (F-PT-09)** draws the picture as parallel rows displaced by its own
  brightness — the *Unknown Pleasures* construction. Nothing in the catalogue did
  this: line screen varies a line's *width* with tone and never moves it, wave
  warp displaces by a fixed geometric function, row displacement by a seed. The
  difference is the whole look, because it turns a texture laid over an image
  into a reading of it.

  **Hidden-line removal is what makes it depth rather than noise**, and it is on
  by default. A row in front is opaque and hides what is behind it. It is done
  without sorting and without a second buffer, by asking the painter's-algorithm
  question at each pixel instead of executing it: the visible row is the nearest
  one whose stroke or fill reaches this pixel, which is one bounded walk.

  Amplitude is measured in **pitches, not texels**, because what the eye reads is
  how far a row travels relative to the gap to the next one — so the picture
  survives having the pitch dragged. Over a dark two-colour palette with epsilon
  glow after it, this is the neon line look; both descriptions say so, because it
  is not discoverable from either node's controls alone.

  **Wave field (F-PT-10)** draws waves from a point, a line or the frame's edge,
  and the subject of the picture interacts with them. *Flow around* delays the
  fronts near the subject so they bend past it and carry over it, the way contour
  lines part around a hill. *Shadow* lets the subject block them, leaving the
  region behind it relative to the source empty, with a penumbra one wavelength
  wide. Which part of the picture counts as the subject is a control — a
  brightness threshold or the alpha channel, with an invert and a smoothing
  radius — not a guess.

- **A signed distance field out of the picture (F-INF-01), as shared
  infrastructure.** `web/src/gpu/sdf.ts` already fixed what a field is and shipped
  the analytic primitives the Shape source draws from. The other producer —
  a field transformed out of a photograph rather than described by parameters —
  is now there too: a subject mask, its boundary, and a jump flood, which is the
  construction the requirement names.

  It is built shared because at least four things want it. Outline gets smooth,
  variable-width strokes from it; epsilon glow gets a falloff by distance from
  the subject rather than by blur radius; dilate/erode is a threshold on it by
  definition. Writing it inside the wave field would have meant writing it four
  times.

  The note that had kept it unbuilt said a jump flood needs a scratch *texture*
  and the pass vocabulary has no role for one. That was wrong, and it is why the
  half sat unbuilt for a phase: a jump flood carries a packed seed **coordinate**
  per texel rather than a colour, and a `u32` in a storage buffer holds one
  exactly. The missing role was never a texture.

- **The node editor — where the wiring is actually drawn and changed.** A band
  under the picture, so the frame stays live while you wire. Nodes on a canvas
  with their ports labelled, wires you drag between them, pan, zoom, select,
  duplicate, delete, and one click to say which node is the picture.

  **Connecting is forgiving and refusals are sentences.** A wire lands on the
  nearest port rather than on the one you hit, and a connection that cannot be
  made is refused *with the reason* — the same reason the engine would give, in
  the same voice the effect picker uses when it explains why an effect cannot go
  where the caret is. An illegal port is still something you can aim at and read,
  because being told why is the point.

  **Dropping a branch on a mask port masks the node.** That one gesture sets the
  node's coverage to read the picture and wires it, as a single undo step. It is
  the path F-PP-08 exists for, and asking for a separate first step is how a
  feature becomes something people are told about rather than something they use.

  **All of it works from the keyboard.** Arrows move between nodes; `C` starts a
  connection and the arrows step through every port it could land on, showing
  the refusal or the consequence for each; `Enter` commits. Disconnect, output,
  duplicate, delete, zoom and fit are all keys, and every port is a real focusable
  control with a name that says what it is and what is wired to it. The list of
  keys is printed in the panel rather than in documentation nobody opens.

  **Positions are computed from the wiring and are not stored.** A node sits one
  column right of everything it reads and level with the picture it transforms,
  so a chain comes out as a straight line and a mask branch hangs below the node
  it modifies. The same document therefore lays out identically on every machine,
  and a document nobody has opened in the editor still reads correctly. The
  consequence is stated in the panel rather than discovered: **a node cannot be
  dragged to a new place**, because there is nowhere to save one and a drag that
  is lost on reload is a control that only appears to work.

- **The stack panel stays, as a view onto the graph.** Most documents are chains,
  most people think in chains, and every document, preset and share link written
  before schema 2 is one — so the list is not replaced and is not a second model
  of the document. It lists every node in the document's own order, and now says
  per row where that node sits in the wiring: on the chain to the picture, or
  feeding some other node's mask, or reaching the frame not at all. On a chain
  there is nothing to say and the panel is exactly what it was.

  Fixed with it: **a generator wired into a mask port no longer claims to throw
  the whole stack away.** What a source node discards was decided from its
  position in the list, which stopped being the wiring at schema 2; it is now
  read off the wiring, which gives the same answer on a chain and the true one
  on a graph.

- **Multiple image inputs per node, and the wiring written down.** A `.dork` is
  now **nodes plus edges** rather than a list whose order was the wiring. An
  effect declares how many pictures it reads and what each one *means* — a mask
  is not a second layer is not a displacement source — so the editor can label a
  port and refuse nonsense before a wire is dropped rather than after a render
  fails. All 71 shipped effects declare nothing and still read one picture; that
  is what the default is for, and none of them was touched.

  **Every existing document, preset and share link loads as the chain it always
  was.** Schema 1 is migrated on load: one edge per adjacent pair, the last node
  as the picture, and nothing else changed. Load it, save it, load it again and
  render — the graph and every node's content hash are identical, which is the
  test that matters, because two graphs with the same hashes cannot draw
  different pixels.

- **Node masking (F-PP-08), recorded as unbuilt since phase 3.** Its stated
  reason — "a mask is a second image edge, and the graph carries one image edge
  per node" — stopped being true, so it is built.

  A mask is **spatially-varying opacity** and nothing else. It is not an effect
  and never appears in the catalogue: it sits on the node beside opacity and
  blend, it is applied by the same composite those two are, and **every node is
  maskable for free**. Coverage comes from a luminance band, from nearness to a
  colour measured in OKLab, or from a picture wired into the node's mask port —
  a second branch of the graph. Mask and opacity multiply, because they answer
  different questions: how much of this node overall, and where.

  Two nodes are refused rather than quietly unmasked. A node that **resamples**
  has no pixel-for-pixel correspondence with its own input, so there is no
  picture for coverage to be *of*; it gets no mask port at all. A mask that reads
  a picture with nothing wired to it is an error, not full coverage.

- **Cycles are legal where a feedback edge makes them.** "No cycles" was an
  invariant; it is now a property that exactly one kind of edge may violate,
  because a feedback edge reads the previous frame and imposes no order within
  this one. Everything else the stack grammar refused, graph validation still
  refuses — index-map producers and consumers, extent rules, CMYK halftone's
  missing map — and it adds the refusals a graph makes possible: a dangling edge,
  a port that does not exist, two pictures on one port, a document that names no
  picture. A graph that cannot render is impossible to build.

  The limit is stated rather than hidden: the only feedback edge that exists is a
  node reading **its own** previous output, because the frame store is keyed by
  node id. A general delay edge — B reading A's previous frame — is refused
  naming the reason, not accepted and then rendered from pixels nobody wrote.

- **The evaluation order is deterministic, and that is now a guarantee.** A DAG
  has no single topological order, and the project promises the same document
  gives the same picture. Ties are broken by the execution kind just scheduled —
  which keeps GPU runs coalesced and the boundary crossings down — and then by
  the node's position in the document's own list. Never by a `Set`'s iteration
  order, which is deterministic today for reasons nobody wrote down.


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

### Changed

- **The unbuilt table is down to one entry.** F-PT-09 and F-PT-10 left it by
  becoming real, which is the direction it is supposed to move in, and the
  build fails if an entry in it ever names a shipped effect. Typing *unknown
  pleasures* or *radio waves* into the picker now reaches an effect instead of an
  explanation; only **F-GL-06** (JPEG glitch) still answers with a reason, and its
  reason is an execution kind that does not exist rather than work not yet done.

### Fixed

- **Five golden references were pictures of the input.** `brightness-contrast`,
  `channel-swap`, `curves`, `hsl` and `levels` each stored a `defaults.png` that
  was **byte-identical to the source fixture**. That is not an accident of those
  five: they are corrections before they are looks, and a correction that altered
  the picture the moment it was added could not be added without committing to a
  change, so the identity is the right default. It does mean the stored image
  recorded the fixture and not the shader, and a rewritten shader that never ran
  would have matched it forever. Half the coverage of five effects was
  decorative and the run reported a clean sheet.

  The vacuity check is why it went unseen: it took the *best* of an effect's two
  variants and asked only whether that one moved, so each of the five passed on
  the strength of its surprise render. **Every variant is now judged on its own**,
  and the legitimate identity is handled by being named rather than by being
  averaged away. Each of the five carries a third **engaged** reference at a
  written-down parameter set — a contrast lift, a true cyclic channel rotation, an
  S-curve, a third of a hue turn, a darkening gamma — every value inside the
  parameter's own declared surprise range and checked against the descriptor with
  the application's `validateParams`, so each is a picture the product can really
  make. They move 49% to 90% of the frame where they moved nothing before.

  The check closes in both directions, because a declaration nobody re-reads is
  how this opened: an effect that is the identity at defaults with no engaged
  entry fails the run naming what to add, an engaged entry for an effect whose
  defaults are *not* the identity fails as stale, and an engaged render that comes
  out identical to that effect's surprise render fails as a third picture worth
  reviewing that says nothing new. All three were verified by breaking the table
  on purpose and watching the run go red. The `defaults` references are kept, not
  deleted: they now pin the claim that the opening state really is a no-op.

  The whole set was re-blessed in the pinned browser image afterwards and the
  116 existing references came back byte-identical.

- **Deleting the picture that fed a mask left a document that would not render.**
  Removing a node rewires its consumers to whatever fed *its* `in` port, which is
  what makes deleting from the middle of a chain leave a chain. A generator has
  nothing feeding it, so its consumers simply became roots — correct for a
  picture, wrong for a mask: the masked node went on saying its coverage came
  from a picture, the edge carrying it was gone, and the renderer refused the
  pair. Undo was the only way back, and after a reload there was no undo, because
  nothing in the editor can clear a mask. A mask edge that cannot be healed now
  takes the mask with it — the same pairing `setNodeMask` already enforced from
  the other direction.

- **Four source files were binary as far as git was concerned.** A raw NUL byte
  was being used as a key separator inside template literals, and one in a
  regular expression's character class. Where the byte fell inside git's first
  8000 bytes — `ui/graph/model.ts`, the node editor's model, and
  `batch/destination.ts` — git classified the file as binary and refused to diff
  it, so 19KB of new code would have been committed and reviewed as an opaque
  blob. They are `\u0000` escapes now: identical at runtime, and text again.

### Known gaps

Stated here because they are the difference between what this release built and
what it was for.

- **No node takes a second picture.** The graph carries as many input ports as an
  effect declares, and of the 73 effects every one declares a single image input;
  only `feedback` has a second port, and that is its own previous frame. So two
  branches can converge on a node's **mask** port and nowhere else. Blending two
  chains as colour and displacing one picture by another — the other two reasons
  multiple inputs were built — need a node that does not exist yet. The `layer`
  and `displace` roles are defined and unused.

- **The subject mask reads brightness or alpha, not the index map.** F-INF-01
  names a third source — *the subject is palette entries 2 and 5* — and it is not
  offered. A pass may bind the index map only if its whole effect declares it
  needs one, and that declaration would make the wave field illegal in front of a
  dither, which is the case it was asked for. So a subject the same brightness as
  its background cannot be separated, and nothing guesses at one.

- **Masking exposes one of its three coverages.** F-PP-08 asks for coverage from
  a luminance range, a colour range, or a picture. All three are implemented and
  agree between the CPU and GPU paths; only the picture can be reached, by wiring
  a branch into a mask port, and it always uses the luminance channel. There is
  no channel picker, no invert, and no control that clears a mask. The
  requirement is recorded as partly built rather than done.

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
