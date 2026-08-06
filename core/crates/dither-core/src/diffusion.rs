//! Error-diffusion dithering (F-ED-01..15, F-ED-CTL).
//!
//! These kernels are inherently serial — each pixel's value depends on error
//! propagated from pixels already processed — so they cannot be expressed as a
//! shader and live here on the CPU. The ~48 per-pixel-independent effects run
//! as WebGPU compute passes instead; see docs/ARCHITECTURE.md.
//!
//! Thirteen of the fifteen kernels really are nothing but a coefficient table,
//! and those share one scan. The other two do not, and pretending otherwise
//! would have produced two plausible-looking wrong kernels:
//!
//! * **Ostromoukhov** (F-ED-14) picks its coefficients per input level, so its
//!   "table" is 256 rows deep with a divisor that changes row by row.
//! * **Riemersma** (F-ED-15) does not distribute to neighbours at all. It walks
//!   a Hilbert curve and carries a decaying queue of past errors forward along
//!   it, which is a different traversal *and* a different error model.
//!
//! [`Rule`] is what keeps all three honest: a kernel declares which of the
//! three algorithms it is, and the shared controls of F-ED-CTL apply to every
//! one of them.

use crate::color::{linear_to_srgb, Rgba};
use crate::palette::{Metric, Palette};
use crate::rng::{stream_of, Pcg32};
use std::collections::VecDeque;

/// One error-distribution term: an offset from the current pixel and the share
/// of the quantization error it receives.
#[derive(Clone, Copy, Debug)]
pub struct Tap {
    pub dx: i32,
    pub dy: i32,
    pub weight: f32,
}

/// Number of input levels a variable-coefficient table is indexed by. Eight-bit
/// levels, because that is what Ostromoukhov's coefficients were solved for.
pub const LEVELS: usize = 256;

/// One row of a variable-coefficient table (F-ED-14): the weights this input
/// level sends right, down-left and down.
///
/// The row carries no divisor because the row *is* the divisor — the three
/// weights are normalized against their own sum, which differs level to level.
/// That is the entire point of the method and the reason it cannot be folded
/// into [`Tap`].
#[derive(Clone, Copy, Debug)]
pub struct LevelWeights {
    pub right: u32,
    pub down_left: u32,
    pub down: u32,
}

/// How a kernel moves quantization error.
///
/// An enum rather than three separate entry points so that F-ED-CTL, the kernel
/// registry and the WASM boundary each stay single-valued: there is one list of
/// kernels, one options struct and one `dither` call, whichever algorithm is
/// underneath.
#[derive(Clone, Copy, Debug)]
pub enum Rule {
    /// F-ED-01..13. A fixed table of neighbour weights over `divisor`.
    Fixed { taps: &'static [Tap], divisor: f32 },
    /// F-ED-14. Coefficients chosen per input level; each row normalizes
    /// against its own sum.
    Variable {
        levels: &'static [LevelWeights; LEVELS],
    },
    /// F-ED-15. Hilbert traversal with an exponentially decaying error history.
    ///
    /// `history` is the queue length; `decay` is how many times more weight the
    /// newest error carries than the oldest.
    Riemersma { history: usize, decay: f32 },
}

/// A named diffusion kernel.
#[derive(Clone, Copy, Debug)]
pub struct Kernel {
    pub id: &'static str,
    pub name: &'static str,
    pub rule: Rule,
}

macro_rules! tap {
    ($dx:expr, $dy:expr, $w:expr) => {
        Tap {
            dx: $dx,
            dy: $dy,
            weight: $w,
        }
    };
}

/// Declare a fixed-coefficient kernel.
///
/// The published matrices below are written in the layout they are published
/// in, `*` marking the current pixel, so a coefficient can be checked against
/// its source by eye without decoding an offset list first. That is the only
/// review that catches a transposed digit, and a transposed digit still
/// produces a picture.
macro_rules! fixed {
    ($id:literal, $name:literal, $divisor:expr, [$($tap:expr),* $(,)?]) => {
        Kernel {
            id: $id,
            name: $name,
            rule: Rule::Fixed {
                taps: &[$($tap),*],
                divisor: $divisor,
            },
        }
    };
}

/// F-ED-01. Floyd & Steinberg, 1976.
///
/// ```text
///        *   7
///    3   5   1        (1/16)
/// ```
pub const FLOYD_STEINBERG: Kernel = fixed!(
    "floyd-steinberg",
    "Floyd-Steinberg",
    16.0,
    [
        tap!(1, 0, 7.0),
        tap!(-1, 1, 3.0),
        tap!(0, 1, 5.0),
        tap!(1, 1, 1.0),
    ]
);

/// F-ED-02. The simplification of Floyd-Steinberg that circulates by mistake,
/// carried here because the mistake has a look of its own: three taps instead
/// of four, and the weight below the pixel lighter than the weight behind it,
/// which is exactly the inversion that makes it worm.
///
/// ```text
///        *   3
///    3   2               (1/8)
/// ```
///
/// Transcribed from DHALF.TXT (Crocker, Boulay, Morra), which is where the name
/// comes from — it gives this as the form Floyd-Steinberg "is often incorrectly
/// given" as. Other implementations in the wild place the second row a column
/// to the right, as (down 3, down-right 2); both sum to 8 and both are called
/// "false Floyd-Steinberg". This is the coefficient in the catalogue with the
/// least agreement behind it.
pub const FALSE_FLOYD_STEINBERG: Kernel = fixed!(
    "false-floyd-steinberg",
    "False Floyd-Steinberg",
    8.0,
    [tap!(1, 0, 3.0), tap!(-1, 1, 3.0), tap!(0, 1, 2.0)]
);

/// F-ED-03. Jarvis, Judice & Ninke, 1976. Twelve taps over three rows: the
/// widest of the classic kernels, and the reason it is also the slowest and the
/// softest.
///
/// ```text
///            *   7   5
///    3   5   7   5   3
///    1   3   5   3   1    (1/48)
/// ```
pub const JARVIS_JUDICE_NINKE: Kernel = fixed!(
    "jarvis-judice-ninke",
    "Jarvis-Judice-Ninke",
    48.0,
    [
        tap!(1, 0, 7.0),
        tap!(2, 0, 5.0),
        tap!(-2, 1, 3.0),
        tap!(-1, 1, 5.0),
        tap!(0, 1, 7.0),
        tap!(1, 1, 5.0),
        tap!(2, 1, 3.0),
        tap!(-2, 2, 1.0),
        tap!(-1, 2, 3.0),
        tap!(0, 2, 5.0),
        tap!(1, 2, 3.0),
        tap!(2, 2, 1.0),
    ]
);

/// F-ED-04. Stucki, 1981. Jarvis with powers of two, which is what made it the
/// one people actually shipped on integer hardware.
///
/// ```text
///            *   8   4
///    2   4   8   4   2
///    1   2   4   2   1    (1/42)
/// ```
pub const STUCKI: Kernel = fixed!(
    "stucki",
    "Stucki",
    42.0,
    [
        tap!(1, 0, 8.0),
        tap!(2, 0, 4.0),
        tap!(-2, 1, 2.0),
        tap!(-1, 1, 4.0),
        tap!(0, 1, 8.0),
        tap!(1, 1, 4.0),
        tap!(2, 1, 2.0),
        tap!(-2, 2, 1.0),
        tap!(-1, 2, 2.0),
        tap!(0, 2, 4.0),
        tap!(1, 2, 2.0),
        tap!(2, 2, 1.0),
    ]
);

/// F-ED-05. Burkes, 1988. Stucki with the third row dropped — half the taps,
/// and a divisor that is a power of two.
///
/// ```text
///            *   8   4
///    2   4   8   4   2    (1/32)
/// ```
pub const BURKES: Kernel = fixed!(
    "burkes",
    "Burkes",
    32.0,
    [
        tap!(1, 0, 8.0),
        tap!(2, 0, 4.0),
        tap!(-2, 1, 2.0),
        tap!(-1, 1, 4.0),
        tap!(0, 1, 8.0),
        tap!(1, 1, 4.0),
        tap!(2, 1, 2.0),
    ]
);

/// F-ED-06. Sierra, three rows.
///
/// ```text
///            *   5   3
///    2   4   5   4   2
///        2   3   2        (1/32)
/// ```
pub const SIERRA_3: Kernel = fixed!(
    "sierra-3",
    "Sierra-3",
    32.0,
    [
        tap!(1, 0, 5.0),
        tap!(2, 0, 3.0),
        tap!(-2, 1, 2.0),
        tap!(-1, 1, 4.0),
        tap!(0, 1, 5.0),
        tap!(1, 1, 4.0),
        tap!(2, 1, 2.0),
        tap!(-1, 2, 2.0),
        tap!(0, 2, 3.0),
        tap!(1, 2, 2.0),
    ]
);

/// F-ED-07. Sierra, two rows.
///
/// ```text
///            *   4   3
///    1   2   3   2   1    (1/16)
/// ```
pub const SIERRA_2: Kernel = fixed!(
    "sierra-2",
    "Sierra-2 (two-row)",
    16.0,
    [
        tap!(1, 0, 4.0),
        tap!(2, 0, 3.0),
        tap!(-2, 1, 1.0),
        tap!(-1, 1, 2.0),
        tap!(0, 1, 3.0),
        tap!(1, 1, 2.0),
        tap!(2, 1, 1.0),
    ]
);

/// F-ED-08. Sierra Lite, also published as Sierra-2-4A. Three taps and a
/// divisor of four, so every weight is a shift.
///
/// ```text
///        *   2
///    1   1                (1/4)
/// ```
pub const SIERRA_LITE: Kernel = fixed!(
    "sierra-lite",
    "Sierra Lite",
    4.0,
    [tap!(1, 0, 2.0), tap!(-1, 1, 1.0), tap!(0, 1, 1.0)]
);

/// F-ED-09. Atkinson, Apple, mid-1980s.
///
/// ```text
///        *   1   1
///    1   1   1
///        1                (1/8)
/// ```
///
/// Distributes only 6/8 of the error, which is why it blows out highlights and
/// shadows the way it does — that loss is the look, not a bug, and it is why
/// this is the one kernel whose taps deliberately do not sum to its divisor.
pub const ATKINSON: Kernel = fixed!(
    "atkinson",
    "Atkinson",
    8.0,
    [
        tap!(1, 0, 1.0),
        tap!(2, 0, 1.0),
        tap!(-1, 1, 1.0),
        tap!(0, 1, 1.0),
        tap!(1, 1, 1.0),
        tap!(0, 2, 1.0),
    ]
);

/// F-ED-10. Stevenson & Arce, 1985. Twelve taps, and the only kernel here that
/// reaches four rows down.
///
/// The gaps are not omissions. The filter was designed for a hexagonal sampling
/// lattice, and every published rendering of it on a rectangular grid comes out
/// like this — occupying alternating columns, which is what the hexagonal
/// geometry becomes once it is squared off. Columns below are one `dx` step
/// apart, from -3 on the left to +3 on the right.
///
/// ```text
///                 *       32
///     12      26      30      16
///         12      26      12
///     5       12      12       5     (1/200)
/// ```
pub const STEVENSON_ARCE: Kernel = fixed!(
    "stevenson-arce",
    "Stevenson-Arce",
    200.0,
    [
        tap!(2, 0, 32.0),
        tap!(-3, 1, 12.0),
        tap!(-1, 1, 26.0),
        tap!(1, 1, 30.0),
        tap!(3, 1, 16.0),
        tap!(-2, 2, 12.0),
        tap!(0, 2, 26.0),
        tap!(2, 2, 12.0),
        tap!(-3, 3, 5.0),
        tap!(-1, 3, 12.0),
        tap!(1, 3, 12.0),
        tap!(3, 3, 5.0),
    ]
);

/// F-ED-11. Fan, 1993. Floyd-Steinberg with the lower row shifted one column
/// left, which is the whole trick: nothing lands diagonally ahead of the scan,
/// so the diagonal worm Floyd-Steinberg produces has nowhere to start.
///
/// ```text
///            *   7
///    1   3   5            (1/16)
/// ```
pub const FAN: Kernel = fixed!(
    "fan",
    "Fan",
    16.0,
    [
        tap!(1, 0, 7.0),
        tap!(-2, 1, 1.0),
        tap!(-1, 1, 3.0),
        tap!(0, 1, 5.0),
    ]
);

/// F-ED-12. Shiau & Fan, 1996, the first of their pair. Every weight is a power
/// of two over a power of two, so the whole kernel is shifts.
///
/// ```text
///            *   4
///    1   1   2            (1/8)
/// ```
pub const SHIAU_FAN: Kernel = fixed!(
    "shiau-fan",
    "Shiau-Fan",
    8.0,
    [
        tap!(1, 0, 4.0),
        tap!(-2, 1, 1.0),
        tap!(-1, 1, 1.0),
        tap!(0, 1, 2.0),
    ]
);

/// F-ED-13. Shiau & Fan, 1996, the second: the same shape reaching one column
/// further back, trading a little sharpness for fewer worms still.
///
/// ```text
///                *   8
///    1   1   2   4        (1/16)
/// ```
pub const SHIAU_FAN_2: Kernel = fixed!(
    "shiau-fan-2",
    "Shiau-Fan 2",
    16.0,
    [
        tap!(1, 0, 8.0),
        tap!(-3, 1, 1.0),
        tap!(-2, 1, 1.0),
        tap!(-1, 1, 2.0),
        tap!(0, 1, 4.0),
    ]
);

/// One published row of Ostromoukhov's table, in the paper's own column order.
const fn lw(right: u32, down_left: u32, down: u32) -> LevelWeights {
    LevelWeights {
        right,
        down_left,
        down,
    }
}

/// F-ED-14, as printed in Appendix I of Ostromoukhov's paper: the levels
/// `[0..127]`, three integers each, `A_10 A_-11 A_01`.
///
/// The subscripts are the paper's own `(dx, dy)` offsets, so the columns are
/// the weights for the pixel to the **right**, the pixel **down-left** and the
/// pixel **below** — the three taps of Figure 1. There is no divisor column
/// because the paper defines `M(i) = A_10(i) + A_-11(i) + A_01(i)` and
/// `d(i) = A(i)/M(i)`: the row normalizes against its own sum. See
/// [`LevelWeights`].
///
/// Only half the range is published. Fifteen levels — marked `key` — were
/// optimized off-line against blue-noise spectra; everything between them is a
/// linear interpolation of the *normalized* coefficients, which is why the
/// integers look arbitrary and their sums do not. That structure is not
/// decoration: it is what
/// [`tests::the_published_table_interpolates_linearly_between_the_papers_key_levels`]
/// checks, and it is a far sharper transcription test than any sum could be,
/// because a single mistyped digit breaks the exact rational arithmetic of the
/// segment it lands in.
const PUBLISHED_HALF: [LevelWeights; LEVELS / 2] = [
    lw(13, 0, 5),         //   0 key
    lw(13, 0, 5),         //   1 key
    lw(21, 0, 10),        //   2 key
    lw(7, 0, 4),          //   3 key
    lw(8, 0, 5),          //   4 key
    lw(47, 3, 28),        //   5
    lw(23, 3, 13),        //   6
    lw(15, 3, 8),         //   7
    lw(22, 6, 11),        //   8
    lw(43, 15, 20),       //   9
    lw(7, 3, 3),          //  10 key
    lw(501, 224, 211),    //  11
    lw(249, 116, 103),    //  12
    lw(165, 80, 67),      //  13
    lw(123, 62, 49),      //  14
    lw(489, 256, 191),    //  15
    lw(81, 44, 31),       //  16
    lw(483, 272, 181),    //  17
    lw(60, 35, 22),       //  18
    lw(53, 32, 19),       //  19
    lw(237, 148, 83),     //  20
    lw(471, 304, 161),    //  21
    lw(3, 2, 1),          //  22 key
    lw(481, 314, 185),    //  23
    lw(354, 226, 155),    //  24
    lw(1389, 866, 685),   //  25
    lw(227, 138, 125),    //  26
    lw(267, 158, 163),    //  27
    lw(327, 188, 220),    //  28
    lw(61, 34, 45),       //  29
    lw(627, 338, 505),    //  30
    lw(1227, 638, 1075),  //  31
    lw(20, 10, 19),       //  32 key
    lw(1937, 1000, 1767), //  33
    lw(977, 520, 855),    //  34
    lw(657, 360, 551),    //  35
    lw(71, 40, 57),       //  36
    lw(2005, 1160, 1539), //  37
    lw(337, 200, 247),    //  38
    lw(2039, 1240, 1425), //  39
    lw(257, 160, 171),    //  40
    lw(691, 440, 437),    //  41
    lw(1045, 680, 627),   //  42
    lw(301, 200, 171),    //  43
    lw(177, 120, 95),     //  44
    lw(2141, 1480, 1083), //  45
    lw(1079, 760, 513),   //  46
    lw(725, 520, 323),    //  47
    lw(137, 100, 57),     //  48
    lw(2209, 1640, 855),  //  49
    lw(53, 40, 19),       //  50
    lw(2243, 1720, 741),  //  51
    lw(565, 440, 171),    //  52
    lw(759, 600, 209),    //  53
    lw(1147, 920, 285),   //  54
    lw(2311, 1880, 513),  //  55
    lw(97, 80, 19),       //  56
    lw(335, 280, 57),     //  57
    lw(1181, 1000, 171),  //  58
    lw(793, 680, 95),     //  59
    lw(599, 520, 57),     //  60
    lw(2413, 2120, 171),  //  61
    lw(405, 360, 19),     //  62
    lw(2447, 2200, 57),   //  63
    lw(11, 10, 0),        //  64 key
    lw(158, 151, 3),      //  65
    lw(178, 179, 7),      //  66
    lw(1030, 1091, 63),   //  67
    lw(248, 277, 21),     //  68
    lw(318, 375, 35),     //  69
    lw(458, 571, 63),     //  70
    lw(878, 1159, 147),   //  71
    lw(5, 7, 1),          //  72 key
    lw(172, 181, 37),     //  73
    lw(97, 76, 22),       //  74
    lw(72, 41, 17),       //  75
    lw(119, 47, 29),      //  76
    lw(4, 1, 1),          //  77 key
    lw(4, 1, 1),          //  78
    lw(4, 1, 1),          //  79
    lw(4, 1, 1),          //  80
    lw(4, 1, 1),          //  81
    lw(4, 1, 1),          //  82
    lw(4, 1, 1),          //  83
    lw(4, 1, 1),          //  84
    lw(4, 1, 1),          //  85 key
    lw(65, 18, 17),       //  86
    lw(95, 29, 26),       //  87
    lw(185, 62, 53),      //  88
    lw(30, 11, 9),        //  89
    lw(35, 14, 11),       //  90
    lw(85, 37, 28),       //  91
    lw(55, 26, 19),       //  92
    lw(80, 41, 29),       //  93
    lw(155, 86, 59),      //  94
    lw(5, 3, 2),          //  95 key
    lw(5, 3, 2),          //  96
    lw(5, 3, 2),          //  97
    lw(5, 3, 2),          //  98
    lw(5, 3, 2),          //  99
    lw(5, 3, 2),          // 100
    lw(5, 3, 2),          // 101
    lw(5, 3, 2),          // 102
    lw(5, 3, 2),          // 103
    lw(5, 3, 2),          // 104
    lw(5, 3, 2),          // 105
    lw(5, 3, 2),          // 106
    lw(5, 3, 2),          // 107 key
    lw(305, 176, 119),    // 108
    lw(155, 86, 59),      // 109
    lw(105, 56, 39),      // 110
    lw(80, 41, 29),       // 111
    lw(65, 32, 23),       // 112
    lw(55, 26, 19),       // 113
    lw(335, 152, 113),    // 114
    lw(85, 37, 28),       // 115
    lw(115, 48, 37),      // 116
    lw(35, 14, 11),       // 117
    lw(355, 136, 109),    // 118
    lw(30, 11, 9),        // 119
    lw(365, 128, 107),    // 120
    lw(185, 62, 53),      // 121
    lw(25, 8, 7),         // 122
    lw(95, 29, 26),       // 123
    lw(385, 112, 103),    // 124
    lw(65, 18, 17),       // 125
    lw(395, 104, 101),    // 126
    lw(4, 1, 1),          // 127 key
];

/// The levels the paper solved for rather than interpolated, as highlighted in
/// Appendix I and repeated in the `key` comments above.
///
/// Test-only, because the running algorithm has no use for it: at render time
/// a key level and an interpolated one are the same lookup. It exists so that
/// the transcription can be checked against the table's own shape — see
/// [`tests::the_published_table_interpolates_linearly_between_the_papers_key_levels`].
#[cfg(test)]
const KEY_LEVELS: [usize; 15] = [0, 1, 2, 3, 4, 10, 22, 32, 64, 72, 77, 85, 95, 107, 127];

/// Both halves, mirrored the way the paper's Step 3 says to mirror them.
///
/// "We extend the half-range [0..127] symmetrically around 127.5", which is
/// `D(i) = D(255 - i)` — level 128 takes level 127's row and level 255 takes
/// level 0's. Built here rather than transcribed as 256 rows because the
/// second half is not data: it is a rule, and a rule that is executed cannot
/// disagree with the half it is derived from.
const fn mirrored(half: &[LevelWeights; LEVELS / 2]) -> [LevelWeights; LEVELS] {
    let mut out = [lw(1, 1, 1); LEVELS];
    let mut i = 0;
    while i < LEVELS {
        out[i] = if i < LEVELS / 2 {
            half[i]
        } else {
            half[LEVELS - 1 - i]
        };
        i += 1;
    }
    out
}

const OSTROMOUKHOV_LEVELS: [LevelWeights; LEVELS] = mirrored(&PUBLISHED_HALF);

/// F-ED-14. Ostromoukhov, 2001.
///
/// The only kernel here whose coefficients depend on the pixel. Its shape is
/// the cheapest one in the catalogue — three taps, the same three [`SIERRA_LITE`]
/// uses, which is Floyd-Steinberg without the tap that lands diagonally ahead
/// of the scan. What varies is the weights: they are looked up per input level
/// from a table solved off-line so that the Fourier spectrum at each key level
/// sits as close to blue noise as three coefficients can be made to sit. That
/// is the whole method, and it is why it is both faster than Floyd-Steinberg
/// and quieter than it.
///
/// ```text
///          *     A_10
///    A_-11 A_01         (1 / (A_10 + A_-11 + A_01))
/// ```
///
/// Transcribed from Appendix I of Victor Ostromoukhov, "A Simple and Efficient
/// Error-Diffusion Algorithm", Proceedings of SIGGRAPH 2001, pp. 567-572.
///
/// **These numbers are not the ones other implementations use, and that is
/// deliberate.** Alongside the paper the author released C sample code
/// (`varcoeffED.tar`), and its table differs from the paper's for input levels
/// 23..=71 — it places a key level at 36 where the paper places one at 32, and
/// it gives level 64 a different triple. Every third-party implementation
/// traced during this transcription descends from that sample code, so the
/// paper's own table is the minority reading in the wild. It is nonetheless
/// what is registered here: the paper is the published record, it is what this
/// kernel cites, and its table is self-consistent in a way that can be checked
/// — the levels it highlights as key are exactly the levels at which its own
/// numbers stop interpolating linearly. The sample-code table does not satisfy
/// that against the paper's highlighting. Whoever revisits this should know
/// that both tables are the author's and that switching to the other one is an
/// edit to [`PUBLISHED_HALF`] and a re-bless of the golden set, nothing more.
pub const OSTROMOUKHOV: Kernel = Kernel {
    id: "ostromoukhov",
    name: "Ostromoukhov",
    rule: Rule::Variable {
        levels: &OSTROMOUKHOV_LEVELS,
    },
};

/// Riemersma's published defaults: sixteen errors of history, the newest
/// weighted sixteen times the oldest.
const RIEMERSMA_HISTORY: usize = 16;
const RIEMERSMA_DECAY: f32 = 16.0;

/// F-ED-15. Riemersma, 1998.
///
/// The odd one out twice over. It visits pixels along a Hilbert curve instead
/// of by rows, and it hands error forward through a fixed-length queue whose
/// weights decay exponentially instead of splashing it onto named neighbours.
/// Because the curve has no preferred direction, the output has no directional
/// structure at all — no worms, no diagonal grain, and nothing for serpentine
/// scanning to fix, which is why serpentine is inert here.
pub const RIEMERSMA: Kernel = Kernel {
    id: "riemersma",
    name: "Riemersma",
    rule: Rule::Riemersma {
        history: RIEMERSMA_HISTORY,
        decay: RIEMERSMA_DECAY,
    },
};

/// Every kernel registered so far, in F-ED order. The web layer reads this to
/// build its effect list rather than keeping a parallel copy.
pub const KERNELS: &[Kernel] = &[
    FLOYD_STEINBERG,
    FALSE_FLOYD_STEINBERG,
    JARVIS_JUDICE_NINKE,
    STUCKI,
    BURKES,
    SIERRA_3,
    SIERRA_2,
    SIERRA_LITE,
    ATKINSON,
    STEVENSON_ARCE,
    FAN,
    SHIAU_FAN,
    SHIAU_FAN_2,
    OSTROMOUKHOV,
    RIEMERSMA,
];

pub fn kernel_by_id(id: &str) -> Option<&'static Kernel> {
    KERNELS.iter().find(|k| k.id == id)
}

/// Whether quantization error is diffused per channel or as one luminance term
/// (F-ED-CTL).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelMode {
    /// Three independent error channels. A pixel matched to a palette entry of
    /// the wrong hue pushes its neighbours toward the complementary hue, which
    /// is what lets a small palette reconstruct colours it does not contain —
    /// and also what produces the coloured speckle in flat areas.
    PerChannel,
    /// One luminance error. The chroma part of the quantization error is
    /// dropped rather than spread, so flat areas stay clean and colour
    /// gradients band instead of dissolving.
    Luma,
}

/// Shared controls for every diffusion kernel (F-ED-CTL).
#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// 0.0 = no diffusion (plain nearest-colour quantization), 1.0 = full.
    pub strength: f32,
    /// Alternate scan direction per row. Removes the directional worming that
    /// left-to-right-only scanning produces.
    ///
    /// Has no meaning for [`Rule::Riemersma`], which does not scan in rows, and
    /// is ignored there rather than approximated.
    pub serpentine: bool,
    /// Seeded threshold jitter, 0.0..=1.0.
    ///
    /// Perturbs the value the palette match is taken on, not the value the
    /// error is measured against — see [`Pass::resolve`]. The draws come from
    /// [`Pcg32`] seeded with [`Options::seed`], never from a clock, so the same
    /// document renders identically on every platform and in every worker
    /// (F-AN-05).
    pub jitter: f32,
    /// Seed for the jitter draws. Explicit, because nothing in a render path is
    /// allowed to invent one.
    pub seed: u64,
    /// How far outside `[0, 1]` an accumulated working value may travel before
    /// it is pinned.
    ///
    /// This bounds the **working buffer**, not the error term. The field's
    /// previous doc comment claimed the opposite of what the code has always
    /// done; the code is the behaviour worth keeping, because what produces the
    /// long bright or dark drag out of a saturated region is the running value
    /// climbing away from the palette over many pixels, not any single error
    /// being large. `0.0` pins the buffer to the palette's own range and kills
    /// the drag outright; `1.0`, the default, leaves a full unit of headroom.
    pub overshoot_limit: f32,
    /// Per-channel or luma diffusion.
    pub channels: ChannelMode,
    pub metric: Metric,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            strength: 1.0,
            serpentine: true,
            jitter: 0.0,
            seed: 0,
            overshoot_limit: 1.0,
            channels: ChannelMode::PerChannel,
            metric: Metric::Oklab,
        }
    }
}

/// Result of a dither pass.
///
/// Both buffers are returned deliberately. The index map is what makes
/// hue-targeted recolour, index remap, outline, dilate/erode and the SVG
/// tracer lossless and cheap downstream; carrying it is a chosen memory cost.
pub struct DitherResult {
    pub pixels: Vec<Rgba>,
    pub indices: Vec<u16>,
}

/// Run `kernel` over a linear-light buffer, quantizing to `palette`.
///
/// Panics if `pixels.len() != width * height`, or if the palette has more
/// entries than a `u16` index map can name — silently wrapping an index would
/// corrupt every downstream index-map operation with no error anywhere.
pub fn dither(
    pixels: &[Rgba],
    width: usize,
    height: usize,
    palette: &Palette,
    kernel: &Kernel,
    opts: Options,
) -> DitherResult {
    assert_eq!(
        pixels.len(),
        width * height,
        "buffer does not match dimensions"
    );
    assert!(
        palette.len() <= u16::MAX as usize + 1,
        "palette of {} entries does not fit a u16 index map",
        palette.len()
    );

    let mut pass = Pass::new(pixels, width, height, palette, opts);
    match kernel.rule {
        Rule::Fixed { taps, divisor } => pass.run_fixed(taps, divisor),
        Rule::Variable { levels } => pass.run_variable(levels),
        Rule::Riemersma { history, decay } => pass.run_riemersma(history, decay),
    }
    pass.finish()
}

/// Rec. 709 luminance of a linear-light colour.
///
/// The weights sum to 1, which is what makes luma diffusion work: adding one
/// scalar to R, G and B moves a pixel's luminance by exactly that scalar and
/// leaves its chroma alone.
#[inline]
fn luminance(c: Rgba) -> f32 {
    0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

/// The error owed to pixels not yet visited. Three components even in luma
/// mode, where all three carry the same scalar — see [`Pass::resolve`].
#[derive(Clone, Copy, Debug)]
struct Diff {
    r: f32,
    g: f32,
    b: f32,
}

impl Diff {
    const ZERO: Self = Self {
        r: 0.0,
        g: 0.0,
        b: 0.0,
    };
}

/// One dither pass in flight. Holds the state the three rules share so that
/// F-ED-CTL is implemented once rather than three times slightly differently.
struct Pass<'a> {
    source: &'a [Rgba],
    palette: &'a Palette,
    metric: Metric,
    channels: ChannelMode,
    serpentine: bool,
    width: usize,
    height: usize,
    work: Vec<Rgba>,
    out: Vec<Rgba>,
    indices: Vec<u16>,
    /// Jitter draws in **raster** order, or empty when jitter is off.
    ///
    /// Drawn up front rather than as the scan reaches each pixel so that the
    /// jitter is a function of the seed and the pixel's position and nothing
    /// else. Drawing them inline would tie the noise to the traversal, and the
    /// traversal changes with serpentine and is a Hilbert curve for Riemersma —
    /// the same seed would then mean three different noise fields.
    jitter: Vec<f32>,
    jitter_amount: f32,
    strength: f32,
    lo: f32,
    hi: f32,
}

impl<'a> Pass<'a> {
    fn new(
        pixels: &'a [Rgba],
        width: usize,
        height: usize,
        palette: &'a Palette,
        opts: Options,
    ) -> Self {
        let jitter_amount = opts.jitter.clamp(0.0, 1.0);
        let jitter = if jitter_amount > 0.0 {
            let mut rng = Pcg32::new(opts.seed, stream_of("diffusion-threshold-jitter"));
            (0..pixels.len()).map(|_| rng.next_f32()).collect()
        } else {
            // Not allocated at all when the control is off: this is one f32 per
            // pixel alongside buffers that already cost 34 bytes each.
            Vec::new()
        };
        let overshoot = opts.overshoot_limit.max(0.0);

        Self {
            source: pixels,
            palette,
            metric: opts.metric,
            channels: opts.channels,
            serpentine: opts.serpentine,
            width,
            height,
            work: pixels.to_vec(),
            out: vec![Rgba::new(0.0, 0.0, 0.0, 0.0); pixels.len()],
            indices: vec![0u16; pixels.len()],
            jitter,
            jitter_amount,
            strength: opts.strength.clamp(0.0, 1.0),
            lo: -overshoot,
            hi: 1.0 + overshoot,
        }
    }

    fn finish(self) -> DitherResult {
        DitherResult {
            pixels: self.out,
            indices: self.indices,
        }
    }

    /// Quantize pixel `i`, record it, and return the error owed forward —
    /// already scaled by strength and already collapsed to one term in luma
    /// mode.
    fn resolve(&mut self, i: usize) -> Diff {
        let current = self.work[i];

        // F-ED-CTL threshold jitter. The *decision* is taken on a perturbed
        // value; the error is still measured against the unperturbed one, so
        // the noise breaks the pattern up without ever entering the error
        // budget and the mean of the output is untouched. Feeding the perturbed
        // value into the error instead would be seeded noise injection
        // (F-PP-06), which is a different node with a different look.
        let probe = if self.jitter.is_empty() {
            current
        } else {
            let d = (self.jitter[i] - 0.5) * self.jitter_amount;
            Rgba::new(current.r + d, current.g + d, current.b + d, current.a)
        };

        let idx = self.palette.nearest(probe, self.metric);
        let chosen = self.palette.color(idx);
        self.indices[i] = idx as u16;
        self.out[i] = Rgba::new(chosen.r, chosen.g, chosen.b, current.a);

        match self.channels {
            ChannelMode::PerChannel => Diff {
                r: (current.r - chosen.r) * self.strength,
                g: (current.g - chosen.g) * self.strength,
                b: (current.b - chosen.b) * self.strength,
            },
            ChannelMode::Luma => {
                let d = (luminance(current) - luminance(chosen)) * self.strength;
                Diff { r: d, g: d, b: d }
            }
        }
    }

    /// Add `share` of `diff` into the working value at `(nx, ny)`, discarding
    /// anything that falls off the image.
    #[inline]
    fn deposit(&mut self, nx: i32, ny: i32, diff: Diff, share: f32) {
        if nx < 0 || ny < 0 || nx >= self.width as i32 || ny >= self.height as i32 {
            return;
        }
        let ni = ny as usize * self.width + nx as usize;
        let (lo, hi) = (self.lo, self.hi);
        let p = &mut self.work[ni];
        p.r = (p.r + diff.r * share).clamp(lo, hi);
        p.g = (p.g + diff.g * share).clamp(lo, hi);
        p.b = (p.b + diff.b * share).clamp(lo, hi);
    }

    /// F-ED-01..13: raster scan, fixed tap table.
    fn run_fixed(&mut self, taps: &'static [Tap], divisor: f32) {
        let diffuse = self.strength > 0.0;
        for y in 0..self.height {
            let reversed = self.serpentine && y % 2 == 1;
            for step in 0..self.width {
                let x = if reversed {
                    self.width - 1 - step
                } else {
                    step
                };
                let i = y * self.width + x;
                let diff = self.resolve(i);
                if !diffuse {
                    continue;
                }
                for tap in taps {
                    // Mirror the horizontal offset when scanning right-to-left,
                    // otherwise serpentine scanning pushes error the wrong way.
                    let dx = if reversed { -tap.dx } else { tap.dx };
                    self.deposit(x as i32 + dx, y as i32 + tap.dy, diff, tap.weight / divisor);
                }
            }
        }
    }

    /// F-ED-14: raster scan, coefficients looked up per input level.
    fn run_variable(&mut self, levels: &'static [LevelWeights; LEVELS]) {
        for (level, w) in levels.iter().enumerate() {
            assert!(
                w.right + w.down_left + w.down > 0,
                "variable-coefficient row {level} sums to zero and has no divisor"
            );
        }

        let diffuse = self.strength > 0.0;
        for y in 0..self.height {
            let reversed = self.serpentine && y % 2 == 1;
            for step in 0..self.width {
                let x = if reversed {
                    self.width - 1 - step
                } else {
                    step
                };
                let i = y * self.width + x;

                // Indexed by the *source* level, not the running value: the
                // coefficients were solved for the behaviour of the algorithm
                // on a constant input of that intensity, so the intensity being
                // reproduced is what selects them.
                let w = levels[level_index(self.source[i])];
                let total = (w.right + w.down_left + w.down) as f32;

                let diff = self.resolve(i);
                if !diffuse {
                    continue;
                }
                let ahead = if reversed { -1 } else { 1 };
                let (x, y) = (x as i32, y as i32);
                self.deposit(x + ahead, y, diff, w.right as f32 / total);
                self.deposit(x - ahead, y + 1, diff, w.down_left as f32 / total);
                self.deposit(x, y + 1, diff, w.down as f32 / total);
            }
        }
    }

    /// F-ED-15: Hilbert traversal, exponentially decaying error history.
    fn run_riemersma(&mut self, history: usize, decay: f32) {
        assert!(history >= 2, "error history needs at least two slots");
        assert!(
            decay > 1.0,
            "decay must exceed 1, or the history is not a decay"
        );

        // `weights[k]` applies to the k-th oldest error still in the queue, so
        // the newest carries `decay` times the weight of the oldest.
        let ratio = decay.powf(1.0 / (history - 1) as f32);
        let mut weights: Vec<f32> = (0..history).map(|k| ratio.powi(k as i32)).collect();

        // Normalized to sum to 1. Riemersma's own code kept the weights as
        // small integers because it was doing this in integer arithmetic in
        // 1998; the ratio between them is the algorithm, the rounding was the
        // hardware. What is not optional is the normalization: the queue has to
        // hand on the whole quantization error, exactly as a tap table whose
        // weights sum to its divisor does, or a flat field stops averaging back
        // to itself.
        let total: f32 = weights.iter().sum();
        for w in &mut weights {
            *w /= total;
        }

        // No strength shortcut here, unlike the two raster passes. There it
        // skips a dozen deposits per pixel; here the queue would have to be
        // stepped anyway and `resolve` has already scaled the error to zero,
        // so a guard would only be a branch that never changes an answer.
        let mut queue: VecDeque<Diff> = VecDeque::from(vec![Diff::ZERO; history]);
        let width = self.width;

        hilbert::walk(self.width, self.height, &mut |x: usize, y: usize| {
            let i = y * width + x;

            let mut acc = Diff::ZERO;
            for (e, w) in queue.iter().zip(weights.iter()) {
                acc.r += e.r * w;
                acc.g += e.g * w;
                acc.b += e.b * w;
            }
            {
                let (lo, hi) = (self.lo, self.hi);
                let p = &mut self.work[i];
                p.r = (p.r + acc.r).clamp(lo, hi);
                p.g = (p.g + acc.g).clamp(lo, hi);
                p.b = (p.b + acc.b).clamp(lo, hi);
            }

            let diff = self.resolve(i);
            queue.pop_front();
            queue.push_back(diff);
        });
    }
}

/// Map a linear-light colour onto one of [`LEVELS`] input levels.
///
/// Through the sRGB transfer curve, because a variable-coefficient table is
/// indexed by the 8-bit code value of the source image and code values are
/// display-referred. Indexing by linear luminance instead would crowd
/// two-thirds of the table into the top stop of the image.
#[inline]
fn level_index(c: Rgba) -> usize {
    let code = linear_to_srgb(luminance(c)).clamp(0.0, 1.0);
    (code * (LEVELS - 1) as f32 + 0.5) as usize
}

/// Hilbert-curve traversal for arbitrary, non-power-of-two images (F-ED-15).
mod hilbert {
    /// Visit every pixel of a `width` x `height` image in Hilbert order.
    ///
    /// The curve is defined on the smallest enclosing power-of-two square and
    /// the points outside the image are dropped, which is the standard way to
    /// take a curve that only exists on squares to a rectangle: it visits every
    /// pixel exactly once and it keeps the locality that Riemersma depends on.
    ///
    /// Sub-squares that fall entirely outside the image are pruned rather than
    /// walked and discarded. Without that, a 4096x64 image would step through
    /// sixteen million curve positions to dither a quarter of a million pixels,
    /// and a strip narrower still would never finish at all.
    pub fn walk<F: FnMut(usize, usize)>(width: usize, height: usize, visit: &mut F) {
        if width == 0 || height == 0 {
            return;
        }
        let side = width.max(height).next_power_of_two() as u64;
        let order = side.trailing_zeros();
        descend(order, 0, order, width as u64, height as u64, visit);
    }

    /// Walk the sub-curve of length `4^level` that starts at index `start`.
    fn descend<F: FnMut(usize, usize)>(
        order: u32,
        start: u64,
        level: u32,
        w: u64,
        h: u64,
        visit: &mut F,
    ) {
        let (x, y) = d2xy(order, start);
        if level == 0 {
            if x < w && y < h {
                visit(x as usize, y as usize);
            }
            return;
        }

        // `start` is a multiple of 4^level, so this sub-curve fills exactly the
        // aligned 2^level block that its first point sits in — which is what
        // makes the block cheap to test and safe to skip whole.
        let block = 1u64 << level;
        if (x & !(block - 1)) >= w || (y & !(block - 1)) >= h {
            return;
        }

        let quarter = 1u64 << (2 * (level - 1));
        for q in 0..4 {
            descend(order, start + q * quarter, level - 1, w, h, visit);
        }
    }

    /// Hilbert index to coordinates on a `2^order` square.
    ///
    /// The standard iterative construction: read the index two bits at a time
    /// from the bottom, and rotate and reflect the square assembled so far
    /// before placing it in its quadrant. Integer-only, so it produces the same
    /// traversal on every platform — the same requirement the PRNG is built to.
    fn d2xy(order: u32, d: u64) -> (u64, u64) {
        let side = 1u64 << order;
        let (mut x, mut y) = (0u64, 0u64);
        let mut t = d;
        let mut s = 1u64;
        while s < side {
            let rx = (t >> 1) & 1;
            let ry = (t ^ rx) & 1;
            if ry == 0 {
                if rx == 1 {
                    x = s - 1 - x;
                    y = s - 1 - y;
                }
                std::mem::swap(&mut x, &mut y);
            }
            x += s * rx;
            y += s * ry;
            t >>= 2;
            s <<= 1;
        }
        (x, y)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn collect(width: usize, height: usize) -> Vec<(usize, usize)> {
            let mut seen = Vec::new();
            walk(width, height, &mut |x, y| seen.push((x, y)));
            seen
        }

        #[test]
        fn a_square_is_covered_exactly_once() {
            let points = collect(16, 16);
            assert_eq!(points.len(), 256);
            let mut sorted = points.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), 256, "the curve revisited a pixel");
        }

        #[test]
        fn a_square_is_walked_in_single_steps() {
            // The property that makes this a Hilbert curve rather than a
            // permutation: consecutive positions are neighbours. Riemersma's
            // whole premise is that the error queue holds spatially near
            // pixels, so this is a correctness test, not a curiosity.
            let points = collect(32, 32);
            for pair in points.windows(2) {
                let (a, b) = (pair[0], pair[1]);
                let step = a.0.abs_diff(b.0) + a.1.abs_diff(b.1);
                assert_eq!(step, 1, "jumped from {a:?} to {b:?}");
            }
        }

        #[test]
        fn non_power_of_two_rectangles_are_covered_exactly_once() {
            for (w, h) in [(1, 1), (1, 7), (7, 1), (13, 5), (37, 23), (64, 3)] {
                let points = collect(w, h);
                assert_eq!(points.len(), w * h, "{w}x{h} visited the wrong count");
                let mut sorted = points;
                sorted.sort_unstable();
                sorted.dedup();
                assert_eq!(sorted.len(), w * h, "{w}x{h} revisited a pixel");
                assert!(
                    sorted.first() == Some(&(0, 0)) && sorted.last() == Some(&(w - 1, h - 1)),
                    "{w}x{h} did not span the image"
                );
            }
        }

        #[test]
        fn pruning_keeps_a_thin_strip_tractable() {
            // 4096x2 sits in a 4096x4096 curve. Unpruned this is sixteen
            // million steps for eight thousand pixels; pruned it is linear.
            // If this ever hangs, the block test above it has stopped working.
            let points = collect(4096, 2);
            assert_eq!(points.len(), 8192);
        }

        #[test]
        fn an_empty_image_visits_nothing() {
            assert!(collect(0, 8).is_empty());
            assert!(collect(8, 0).is_empty());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::srgb_to_linear;
    use crate::palette::builtin;

    fn flat(w: usize, h: usize, c: Rgba) -> Vec<Rgba> {
        vec![c; w * h]
    }

    /// A picture with edges, saturated corners and out-of-palette hues — the
    /// input that actually exercises clamping and per-channel diffusion, which
    /// a flat field does not.
    fn busy(w: usize, h: usize) -> Vec<Rgba> {
        let mut px = Vec::with_capacity(w * h);
        for y in 0..h {
            for x in 0..w {
                let u = x as f32 / (w - 1) as f32;
                let v = y as f32 / (h - 1) as f32;
                let block = if (x / 5 + y / 7) % 2 == 0 { 1.0 } else { 0.0 };
                px.push(Rgba::new(
                    srgb_to_linear(u * block),
                    srgb_to_linear(v),
                    srgb_to_linear(1.0 - u * v),
                    1.0,
                ));
            }
        }
        px
    }

    // ---- coefficient tables -------------------------------------------------

    /// The typo check. Every published kernel except Atkinson distributes all
    /// of the error, so its taps sum to its divisor; a transposed or dropped
    /// digit almost always breaks that sum, and nothing else in the test suite
    /// would notice — the picture still renders, only slightly wrong.
    #[test]
    fn fixed_tap_tables_sum_to_their_divisor() {
        for k in KERNELS {
            let Rule::Fixed { taps, divisor } = k.rule else {
                continue;
            };
            let sum: f32 = taps.iter().map(|t| t.weight).sum();
            if k.id == "atkinson" {
                // Six eighths, on purpose. See ATKINSON.
                assert!(
                    (sum / divisor - 0.75).abs() < 1e-6,
                    "{}: {sum}/{divisor}",
                    k.id
                );
            } else {
                assert!(
                    (sum - divisor).abs() < 1e-6,
                    "{}: taps sum to {sum}, divisor is {divisor}",
                    k.id
                );
            }
        }
    }

    /// A kernel may only push error at pixels the scan has not reached. A tap
    /// with `dy < 0`, or on the current row at or behind the pixel, would be
    /// written and then immediately overwritten — a silent no-op that reads as
    /// a working coefficient.
    #[test]
    fn fixed_taps_only_reach_forward() {
        for k in KERNELS {
            let Rule::Fixed { taps, .. } = k.rule else {
                continue;
            };
            for t in taps {
                assert!(t.dy >= 0, "{}: tap reaches back a row", k.id);
                assert!(t.dy > 0 || t.dx > 0, "{}: tap reaches back a pixel", k.id);
                assert!(t.weight > 0.0, "{}: tap carries no weight", k.id);
            }
        }
    }

    #[test]
    fn the_registry_is_consistent() {
        let mut ids: Vec<&str> = KERNELS.iter().map(|k| k.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate kernel id");

        for k in KERNELS {
            assert!(!k.name.is_empty(), "{}: no display name", k.id);
            assert!(
                k.id.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{}: id is not kebab-case",
                k.id
            );
            assert_eq!(kernel_by_id(k.id).map(|f| f.id), Some(k.id));
        }
        assert_eq!(kernel_by_id("no-such-kernel").map(|k| k.id), None);
    }

    // ---- the colour-correctness test, for every kernel ----------------------

    /// The share of each quantization error a kernel actually hands on. One for
    /// all of them except Atkinson, which is the point of this function
    /// existing.
    fn retained(k: &Kernel) -> f32 {
        match k.rule {
            Rule::Fixed { taps, divisor } => taps.iter().map(|t| t.weight).sum::<f32>() / divisor,
            // Both normalize their weights against their own sum, by
            // construction — a variable row against its three coefficients, a
            // Riemersma queue against the whole decay curve.
            Rule::Variable { .. } | Rule::Riemersma { .. } => 1.0,
        }
    }

    /// The colour-correctness claim, run over a flat mid-grey and the whole
    /// catalogue. Two assertions, and they are testing different things.
    ///
    /// The first is the one docs/ARCHITECTURE.md names: the dithered mean must
    /// come back to the input's own luminance. It holds tightly for every
    /// kernel that hands on all of the error it generates. Atkinson does not —
    /// it distributes six eighths and drops the rest — so on a flat field its
    /// mean leans toward whichever decision it keeps repeating. Its allowance
    /// is derived rather than picked: at a retained share `t` the steady-state
    /// shortfall is `(1-t)/t` of the distance between the input level and
    /// wherever the working buffer settles, and the working buffer settles
    /// somewhere inside the palette's own range.
    ///
    /// That derived bound is loose, which is why the second assertion is here
    /// and applies to everything without exception: the mean has to land nearer
    /// the linear-light answer than the sRGB-encoded one. Diffusing in gamma
    /// space reproduces the encoded value, so that is the comparison the
    /// mistake actually fails — and no error-losing kernel gets a pass on it.
    #[test]
    fn every_kernel_averages_a_flat_grey_back_to_itself() {
        let pal = Palette::from_srgb_rgb(builtin::MONO);

        // Two sizes and two levels: the second is non-square and
        // non-power-of-two, which is where Riemersma's curve has to be pruned
        // and every other kernel has to get its row ends right.
        for (w, h, encoded) in [(96usize, 96usize, 0.5f32), (101, 67, 0.6)] {
            let level = srgb_to_linear(encoded);
            let src = flat(w, h, Rgba::new(level, level, level, 1.0));

            for k in KERNELS {
                for channels in [ChannelMode::PerChannel, ChannelMode::Luma] {
                    let opts = Options {
                        channels,
                        ..Options::default()
                    };
                    let res = dither(&src, w, h, &pal, k, opts);
                    let mean: f32 = res.pixels.iter().map(|p| p.r).sum::<f32>() / (w * h) as f32;

                    let t = retained(k);
                    let tolerance = if t >= 1.0 {
                        0.02
                    } else {
                        (1.0 - t) / t * level.max(1.0 - level)
                    };
                    assert!(
                        (mean - level).abs() < tolerance,
                        "{} ({channels:?}) at {w}x{h}: mean {mean} vs target {level}",
                        k.id
                    );
                    assert!(
                        (mean - level).abs() < (mean - encoded).abs(),
                        "{} ({channels:?}) at {w}x{h}: mean {mean} sits nearer the encoded \
                         value {encoded} than the linear one {level} — this is what \
                         diffusing in sRGB looks like",
                        k.id
                    );
                }
            }
        }
    }

    #[test]
    fn every_kernel_keeps_indices_inside_the_palette() {
        let (w, h) = (53usize, 31usize);
        let src = busy(w, h);
        for bytes in [builtin::MONO, builtin::GAMEBOY_DMG, builtin::CGA_1_HIGH] {
            let pal = Palette::from_srgb_rgb(bytes);
            for k in KERNELS {
                for metric in [Metric::Oklab, Metric::SrgbEuclidean] {
                    let opts = Options {
                        metric,
                        jitter: 0.4,
                        seed: 7,
                        ..Options::default()
                    };
                    let res = dither(&src, w, h, &pal, k, opts);
                    assert_eq!(res.indices.len(), w * h, "{}", k.id);
                    assert_eq!(res.pixels.len(), w * h, "{}", k.id);
                    assert!(
                        res.indices.iter().all(|&i| (i as usize) < pal.len()),
                        "{} produced an index outside a {}-entry palette",
                        k.id,
                        pal.len()
                    );
                }
            }
        }
    }

    #[test]
    fn every_kernel_covers_the_image() {
        // Alpha is carried through untouched (F-IN-03), which also proves every
        // pixel was written rather than left at the zeroed initial value.
        let (w, h) = (23usize, 19usize);
        let src: Vec<Rgba> = busy(w, h)
            .into_iter()
            .map(|p| Rgba::new(p.r, p.g, p.b, 0.25))
            .collect();
        let pal = Palette::from_srgb_rgb(builtin::GAMEBOY_DMG);
        for k in KERNELS {
            let res = dither(&src, w, h, &pal, k, Options::default());
            assert!(
                res.pixels.iter().all(|p| p.a == 0.25),
                "{} did not write every pixel",
                k.id
            );
        }
    }

    // ---- F-ED-CTL -----------------------------------------------------------

    #[test]
    fn zero_strength_is_plain_quantization() {
        let (w, h) = (8usize, 8usize);
        let src = flat(w, h, Rgba::new(0.9, 0.9, 0.9, 1.0));
        let pal = Palette::from_srgb_rgb(builtin::MONO);
        let opts = Options {
            strength: 0.0,
            ..Options::default()
        };
        for k in KERNELS {
            let res = dither(&src, w, h, &pal, k, opts);
            assert!(res.indices.iter().all(|&i| i == 1), "{}", k.id);
        }
    }

    #[test]
    fn strength_between_the_ends_lands_between_the_ends() {
        let (w, h) = (64usize, 64usize);
        let level = srgb_to_linear(0.5);
        let src = flat(w, h, Rgba::new(level, level, level, 1.0));
        let pal = Palette::from_srgb_rgb(builtin::MONO);
        let white = |s: f32| {
            let opts = Options {
                strength: s,
                ..Options::default()
            };
            let res = dither(&src, w, h, &pal, &FLOYD_STEINBERG, opts);
            res.indices.iter().filter(|&&i| i == 1).count()
        };
        // At zero strength every pixel takes the same nearest colour — for this
        // level, under OKLab, white. At full strength the field reproduces its
        // own luminance, which is far darker than all-white. Half has to sit
        // between the two, or the control is not a mix.
        let (none, half, full) = (white(0.0), white(0.5), white(1.0));
        assert_eq!(none, w * h);
        assert!(
            full < half && half < none,
            "0: {none}, 0.5: {half}, 1: {full}"
        );
    }

    /// Threshold jitter must be reproducible from its seed, and only from its
    /// seed. This is the F-AN-05 guarantee for the diffusion family.
    #[test]
    fn every_kernel_is_reproducible_from_its_seed() {
        let (w, h) = (41usize, 29usize);
        let src = busy(w, h);
        let pal = Palette::from_srgb_rgb(builtin::GAMEBOY_DMG);
        let opts = |seed| Options {
            jitter: 0.5,
            seed,
            ..Options::default()
        };

        for k in KERNELS {
            let a = dither(&src, w, h, &pal, k, opts(0xfeed_beef));
            let b = dither(&src, w, h, &pal, k, opts(0xfeed_beef));
            assert_eq!(a.indices, b.indices, "{} is not deterministic", k.id);
            assert!(
                a.pixels.iter().zip(&b.pixels).all(|(x, y)| x == y),
                "{} is not deterministic",
                k.id
            );

            let c = dither(&src, w, h, &pal, k, opts(0xfeed_bef0));
            assert_ne!(a.indices, c.indices, "{} ignores its seed", k.id);
        }
    }

    #[test]
    fn jitter_off_is_not_jitter_on() {
        let (w, h) = (48usize, 48usize);
        let level = srgb_to_linear(0.45);
        let src = flat(w, h, Rgba::new(level, level, level, 1.0));
        let pal = Palette::from_srgb_rgb(builtin::MONO);
        let plain = dither(&src, w, h, &pal, &FLOYD_STEINBERG, Options::default());
        let jittered = dither(
            &src,
            w,
            h,
            &pal,
            &FLOYD_STEINBERG,
            Options {
                jitter: 0.6,
                seed: 1,
                ..Options::default()
            },
        );
        assert_ne!(plain.indices, jittered.indices);

        // And it still averages back: the jitter moves the decision, not the
        // error, so the mean is not allowed to drift with it.
        let mean: f32 = jittered.pixels.iter().map(|p| p.r).sum::<f32>() / (w * h) as f32;
        assert!((mean - level).abs() < 0.02, "mean {mean} vs {level}");
    }

    /// The jitter field is indexed by pixel, not by visit order, so turning
    /// serpentine on must not re-roll the noise — only re-order the scan.
    #[test]
    fn jitter_does_not_depend_on_the_traversal() {
        let (w, h) = (32usize, 32usize);
        let src = busy(w, h);
        let pal = Palette::from_srgb_rgb(builtin::MONO);
        let opts = Options {
            jitter: 0.5,
            seed: 99,
            strength: 0.0, // no diffusion, so only the jitter decides
            serpentine: false,
            ..Options::default()
        };
        let straight = dither(&src, w, h, &pal, &FLOYD_STEINBERG, opts);
        let snake = dither(
            &src,
            w,
            h,
            &pal,
            &FLOYD_STEINBERG,
            Options {
                serpentine: true,
                ..opts
            },
        );
        assert_eq!(straight.indices, snake.indices);
    }

    #[test]
    fn serpentine_changes_the_result() {
        let (w, h) = (64usize, 64usize);
        let level = srgb_to_linear(0.4);
        let src = flat(w, h, Rgba::new(level, level, level, 1.0));
        let pal = Palette::from_srgb_rgb(builtin::MONO);
        let a = dither(
            &src,
            w,
            h,
            &pal,
            &FLOYD_STEINBERG,
            Options {
                serpentine: false,
                ..Options::default()
            },
        );
        let b = dither(&src, w, h, &pal, &FLOYD_STEINBERG, Options::default());
        assert_ne!(a.indices, b.indices);
    }

    /// The overshoot limit bounds the working buffer, so it can only show up
    /// where the buffer would otherwise leave the palette's range — a colour
    /// the palette cannot reach at all.
    #[test]
    fn the_overshoot_limit_bounds_the_working_buffer() {
        let (w, h) = (40usize, 40usize);
        // Saturated red against four greens: every match is badly wrong, so the
        // error piles up in the same direction pixel after pixel.
        let src = flat(w, h, Rgba::new(1.0, 0.0, 0.0, 1.0));
        let pal = Palette::from_srgb_rgb(builtin::GAMEBOY_DMG);
        let run = |limit: f32| {
            dither(
                &src,
                w,
                h,
                &pal,
                &FLOYD_STEINBERG,
                Options {
                    overshoot_limit: limit,
                    ..Options::default()
                },
            )
            .indices
        };
        assert_ne!(run(0.0), run(4.0), "the clamp had no observable effect");
    }

    /// On neutral input the luminance error and the three channel errors are
    /// the same number, so the two modes must agree exactly. Anything else
    /// means the luma path is not measuring luminance.
    #[test]
    fn luma_and_per_channel_agree_on_neutral_input() {
        let (w, h) = (37usize, 41usize);
        let src: Vec<Rgba> = (0..w * h)
            .map(|i| {
                let v = srgb_to_linear((i % 251) as f32 / 250.0);
                Rgba::new(v, v, v, 1.0)
            })
            .collect();
        let pal = Palette::from_srgb_rgb(builtin::MONO);
        for k in KERNELS {
            let per = dither(
                &src,
                w,
                h,
                &pal,
                k,
                Options {
                    channels: ChannelMode::PerChannel,
                    ..Options::default()
                },
            );
            let luma = dither(
                &src,
                w,
                h,
                &pal,
                k,
                Options {
                    channels: ChannelMode::Luma,
                    ..Options::default()
                },
            );
            assert_eq!(per.indices, luma.indices, "{}", k.id);
        }
    }

    #[test]
    fn luma_and_per_channel_diverge_on_colour() {
        let (w, h) = (48usize, 48usize);
        let src = busy(w, h);
        let pal = Palette::from_srgb_rgb(builtin::CGA_1_HIGH);
        let per = dither(&src, w, h, &pal, &FLOYD_STEINBERG, Options::default());
        let luma = dither(
            &src,
            w,
            h,
            &pal,
            &FLOYD_STEINBERG,
            Options {
                channels: ChannelMode::Luma,
                ..Options::default()
            },
        );
        assert_ne!(per.indices, luma.indices);
    }

    // ---- the variable-coefficient path (F-ED-14) -----------------------------

    /// The code path, proved independently of the table it will be given: a
    /// table whose every row is the same triple must behave exactly like the
    /// fixed kernel with those three taps. If the level lookup, the per-row
    /// divisor or the serpentine mirroring were wrong, the two would not agree.
    ///
    /// Worth keeping now that F-ED-14's real coefficients are in the tree,
    /// because it is the only test here that isolates the machinery from them —
    /// everything below would also fail on a bad table.
    #[test]
    fn a_constant_level_table_matches_the_equivalent_fixed_kernel() {
        const CONSTANT: [LevelWeights; LEVELS] = [LevelWeights {
            right: 7,
            down_left: 3,
            down: 5,
        }; LEVELS];

        const VARIABLE: Kernel = Kernel {
            id: "test-constant-variable",
            name: "test",
            rule: Rule::Variable { levels: &CONSTANT },
        };
        const EQUIVALENT: Kernel = fixed!(
            "test-constant-fixed",
            "test",
            15.0,
            [tap!(1, 0, 7.0), tap!(-1, 1, 3.0), tap!(0, 1, 5.0)]
        );

        let (w, h) = (44usize, 36usize);
        let src = busy(w, h);
        let pal = Palette::from_srgb_rgb(builtin::GAMEBOY_DMG);
        for serpentine in [false, true] {
            let opts = Options {
                serpentine,
                ..Options::default()
            };
            let a = dither(&src, w, h, &pal, &VARIABLE, opts);
            let b = dither(&src, w, h, &pal, &EQUIVALENT, opts);
            assert_eq!(a.indices, b.indices, "serpentine {serpentine}");
        }
    }

    fn triple(w: LevelWeights) -> (u32, u32, u32) {
        (w.right, w.down_left, w.down)
    }

    /// The transcription check for F-ED-14, and the only one that could catch a
    /// mistyped digit in it.
    ///
    /// `golden.rs` pins the fixed kernels by perturbing a tap table; F-ED-14
    /// has no tap table to perturb, so it is skipped there, and a wrong digit
    /// in 128 published rows would render a picture and pass every other test
    /// in this file. What pins it instead is the paper's own construction:
    /// fifteen key levels were solved off-line and every level between them is
    /// a linear interpolation of the **normalized** coefficients. So for any
    /// non-key level, `d(i-1) + d(i+1) == 2*d(i)`, and at a key level it does
    /// not. One wrong digit breaks that in the segment it lands in.
    ///
    /// Cross-multiplied into `i128` rather than evaluated in floating point,
    /// because the claim is exact equality of rationals — in `f32` this would
    /// pass on a table that is merely close, which is precisely the table a
    /// transcription error produces.
    ///
    /// What it is worth, measured rather than hoped for: of the 762 possible
    /// off-by-one changes to a single number in the table this rejects 742, and
    /// of the 415 possible adjacent-digit transpositions it rejects 411. Every
    /// one it misses is in levels 0..=3, and for a structural reason worth
    /// knowing — 0, 1, 2, 3 and 4 are all key levels, so those rows sit in no
    /// interpolation segment and nothing here constrains them. They are four
    /// two-digit triples (`13,0,5`, `13,0,5`, `21,0,10`, `7,0,4`) on which the
    /// paper and every implementation traced during transcription agree, which
    /// is the corroboration they have instead. The other 124 rows are pinned.
    #[test]
    fn the_published_table_interpolates_linearly_between_the_papers_key_levels() {
        let sum = |w: LevelWeights| (w.right + w.down_left + w.down) as i128;
        let part = |w: LevelWeights, c: usize| match c {
            0 => w.right as i128,
            1 => w.down_left as i128,
            _ => w.down as i128,
        };

        for i in 1..PUBLISHED_HALF.len() - 1 {
            let (a, b, c) = (
                PUBLISHED_HALF[i - 1],
                PUBLISHED_HALF[i],
                PUBLISHED_HALF[i + 1],
            );
            let (sa, sb, sc) = (sum(a), sum(b), sum(c));
            let linear = (0..3)
                .all(|k| part(a, k) * sc * sb + part(c, k) * sa * sb == 2 * part(b, k) * sa * sc);
            let key = KEY_LEVELS.contains(&i);
            assert_eq!(
                linear,
                !key,
                "level {i}: the coefficients {} interpolate linearly here, but \
                 Appendix I {} highlight it as a key level — one of the two has \
                 been mistranscribed",
                if linear { "do" } else { "do not" },
                if key { "does" } else { "does not" },
            );
        }
    }

    /// Every row has to have a divisor, because the row *is* the divisor.
    /// `run_variable` panics on a row of zeroes rather than dividing by it; this
    /// is the static form of that check, and the analogue of
    /// [`fixed_tap_tables_sum_to_their_divisor`] for the variable family.
    #[test]
    fn every_published_row_carries_a_divisor() {
        for (level, w) in PUBLISHED_HALF.iter().enumerate() {
            assert!(
                w.right + w.down_left + w.down > 0,
                "published row {level} sums to zero"
            );
        }
    }

    /// The half the paper prints, and the half it only describes.
    ///
    /// Appendix I stops at 127; Step 3 extends it "symmetrically around 127.5",
    /// which is `D(i) = D(255 - i)`. The derived half is built by
    /// [`mirrored`], so this checks that the rule was applied the way the paper
    /// states it and that the transcribed half survived into the table intact.
    #[test]
    fn the_variable_table_is_mirrored_around_the_papers_midpoint() {
        let Rule::Variable { levels } = OSTROMOUKHOV.rule else {
            panic!("F-ED-14 is no longer a variable-coefficient rule");
        };

        for (i, w) in PUBLISHED_HALF.iter().enumerate() {
            assert_eq!(
                triple(levels[i]),
                triple(*w),
                "level {i} is not as published"
            );
        }
        for i in 0..LEVELS {
            let j = LEVELS - 1 - i;
            assert_eq!(
                triple(levels[i]),
                triple(levels[j]),
                "levels {i} and {j} carry different weights"
            );
        }
        // The seam. Mirroring around 127.5 rather than around 127 means the two
        // middle rows are the same row, not that 128 is skipped.
        assert_eq!(triple(levels[127]), triple(levels[128]));
        assert_eq!(triple(levels[255]), triple(PUBLISHED_HALF[0]));
    }

    /// The linear-light claim, for F-ED-14 specifically.
    ///
    /// [`every_kernel_averages_a_flat_grey_back_to_itself`] already runs this
    /// over the whole catalogue at two levels; this one exists because F-ED-14
    /// is the only kernel whose coefficients change with the input, so it is
    /// the only one where the *level* being tested chooses which rows of the
    /// table are on trial. Three levels, deliberately spread across both halves
    /// of the mirrored table.
    #[test]
    fn ostromoukhov_averages_a_flat_grey_back_to_its_own_luminance() {
        let pal = Palette::from_srgb_rgb(builtin::MONO);
        let (w, h) = (128usize, 96usize);

        for encoded in [0.25f32, 0.5, 0.75] {
            let level = srgb_to_linear(encoded);
            let src = flat(w, h, Rgba::new(level, level, level, 1.0));
            let res = dither(&src, w, h, &pal, &OSTROMOUKHOV, Options::default());
            let mean: f32 = res.pixels.iter().map(|p| p.r).sum::<f32>() / (w * h) as f32;

            assert!(
                (mean - level).abs() < 0.02,
                "at {encoded}: mean {mean} vs target {level}"
            );
            assert!(
                (mean - level).abs() < (mean - encoded).abs(),
                "at {encoded}: mean {mean} sits nearer the encoded value than the \
                 linear one {level} — this is what diffusing in sRGB looks like"
            );
        }
    }

    /// The level index has to walk the whole table as the input walks the whole
    /// range, and it has to do it through the transfer curve — a linear index
    /// would leave the bottom half of the table unreachable by most images.
    #[test]
    fn the_level_index_spans_the_table() {
        assert_eq!(level_index(Rgba::new(0.0, 0.0, 0.0, 1.0)), 0);
        assert_eq!(level_index(Rgba::new(1.0, 1.0, 1.0, 1.0)), LEVELS - 1);
        // sRGB mid-grey is linear 0.214; on the display-referred scale the
        // table is indexed on, that is the middle rung.
        let mid = level_index(Rgba::new(
            srgb_to_linear(0.5),
            srgb_to_linear(0.5),
            srgb_to_linear(0.5),
            1.0,
        ));
        assert!((127..=128).contains(&mid), "mid-grey landed on rung {mid}");
    }

    // ---- shapes and edges ---------------------------------------------------

    #[test]
    fn single_pixel_and_single_row_images_work() {
        let pal = Palette::from_srgb_rgb(builtin::MONO);
        for (w, h) in [(1usize, 1usize), (1, 9), (9, 1)] {
            let src = flat(w, h, Rgba::new(0.3, 0.3, 0.3, 1.0));
            for k in KERNELS {
                let res = dither(&src, w, h, &pal, k, Options::default());
                assert_eq!(res.indices.len(), w * h, "{} at {w}x{h}", k.id);
            }
        }
    }

    #[test]
    #[should_panic(expected = "buffer does not match dimensions")]
    fn a_mismatched_buffer_panics_rather_than_reading_past_the_end() {
        let pal = Palette::from_srgb_rgb(builtin::MONO);
        let src = flat(4, 4, Rgba::new(0.5, 0.5, 0.5, 1.0));
        dither(&src, 5, 4, &pal, &FLOYD_STEINBERG, Options::default());
    }
}
