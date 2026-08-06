// F-PT-02 — CMYK halftone: four separations, each on its own rotated screen.
//
// The whole point of this effect is that the four screens do *not* line up.
// Four dot grids at the same angle print on top of one another and the result
// is a colour cast that swims as the image moves; at 15 / 75 / 0 / 45 degrees
// they interleave into the rosette that reads as continuous tone. Those four
// defaults are the classical set and they are why every parameter below comes
// in fours — angles and cell sizes are per separation, independently, and the
// registry says so.
//
// Three parts, in order.
//
// **Separation.** Ink is subtractive and this pipeline is linear light, which is
// exactly where a multiplicative ink model belongs: transmittances multiply.
// Black is generated first from the neutral component (`black_generation` is
// the GCR amount), and cyan, magenta and yellow are then solved for what is
// left of the paper — a_c = 1 - r / (1 - a_k) — rather than being taken from the
// image directly. Solving instead of assuming is what makes the four coverages
// reproduce the pixel: with ideal inks the red channel survives only where
// neither cyan nor black printed, so its expected value is (1 - a_c)(1 - a_k),
// which by that solution is r.
//
// **Screening.** Each coverage is compared against its own screen, built the
// same way as halftone.wgsl: the threshold at a point is the fraction of the
// cell enclosed by the dot outline through it, so {t < a} is exactly the dot of
// area a. That gives each separation the dot area its coverage asked for, at
// every tone, with no per-shape calibration.
//
// **Printing.** Present inks multiply their transmittance onto the paper. With
// `ink_density` at 1 the inks are ideal — cyan removes all red and nothing else
// — and tone is reproduced exactly. Below 1 the inks leak, the print lightens,
// and that is the honest behaviour of under-inking rather than a correction to
// apply.
//
// The expectation argument above assumes the four screens are mutually
// equidistributed, which is what choosing 15/75/0/45 buys and what a printer
// means by a moire-free angle set. The residual is the rosette itself, and the
// rosette is the look.
//
// Yellow's 0 degrees is the one angle in that set commensurate with the pixel
// raster, so with a whole-pixel cell every yellow cell samples at the same
// phase and its quantization is systematic rather than averaging out. Measured
// on flat fields at cell 8, blue comes back up to 4% low; moving yellow to 7.5
// degrees, or its cell to a fractional size, drops that to 0.2%. The default
// stays at 0 because the requirement names it and because yellow is the least
// visible ink, which is why it is the plate given that angle in the first
// place — but it is a real effect and not a defect to hunt for.
//
// This effect does not quantize to the document palette: its output colours are
// the ink overprints, sixteen of them, and none of them is a palette entry. So
// it binds no palette and emits no index map — an index into a palette these
// pixels do not come from would be a lie the tracer and the recolour nodes
// would then act on.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const DEG_TO_RAD : f32 = 0.017453292519943295;

// Dot shapes. The ordinal is the parameter's position in the registry
// descriptor's `values` list — see CMYK_HALFTONE_DOT_SHAPES in
// web/src/effects/cmyk-halftone.effect.ts, which asserts the two agree.
// Appending a shape is safe; inserting one renumbers every saved document.
const SHAPE_ROUND   : u32 = 0u;
const SHAPE_SQUARE  : u32 = 1u;
const SHAPE_DIAMOND : u32 = 2u;
const SHAPE_ELLIPSE : u32 = 3u;

// Cell sizes divide the sampling coordinate and the aspect divides one of its
// components. The registry's legal ranges both start well above zero, so these
// clamps only catch a malformed document — but a zero in either place paints
// the frame NaN, and NaN in a linear-light buffer survives every node after it.
const MIN_CELL   : f32 = 0.03125;
const MIN_ASPECT : f32 = 0.03125;

// Below this much paper left, black has already closed the page: there is
// nothing for the other three inks to remove, and solving for them would divide
// by a vanishing number.
const MIN_PAPER : f32 = 0.0009765625;

// Offsets must match CMYK_HALFTONE_UNIFORMS in
// web/src/effects/cmyk-halftone.effect.ts. The two pad members make the 64-byte
// size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width            : u32,   //  0
  height           : u32,   //  4
  cyan_angle       : f32,   //  8  degrees
  magenta_angle    : f32,   // 12
  yellow_angle     : f32,   // 16
  black_angle      : f32,   // 20
  cyan_cell        : f32,   // 24  pixels
  magenta_cell     : f32,   // 28
  yellow_cell      : f32,   // 32
  black_cell       : f32,   // 36
  black_generation : f32,   // 40
  ink_density      : f32,   // 44
  dot_shape        : u32,   // 48
  dot_aspect       : f32,   // 52
  pad0             : f32,   // 56
  pad1             : f32,   // 60
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// --- shared: halftone dot areas (keep identical with halftone.wgsl) ------
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

// One separation's screen. Angle and cell size are arguments rather than
// uniforms read inside, because the four separations differ in exactly those
// two and nothing else — that is the requirement, and passing them makes it
// impossible for one separation to quietly read another's.
fn screen_threshold(pixel : vec2<f32>, angle_degrees : f32, cell : f32) -> f32 {
  let centre = vec2<f32>(f32(params.width), f32(params.height)) * 0.5;
  let angle = angle_degrees * DEG_TO_RAD;
  let sn = sin(angle);
  let cs = cos(angle);

  // Rotation is about the image centre, so the four screens share an origin and
  // their relative registration is the same everywhere in the frame — which is
  // what makes the rosette stable rather than drifting across the image.
  let d = pixel - centre;
  var q = vec2<f32>(d.x * cs + d.y * sn, -d.x * sn + d.y * cs);
  q = q / max(cell, MIN_CELL);

  let local = q - round(q);
  return dot_coverage(params.dot_shape, local, params.dot_aspect);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  // Ink cannot make paper brighter than paper, so anything the stack pushed
  // above 1 prints as white rather than being carried into the separation,
  // where it would produce a negative coverage.
  let rgb = clamp(texel.rgb, vec3<f32>(0.0), vec3<f32>(1.0));

  // Black generation: the neutral component is the most ink all three
  // chromatic separations have in common, and `black_generation` is how much of
  // it is handed to the black plate instead.
  let demand = vec3<f32>(1.0) - rgb;
  let neutral = min(demand.r, min(demand.g, demand.b));
  let black = clamp(neutral * params.black_generation, 0.0, 1.0);

  let paper_left = 1.0 - black;
  var cmy = vec3<f32>(0.0);
  if (paper_left > MIN_PAPER) {
    // Solved against what black left, not read off the image: this is the step
    // that makes the four coverages reproduce the pixel instead of overprinting
    // it.
    cmy = clamp(vec3<f32>(1.0) - rgb / paper_left, vec3<f32>(0.0), vec3<f32>(1.0));
  }

  let pixel = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let t_c = screen_threshold(pixel, params.cyan_angle, params.cyan_cell);
  let t_m = screen_threshold(pixel, params.magenta_angle, params.magenta_cell);
  let t_y = screen_threshold(pixel, params.yellow_angle, params.yellow_cell);
  let t_k = screen_threshold(pixel, params.black_angle, params.black_cell);

  // What each ink lets through. At density 1 an ink removes its own primary
  // completely; below that it leaks, and the print lightens.
  let leak = clamp(1.0 - params.ink_density, 0.0, 1.0);

  var transmit = vec3<f32>(1.0);
  if (t_c < cmy.x) { transmit = transmit * vec3<f32>(leak, 1.0, 1.0); }
  if (t_m < cmy.y) { transmit = transmit * vec3<f32>(1.0, leak, 1.0); }
  if (t_y < cmy.z) { transmit = transmit * vec3<f32>(1.0, 1.0, leak); }
  if (t_k < black) { transmit = transmit * vec3<f32>(leak); }

  // The paper is white, so the transmittance product is the printed colour.
  // Alpha is carried through untouched; it is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(transmit, texel.a));
}
