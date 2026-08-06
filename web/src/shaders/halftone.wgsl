// F-PT-01 — Halftone screen: round, square, diamond or elliptical dots on a
// rotated grid.
//
// A halftone is not a threshold *tile* like the ordered dithers — it is a
// threshold *field*, and the field is what makes the tone come out right. For
// every point of a cell the screen answers one question: what fraction of this
// cell is enclosed by the dot whose outline passes through me? Call that
// fraction `t`. Then the set of points with `t < a` is, by construction, exactly
// the dot of area `a` centred on the cell. So a cell that has to print `a` ink
// prints a dot of area `a`, at every tone, for every dot shape, with no lookup
// table and no calibration curve.
//
// That is why each shape below is an analytic *area*, clipped to the cell, and
// not a distance. A distance would need a per-shape normalisation curve to
// reproduce tone, and every such curve is a place for a plausible-looking wrong
// number to live. The areas are closed forms and each one is checkable by hand:
// all four reach exactly 1 at the cell corner, which is the statement that the
// dot has grown to fill the cell.
//
// The dot merging that a real screen shows in the shadows falls out rather than
// being added: past ~78% coverage a round dot's neighbours touch, the clipped
// area formula takes over from the plain πr², and the remaining white shrinks as
// four-cornered stars. Nothing special-cases it.
//
// Geometry is built in a rotated frame about the image centre so an animated
// screen angle sweeps the whole frame evenly instead of pivoting on a corner.
//
// One property of screening anything onto a pixel grid, worth knowing before it
// is mistaken for a bug here: the areas above are exact, but the *sampling* of
// them is not, and how well the sampling error cancels depends on the angle. A
// screen commensurate with the raster — angle 0 with a whole-pixel cell — gives
// every cell the identical sampling phase, so the quantization is systematic
// instead of averaging out. Measured on a flat field at cell 8: a 25% tone
// lands 6.25% off at angle 0, which is exactly 4 pixels of the 64 in a cell,
// and 0.03% off at the default 45. That is why screens are angled in the first
// place, and why the default here is 45 rather than 0.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const DEG_TO_RAD : f32 = 0.017453292519943295;

// Dot shapes. The ordinal is the parameter's position in the registry
// descriptor's `values` list — see HALFTONE_DOT_SHAPES in
// web/src/effects/halftone.effect.ts, which asserts the two agree. Appending a
// shape is safe; inserting one renumbers every saved document.
const SHAPE_ROUND   : u32 = 0u;
const SHAPE_SQUARE  : u32 = 1u;
const SHAPE_DIAMOND : u32 = 2u;
const SHAPE_ELLIPSE : u32 = 3u;

// The cell size divides the sampling coordinate and the aspect divides one of
// its components. The registry's legal ranges both start well above zero, so
// these clamps only catch a malformed document — but a zero in either place
// paints the frame NaN, and NaN in a linear-light buffer survives every node
// after it.
const MIN_CELL   : f32 = 0.03125;
const MIN_ASPECT : f32 = 0.03125;

const METRIC_OKLAB : u32 = 0u;
const METRIC_SRGB  : u32 = 1u;

// Offsets must match HALFTONE_UNIFORMS in web/src/effects/halftone.effect.ts.
// The two pad members make the 48-byte size visible here rather than leaving it
// to WGSL's round-up rule.
struct Params {
  width    : u32,   //  0
  height   : u32,   //  4
  cell     : f32,   //  8
  angle    : f32,   // 12  degrees
  shape    : u32,   // 16
  aspect   : f32,   // 20
  coverage : f32,   // 24
  spread   : f32,   // 28
  offset_x : f32,   // 32
  offset_y : f32,   // 36
  pad0     : f32,   // 40
  pad1     : f32,   // 44
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

// --- shared: colour and palette search (keep identical across shaders) ---

fn linear_to_oklab(c : vec3<f32>) -> vec3<f32> {
  let clamped = max(c, vec3<f32>(0.0));
  let l = 0.41222146 * clamped.r + 0.53633255 * clamped.g + 0.051445995 * clamped.b;
  let m = 0.2119035  * clamped.r + 0.6806995  * clamped.g + 0.10739696  * clamped.b;
  let s = 0.08830246 * clamped.r + 0.28171884 * clamped.g + 0.6299785   * clamped.b;

  let l_ = pow(l, 1.0 / 3.0);
  let m_ = pow(m, 1.0 / 3.0);
  let s_ = pow(s, 1.0 / 3.0);

  return vec3<f32>(
    0.21045426  * l_ + 0.7936178  * m_ - 0.004072047 * s_,
    1.9779985   * l_ - 2.4285922  * m_ + 0.4505937   * s_,
    0.025904037 * l_ + 0.78277177 * m_ - 0.80867577  * s_,
  );
}

fn linear_to_srgb(c : vec3<f32>) -> vec3<f32> {
  let clamped = max(c, vec3<f32>(0.0));
  let lo = clamped * 12.92;
  let hi = 1.055 * pow(clamped, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, clamped <= vec3<f32>(0.0031308));
}

// sRGB Euclidean is a look control, not a fallback: it reproduces what
// period-accurate tools did by doing the maths in gamma space.
fn match_coords(linear_rgb : vec3<f32>, metric : u32) -> vec3<f32> {
  if (metric == METRIC_SRGB) {
    return linear_to_srgb(linear_rgb);
  }
  return linear_to_oklab(linear_rgb);
}

// Rec.709 luma on linear light. Used only to give the candidate pair a stable
// order, never to decide a colour.
fn luminance(c : vec3<f32>) -> f32 {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// The two palette entries the pixel sits between, measured with the palette's
// own metric. An ordered dither alternates between exactly two colours per
// pixel; which two is a perceptual question, and this is where the metric earns
// its place.
//
// Returned darker-first, and that ordering is the point. Returning them
// nearest-first would make the pair swap over as the image crosses the midpoint
// between two entries, and every control that is not symmetric about zero —
// threshold offset above all — would reverse direction at that line. On a
// gradient that reversal is a visible seam. Luminance orders them, with the
// palette index breaking a tie between two entries of equal luminance so the
// result is deterministic rather than dependent on iteration order.
fn candidate_pair(probe : vec3<f32>) -> vec2<u32> {
  var first  : u32 = 0u;
  var second : u32 = 0u;
  var d_first  : f32 = 1e30;
  var d_second : f32 = 1e30;
  for (var i : u32 = 0u; i < palette.count; i = i + 1u) {
    let delta = probe - palette.entries[i].match_.xyz;
    let d = dot(delta, delta);
    if (d < d_first) {
      d_second = d_first;
      second = first;
      d_first = d;
      first = i;
    } else if (d < d_second) {
      d_second = d;
      second = i;
    }
  }

  let lum_first = luminance(palette.entries[first].linear.rgb);
  let lum_second = luminance(palette.entries[second].linear.rgb);
  let swap = lum_second < lum_first || (lum_second == lum_first && second < first);
  return select(vec2<u32>(first, second), vec2<u32>(second, first), swap);
}

// --- end shared ----------------------------------------------------------

// --- shared: halftone dot areas (keep identical with cmyk-halftone.wgsl) --
//
// Every function here returns the fraction of one cell enclosed by the dot
// whose outline passes through the given cell-local point. Cell-local means
// both components in [-0.5, 0.5], so the cell has area 1 and "fraction" and
// "area" are the same number.

// The area under a circular arc: the integral of sqrt(c^2 - t^2) from 0 to x.
// Caller guarantees c > 0.
fn arc_integral(x : f32, c : f32) -> f32 {
  let up_to = clamp(x, 0.0, c);
  return 0.5 * (up_to * sqrt(max(c * c - up_to * up_to, 0.0))
                + c * c * asin(clamp(up_to / c, 0.0, 1.0)));
}

// Area of the disc of radius c about the origin, clipped to the rectangle
// [-a, a] x [-b, b], as a fraction of that rectangle. The caller passes a
// rectangle of area 1 (4ab == 1), so no further normalisation is needed.
//
// Split at x_flat, the abscissa where the circle drops below the rectangle's
// top edge: left of it the disc spans the full height b, right of it the arc
// bounds it. Both pieces are closed forms, so the whole thing is exact — which
// matters, because this single function is what makes the round dot and the
// elliptical dot reproduce tone without a per-shape correction curve.
fn disc_area_in_rect(c : f32, a : f32, b : f32) -> f32 {
  if (c <= 0.0) {
    return 0.0;
  }
  let x_max = min(a, c);
  let x_flat = min(sqrt(max(c * c - b * b, 0.0)), x_max);
  let quarter = b * x_flat + (arc_integral(x_max, c) - arc_integral(x_flat, c));
  return clamp(4.0 * quarter, 0.0, 1.0);
}

fn dot_coverage(shape : u32, local : vec2<f32>, aspect : f32) -> f32 {
  // A square of half-width m has area (2m)^2, and m runs to 0.5 at the cell
  // edge, so the area reaches 1 there.
  if (shape == SHAPE_SQUARE) {
    let m = max(abs(local.x), abs(local.y));
    return clamp(4.0 * m * m, 0.0, 1.0);
  }

  // A diamond |u| + |v| <= s has area 2s^2 until s passes 0.5, after which the
  // four tips are cut off by the cell edges — one triangle of leg (s - 0.5)
  // each. The tips cannot overlap for s <= 1, so the subtraction is exact, and
  // at the corner (s = 1) the area is 2 - 4(0.25) = 1.
  if (shape == SHAPE_DIAMOND) {
    let s = clamp(abs(local.x) + abs(local.y), 0.0, 1.0);
    let tip = max(s - 0.5, 0.0);
    return clamp(2.0 * s * s - 4.0 * tip * tip, 0.0, 1.0);
  }

  // Round and elliptical dots are one construction. Scaling the cell by k in u
  // and 1/k in v is area-preserving, so an ellipse in the square cell is a
  // circle in a rectangle of the same area — and the round dot is that at
  // k = 1. Writing it once means the two shapes cannot drift apart.
  let k = select(1.0, max(aspect, MIN_ASPECT), shape == SHAPE_ELLIPSE);
  let scaled = vec2<f32>(local.x * k, local.y / k);
  return disc_area_in_rect(length(scaled), k * 0.5, 0.5 / k);
}

// --- end shared ----------------------------------------------------------

// The screen's own frame: rotated about the image centre, scaled to cells,
// shifted by the offset, then reduced to the offset from the nearest cell
// centre. Rotating about the centre rather than the origin keeps an animated
// angle sweeping the frame evenly instead of pivoting on a corner.
//
// The angle turns the sampling frame, so with image y running downward a
// positive angle reads as clockwise on screen. Offsets are in cells and along
// the screen's own axes, so they stay meaningful at any angle.
fn screen_threshold(pixel : vec2<f32>) -> f32 {
  let centre = vec2<f32>(f32(params.width), f32(params.height)) * 0.5;
  let angle = params.angle * DEG_TO_RAD;
  let sn = sin(angle);
  let cs = cos(angle);

  let d = pixel - centre;
  var q = vec2<f32>(d.x * cs + d.y * sn, -d.x * sn + d.y * cs);
  q = q / max(params.cell, MIN_CELL);
  q = q + vec2<f32>(params.offset_x, params.offset_y);

  let local = q - round(q);
  return dot_coverage(params.shape, local, params.aspect);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let linear_rgb = texel.rgb;

  let t = screen_threshold(vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5));

  let pair = candidate_pair(match_coords(linear_rgb, palette.metric));
  let entry_a = palette.entries[pair.x].linear.rgb;   // darker
  let entry_b = palette.entries[pair.y].linear.rgb;   // lighter

  // Where the pixel sits between the two candidates, measured in LINEAR LIGHT.
  //
  // Dithering is tone reproduction: the fraction of the cell given to the darker
  // entry has to equal the pixel's position between the two, or a flat field
  // does not average back to itself. Averaging is physical, so it happens in
  // linear light. The metric above still decides *which two* entries are in
  // play; it does not decide the ratio between them.
  let axis = entry_b - entry_a;
  let axis_length_sq = dot(axis, axis);
  var f : f32 = 0.0;
  if (axis_length_sq > 1e-12) {
    f = clamp(dot(linear_rgb - entry_a, axis) / axis_length_sq, 0.0, 1.0);
  }

  // Ink demand: the area of the cell the darker entry has to cover. `coverage`
  // is dot gain — it grows every dot by the same area at every tone, which is
  // what an over-inked press does, so 0 is the only value that reproduces tone
  // exactly.
  let ink = clamp((1.0 - f) + params.coverage, 0.0, 1.0);

  // `t` is the fraction of the cell inside the outline through this pixel, so
  // {t < ink} is exactly the dot of area `ink`. Written through the same
  // (value - 0.5) form the ordered dithers use so `spread` means the same thing
  // here: 1 reproduces tone, 0 collapses to plain nearest-colour, above 1
  // over-screens on purpose.
  let decision = ((1.0 - ink) - 0.5) + (t - 0.5) * params.spread;
  let index = select(pair.x, pair.y, decision > 0.0);

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(palette.entries[index].linear.rgb, texel.a));
  textureStore(dst_index, coord, vec4<u32>(index, 0u, 0u, 0u));
}
