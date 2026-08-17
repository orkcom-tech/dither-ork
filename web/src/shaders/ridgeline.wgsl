// F-PT-09 — Ridgeline: a line screen displaced by the picture's own luminance.
//
// The *Unknown Pleasures* construction, and the one thing the catalogue could
// not do. `line-screen` (F-PT-03) draws parallel lines and varies their WIDTH
// with tone; `wave-warp` (F-GL-10) moves pixels by a geometric function;
// `row-displacement` (F-GL-02) moves them by a seed. None of them moves a line
// **by the picture**, and that single difference is what turns a texture laid
// over an image into a contour reading OF it.
//
// ## The construction
//
// Rows are laid across the frame at a fixed pitch. Row k's baseline is at
// `across = (k + phase) * pitch`, where `across` is the coordinate
// perpendicular to the run of the lines. At every point along its own run, row
// k is displaced towards the viewer by the luminance of the picture **at its
// own baseline** — not at the displaced position, which would be a feedback
// loop with no fixed point. So each row is literally a plot of one line of the
// image, and the set of them is a relief map.
//
// `+across` is towards the viewer: brighter pushes a row down the page, rows
// with a larger index are in front.
//
// ## Hidden-line removal is not a refinement, it is the effect
//
// Without it the rows cross each other freely and the result reads as noise —
// a tangle of sine-ish curves with no depth in it. With it, a row is opaque:
// it hides whatever is behind it, and the eye reads the occlusion as relief.
// The requirement says so and the reference images are the proof.
//
// It is done here **without sorting and without a second buffer**, by asking
// the painter's-algorithm question at each pixel instead of executing it. Row k
// paints two things: its own stroke, a band of `thickness` centred on the row,
// and its fill, everything below the row. Drawn back to front, the front-most
// row that paints anything here is what is visible. That row is the largest k
// with `row_k - thickness/2 <= across`, and the pixel is ink exactly when it is
// within half a thickness of that row's curve. One bounded walk, no ordering
// pass, no depth buffer.
//
// ## Two colours, because it is a drawing
//
// A ridgeline is ink on paper, so it uses the palette's lightest and darkest
// entries and nothing between them — a stroke rendered in a mid-tone would be a
// grey line, which is not what a plotter or a phosphor does. Over a dark
// two-colour palette with `epsilon-glow` after it, that is the neon look the
// references have.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const TAU : f32 = 6.28318530717958647692;

// Pitch divides the sampling coordinate. The registry's legal range starts well
// above this, so the clamp only catches a malformed document — but a zero here
// paints the frame NaN, and NaN in a linear-light buffer survives every node
// after it.
const MIN_PITCH : f32 = 1.0;

// How many rows back the walk may go before it is guaranteed to have found the
// front-most one that paints here.
//
// Row k's curve never sits more than `amplitude` pitches below its own
// baseline, so a row `amplitude + 1` behind the pixel's own row has certainly
// reached it. The registry caps amplitude at 10 pitches (RIDGELINE_MAX_AMPLITUDE
// in ridgeline.effect.ts), and one more covers the floor() in `top`: 12 is
// sufficient at every legal parameter set, and it is a constant so the loop is
// statically bounded.
const SEARCH_ROWS : i32 = 12;

// Offsets must match RIDGELINE_UNIFORMS in
// web/src/effects/ridgeline.effect.ts. The three pad members make the 48-byte
// size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width      : u32,   //  0
  height     : u32,   //  4
  pitch      : f32,   //  8  texels between baselines
  amplitude  : f32,   // 12  displacement at white, in pitches
  thickness  : f32,   // 16  stroke width in texels
  angle      : f32,   // 20  turns
  phase      : f32,   // 24  in pitches
  hidden     : u32,   // 28  hidden-line removal
  invert     : u32,   // 32  swap ink and ground
  pad0       : u32,   // 36
  pad1       : u32,   // 40
  pad2       : u32,   // 44
};

struct PaletteEntry {
  linear : vec4<f32>,
  match_ : vec4<f32>,
};

struct PaletteData {
  count   : u32,
  metric  : u32,
  pad0    : u32,
  pad1    : u32,
  entries : array<PaletteEntry>,
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var dst_index : texture_storage_2d<r32uint, write>;
@group(0) @binding(4) var<storage, read> palette : PaletteData;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: clamped texel fetch (keep identical across shaders) ----------
//
// Every neighbourhood effect needs this and none of them may use a sampler:
// the working surface is linear-light rgba16float read at integer coordinates.
// Out-of-bounds `textureLoad` returns zero, so an unclamped kernel paints a
// dark frame one radius wide around the image. Clamp-to-edge is the standard
// answer and the only one that leaves a flat field flat.
fn load_clamped(coord : vec2<i32>) -> vec4<f32> {
  let last = vec2<i32>(i32(params.width) - 1, i32(params.height) - 1);
  return textureLoad(src, clamp(coord, vec2<i32>(0, 0), last), 0);
}
// --- end shared ----------------------------------------------------------

// --- shared: perceptual lightness (keep identical across shaders) ---------
//
// The cube root of Rec.709 luminance. This is the classical lightness curve —
// CIE L* and OKLab's L are both this shape — and for a neutral colour it is
// exactly OKLab's L, because each row of OKLab's LMS matrix sums to one, so a
// grey of linear value v has l = m = s = v and L = v^(1/3).
//
// Used rather than the full OKLab transform because these effects evaluate
// lightness per TAP, not per pixel: a glow's bright-pass at radius 24 asks for
// it 49 times per invocation, and the full transform is three `pow` calls to
// this one's one. The two agree exactly where it matters — on the neutral axis
// — and the quantity being measured here is relief and edge contrast, not
// colour difference, so no palette decision depends on the difference.
fn rec709_luminance(linear_rgb : vec3<f32>) -> f32 {
  return 0.2126 * linear_rgb.r + 0.7152 * linear_rgb.g + 0.0722 * linear_rgb.b;
}

fn perceptual_lightness(linear_rgb : vec3<f32>) -> f32 {
  // `pow` of a negative base is undefined in WGSL, and a previous node with
  // headroom can leave a channel slightly below zero.
  return pow(max(rec709_luminance(linear_rgb), 0.0), 1.0 / 3.0);
}
// --- end shared ----------------------------------------------------------

// The palette's lightest and darkest entries, in that order.
//
// A drawing has an ink and a ground, and it has no use for the entries in
// between: this is not tone reproduction, it is a stroke. Choosing them by
// luminance rather than by index is what makes the node behave the same way
// under any palette the user loads or extracts, in any order, and what makes a
// dark two-colour palette produce a bright line on black without anybody
// setting anything.
//
// The lowest index wins a tie, so two entries of equal luminance give a
// deterministic answer rather than one that depends on the loop.
fn ink_and_ground() -> vec2<u32> {
  var lightest : u32 = 0u;
  var darkest  : u32 = 0u;
  var most  : f32 = -1.0;
  var least : f32 = 1.0e30;
  for (var i : u32 = 0u; i < palette.count; i = i + 1u) {
    let y = rec709_luminance(palette.entries[i].linear.rgb);
    if (y > most) {
      most = y;
      lightest = i;
    }
    if (y < least) {
      least = y;
      darkest = i;
    }
  }
  return vec2<u32>(lightest, darkest);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let alpha = textureLoad(src, coord, 0).a;

  let centre = vec2<f32>(f32(params.width), f32(params.height)) * 0.5;

  // Turns rather than degrees: a modulator ramping 0 -> 1 sweeps the rows
  // through a full revolution and lands where it started, so an animated
  // direction closes its loop by construction (CONVENTIONS.md). The halftone
  // family's degrees are a printer's convention and this is not a printing
  // screen.
  let a = params.angle * TAU;
  let dir = vec2<f32>(cos(a), sin(a));    // along the run of a row
  let nrm = vec2<f32>(-dir.y, dir.x);     // across the rows, +towards the viewer

  // Rotation about the image centre, so an animated direction sweeps the frame
  // evenly instead of pivoting on a corner.
  let q = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5) - centre;
  let across = dot(q, nrm);
  let along  = dot(q, dir);

  let pitch = max(params.pitch, MIN_PITCH);
  // Amplitude is in PITCHES, not in texels, and that is a design decision
  // rather than a unit. The look is set by how far a row travels relative to
  // the gap to the next one — that ratio is what decides whether rows graze
  // each other or pile up into a relief — so expressing it this way keeps the
  // picture recognisable when the pitch is dragged, and it is what bounds the
  // hidden-line walk to a constant number of rows.
  let reach = params.amplitude * pitch;
  let half_t = max(params.thickness, 0.0) * 0.5;

  // The highest row that could paint anything at this pixel. A row's curve is
  // never above its own baseline, so a row whose baseline is more than half a
  // stroke below this pixel cannot reach up to it.
  let top = i32(floor((across + half_t) / pitch - params.phase));

  var ink = false;
  for (var i : i32 = 0; i <= SEARCH_ROWS; i = i + 1) {
    let k = f32(top - i);
    let base = (k + params.phase) * pitch;

    // The picture at this row's own BASELINE — the undisplaced position. Using
    // the displaced position instead would make the row's height depend on
    // where the row already is, which has no fixed point and would read as a
    // smear rather than as a profile.
    let sample = centre + nrm * base + dir * along;
    let lum = perceptual_lightness(
      load_clamped(vec2<i32>(i32(floor(sample.x)), i32(floor(sample.y)))).rgb,
    );

    let row = base + reach * lum;
    let delta = across - row;

    if (params.hidden != 0u) {
      // Painter's algorithm, asked rather than executed: the first row the walk
      // meets going front-to-back that paints here is the one that is visible,
      // and everything behind it is hidden by its fill. This `break` IS the
      // hidden-line removal.
      if (delta >= -half_t) {
        ink = delta <= half_t;
        break;
      }
    } else {
      // Rows are wireframe: no fill, so nothing occludes and a stroke anywhere
      // in the walk shows. The tangle this produces is the thing the
      // requirement contrasts hidden-line removal against, and it is kept as a
      // control because it is a legitimate oscilloscope look on its own.
      if (delta >= -half_t && delta <= half_t) {
        ink = true;
        break;
      }
    }
  }

  let pair = ink_and_ground();
  let stroke = select(pair.x, pair.y, params.invert != 0u);
  let ground = select(pair.y, pair.x, params.invert != 0u);
  let index = select(ground, stroke, ink);

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(palette.entries[index].linear.rgb, alpha));
  textureStore(dst_index, coord, vec4<u32>(index, 0u, 0u, 0u));
}
