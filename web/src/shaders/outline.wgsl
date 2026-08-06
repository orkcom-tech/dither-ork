// F-SP-10 — Outline / stroke around palette regions.
//
// This is the effect the index map exists for. A region here is a run of pixels
// carrying the same palette index, so a boundary is an exact integer comparison
// between two indices — no edge detector, no threshold, no gradient magnitude,
// and no dependence on how far apart the two colours happen to be. Doing the
// same job on the colour buffer would mean detecting edges, and a Sobel across
// two palette entries of similar luminance finds nothing while a Sobel across
// dither noise finds edges everywhere.
//
// ## Why the stroke names a palette entry rather than a colour
//
// The node writes the index map as well as the colour buffer, because after it
// runs the two have to keep agreeing — a stroke painted as raw RGB would be a
// pixel whose index still claims the colour underneath it, and every downstream
// index-map consumer (dilate/erode, hue-targeted recolour, the SVG tracer)
// would trace the region boundary straight through the middle of the stroke.
// There is no index for an arbitrary colour, so the stroke colour is a palette
// entry. That also happens to be the only kind of colour parameter that can
// reach a shader today; see the note in gradient-map.effect.ts.
//
// ## Why the stroke is around one index and not around every boundary
//
// Inside and outside are only definable against a chosen region. An index map
// tiles the plane — there is no background — so "outside region A" is "inside
// region B", and asking for a stroke around *every* boundary makes the
// inside/outside control name the same set of pixels twice. F-SP-10 asks for
// that control, so the target is a parameter and the control means something.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const PLACEMENT_INSIDE  : u32 = 0u;
const PLACEMENT_OUTSIDE : u32 = 1u;
const PLACEMENT_BOTH    : u32 = 2u;

const SHAPE_ROUND  : u32 = 0u;
const SHAPE_SQUARE : u32 = 1u;

// Restated from the `strokeWidth` legal range in
// web/src/effects/outline.effect.ts. The search is O(w^2) per pixel, so a
// malformed document must not be able to ask for a 200-pixel radius and hang
// the frame.
const MAX_STROKE_WIDTH : u32 = 8u;

// Offsets must match OUTLINE_UNIFORMS in web/src/effects/outline.effect.ts. The
// pad member makes the 32-byte size visible here rather than leaving it to
// WGSL's round-up rule.
struct Params {
  width        : u32,   //  0
  height       : u32,   //  4
  stroke_width : u32,   //  8
  target_index : u32,   // 12
  color_index  : u32,   // 16
  placement    : u32,   // 20
  shape        : u32,   // 24
  pad0         : u32,   // 28
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
@group(0) @binding(2) var src_index : texture_2d<u32>;
@group(0) @binding(3) var dst_index : texture_storage_2d<r32uint, write>;
@group(0) @binding(4) var<storage, read> palette : PaletteData;
@group(0) @binding(5) var<uniform> params : Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let texel = textureLoad(src, coord, 0);
  let centre_index = textureLoad(src_index, coord, 0).r;

  let on_target = centre_index == params.target_index;

  // Which side of the boundary this pixel is allowed to be painted on.
  var eligible : bool;
  if (params.placement == PLACEMENT_INSIDE) {
    eligible = on_target;
  } else if (params.placement == PLACEMENT_OUTSIDE) {
    eligible = !on_target;
  } else {
    eligible = true;
  }

  var paint = false;
  if (eligible) {
    let radius = i32(min(params.stroke_width, MAX_STROKE_WIDTH));
    let radius_sq = radius * radius;
    let max_x = i32(params.width) - 1;
    let max_y = i32(params.height) - 1;

    for (var dy = -radius; (dy <= radius) && !paint; dy = dy + 1) {
      for (var dx = -radius; (dx <= radius) && !paint; dx = dx + 1) {
        // Round is a disc, square is the full Chebyshev block. At width 1 they
        // differ only in the four diagonals; by width 4 the square one has
        // visible corners on curves, which is the reason both exist.
        let in_shape =
          (params.shape == SHAPE_SQUARE) || ((dx * dx + dy * dy) <= radius_sq);
        if (in_shape) {
          // Clamped to the frame rather than skipped. Two reasons, and the
          // second one is the one that bites: an out-of-image neighbour has to
          // read as more of the same region or every image grows a stroke along
          // its own border, and `textureLoad` outside the texture returns zero,
          // which is a real palette index — a wrong outline, silently, rather
          // than an error anywhere.
          let neighbour = vec2<i32>(
            clamp(coord.x + dx, 0, max_x),
            clamp(coord.y + dy, 0, max_y),
          );
          let other_index = textureLoad(src_index, neighbour, 0).r;

          // An inside pixel is painted when something near it is not the target
          // region; an outside pixel when something near it is. One expression
          // covers both, and the centre tap can never satisfy it.
          paint = paint || ((other_index == params.target_index) != on_target);
        }
      }
    }
  }

  // The palette always has at least one entry, but the count arrives in a
  // storage buffer and an empty one would underflow this subtraction into
  // 0xffffffff — which robust buffer access would then turn into a read of
  // zeroes rather than a fault.
  let last_entry = select(0u, palette.count - 1u, palette.count > 0u);
  let stroke_index = min(params.color_index, last_entry);

  // `target_index` is deliberately not clamped: a target outside the palette
  // simply matches nothing, which is an outline of nothing rather than an
  // outline of a region the user did not name.
  var out_index = centre_index;
  var out_rgb = texel.rgb;
  if (paint) {
    out_index = stroke_index;
    out_rgb = palette.entries[stroke_index].linear.rgb;
  }

  // Unpainted pixels keep the colour they arrived with rather than being
  // re-derived from their index. If something between the quantizer and here
  // has tinted the buffer, that is not this node's to undo.
  //
  // Alpha is carried through untouched (F-IN-03).
  textureStore(dst, coord, vec4<f32>(out_rgb, texel.a));
  textureStore(dst_index, coord, vec4<u32>(out_index, 0u, 0u, 0u));
}
