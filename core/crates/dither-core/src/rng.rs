//! Seeded pseudo-random numbers (F-AN-05).
//!
//! Every stochastic node reads an explicit seed from the document; there is no
//! unseeded randomness and no wall-clock read anywhere in a render path. That
//! makes this generator's exact output part of the observable behaviour of the
//! application: the same document, frame and build must produce byte-identical
//! pixels on macOS and Windows, in the main worker and in a batch worker, and
//! in a golden-image test on CI.
//!
//! PCG32 (XSH-RR, 64-bit state, 32-bit output) earns that. The state advance is
//! a single 64-bit wrapping multiply-add and the output function is shifts and
//! a rotate — integers only, so there is no float rounding, no `f64` intrinsic
//! that a different backend may contract differently, and no dependence on
//! pointer width. `std`'s hashers and `HashMap` iteration order are avoided for
//! the same reason: both are deliberately unspecified across builds.
//!
//! The `stream` parameter is what keeps independent nodes independent. One
//! document seed plus a distinct stream per node gives every node its own
//! non-overlapping sequence, rather than nodes taking turns from a shared
//! generator — which would make a node's output depend on how many draws the
//! nodes before it happened to make.

/// LCG multiplier from the reference PCG implementation.
///
/// A constant, not a tunable: changing it changes every rendered frame that has
/// a stochastic node in it, and invalidates every golden image.
const MULTIPLIER: u64 = 6_364_136_223_846_793_005;

/// Stream used by [`Pcg32::seeded`], for the single-generator case where there
/// is nothing to keep independent.
const DEFAULT_STREAM: u64 = 0;

/// 2^-24. The draw in [`Pcg32::next_f32`] is scaled by this, and both the
/// scale and every numerator are exactly representable in `f32`, so the
/// multiplication is exact and cannot round up to 1.0.
const F32_SCALE: f32 = 1.0 / 16_777_216.0;

/// FNV-1a 64-bit offset basis and prime, used by [`stream_of`].
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// A seeded PCG32 generator.
///
/// Deliberately not `Copy`. An accidental copy would hand out a second
/// generator producing the identical sequence, which is precisely the bug this
/// module exists to prevent; making the duplication explicit via `clone` means
/// it can only happen on purpose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pcg32 {
    state: u64,
    /// The sequence selector, stored pre-shifted and forced odd as the
    /// reference implementation requires — an even increment would shorten the
    /// period of the underlying LCG.
    inc: u64,
}

impl Pcg32 {
    /// Seed a generator on an explicit stream.
    ///
    /// `seed` is the document seed; `stream` selects which of the 2^63 distinct
    /// sequences this generator walks. Two generators built from the same seed
    /// and different streams are independent.
    pub fn new(seed: u64, stream: u64) -> Self {
        // The reference seeding routine: zero the state, install the
        // increment, step once, add the seed, step again. Both steps are load
        // bearing — without them low-entropy seeds such as 0 and 1 produce
        // visibly correlated first outputs.
        let mut rng = Self {
            state: 0,
            inc: (stream << 1) | 1,
        };
        rng.next_u32();
        rng.state = rng.state.wrapping_add(seed);
        rng.next_u32();
        rng
    }

    /// Seed a generator on the default stream.
    pub fn seeded(seed: u64) -> Self {
        Self::new(seed, DEFAULT_STREAM)
    }

    /// Next 32 bits. Every other draw is built on this one.
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(MULTIPLIER).wrapping_add(self.inc);

        // XSH-RR: xorshift the high bits down to 32, then rotate by an amount
        // taken from the top 5 bits. The rotation is what defeats the lattice
        // structure a plain truncated LCG has in its low bits.
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform `f32` in `[0, 1)`.
    ///
    /// Takes the top 24 bits, which is exactly the `f32` significand: every
    /// representable value in the range is reachable, spacing is uniform, and
    /// the result is provably below 1.0 rather than below-1.0-in-practice.
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * F32_SCALE
    }

    /// Uniform integer in `[0, bound)`, without modulo bias.
    ///
    /// A bare `next_u32() % bound` favours the low end whenever `bound` does
    /// not divide 2^32, by up to one part in `2^32 / bound`. That is invisible
    /// for a dice roll and very visible in a 3-value enum sampled a million
    /// times across a batch, so the biased draws are rejected instead.
    ///
    /// Panics if `bound` is zero — an empty range has no correct answer, and
    /// silently returning 0 would hide the caller's bug in the output image.
    pub fn next_below(&mut self, bound: u32) -> u32 {
        assert!(bound > 0, "bound must be positive");

        // 2^32 % bound, computed without widening: the size of the short final
        // block of `[0, 2^32)`. Draws landing in the first `threshold` values
        // are the ones that would be over-represented after the modulo.
        let threshold = bound.wrapping_neg() % bound;
        loop {
            let r = self.next_u32();
            if r >= threshold {
                return r % bound;
            }
        }
    }

    /// Uniform integer in `[low, high)`, without modulo bias.
    ///
    /// Panics if the range is empty.
    pub fn next_range(&mut self, low: i32, high: i32) -> i32 {
        assert!(low < high, "range must be non-empty: {low}..{high}");

        // Widened so the full `i32::MIN..i32::MAX` span does not overflow; the
        // span of a non-empty i32 range always fits in a u32.
        let span = (i64::from(high) - i64::from(low)) as u32;
        let offset = i64::from(self.next_below(span));
        (i64::from(low) + offset) as i32
    }
}

/// Map a name to a stream selector.
///
/// Lets a node name its own independent streams — `stream_of("row-offsets")`
/// and `stream_of("slice-heights")` inside one effect — without a central table
/// of stream numbers that every new effect would have to edit and that two
/// effects could collide in by hand.
///
/// FNV-1a, because it is specified to the bit and has published test vectors.
/// `std::hash::DefaultHasher` would not do: its algorithm is explicitly allowed
/// to change between Rust releases, which would silently re-roll every seeded
/// effect on a toolchain bump.
pub fn stream_of(name: &str) -> u64 {
    let mut hash = FNV_OFFSET;
    for byte in name.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known-answer test against the reference PCG32 output sequence, seeded as
    /// the upstream demo seeds it (`pcg32_srandom_r(&rng, 42, 54)`).
    ///
    /// This is the test that fails if the state advance, the output permutation
    /// or the seeding routine is subtly wrong — each of which still produces
    /// plausible-looking noise, and none of which would show up in a
    /// distribution check.
    #[test]
    fn known_answer_matches_the_reference_implementation() {
        let mut rng = Pcg32::new(42, 54);
        let got: Vec<u32> = (0..6).map(|_| rng.next_u32()).collect();
        assert_eq!(
            got,
            vec![
                0xa15c_02b7,
                0x7b47_f409,
                0xba1d_3330,
                0x83d2_f293,
                0xbfa4_784b,
                0xcbed_606e,
            ]
        );
    }

    #[test]
    fn same_seed_reproduces_the_same_stream() {
        let mut a = Pcg32::new(0x853c_49e6_748f_ea9b, 7);
        let mut b = Pcg32::new(0x853c_49e6_748f_ea9b, 7);
        let left: Vec<u32> = (0..256).map(|_| a.next_u32()).collect();
        let right: Vec<u32> = (0..256).map(|_| b.next_u32()).collect();
        assert_eq!(left, right);
        assert_eq!(a, b, "generators must also agree on their internal state");
    }

    #[test]
    fn different_streams_from_one_seed_diverge() {
        let seed = 0x853c_49e6_748f_ea9b;
        let mut a = Pcg32::new(seed, 0);
        let mut b = Pcg32::new(seed, 1);
        let left: Vec<u32> = (0..256).map(|_| a.next_u32()).collect();
        let right: Vec<u32> = (0..256).map(|_| b.next_u32()).collect();

        assert_ne!(left, right);
        // A stronger claim than "not equal": two independent streams should
        // agree on a given draw only by coincidence, so at most a handful of
        // 256 draws may collide.
        let shared = left.iter().zip(&right).filter(|(x, y)| x == y).count();
        assert!(shared < 4, "{shared} of 256 draws collided across streams");
    }

    #[test]
    fn seeded_is_the_default_stream() {
        assert_eq!(Pcg32::seeded(99), Pcg32::new(99, DEFAULT_STREAM));
    }

    #[test]
    fn uniform_f32_stays_inside_the_half_open_unit_range() {
        let mut rng = Pcg32::seeded(1);
        let mut max = 0.0f32;
        for _ in 0..100_000 {
            let v = rng.next_f32();
            assert!((0.0..1.0).contains(&v), "{v} outside [0, 1)");
            max = max.max(v);
        }
        // The top of the range must actually be reachable, or the scale is
        // wrong in the other direction and every draw is quietly compressed.
        assert!(max > 0.999, "largest of 100k draws was only {max}");
    }

    #[test]
    fn bounded_draws_stay_in_range_and_are_not_modulo_biased() {
        let mut rng = Pcg32::seeded(0xfeed_beef);
        // 3 does not divide 2^32, so this is exactly the case a bare modulo
        // skews. Deterministic seed, so the tolerance cannot flake.
        let mut counts = [0usize; 3];
        for _ in 0..300_000 {
            let v = rng.next_below(3);
            counts[v as usize] += 1;
        }
        for (value, count) in counts.iter().enumerate() {
            let deviation = (*count as f64 / 100_000.0 - 1.0).abs();
            assert!(deviation < 0.01, "value {value} came up {count} times");
        }
    }

    #[test]
    fn bound_of_one_is_always_zero() {
        let mut rng = Pcg32::seeded(5);
        assert!((0..64).all(|_| rng.next_below(1) == 0));
    }

    #[test]
    #[should_panic(expected = "bound must be positive")]
    fn zero_bound_panics_rather_than_inventing_an_answer() {
        Pcg32::seeded(5).next_below(0);
    }

    #[test]
    fn range_covers_negative_lows_and_never_reaches_the_high_bound() {
        let mut rng = Pcg32::seeded(0x1234_5678);
        let mut saw_low = false;
        let mut saw_high = false;
        for _ in 0..10_000 {
            let v = rng.next_range(-5, 5);
            assert!((-5..5).contains(&v), "{v} outside -5..5");
            saw_low |= v == -5;
            saw_high |= v == 4;
        }
        assert!(
            saw_low && saw_high,
            "range endpoints were not both reachable"
        );
    }

    #[test]
    fn range_handles_the_full_i32_span_without_overflow() {
        let mut rng = Pcg32::seeded(11);
        for _ in 0..1_000 {
            let v = rng.next_range(i32::MIN, i32::MAX);
            assert!(v < i32::MAX);
        }
    }

    #[test]
    #[should_panic(expected = "range must be non-empty")]
    fn empty_range_panics() {
        Pcg32::seeded(5).next_range(3, 3);
    }

    /// Known-answer test against the published FNV-1a 64 vectors. If a Rust
    /// release ever changed what this function returns, every seeded effect
    /// would re-roll silently; pinning it to published values makes that a
    /// build failure instead.
    #[test]
    fn stream_of_matches_the_published_fnv1a_vectors() {
        assert_eq!(stream_of(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(stream_of("a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(stream_of("foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn named_streams_are_stable_and_distinct() {
        assert_eq!(stream_of("row-offsets"), stream_of("row-offsets"));
        assert_ne!(stream_of("row-offsets"), stream_of("slice-heights"));

        let seed = 4242;
        let mut a = Pcg32::new(seed, stream_of("row-offsets"));
        let mut b = Pcg32::new(seed, stream_of("slice-heights"));
        assert_ne!(a.next_u32(), b.next_u32());
    }
}
