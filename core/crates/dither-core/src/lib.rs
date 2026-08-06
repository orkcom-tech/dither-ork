//! dither-core — colour, dithering and quantization.
//!
//! Nothing in this crate may know that a browser exists. That boundary is what
//! keeps a future native or CLI build a packaging exercise rather than a
//! rewrite; the WebAssembly bindings live in the `dither-wasm` crate.

pub mod color;
pub mod diffusion;
pub mod fixture;
pub mod noise;
pub mod palette;
pub mod quantize;
pub mod rng;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
