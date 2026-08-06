// F-SP-11 — Dilate / erode on the index map.
//
// Binary morphology over one palette region, with the index map as the set
// membership function. A pixel is "in" the set when its index equals the target
// index; dilation grows that set by the structuring element, erosion shrinks it.
// Both are exact integer operations — there is no threshold anywhere in this
// file, because the index map already carries the segmentation that a colour
// buffer would have to guess at.
//
// ## Why a target index and not every region at once
//
// The obvious alternative is greyscale morphology — take the max index in the
// neighbourhood for dilate, the min for erode. It compiles, it is one line, and
// it is wrong here: palette index order is an artefact of extraction order or of
// whatever sort F-CO-06 last applied, so "the larger index" is not a larger
// anything. Growing a region the user names is a defined operation; growing
// "whichever index sorts higher" is a coin toss dressed as morphology.
//
// ## Why erosion needs somewhere to put the vacated pixels
//
// An index map tiles the plane — every pixel carries some index, and there is no
// background label to erode into. So erosion has to answer "and then what?", and
// the answer that preserves the picture is the nearest neighbouring index that
// is not the target: the pixel joins whichever region was already pressing on it.
// Filling with a fixed index instead would paint a colour that was never next to
// that pixel, and eroding a region surrounded by two others would pick one of
// them arbitrarily.
//
// Ties are broken by scan order — first hit at the smallest squared distance
// wins, scanning dy then dx ascending — so the result is deterministic rather
// than dependent on how the loop happened to be unrolled.
//
// ## Why it writes both halves of the buffer
//
// Same reason as outline (F-SP-10): a node that moved a region boundary in the
// colour buffer while leaving the index map behind would hand the next index-map
// consumer a segmentation that no longer describes the pixels. The colour of a
// changed pixel therefore comes from the palette entry its new index names, and
// unchanged pixels keep the colour they arrived with.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const OP_DILATE : u32 = 0u;
const OP_ERODE  : u32 = 1u;

const SHAPE_ROUND  : u32 = 0u;
const SHAPE_SQUARE : u32 = 1u;

// Restated from the `radius` legal range in
// web/src/effects/dilate-erode.effect.ts. The search is O(r^2) per pixel — 8 is
// 289 index taps — so a hand-edited document must not be able to ask for a
// 200-pixel radius and hang the frame.
const MAX_RADIUS : u32 = 8u;

// Larger than any squared distance the search can produce (2 * 8 * 8 = 128), and
// small enough that nothing here can overflow an i32.
const NO_MATCH : i32 = 65536;

// Offsets must match DILATE_ERODE_UNIFORMS in
// web/src/effects/dilate-erode.effect.ts. The two pad members make the 32-byte
// size visible here rather than leaving it to WGSL's round-up rule.
struct Params {
  width        : u32,   //  0
  height       : u32,   //  4
  operation    : u32,   //  8
  target_index : u32,   // 12
  radius       : u32,   // 16
  shape        : u32,   // 20
  pad0         : u32,   // 24
  pad1         : u32,   // 28
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

  let radius = i32(min(params.radius, MAX_RADIUS));
  let radius_sq = radius * radius;
  let max_x = i32(params.width) - 1;
  let max_y = i32(params.height) - 1;
  let on_target = centre_index == params.target_index;

  var changed = false;
  var new_index : u32 = centre_index;

  if (params.operation == OP_DILATE) {
    // Only pixels outside the region can be grown into; a pixel already on the
    // target is unchanged by definition, and skipping it is also what keeps the
    // interior of a large region off the O(r^2) search entirely.
    if (!on_target) {
      var grew = false;
      for (var dy = -radius; (dy <= radius) && !grew; dy = dy + 1) {
        for (var dx = -radius; (dx <= radius) && !grew; dx = dx + 1) {
          // Round is a disc, square is the full Chebyshev block. At radius 1
          // they differ only in the four diagonals; by radius 4 the square one
          // puts visible corners on curves, which is why both exist.
          let in_shape =
            (params.shape == SHAPE_SQUARE) || ((dx * dx + dy * dy) <= radius_sq);
          if (in_shape) {
            // Clamped to the frame rather than skipped: `textureLoad` outside a
            // texture returns zero, and zero is a real palette index, so an
            // unclamped tap would grow region 0 inward from every border.
            let neighbour = vec2<i32>(
              clamp(coord.x + dx, 0, max_x),
              clamp(coord.y + dy, 0, max_y),
            );
            grew = grew || (textureLoad(src_index, neighbour, 0).r == params.target_index);
          }
        }
      }
      if (grew) {
        changed = true;
        new_index = params.target_index;
      }
    }
  } else {
    // Erosion is the dual: a target pixel with any non-target inside the
    // structuring element leaves the set, and joins the nearest region that was
    // already touching it.
    if (on_target) {
      var best_dist : i32 = NO_MATCH;
      var best_index : u32 = centre_index;
      for (var dy = -radius; dy <= radius; dy = dy + 1) {
        for (var dx = -radius; dx <= radius; dx = dx + 1) {
          let dist_sq = dx * dx + dy * dy;
          let in_shape = (params.shape == SHAPE_SQUARE) || (dist_sq <= radius_sq);
          // `dist_sq < best_dist` is strict, so with dy then dx ascending the
          // first hit at a given distance wins and the tie-break is stable.
          if (in_shape && dist_sq < best_dist) {
            let neighbour = vec2<i32>(
              clamp(coord.x + dx, 0, max_x),
              clamp(coord.y + dy, 0, max_y),
            );
            let other = textureLoad(src_index, neighbour, 0).r;
            if (other != params.target_index) {
              best_dist = dist_sq;
              best_index = other;
            }
          }
        }
      }
      if (best_dist < NO_MATCH) {
        changed = true;
        new_index = best_index;
      }
    }
  }

  // The palette always has at least one entry, but the count arrives in a
  // storage buffer and an empty one would underflow this subtraction into
  // 0xffffffff — which robust buffer access turns into a read of zeroes rather
  // than a fault.
  let last_entry = select(0u, palette.count - 1u, palette.count > 0u);

  var out_index = centre_index;
  var out_rgb = texel.rgb;
  if (changed) {
    // Clamped, and the *stored* index is the clamped one: writing a colour from
    // entry N while the index map claims entry N+k is the exact disagreement
    // this node exists to avoid. `target_index` itself is never clamped — a
    // target outside the palette matches nothing, which is a node that does
    // nothing rather than a node that dilates a region the user did not name.
    let safe = min(new_index, last_entry);
    out_index = safe;
    out_rgb = palette.entries[safe].linear.rgb;
  }

  // Alpha is carried through untouched. It is never composited onto white
  // anywhere in the stack (F-IN-03).
  textureStore(dst, coord, vec4<f32>(out_rgb, texel.a));
  textureStore(dst_index, coord, vec4<u32>(out_index, 0u, 0u, 0u));
}
