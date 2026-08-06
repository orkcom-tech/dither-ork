// F-GL-10 — Wave warp.
//
// A geometric glitch: every output pixel gathers from a source position pushed
// aside by a periodic wave. Nothing here is stochastic, so this is the one
// effect in the glitch family with no seed — a wave is a shape, and a seeded
// wave would be a different requirement.
//
// Gather, not scatter. The pass reads `centre - displacement`, so the picture
// appears to move *by* the displacement; scattering would need atomics and
// would leave holes wherever two sources landed on one destination.
//
// Conventions: web/src/shaders/CONVENTIONS.md.

const WAVE_SINE     : u32 = 0u;
const WAVE_TRIANGLE : u32 = 1u;

const AXIS_HORIZONTAL : u32 = 0u;
const AXIS_VERTICAL   : u32 = 1u;
const AXIS_BOTH       : u32 = 2u;

const EDGE_MIRROR : u32 = 0u;
const EDGE_WRAP   : u32 = 1u;
const EDGE_CLAMP  : u32 = 2u;

const TAU : f32 = 6.283185307179586;

// Offsets must match WAVE_WARP_UNIFORMS in web/src/effects/wave-warp.effect.ts.
// The three pad members make the 48-byte size visible here rather than leaving
// it to WGSL's round-up rule.
struct Params {
  width     : u32,   //  0
  height    : u32,   //  4
  amplitude : f32,   //  8
  frequency : f32,   // 12
  phase     : f32,   // 16
  waveform  : u32,   // 20
  axis      : u32,   // 24
  edges     : u32,   // 28
  smoothing : u32,   // 32
  pad0      : u32,   // 36
  pad1      : u32,   // 40
  pad2      : u32,   // 44
};

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var dst : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> params : Params;

// Both waveforms are normalized to [-1, 1] with a period of exactly one turn,
// so switching between them changes the shape and nothing else — the amplitude
// slider means the same number of pixels either way, and a phase modulator
// ramping 0 -> 1 closes the loop for both.
//
// The triangle is phase-aligned to the sine (zero rising at t = 0, peak at
// t = 0.25) rather than starting at its peak, which is what the naive
// `4*|t-0.5|-1` form does. Without that alignment, changing waveform would also
// shift the image by a quarter period.
fn wave(turns : f32) -> f32 {
  if (params.waveform == WAVE_TRIANGLE) {
    return 1.0 - 4.0 * abs(fract(turns + 0.25) - 0.5);
  }
  return sin(fract(turns) * TAU);
}

// The wave's argument is measured in cycles across the image, so the shape of
// the warp survives a resolution change; the amplitude is in pixels, which is
// the unit every other length in the catalogue uses (F-OD-CTL's tile scale, the
// blur radius) and is what the internal-resolution node (F-PP-01) is there to
// scale.
//
// On the `both` axis the two components read different coordinates already —
// x displacement varies down the image, y displacement varies across it — so
// they do not collapse into a single diagonal shear.
fn displacement(p : vec2<f32>) -> vec2<f32> {
  var d = vec2<f32>(0.0, 0.0);
  if (params.axis == AXIS_HORIZONTAL || params.axis == AXIS_BOTH) {
    d.x = params.amplitude * wave(p.y / f32(params.height) * params.frequency + params.phase);
  }
  if (params.axis == AXIS_VERTICAL || params.axis == AXIS_BOTH) {
    d.y = params.amplitude * wave(p.x / f32(params.width) * params.frequency + params.phase);
  }
  return d;
}

// What happens off the edge is a parameter, not a driver default. Clamp smears
// the border row across the whole excursion, wrap tiles, mirror reflects — all
// three are looks people ask for by name, and leaving it implicit would make
// the choice belong to whichever sampler happened to be bound.
fn resolve_axis(v : i32, n : i32) -> i32 {
  if (params.edges == EDGE_WRAP) {
    let k = v % n;
    return select(k + n, k, k >= 0);
  }
  if (params.edges == EDGE_MIRROR) {
    // Reflection has period 2n: -1 -> 0, -2 -> 1, n -> n-1, n+1 -> n-2.
    let period = 2 * n;
    var k = v % period;
    k = select(k + period, k, k >= 0);
    return select(k, period - 1 - k, k >= n);
  }
  return clamp(v, 0, n - 1);
}

fn fetch(px : i32, py : i32) -> vec4<f32> {
  let x = resolve_axis(px, i32(params.width));
  let y = resolve_axis(py, i32(params.height));
  return textureLoad(src, vec2<i32>(x, y), 0);
}

// Bilinear assembled from four integer `textureLoad`s rather than taken from a
// sampler. Two reasons, both from CONVENTIONS.md: the working surface is
// linear-light rgba16float read at integer coordinates and no sampler is bound
// anywhere in the layer, and a sampler's address mode would silently take over
// the edge decision that `resolve_axis` owns.
//
// Interpolating in linear light is also the only correct place to do it — a
// weighted average of two colours is a physical mixture, and averaging encoded
// values instead darkens every soft edge the warp produces.
fn sample_warped(p : vec2<f32>) -> vec4<f32> {
  if (params.smoothing == 0u) {
    return fetch(i32(floor(p.x)), i32(floor(p.y)));
  }
  // Texel centres sit at integer + 0.5, so the four neighbours of p are found
  // by shifting half a texel down before flooring.
  let base = floor(p - vec2<f32>(0.5, 0.5));
  let f = p - vec2<f32>(0.5, 0.5) - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);
  let c00 = fetch(x0, y0);
  let c10 = fetch(x0 + 1, y0);
  let c01 = fetch(x0, y0 + 1);
  let c11 = fetch(x0 + 1, y0 + 1);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));

  // Evaluated at the texel centre, which is what makes a zero-amplitude warp
  // read exactly the texel it writes instead of landing half a pixel off and
  // blurring the whole frame.
  let centre = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let source = centre - displacement(centre);

  // Alpha travels with the pixel it belongs to and is never composited onto
  // white anywhere in the stack (F-IN-03).
  textureStore(dst, coord, sample_warped(source));
}
