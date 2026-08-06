// F-SP-14 — nearest-neighbour upscale, integer factor.
//
// The other half of the detail crush. F-PP-01 runs the middle of the stack at a
// fraction of the ends; this brings the frame back, replicating each texel into
// a `factor × factor` block so a dithered pixel becomes a visible square rather
// than a dot nobody can see. Nearest and integer-only, because any other filter
// or any fractional factor would blend two palette entries into a colour the
// palette does not contain — which is the one thing an indexed image must never
// do.
//
// **It carries the index map with it, and that is not an extra.** The colour
// buffer and the index map describe the same pixel grid; a pass that rewrites
// one at a new extent and leaves the other at the old one produces a frame
// whose indices name a different grid than its colours. That is invisible until
// an outline (F-SP-10), a dilate (F-SP-11) or the SVG tracer (F-EX-08) reads
// it, and then it is wrong with no error anywhere. `web/src/gpu/scheduler.ts`
// refuses the combination outright rather than letting it be discovered, so
// this shader upsamples both or it does not run.
//
// Replicating the index is also exactly right rather than merely safe: nearest
// upscale of an indexed image is a relabelling of the same regions, so the
// tracer's rectangle merge produces the same paths `factor` times larger and
// nothing is lost.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

// Offsets must match NN_UPSCALE_UNIFORMS in web/src/effects/nn-upscale.effect.ts.
// Five 4-byte scalars plus three pad words make the 32-byte size visible here
// rather than leaving it to WGSL's round-up rule.
struct Params {
  width         : u32,   //  0  extent this pass READS
  height        : u32,   //  4
  output_width  : u32,   //  8  extent this pass WRITES
  output_height : u32,   // 12
  factor        : u32,   // 16
  pad0          : u32,   // 20
  pad1          : u32,   // 24
  pad2          : u32,   // 28
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var src_index : texture_2d<u32>;
@group(0) @binding(3) var dst_index : texture_storage_2d<r32uint, write>;
@group(0) @binding(5) var<uniform> params : Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  // Against the extent this pass WRITES: the dispatch is sized to cover the
  // output, which here is the larger of the two.
  if (gid.x >= params.output_width || gid.y >= params.output_height) {
    return;
  }

  // Integer division by zero is implementation-defined in WGSL, and the value
  // that would cause it cannot arrive — `web/src/gpu/extent.ts` refuses a
  // factor below 1 before the pass is ever scheduled, because the same number
  // sizes the texture. The floor costs one instruction and means this file does
  // not depend on being read alongside that one.
  let factor = max(params.factor, 1u);

  // The output extent is the input times the factor exactly, so this quotient
  // is always in range; the clamp is what makes that true of the file rather
  // than of the caller.
  let sx = min(i32(gid.x / factor), i32(params.width) - 1);
  let sy = min(i32(gid.y / factor), i32(params.height) - 1);
  // `target` is a WGSL reserved keyword, hence the name: the same reason the
  // palette struct's `match_` carries a trailing underscore.
  let source = vec2<i32>(sx, sy);
  let destination = vec2<i32>(i32(gid.x), i32(gid.y));

  // Copied, not resampled: the texel's exact linear-light value and its exact
  // palette index, alpha included (F-IN-03).
  textureStore(dst, destination, textureLoad(src, source, 0));
  textureStore(
    dst_index,
    destination,
    vec4<u32>(textureLoad(src_index, source, 0).x, 0u, 0u, 0u),
  );
}
