// F-GL-16 — Interlace tear.
//
// The image is cut into horizontal fields `field_height` rows tall and the
// fields are shifted horizontally in alternating directions: even fields by
// +offset, odd fields by -offset. At a field height of 1 that is a true
// interlace comb; taller fields turn it into the block tearing of a dropped
// frame.
//
// The offsets are opposite rather than one-sided so the comb stays centred on
// the subject. A one-sided shift moves the whole picture as well as tearing it,
// and the picture moving is a different effect that already exists in the
// catalogue as row displacement (F-GL-02).
//
// `phase` slides which rows belong to which field, measured in field *pairs*,
// so a modulator ramping 0 -> 1 rolls the comb down the image exactly once and
// lands back where it started. Same reason the ordered dithers measure tile
// rotation in turns: the loop closes by construction rather than because the UI
// knows that some number is special.
//
// Deterministic throughout — the field a row lands in is a function of its y
// coordinate. There is no seed here because there is nothing stochastic to
// seed; see the note in interlace-tear.effect.ts.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Offsets must match INTERLACE_TEAR_UNIFORMS in interlace-tear.effect.ts.
struct Params {
  width        : u32,   //  0
  height       : u32,   //  4
  field_height : u32,   //  8
  wrap         : u32,   // 12
  offset       : f32,   // 16
  phase        : f32,   // 20
  pad0         : f32,   // 24
  pad1         : f32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// WGSL's % takes the sign of the dividend, so a leftward shift past column 0
// would index backwards out of the row.
fn wrap_index(v : i32, n : i32) -> i32 {
  let k = v % n;
  return select(k + n, k, k >= 0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  let w = i32(params.width);

  // The registry's legal range starts at 1, so this guard only catches a
  // malformed document — but a zero field height divides by zero and paints the
  // frame NaN, and NaN in a linear-light buffer survives every node after it.
  let field_rows = f32(max(params.field_height, 1u));

  // phase is in field pairs: shifting by 2 * field_height rows is the identity,
  // so phase = 1 is the same image as phase = 0.
  let rolled = f32(gid.y) + params.phase * 2.0 * field_rows;
  let field = i32(floor(rolled / field_rows));
  // Two-step modulo: the first % may return -1 for a negative phase.
  let parity = ((field % 2) + 2) % 2;

  let direction = select(-1.0, 1.0, parity == 0);
  let shift = i32(round(params.offset * direction));
  let sx = coord.x - shift;

  // Both edge policies are real looks and the parameter picks between them: a
  // tear caused by a timing shift wraps, because the line is still the same
  // length and its content has only moved within it; a tear caused by a lost
  // block does not, and smears its last column instead.
  let source_x = select(clamp(sx, 0, w - 1), wrap_index(sx, w), params.wrap != 0u);

  let texel = textureLoad(src, vec2<i32>(source_x, coord.y), 0);
  textureStore(dst, coord, texel);
}
