// F-GL-09 — CRT mask: aperture grille, shadow mask, slot mask.
//
// A colour CRT has no white phosphor. It has three, arranged behind a metal
// mask that lets each electron gun reach only its own, and the arrangement is
// what makes the three tube families look different from one another. This
// shader implements the three arrangements as three geometries, not as three
// settings of one pattern:
//
//   aperture grille  continuous vertical R/G/B stripes, no vertical structure
//                    at all (Trinitron). The damper wires are omitted — they
//                    are two horizontal lines across the whole tube, an
//                    artifact of that specific mask's construction rather than
//                    part of its geometry.
//
//   shadow mask      a triangular lattice of round phosphor dots, three-coloured
//                    so that any three mutually adjacent dots are one R, one G
//                    and one B — the delta arrangement. Colour therefore cycles
//                    R,G,B down a column as well as across a row, which is the
//                    thing that distinguishes a real delta mask from rows of
//                    RGB dots with alternate rows nudged sideways.
//
//   slot mask        the grille's vertical stripes cut into slots by horizontal
//                    bridges, with adjacent triads staggered by half a slot so
//                    the bridges do not line up into a visible horizontal band.
//                    The brick pattern that produces is what most consumer TVs
//                    actually had.
//
// All three attenuate per channel in LINEAR LIGHT, because a mask blocks light
// and blocking is multiplicative on light, not on encoded values.
//
// One consequence worth stating: a mask throws away roughly two thirds of the
// picture's light, which is exactly what the real ones did and what CRT
// brightness was set to compensate for. `boost` is that compensation, and it
// defaults to 1 so the unmodified effect is the unmodified physics.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Enum ordinals, in the order `values` declares them in crt-mask.effect.ts.
// The packer sends an enum as its position in that list, so the list is
// append-only — inserting a value in the middle renumbers every saved document.
const GEOM_APERTURE_GRILLE : u32 = 0u;
const GEOM_SHADOW_MASK     : u32 = 1u;
const GEOM_SLOT_MASK       : u32 = 2u;

// Guards, not controls. The registry's legal ranges start above all of these,
// so they only ever catch a malformed document — but a zero pitch paints the
// whole frame NaN, and NaN in a linear-light buffer survives every node after
// it.
const MIN_PITCH  : f32 = 0.5;
const MIN_ASPECT : f32 = 0.0625;

// Minimum smoothstep transition half-width. `softness` = 0 means a hard edge,
// but smoothstep with equal bounds is undefined, so a hard edge is a very
// narrow transition instead. One is in triad units, the other in pixels.
const MIN_EDGE_CELL : f32 = 0.0009765625;
const MIN_EDGE_PX   : f32 = 0.0009765625;

// Row spacing of a regular triangular lattice whose points are one unit apart.
const ROW_SPACING : f32 = 0.86602540378;

// Share of a slot mask's vertical period that is phosphor rather than bridge,
// at full duty. A slot mask without bridges is an aperture grille — the bridges
// are the whole difference between the two geometries — so the vertical extent
// is not allowed to reach the full period however wide the phosphor is set.
const SLOT_FILL : f32 = 0.85;

// Offsets must match CRT_MASK_UNIFORMS in web/src/effects/crt-mask.effect.ts.
// pad0 makes the 48-byte size visible here rather than leaving it to WGSL's
// round-up rule.
struct Params {
  width    : u32,   //  0
  height   : u32,   //  4
  geometry : u32,   //  8
  pitch    : f32,   // 12
  aspect   : f32,   // 16
  duty     : f32,   // 20
  strength : f32,   // 24
  softness : f32,   // 28
  boost    : f32,   // 32
  offset_x : f32,   // 36
  offset_y : f32,   // 40
  pad0     : f32,   // 44
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// Signed distance to the nearest whole number, in [-0.5, 0.5). Used so a stripe
// centred near a cell boundary is measured across the wrap instead of from the
// far side of the cell.
fn wrap_delta(v : f32) -> f32 {
  return fract(v + 0.5) - 0.5;
}

// Coverage of stripe `k` (0 = R, 1 = G, 2 = B) at position `tx` within one
// triad, where `half_w` is the stripe's half-width in triad units.
//
// duty = 1 puts half_w at 1/6, so each stripe is a third of the triad wide and
// the three of them tile it with no gap. Below that the gaps are unlit mask;
// above it the phosphors overlap and the mask washes out.
fn stripe_coverage(tx : f32, k : f32, half_w : f32, edge : f32) -> f32 {
  let d = abs(wrap_delta(tx - (k + 0.5) / 3.0));
  return 1.0 - smoothstep(half_w - edge, half_w + edge, d);
}

fn aperture_grille(px : f32, half_w : f32, edge : f32) -> vec3<f32> {
  let pitch = max(params.pitch, MIN_PITCH);
  let tx = fract(px / pitch);
  return vec3<f32>(
    stripe_coverage(tx, 0.0, half_w, edge),
    stripe_coverage(tx, 1.0, half_w, edge),
    stripe_coverage(tx, 2.0, half_w, edge),
  );
}

// The delta three-colouring of the triangular lattice.
//
// With basis a1 = (s, 0) and a2 = (s/2, h), the neighbours of (i, j) are
// ±a1, ±a2 and ±(a1 - a2); (i + 2j) mod 3 steps by +1, +2 and -1 across those,
// so every triangle of mutually adjacent dots carries one of each colour. That
// is what "delta" means, and it is why colour cycles down a column.
fn delta_colour(i : i32, j : i32) -> u32 {
  let m = ((i + 2 * j) % 3 + 3) % 3;
  return u32(m);
}

// Round dots on a triangular lattice.
//
// `aspect` stretches the lattice vertically; at 1 the row spacing is
// s * sqrt(3)/2 and the six neighbours of every dot are equidistant, which is
// the physical arrangement.
//
// The 3x4 candidate window is not an approximation of a nearest-point search —
// it is a full one for this lattice at the radii the duty control can reach.
// A dot's reach is at most duty * s / 2, and the window spans 1.5 s
// horizontally and at least 2 row spacings vertically, so no dot that covers
// the pixel is outside it. Taking the per-channel maximum rather than the
// nearest dot is what keeps soft-edged dots continuous where two of them meet.
fn shadow_mask(px : f32, py : f32, radius : f32, edge : f32) -> vec3<f32> {
  let pitch = max(params.pitch, MIN_PITCH);
  let s = pitch / 3.0;
  let h = s * ROW_SPACING * max(params.aspect, MIN_ASPECT);

  let jf = py / h;
  let j0 = i32(floor(jf));
  let i0 = i32(floor((px - jf * s * 0.5) / s));

  var w = vec3<f32>(0.0, 0.0, 0.0);
  for (var dj : i32 = -1; dj <= 2; dj = dj + 1) {
    let j = j0 + dj;
    for (var di : i32 = -1; di <= 1; di = di + 1) {
      let i = i0 + di;
      let centre = vec2<f32>(f32(i) * s + f32(j) * s * 0.5, f32(j) * h);
      let cover = 1.0 - smoothstep(
        radius - edge,
        radius + edge,
        distance(vec2<f32>(px, py), centre),
      );
      let colour = delta_colour(i, j);
      w.r = max(w.r, select(0.0, cover, colour == 0u));
      w.g = max(w.g, select(0.0, cover, colour == 1u));
      w.b = max(w.b, select(0.0, cover, colour == 2u));
    }
  }
  return w;
}

// Vertical stripes cut into slots, staggered by triad column.
//
// The horizontal half is identical to the aperture grille — a slot mask is a
// grille with bridges — so it calls the same coverage function rather than
// restating it, and the two geometries cannot drift apart.
fn slot_mask(px : f32, py : f32, half_w : f32, edge : f32) -> vec3<f32> {
  let pitch = max(params.pitch, MIN_PITCH);
  let vpitch = pitch * max(params.aspect, MIN_ASPECT);

  let column = px / pitch;
  // Alternate triad columns are offset by half a slot, so the bridges form a
  // brick pattern instead of a continuous horizontal line across the tube.
  let stagger = f32(i32(floor(column)) & 1) * 0.5;

  let tx = fract(column);
  let ty = fract(py / vpitch + stagger);

  let v_half = 0.5 * clamp(params.duty, 0.0, 1.0) * SLOT_FILL;
  let v_edge = max(clamp(params.softness, 0.0, 1.0) * v_half, MIN_EDGE_CELL);
  let vertical = 1.0 - smoothstep(v_half - v_edge, v_half + v_edge, abs(ty - 0.5));

  return vec3<f32>(
    stripe_coverage(tx, 0.0, half_w, edge),
    stripe_coverage(tx, 1.0, half_w, edge),
    stripe_coverage(tx, 2.0, half_w, edge),
  ) * vertical;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);

  // Sampled at the pixel centre. The mask is a continuous physical structure
  // that the pixel grid samples, unlike the scanline pattern of F-GL-08, which
  // is a property of the raster lines themselves.
  let px = f32(gid.x) + 0.5 + params.offset_x;
  let py = f32(gid.y) + 0.5 + params.offset_y;

  let duty = max(params.duty, 0.0);
  let softness = clamp(params.softness, 0.0, 1.0);

  // Phosphor size, expressed once and used by all three geometries so that
  // duty = 1 means "the phosphors tile their cell" in every one of them.
  let half_w = duty / 6.0;                       // triad units, for the stripes
  let radius = duty * (max(params.pitch, MIN_PITCH) / 3.0) * 0.5;  // pixels, for the dots

  var coverage : vec3<f32>;
  if (params.geometry == GEOM_SHADOW_MASK) {
    coverage = shadow_mask(px, py, radius, max(softness * radius, MIN_EDGE_PX));
  } else if (params.geometry == GEOM_SLOT_MASK) {
    coverage = slot_mask(px, py, half_w, max(softness * half_w, MIN_EDGE_CELL));
  } else {
    coverage = aperture_grille(px, half_w, max(softness * half_w, MIN_EDGE_CELL));
  }

  // Unlit mask does not go to black unless asked: strength is how much light
  // the mask takes, so 0 is a no-op and 1 is a mask that passes nothing where
  // there is no phosphor.
  let dim = 1.0 - clamp(params.strength, 0.0, 1.0);
  let gain = mix(vec3<f32>(dim), vec3<f32>(1.0), clamp(coverage, vec3<f32>(0.0), vec3<f32>(1.0)))
    * max(params.boost, 0.0);

  // Not clamped to 1. The working surface is rgba16float in linear light and
  // has real headroom above white; clipping is the output stage's decision, and
  // taking it here would quietly flatten every highlight the boost lifts.
  textureStore(dst, coord, vec4<f32>(texel.rgb * gain, texel.a));
}
