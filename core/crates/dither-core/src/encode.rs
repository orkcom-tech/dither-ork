//! Animated container encoding — GIF (F-EX-04).
//!
//! Frames in, bytes out. Nothing here knows a browser exists, in keeping with
//! the rule the whole crate follows; the web layer hands over index maps and a
//! palette and receives a finished file.
//!
//! ## Why GIF is here and the other animated formats are not
//!
//! This module is deliberately *only* GIF, and the reason is the same argument
//! `web/src/export/zlib.ts` already records for still PNG: **there is no
//! compressor in this repository and there should not be.** APNG and the PNG
//! sequence are deflate, and every target platform ships a native deflate that
//! is faster than anything written here and has no way to be less correct. A
//! Rust APNG writer would therefore have had to bring its own deflate — this
//! crate has zero production dependencies on purpose — and would have been a
//! second copy of the chunk writer and the CRC that `web/src/export/png.ts` and
//! `web/src/export/crc32.ts` already hold.
//!
//! GIF is the opposite case and that is what earns it a place in the core.
//! LZW with a variable code width is not deflate, no platform exposes it, and
//! it is a strictly serial dictionary loop over `frames x width x height`
//! bytes — the exact shape of work this crate exists for.
//!
//! ## The palette is used, never chosen
//!
//! F-EX-04's requirement is that the document palette becomes the global colour
//! table *directly*, with no second quantization. Nothing in this file looks at
//! a colour: it is handed one index per pixel and a table of triplets, and it
//! writes both out. A GIF produced here therefore cannot be a dither of a
//! dither, because there is no code path in which it could quantize anything.
//!
//! ## Size, honestly
//!
//! LZW builds its dictionary out of repeated byte runs, and a dither is the
//! pathological input for that: high entropy, few runs, a dictionary that fills
//! with entries used once. `docs/ARCHITECTURE.md` lists it among the known
//! risks. [`GifReport`] therefore carries the real byte count so the caller can
//! state a measured number rather than a modelled one.
//!
//! Two things are done about it here, and both are ordinary GIF, not tricks:
//!
//! - **The smallest legal code width.** A four-colour picture is written with a
//!   2-bit minimum code size and a four-entry colour table, so its codes start
//!   at three bits rather than nine.
//! - **Frames are cropped to what changed.** A frame that differs from its
//!   predecessor in one corner is written as that corner, with disposal method
//!   1 (leave the previous frame in place). For a full-frame dither this saves
//!   nothing — every pixel moves — and for a document where one node animates
//!   over a still background it saves most of the file.
//!
//! Cropping is disabled whenever the animation has a transparent index, and
//! that is a correctness rule rather than a tuning choice: a partial frame
//! cannot *remove* a pixel that the frame before it drew, so an animation whose
//! transparency moves would smear. Those animations get full frames with
//! disposal method 2 (restore to background) instead.

use std::fmt;

/// The largest colour table GIF can address. The format's index is one byte.
pub const MAX_GIF_COLORS: usize = 256;

/// Ceiling on the index maps one encoder will hold before it refuses.
///
/// The frames are buffered because the global colour table is written *before*
/// them and its size decides the LZW code width, so nothing can be compressed
/// until the last frame's colours are known. 512 MiB is far more than any loop
/// this application can render — a 60-frame 4K loop is 500 MB of index map —
/// and refusing above it names the ceiling instead of failing an allocation.
pub const MAX_BUFFERED_BYTES: usize = 512 << 20;

/// Largest code the format allows. Codes are 12 bits, and 4095 is reserved as
/// the point at which the dictionary is cleared rather than being handed out.
const LZ_MAX_CODE: u16 = 4095;

/// Slots in the encoder's hash table. A power of two above `LZ_MAX_CODE` so
/// linear probing always terminates on an empty slot.
const HASH_SLOTS: usize = 8192;

/// No entry. Unambiguous because a stored entry packs a 20-bit key and a code
/// below 4095, so the all-ones word cannot be produced by an insertion.
const HASH_EMPTY: u32 = u32::MAX;

/// Every way encoding can refuse, with the numbers that caused it.
///
/// A `Result` rather than a panic because every one of these is a caller
/// mistake that the layer above can report to a person: the wasm boundary turns
/// them into a rejected promise instead of an aborted instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EncodeError {
    /// A dimension was zero, or the two together overflow the format's u16.
    BadExtent { width: usize, height: usize },
    /// A frame's index map was not `width * height` bytes.
    BadFrameLength { expected: usize, got: usize },
    /// The palette was empty, not a multiple of three, or above 256 entries.
    BadPalette { entries: usize },
    /// A pixel names a palette entry that does not exist.
    IndexOutOfRange { index: u8, entries: usize },
    /// The transparent index names a palette entry that does not exist.
    TransparentOutOfRange { index: u8, entries: usize },
    /// No frames were pushed.
    NoFrames,
    /// The buffered index maps went past [`MAX_BUFFERED_BYTES`].
    TooManyBytes { bytes: usize, limit: usize },
}

impl fmt::Display for EncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadExtent { width, height } => write!(
                f,
                "a GIF cannot be {width}x{height}; both must be between 1 and 65535"
            ),
            Self::BadFrameLength { expected, got } => write!(
                f,
                "a frame's index map is {got} bytes, and this animation's frames are {expected}"
            ),
            Self::BadPalette { entries } => write!(
                f,
                "a GIF colour table holds 1 to {MAX_GIF_COLORS} entries; this one has {entries}"
            ),
            Self::IndexOutOfRange { index, entries } => write!(
                f,
                "a pixel names palette entry {index}, and the palette has {entries}"
            ),
            Self::TransparentOutOfRange { index, entries } => write!(
                f,
                "the transparent index is {index}, and the palette has {entries} entries"
            ),
            Self::NoFrames => write!(f, "an animated GIF needs at least one frame"),
            Self::TooManyBytes { bytes, limit } => write!(
                f,
                "these frames come to {bytes} bytes of index map, past the {limit} this encoder \
                 will hold; export fewer frames or a smaller loop"
            ),
        }
    }
}

impl std::error::Error for EncodeError {}

/// How a frame is cleaned up before the next one is drawn.
///
/// Only the two values this encoder emits are named. `0` (unspecified) is what
/// a writer emits when it has not thought about the question, and every frame
/// here has an answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Disposal {
    /// Leave the frame in place. What a cropped frame is drawn on top of.
    Keep = 1,
    /// Restore the background before the next frame. Required when transparency
    /// moves, because otherwise a pixel that stops being drawn keeps its old
    /// colour forever.
    Background = 2,
}

/// Everything about the animation that is not its pixels.
#[derive(Clone, Copy, Debug)]
pub struct GifOptions {
    /// Frame delay in hundredths of a second — the only unit the format has.
    ///
    /// The caller converts from `fps` and is the one that must report what the
    /// rounding cost, because only it knows what `fps` was asked for.
    pub delay_centiseconds: u16,
    /// `true` writes the NETSCAPE2.0 extension with a loop count of zero.
    /// `false` omits it, which plays the animation exactly once.
    pub loop_forever: bool,
    /// The one palette entry GIF can draw as nothing, if any.
    pub transparent_index: Option<u8>,
}

impl Default for GifOptions {
    fn default() -> Self {
        Self {
            // 10 centiseconds — 10 fps. A default rather than a guess: it is the
            // value every decoder substitutes for a delay it will not honour, so
            // it is the one delay guaranteed to play the same everywhere.
            delay_centiseconds: 10,
            loop_forever: true,
            transparent_index: None,
        }
    }
}

/// What encoding actually did. Measured, because nothing about GIF's size is
/// predictable from the picture's dimensions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GifReport {
    pub frames: usize,
    pub width: usize,
    pub height: usize,
    /// Bytes of finished file.
    pub bytes: usize,
    /// Entries the caller supplied.
    pub palette_entries: usize,
    /// Entries actually written — the palette padded up to a power of two.
    pub table_entries: usize,
    /// LZW minimum code size, which is the colour table's bit depth.
    pub min_code_size: u8,
    /// Frames written as a sub-rectangle rather than in full.
    pub cropped_frames: usize,
    /// Pixels written across every frame, after cropping. The honest input to a
    /// bytes-per-pixel number.
    pub pixels_written: u64,
    /// True when a transparent index was declared.
    pub transparent: bool,
}

/// A finished file and what producing it did.
#[derive(Clone, Debug)]
pub struct EncodedGif {
    pub bytes: Vec<u8>,
    pub report: GifReport,
}

/// Accumulates index maps, then writes one GIF.
///
/// Stateful rather than a single call taking every frame at once, because the
/// caller renders frames one at a time and a flat `frames * width * height`
/// buffer on its side as well as this one would double the peak. Each
/// [`push`](Self::push) copies one frame in and the caller's buffer is free
/// again immediately.
///
/// `Debug` prints the extent and the frame count and never the index maps: a
/// formatted dump of a hundred megabytes of pixels in a test failure is a test
/// failure nobody can read.
pub struct GifEncoder {
    width: usize,
    height: usize,
    budget: usize,
    frames: Vec<Vec<u8>>,
}

impl fmt::Debug for GifEncoder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GifEncoder")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("frames", &self.frames.len())
            .finish()
    }
}

impl GifEncoder {
    /// Refuses an extent the format cannot describe, before anything is
    /// buffered against it.
    pub fn new(width: usize, height: usize) -> Result<Self, EncodeError> {
        Self::with_budget(width, height, MAX_BUFFERED_BYTES)
    }

    /// The same, with a lower ceiling on buffered index maps.
    ///
    /// It exists because [`MAX_BUFFERED_BYTES`] is half a gigabyte, and a guard
    /// that can only be exercised by allocating half a gigabyte is a guard
    /// nobody has ever run. The caller may also legitimately want a smaller one
    /// — a browser tab has a budget of its own and would rather refuse an export
    /// than be killed by the allocator.
    pub fn with_budget(
        width: usize,
        height: usize,
        max_buffered_bytes: usize,
    ) -> Result<Self, EncodeError> {
        if width == 0 || height == 0 || width > u16::MAX as usize || height > u16::MAX as usize {
            return Err(EncodeError::BadExtent { width, height });
        }
        Ok(Self {
            width,
            height,
            budget: max_buffered_bytes,
            frames: Vec::new(),
        })
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }

    /// Bytes of index map held. The caller logs it; the ceiling is enforced by
    /// [`push`](Self::push).
    pub fn buffered_bytes(&self) -> usize {
        self.frames.len() * self.width * self.height
    }

    /// Add one frame, in playback order.
    pub fn push(&mut self, indices: &[u8]) -> Result<(), EncodeError> {
        let expected = self.width * self.height;
        if indices.len() != expected {
            return Err(EncodeError::BadFrameLength {
                expected,
                got: indices.len(),
            });
        }
        let after = self.buffered_bytes() + expected;
        if after > self.budget {
            return Err(EncodeError::TooManyBytes {
                bytes: after,
                limit: self.budget,
            });
        }
        self.frames.push(indices.to_vec());
        Ok(())
    }

    /// Write the file.
    ///
    /// `palette_rgb` is packed 8-bit sRGB triplets — the layout every other
    /// boundary in this crate already takes, so a palette that came out of
    /// extraction goes straight in.
    pub fn finish(
        &self,
        palette_rgb: &[u8],
        options: GifOptions,
    ) -> Result<EncodedGif, EncodeError> {
        if self.frames.is_empty() {
            return Err(EncodeError::NoFrames);
        }
        if palette_rgb.is_empty() || !palette_rgb.len().is_multiple_of(3) {
            return Err(EncodeError::BadPalette {
                entries: palette_rgb.len(),
            });
        }
        let entries = palette_rgb.len() / 3;
        if entries > MAX_GIF_COLORS {
            return Err(EncodeError::BadPalette { entries });
        }
        if let Some(index) = options.transparent_index {
            if usize::from(index) >= entries {
                return Err(EncodeError::TransparentOutOfRange { index, entries });
            }
        }
        // One sweep over every frame before a byte is written, so an index that
        // names no colour is reported with the value that caused it rather than
        // producing a file that draws a colour nobody chose.
        for frame in &self.frames {
            if let Some(&worst) = frame.iter().max() {
                if usize::from(worst) >= entries {
                    return Err(EncodeError::IndexOutOfRange {
                        index: worst,
                        entries,
                    });
                }
            }
        }

        // The table is padded up to a power of two: the format stores its size
        // as an exponent, so 5 colours occupy 8 slots and the three spare ones
        // are black. `bits` is both the size field (minus one) and the LZW
        // minimum code size.
        let bits = table_bits(entries);
        let table_entries = 1usize << bits;

        let transparent = options.transparent_index;
        // See the module note: a cropped frame can draw over its predecessor
        // but cannot erase it, so transparency and cropping are exclusive.
        let crop = transparent.is_none();
        let disposal = if transparent.is_some() {
            Disposal::Background
        } else {
            Disposal::Keep
        };

        let mut out = Vec::with_capacity(self.width * self.height + 1024);
        out.extend_from_slice(b"GIF89a");

        // Logical screen descriptor.
        push_u16(&mut out, self.width as u16);
        push_u16(&mut out, self.height as u16);
        // Global colour table present, colour resolution = the table's depth,
        // not sorted, table size exponent.
        out.push(0x80 | (((bits - 1) as u8) << 4) | ((bits - 1) as u8));
        // Background colour index. The transparent entry when there is one, so a
        // decoder that honours the field clears to nothing rather than to a
        // colour the picture never contained.
        out.push(transparent.unwrap_or(0));
        // Pixel aspect ratio: 0 means "not specified", which is square.
        out.push(0);

        out.extend_from_slice(palette_rgb);
        // Padding entries. Black rather than a repeat of entry 0, so a file read
        // by something that ignores the palette length shows the fault.
        out.resize(out.len() + (table_entries - entries) * 3, 0);

        if options.loop_forever {
            // NETSCAPE2.0 application extension. Written for a single frame too:
            // the loop count is a property of the document, and a one-frame
            // animation that a person later extends should not change meaning.
            out.extend_from_slice(&[0x21, 0xFF, 0x0B]);
            out.extend_from_slice(b"NETSCAPE2.0");
            out.extend_from_slice(&[0x03, 0x01, 0x00, 0x00, 0x00]);
        }

        let mut lzw = Lzw::new(bits as u32);
        let mut cropped_frames = 0usize;
        let mut pixels_written = 0u64;
        let mut scratch: Vec<u8> = Vec::new();

        for (index, frame) in self.frames.iter().enumerate() {
            let previous = if index == 0 || !crop {
                None
            } else {
                self.frames.get(index - 1).map(Vec::as_slice)
            };
            let rect = match previous {
                None => Rect {
                    left: 0,
                    top: 0,
                    width: self.width,
                    height: self.height,
                },
                Some(previous) => changed_rect(previous, frame, self.width, self.height),
            };
            if rect.width != self.width || rect.height != self.height {
                cropped_frames += 1;
            }
            pixels_written += (rect.width as u64) * (rect.height as u64);

            // Graphic control extension: disposal, no user input, transparency,
            // and the delay.
            let packed = ((disposal as u8) << 2) | u8::from(transparent.is_some());
            out.extend_from_slice(&[0x21, 0xF9, 0x04, packed]);
            push_u16(&mut out, options.delay_centiseconds);
            out.push(transparent.unwrap_or(0));
            out.push(0x00);

            // Image descriptor. No local colour table, not interlaced.
            out.push(0x2C);
            push_u16(&mut out, rect.left as u16);
            push_u16(&mut out, rect.top as u16);
            push_u16(&mut out, rect.width as u16);
            push_u16(&mut out, rect.height as u16);
            out.push(0x00);

            out.push(bits as u8);
            let pixels = if rect.width == self.width && rect.height == self.height {
                frame.as_slice()
            } else {
                scratch.clear();
                scratch.reserve(rect.width * rect.height);
                for row in rect.top..rect.top + rect.height {
                    let start = row * self.width + rect.left;
                    scratch.extend_from_slice(&frame[start..start + rect.width]);
                }
                scratch.as_slice()
            };
            lzw.compress(pixels, &mut out);
        }

        out.push(0x3B);

        Ok(EncodedGif {
            report: GifReport {
                frames: self.frames.len(),
                width: self.width,
                height: self.height,
                bytes: out.len(),
                palette_entries: entries,
                table_entries,
                min_code_size: bits as u8,
                cropped_frames,
                pixels_written,
                transparent: transparent.is_some(),
            },
            bytes: out,
        })
    }
}

/// The colour table's bit depth: the smallest power of two that holds `entries`,
/// never below 2 because the format's minimum code size is 2.
fn table_bits(entries: usize) -> usize {
    let mut bits = 2usize;
    while (1usize << bits) < entries {
        bits += 1;
    }
    bits
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.push((value & 0xFF) as u8);
    out.push((value >> 8) as u8);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    left: usize,
    top: usize,
    width: usize,
    height: usize,
}

/// The smallest rectangle covering every pixel that differs.
///
/// Two identical frames produce a 1x1 rectangle rather than an empty one: GIF
/// has no zero-size image, and one redundant pixel is cheaper than the special
/// case a skipped frame would need in the delay accounting.
fn changed_rect(previous: &[u8], current: &[u8], width: usize, height: usize) -> Rect {
    let mut left = width;
    let mut right = 0usize;
    let mut top = height;
    let mut bottom = 0usize;

    for y in 0..height {
        let row = y * width;
        let a = &previous[row..row + width];
        let b = &current[row..row + width];
        let Some(first) = a.iter().zip(b).position(|(p, c)| p != c) else {
            continue;
        };
        let last = width
            - 1
            - a.iter()
                .zip(b)
                .rev()
                .position(|(p, c)| p != c)
                .unwrap_or(width - 1);
        if first < left {
            left = first;
        }
        if last > right {
            right = last;
        }
        if y < top {
            top = y;
        }
        bottom = y;
    }

    if left > right {
        return Rect {
            left: 0,
            top: 0,
            width: 1,
            height: 1,
        };
    }
    Rect {
        left,
        top,
        width: right - left + 1,
        height: bottom - top + 1,
    }
}

/// GIF's variable-width LZW, with the format's sub-block framing.
///
/// Transcribed from the encoder in the format specification's appendix as it is
/// realised in giflib, and the one detail that matters is *when the code width
/// grows*. The decoder learns a dictionary entry one code later than the
/// encoder assigns it, so an encoder that widens as soon as it inserts the
/// entry that fills the range is one bit ahead of its reader for exactly one
/// code — a file that decodes correctly for a few hundred pixels and then turns
/// to noise. The check therefore sits at the *end* of a code being written and
/// reads the counter as it was before that code's insertion, which is what puts
/// the two in step.
struct Lzw {
    min_code_size: u32,
    clear_code: u16,
    eof_code: u16,
    next_code: u16,
    code_width: u32,
    max_code: u32,
    acc: u32,
    bits: u32,
    block: Vec<u8>,
    table: Vec<u32>,
}

impl Lzw {
    fn new(min_code_size: u32) -> Self {
        let clear_code = 1u16 << min_code_size;
        Self {
            min_code_size,
            clear_code,
            eof_code: clear_code + 1,
            next_code: clear_code + 2,
            code_width: min_code_size + 1,
            max_code: 1u32 << (min_code_size + 1),
            acc: 0,
            bits: 0,
            block: Vec::with_capacity(255),
            table: vec![HASH_EMPTY; HASH_SLOTS],
        }
    }

    fn reset(&mut self) {
        self.next_code = self.clear_code + 2;
        self.code_width = self.min_code_size + 1;
        self.max_code = 1u32 << self.code_width;
        for slot in &mut self.table {
            *slot = HASH_EMPTY;
        }
    }

    /// Compress one image's pixels and append the framed result to `out`.
    ///
    /// The dictionary is reset per image, which the format requires — every
    /// image carries its own clear code — and is also why a per-frame size is a
    /// sound basis for extrapolating a whole animation's.
    fn compress(&mut self, data: &[u8], out: &mut Vec<u8>) {
        self.reset();
        self.acc = 0;
        self.bits = 0;
        self.block.clear();

        let clear = self.clear_code;
        let eof = self.eof_code;
        self.write_code(clear, out);

        let mut iter = data.iter().copied();
        let Some(first) = iter.next() else {
            self.write_code(eof, out);
            self.flush(out);
            return;
        };

        let mut prefix = u16::from(first);
        for byte in iter {
            let key = (u32::from(prefix) << 8) | u32::from(byte);
            if let Some(code) = self.lookup(key) {
                prefix = code;
                continue;
            }
            self.write_code(prefix, out);
            if self.next_code >= LZ_MAX_CODE {
                self.write_code(clear, out);
                self.reset();
            } else {
                self.insert(key, self.next_code);
                self.next_code += 1;
            }
            prefix = u16::from(byte);
        }

        self.write_code(prefix, out);
        self.write_code(eof, out);
        self.flush(out);
    }

    fn lookup(&self, key: u32) -> Option<u16> {
        let mut slot = hash_slot(key);
        loop {
            let entry = self.table[slot];
            if entry == HASH_EMPTY {
                return None;
            }
            if (entry >> 12) == key {
                return Some((entry & 0x0FFF) as u16);
            }
            slot = (slot + 1) & (HASH_SLOTS - 1);
        }
    }

    fn insert(&mut self, key: u32, code: u16) {
        let mut slot = hash_slot(key);
        while self.table[slot] != HASH_EMPTY {
            slot = (slot + 1) & (HASH_SLOTS - 1);
        }
        self.table[slot] = (key << 12) | u32::from(code);
    }

    fn write_code(&mut self, code: u16, out: &mut Vec<u8>) {
        // GIF packs codes least-significant bit first, spanning byte
        // boundaries. Up to 7 held bits plus a 12-bit code fits a u32.
        self.acc |= u32::from(code) << self.bits;
        self.bits += self.code_width;
        while self.bits >= 8 {
            self.push_byte((self.acc & 0xFF) as u8, out);
            self.acc >>= 8;
            self.bits -= 8;
        }
        // See the type's note: read after writing, before this code's insertion
        // is accounted for.
        while u32::from(self.next_code) >= self.max_code && self.max_code < u32::from(LZ_MAX_CODE) {
            self.max_code <<= 1;
            self.code_width += 1;
        }
    }

    fn flush(&mut self, out: &mut Vec<u8>) {
        if self.bits > 0 {
            self.push_byte((self.acc & 0xFF) as u8, out);
            self.acc = 0;
            self.bits = 0;
        }
        if !self.block.is_empty() {
            out.push(self.block.len() as u8);
            out.extend_from_slice(&self.block);
            self.block.clear();
        }
        // The block terminator. Its absence is the single most common way a
        // hand-written GIF is rejected.
        out.push(0);
    }

    fn push_byte(&mut self, byte: u8, out: &mut Vec<u8>) {
        self.block.push(byte);
        if self.block.len() == 255 {
            out.push(255);
            out.extend_from_slice(&self.block);
            self.block.clear();
        }
    }
}

/// giblib's hash: fold the prefix down onto the byte so that two keys sharing a
/// prefix do not collide in a run. The table is twice `LZ_MAX_CODE`, so linear
/// probing always finds a free slot.
fn hash_slot(key: u32) -> usize {
    (((key >> 12) ^ key) & 0x1FFF) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- a decoder, written against the specification --------------------
    //
    // The encoder is checked by reading its output back the way a viewer would
    // rather than by asserting on byte offsets, for the reason
    // `web/src/export/png.test.ts` gives about PNG: a header assertion passes a
    // file whose LZW widens one code early, and that file is structurally valid
    // and shows noise. Composing the decoded frames also proves the cropping and
    // the disposal, which nothing about the bytes alone can.

    struct Reader<'a> {
        bytes: &'a [u8],
        at: usize,
    }

    impl<'a> Reader<'a> {
        fn u8(&mut self) -> u8 {
            let value = self.bytes[self.at];
            self.at += 1;
            value
        }

        fn u16(&mut self) -> u16 {
            let value = u16::from(self.bytes[self.at]) | (u16::from(self.bytes[self.at + 1]) << 8);
            self.at += 2;
            value
        }

        fn take(&mut self, count: usize) -> &'a [u8] {
            let slice = &self.bytes[self.at..self.at + count];
            self.at += count;
            slice
        }

        /// Concatenate a chain of sub-blocks up to the zero-length terminator.
        fn blocks(&mut self) -> Vec<u8> {
            let mut out = Vec::new();
            loop {
                let len = self.u8() as usize;
                if len == 0 {
                    return out;
                }
                out.extend_from_slice(self.take(len));
            }
        }
    }

    #[derive(Debug)]
    struct DecodedFrame {
        left: usize,
        top: usize,
        width: usize,
        height: usize,
        delay: u16,
        disposal: u8,
        transparent: Option<u8>,
        pixels: Vec<u8>,
    }

    #[derive(Debug)]
    struct DecodedGif {
        width: usize,
        height: usize,
        palette: Vec<u8>,
        table_entries: usize,
        min_code_size: u8,
        loops: bool,
        frames: Vec<DecodedFrame>,
    }

    fn decode(bytes: &[u8]) -> DecodedGif {
        let mut r = Reader { bytes, at: 0 };
        assert_eq!(r.take(6), b"GIF89a");
        let width = r.u16() as usize;
        let height = r.u16() as usize;
        let packed = r.u8();
        assert_eq!(
            packed & 0x80,
            0x80,
            "a global colour table is required here"
        );
        let table_entries = 1usize << ((packed & 0x07) + 1);
        let _background = r.u8();
        let _aspect = r.u8();
        let palette = r.take(table_entries * 3).to_vec();

        let mut loops = false;
        let mut frames = Vec::new();
        let mut pending: Option<(u16, u8, Option<u8>)> = None;
        let mut min_code_size = 0u8;

        loop {
            match r.u8() {
                0x3B => break,
                0x21 => {
                    let label = r.u8();
                    if label == 0xF9 {
                        assert_eq!(r.u8(), 4);
                        let flags = r.u8();
                        let delay = r.u16();
                        let index = r.u8();
                        assert_eq!(r.u8(), 0);
                        let transparent = if flags & 1 == 1 { Some(index) } else { None };
                        pending = Some((delay, (flags >> 2) & 0x07, transparent));
                    } else if label == 0xFF {
                        let len = r.u8() as usize;
                        let name = r.take(len).to_vec();
                        let payload = r.blocks();
                        if name == b"NETSCAPE2.0" {
                            assert_eq!(payload, vec![0x01, 0x00, 0x00]);
                            loops = true;
                        }
                    } else {
                        r.blocks();
                    }
                }
                0x2C => {
                    let left = r.u16() as usize;
                    let top = r.u16() as usize;
                    let w = r.u16() as usize;
                    let h = r.u16() as usize;
                    let flags = r.u8();
                    assert_eq!(flags & 0x80, 0, "no local colour table is written");
                    assert_eq!(flags & 0x40, 0, "nothing here is interlaced");
                    min_code_size = r.u8();
                    let data = r.blocks();
                    let pixels = decompress(&data, min_code_size, w * h);
                    let (delay, disposal, transparent) =
                        pending.take().expect("no GCE before image");
                    frames.push(DecodedFrame {
                        left,
                        top,
                        width: w,
                        height: h,
                        delay,
                        disposal,
                        transparent,
                        pixels,
                    });
                }
                other => panic!("unexpected block 0x{other:02X} at {}", r.at - 1),
            }
        }

        DecodedGif {
            width,
            height,
            palette,
            table_entries,
            min_code_size,
            loops,
            frames,
        }
    }

    /// The decoder half of the algorithm, written independently of the encoder
    /// so that a shared misunderstanding cannot cancel out.
    fn decompress(data: &[u8], min_code_size: u8, expected: usize) -> Vec<u8> {
        let clear = 1u16 << min_code_size;
        let eof = clear + 1;

        let mut dictionary: Vec<Vec<u8>> = Vec::new();
        let reset = |dictionary: &mut Vec<Vec<u8>>| {
            dictionary.clear();
            for value in 0..clear {
                dictionary.push(vec![value as u8]);
            }
            dictionary.push(Vec::new()); // clear
            dictionary.push(Vec::new()); // eof
        };
        reset(&mut dictionary);

        let mut width = u32::from(min_code_size) + 1;
        let mut out = Vec::with_capacity(expected);
        let mut previous: Option<u16> = None;

        let mut acc = 0u32;
        let mut bits = 0u32;
        let mut at = 0usize;

        loop {
            while bits < width {
                if at >= data.len() {
                    return out;
                }
                acc |= u32::from(data[at]) << bits;
                at += 1;
                bits += 8;
            }
            let code = (acc & ((1u32 << width) - 1)) as u16;
            acc >>= width;
            bits -= width;

            if code == clear {
                reset(&mut dictionary);
                width = u32::from(min_code_size) + 1;
                previous = None;
                continue;
            }
            if code == eof {
                return out;
            }

            let entry = if usize::from(code) < dictionary.len() {
                dictionary[usize::from(code)].clone()
            } else {
                // The KwKwK case: a code emitted for a dictionary entry the
                // decoder has not built yet, which is legal and is exactly where
                // a naive decoder breaks.
                let prev = previous.expect("first code cannot be deferred");
                let mut entry = dictionary[usize::from(prev)].clone();
                entry.push(dictionary[usize::from(prev)][0]);
                entry
            };
            out.extend_from_slice(&entry);

            if let Some(prev) = previous {
                let mut next = dictionary[usize::from(prev)].clone();
                next.push(entry[0]);
                if dictionary.len() < usize::from(LZ_MAX_CODE) {
                    dictionary.push(next);
                }
            }
            previous = Some(code);

            if dictionary.len() >= (1usize << width) && width < 12 {
                width += 1;
            }
        }
    }

    /// Compose the decoded frames the way a viewer would, so that a cropped
    /// frame drawn over its predecessor is checked as the picture it produces
    /// rather than as the rectangle it stored.
    fn compose(gif: &DecodedGif) -> Vec<Vec<u8>> {
        let mut canvas = vec![0u8; gif.width * gif.height];
        let mut out = Vec::new();
        // A frame's disposal is applied *after* it has been shown, so it is the
        // previous frame's method that decides what this one draws onto. Getting
        // that backwards is the classic composer bug and it hides exactly the
        // defect this test is here to catch.
        let mut pending_clear: Option<u8> = None;
        for frame in &gif.frames {
            if let Some(background) = pending_clear.take() {
                canvas.fill(background);
            }
            if frame.disposal == 2 {
                pending_clear = Some(frame.transparent.unwrap_or(0));
            }
            for y in 0..frame.height {
                for x in 0..frame.width {
                    let value = frame.pixels[y * frame.width + x];
                    if frame.transparent == Some(value) {
                        continue;
                    }
                    canvas[(frame.top + y) * gif.width + frame.left + x] = value;
                }
            }
            out.push(canvas.clone());
        }
        out
    }

    // --- fixtures ---------------------------------------------------------

    /// A deterministic pseudo-random field, which is what a dither looks like to
    /// LZW and therefore the input that exercises dictionary growth and the
    /// clear code rather than a picture of flat runs.
    fn noise(width: usize, height: usize, entries: usize, seed: u64) -> Vec<u8> {
        let mut state = seed | 1;
        (0..width * height)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((state >> 33) % entries as u64) as u8
            })
            .collect()
    }

    fn palette(entries: usize) -> Vec<u8> {
        (0..entries)
            .flat_map(|i| {
                let v = (i * 255 / entries.max(1)) as u8;
                [v, v.wrapping_add(40), v.wrapping_add(80)]
            })
            .collect()
    }

    // --- tests ------------------------------------------------------------

    #[test]
    fn one_flat_frame_round_trips() {
        let mut encoder = GifEncoder::new(8, 4).unwrap();
        encoder.push(&[3u8; 32]).unwrap();
        let encoded = encoder.finish(&palette(4), GifOptions::default()).unwrap();

        let gif = decode(&encoded.bytes);
        assert_eq!((gif.width, gif.height), (8, 4));
        assert_eq!(gif.frames.len(), 1);
        assert_eq!(gif.frames[0].pixels, vec![3u8; 32]);
        assert_eq!(gif.min_code_size, 2);
        assert_eq!(gif.table_entries, 4);
        assert!(gif.loops);
    }

    #[test]
    fn noise_round_trips_at_every_palette_size() {
        // 2, 4, 16 and 256 are the four bit depths the format has, and each is a
        // different LZW minimum code size. A width bug shows up in one and not
        // the others, so all four are checked.
        for entries in [2usize, 4, 16, 256] {
            let (w, h) = (61, 37); // deliberately not a multiple of anything
            let frame = noise(w, h, entries, 0x9E37 + entries as u64);
            let mut encoder = GifEncoder::new(w, h).unwrap();
            encoder.push(&frame).unwrap();
            let encoded = encoder
                .finish(&palette(entries), GifOptions::default())
                .unwrap();

            let gif = decode(&encoded.bytes);
            assert_eq!(gif.frames.len(), 1, "{entries}");
            assert_eq!(
                gif.frames[0].pixels, frame,
                "{entries} colours did not survive"
            );
            assert_eq!(
                usize::from(gif.min_code_size),
                table_bits(entries),
                "{entries}"
            );
        }
    }

    #[test]
    fn a_frame_larger_than_the_dictionary_round_trips() {
        // 4096 codes is the whole dictionary, so this frame forces at least one
        // mid-image clear — the path where the code width has to fall back to
        // its minimum in step with a decoder that has not seen the reset yet.
        let (w, h) = (256, 256);
        let frame = noise(w, h, 64, 0xC0FFEE);
        let mut encoder = GifEncoder::new(w, h).unwrap();
        encoder.push(&frame).unwrap();
        let encoded = encoder.finish(&palette(64), GifOptions::default()).unwrap();

        let gif = decode(&encoded.bytes);
        assert_eq!(gif.frames[0].pixels, frame);
    }

    #[test]
    fn frames_are_cropped_to_what_changed_and_still_compose() {
        let (w, h) = (16, 16);
        let mut first = vec![1u8; w * h];
        let mut second = first.clone();
        // A 3x2 patch in the middle, and nothing else.
        for y in 7..9 {
            for x in 5..8 {
                second[y * w + x] = 2;
            }
        }
        let mut third = second.clone();
        third[0] = 3;
        first[0] = 1;

        let mut encoder = GifEncoder::new(w, h).unwrap();
        encoder.push(&first).unwrap();
        encoder.push(&second).unwrap();
        encoder.push(&third).unwrap();
        let encoded = encoder.finish(&palette(4), GifOptions::default()).unwrap();

        let gif = decode(&encoded.bytes);
        assert_eq!(gif.frames[0].width, w, "the first frame is always full");
        assert_eq!(
            (
                gif.frames[1].left,
                gif.frames[1].top,
                gif.frames[1].width,
                gif.frames[1].height
            ),
            (5, 7, 3, 2),
        );
        assert_eq!(
            (
                gif.frames[2].left,
                gif.frames[2].top,
                gif.frames[2].width,
                gif.frames[2].height
            ),
            (0, 0, 1, 1),
        );
        for frame in &gif.frames {
            assert_eq!(frame.disposal, 1, "cropping needs the previous frame kept");
        }

        let composed = compose(&gif);
        assert_eq!(composed[0], first);
        assert_eq!(composed[1], second);
        assert_eq!(composed[2], third);
        assert_eq!(encoded.report.cropped_frames, 2);
    }

    #[test]
    fn identical_frames_still_produce_a_legal_image() {
        let frame = vec![2u8; 64];
        let mut encoder = GifEncoder::new(8, 8).unwrap();
        encoder.push(&frame).unwrap();
        encoder.push(&frame).unwrap();
        let encoded = encoder.finish(&palette(4), GifOptions::default()).unwrap();

        let gif = decode(&encoded.bytes);
        assert_eq!((gif.frames[1].width, gif.frames[1].height), (1, 1));
        assert_eq!(compose(&gif)[1], frame);
    }

    #[test]
    fn transparency_disables_cropping_and_restores_the_background() {
        let (w, h) = (8, 8);
        let mut first = vec![1u8; w * h];
        first[0] = 0;
        let mut second = vec![1u8; w * h];
        second[63] = 0;

        let mut encoder = GifEncoder::new(w, h).unwrap();
        encoder.push(&first).unwrap();
        encoder.push(&second).unwrap();
        let encoded = encoder
            .finish(
                &palette(4),
                GifOptions {
                    transparent_index: Some(0),
                    ..GifOptions::default()
                },
            )
            .unwrap();

        let gif = decode(&encoded.bytes);
        for frame in &gif.frames {
            assert_eq!(frame.transparent, Some(0));
            assert_eq!(frame.disposal, 2);
            assert_eq!(
                (frame.width, frame.height),
                (w, h),
                "no cropping with transparency"
            );
        }
        let composed = compose(&gif);
        // Pixel 0 is transparent in frame 0 and opaque in frame 1; pixel 63 is
        // the other way round. The second is the one that matters: without
        // disposal 2 it would still be showing frame 0's colour, because a
        // transparent pixel draws nothing rather than drawing nothing *over*
        // something.
        assert_eq!(composed[0][0], 0);
        assert_eq!(composed[0][63], 1);
        assert_eq!(composed[1][0], 1);
        assert_eq!(composed[1][63], 0);
        assert!(encoded.report.transparent);
        assert_eq!(encoded.report.cropped_frames, 0);
    }

    #[test]
    fn the_palette_is_written_verbatim_and_padded_with_black() {
        // Five entries occupy an eight-slot table. The five that were given must
        // come back byte for byte — F-EX-04's "used directly" is exactly this.
        let given: Vec<u8> = vec![
            10, 20, 30, //
            40, 50, 60, //
            70, 80, 90, //
            100, 110, 120, //
            130, 140, 150,
        ];
        let mut encoder = GifEncoder::new(4, 4).unwrap();
        encoder.push(&[4u8; 16]).unwrap();
        let encoded = encoder.finish(&given, GifOptions::default()).unwrap();

        let gif = decode(&encoded.bytes);
        assert_eq!(gif.table_entries, 8);
        assert_eq!(&gif.palette[..15], &given[..]);
        assert_eq!(&gif.palette[15..], &[0u8; 9]);
        assert_eq!(encoded.report.palette_entries, 5);
        assert_eq!(encoded.report.table_entries, 8);
    }

    #[test]
    fn the_delay_and_the_loop_flag_are_what_was_asked_for() {
        let mut encoder = GifEncoder::new(4, 4).unwrap();
        encoder.push(&[0u8; 16]).unwrap();
        encoder.push(&[1u8; 16]).unwrap();
        let encoded = encoder
            .finish(
                &palette(4),
                GifOptions {
                    delay_centiseconds: 7,
                    loop_forever: false,
                    transparent_index: None,
                },
            )
            .unwrap();

        let gif = decode(&encoded.bytes);
        assert!(!gif.loops);
        for frame in &gif.frames {
            assert_eq!(frame.delay, 7);
        }
    }

    #[test]
    fn bad_input_is_refused_with_the_numbers_that_caused_it() {
        assert_eq!(
            GifEncoder::new(0, 4).unwrap_err(),
            EncodeError::BadExtent {
                width: 0,
                height: 4
            }
        );
        assert_eq!(
            GifEncoder::new(70_000, 4).unwrap_err(),
            EncodeError::BadExtent {
                width: 70_000,
                height: 4
            }
        );

        let mut encoder = GifEncoder::new(4, 4).unwrap();
        assert_eq!(
            encoder.push(&[0u8; 15]).unwrap_err(),
            EncodeError::BadFrameLength {
                expected: 16,
                got: 15
            }
        );
        assert_eq!(
            encoder
                .finish(&palette(4), GifOptions::default())
                .unwrap_err(),
            EncodeError::NoFrames
        );

        encoder.push(&[7u8; 16]).unwrap();
        assert_eq!(
            encoder
                .finish(&palette(4), GifOptions::default())
                .unwrap_err(),
            EncodeError::IndexOutOfRange {
                index: 7,
                entries: 4
            }
        );
        assert_eq!(
            encoder.finish(&[1, 2], GifOptions::default()).unwrap_err(),
            EncodeError::BadPalette { entries: 2 }
        );
        assert_eq!(
            encoder
                .finish(&palette(257), GifOptions::default())
                .unwrap_err(),
            EncodeError::BadPalette { entries: 257 }
        );
        assert_eq!(
            encoder
                .finish(
                    &palette(8),
                    GifOptions {
                        transparent_index: Some(9),
                        ..GifOptions::default()
                    }
                )
                .unwrap_err(),
            EncodeError::TransparentOutOfRange {
                index: 9,
                entries: 8
            }
        );
    }

    #[test]
    fn table_bits_never_goes_below_the_formats_minimum() {
        assert_eq!(table_bits(1), 2);
        assert_eq!(table_bits(2), 2);
        assert_eq!(table_bits(4), 2);
        assert_eq!(table_bits(5), 3);
        assert_eq!(table_bits(16), 4);
        assert_eq!(table_bits(17), 5);
        assert_eq!(table_bits(256), 8);
    }

    #[test]
    fn the_report_counts_what_was_actually_written() {
        let (w, h) = (32, 32);
        let mut encoder = GifEncoder::new(w, h).unwrap();
        encoder.push(&vec![1u8; w * h]).unwrap();
        let mut second = vec![1u8; w * h];
        second[5 * w + 5] = 2;
        encoder.push(&second).unwrap();
        let encoded = encoder.finish(&palette(4), GifOptions::default()).unwrap();

        assert_eq!(encoded.report.frames, 2);
        assert_eq!(encoded.report.bytes, encoded.bytes.len());
        // Frame 0 in full, frame 1 as a single pixel.
        assert_eq!(encoded.report.pixels_written, (w * h) as u64 + 1);
        assert_eq!(encoded.report.cropped_frames, 1);
    }

    #[test]
    fn the_buffered_ceiling_is_refused_rather_than_allocated() {
        // Run against a lowered budget rather than the shipped half-gigabyte
        // one, which is why `with_budget` exists: the guard is the same code and
        // the test does not have to allocate 512 MiB to reach it.
        let mut encoder = GifEncoder::with_budget(8, 8, 128).unwrap();
        encoder.push(&[0u8; 64]).unwrap();
        encoder.push(&[0u8; 64]).unwrap();
        let error = encoder.push(&[0u8; 64]).unwrap_err();
        assert_eq!(
            error,
            EncodeError::TooManyBytes {
                bytes: 192,
                limit: 128
            }
        );
        // Refused rather than half-accepted: the frame that did not fit is not
        // in the encoder afterwards.
        assert_eq!(encoder.frame_count(), 2);
        assert_eq!(encoder.buffered_bytes(), 128);
    }

    /// The risk docs/ARCHITECTURE.md names, measured rather than asserted from
    /// memory.
    ///
    /// "GIF compresses dither noise poorly — LZW hates high-entropy data, which
    /// is exactly what a dither produces." This runs a real Floyd-Steinberg
    /// pass over a real fixture at the same palette as a flat field of the same
    /// size, and pins the ratio between them. The numbers print under
    /// `cargo test -- --nocapture`, which is where the honest figure for the
    /// size estimate comes from.
    ///
    /// The bound is loose on purpose: what is being protected is the *shape* of
    /// the finding, so that an encoder change that accidentally made a dither
    /// cheap — by smoothing it, by dropping frames, by quantizing again —
    /// would fail here rather than look like an improvement.
    #[test]
    fn a_dither_costs_far_more_per_pixel_than_a_flat_field() {
        use crate::diffusion;
        use crate::palette::Palette;

        let fixture = crate::fixture::RADIAL_GRADIENT;
        let (w, h) = (fixture.width, fixture.height);
        let pixels = fixture.render();
        // Four colours: black, white and two greys. The smallest palette that
        // still gives error diffusion somewhere to put the error.
        let palette_rgb: Vec<u8> = vec![0, 0, 0, 85, 85, 85, 170, 170, 170, 255, 255, 255];
        let palette = Palette::from_srgb_rgb(&palette_rgb);
        let kernel = diffusion::kernel_by_id("floyd-steinberg").expect("the kernel is registered");

        let dithered = diffusion::dither(
            &pixels,
            w,
            h,
            &palette,
            kernel,
            diffusion::Options::default(),
        );
        let indices: Vec<u8> = dithered.indices.iter().map(|&i| i as u8).collect();

        let mut noisy = GifEncoder::new(w, h).unwrap();
        noisy.push(&indices).unwrap();
        let noisy_gif = noisy.finish(&palette_rgb, GifOptions::default()).unwrap();

        let mut flat = GifEncoder::new(w, h).unwrap();
        flat.push(&vec![2u8; w * h]).unwrap();
        let flat_gif = flat.finish(&palette_rgb, GifOptions::default()).unwrap();

        let pixels_count = (w * h) as f64;
        let noisy_bpp = noisy_gif.report.bytes as f64 / pixels_count;
        let flat_bpp = flat_gif.report.bytes as f64 / pixels_count;
        println!(
            "GIF of a {w}x{h} four-colour Floyd-Steinberg dither: {} bytes ({noisy_bpp:.3} \
             bytes/pixel, {:.1}x smaller than its raw index map). The same extent as a flat \
             field: {} bytes ({flat_bpp:.4} bytes/pixel, {:.1}x). A dither costs {:.1}x per \
             pixel what a flat field of the same size does.",
            noisy_gif.report.bytes,
            pixels_count / noisy_gif.report.bytes as f64,
            flat_gif.report.bytes,
            pixels_count / flat_gif.report.bytes as f64,
            noisy_bpp / flat_bpp,
        );

        // Four rather than a larger factor because the flat field's number is
        // mostly the file's fixed overhead at this extent — 154 bytes of which
        // roughly fifty are the header and the colour table. On a full-size
        // frame the gap is wider; this bound is the one that holds at every
        // size, which is what a regression test needs.
        assert!(
            noisy_bpp > flat_bpp * 4.0,
            "a dither compressed almost as well as a flat field, which means it is not a \
             dither any more: {noisy_bpp} against {flat_bpp} bytes per pixel"
        );
        // Below an eighth of a byte a pixel LZW is still finding real structure;
        // above one byte it is emitting more than the raw index map, which the
        // format allows and which would mean something is wrong with the clear
        // code.
        assert!(
            (0.125..1.0).contains(&noisy_bpp),
            "{noisy_bpp} bytes per pixel is outside anything LZW does to a dither"
        );
    }

    #[test]
    fn every_error_says_something_a_person_could_act_on() {
        let cases = [
            EncodeError::BadExtent {
                width: 0,
                height: 1,
            },
            EncodeError::BadFrameLength {
                expected: 4,
                got: 3,
            },
            EncodeError::BadPalette { entries: 0 },
            EncodeError::IndexOutOfRange {
                index: 3,
                entries: 2,
            },
            EncodeError::TransparentOutOfRange {
                index: 3,
                entries: 2,
            },
            EncodeError::NoFrames,
            EncodeError::TooManyBytes { bytes: 2, limit: 1 },
        ];
        for case in cases {
            let text = case.to_string();
            assert!(text.len() > 20, "{case:?} says only {text:?}");
        }
    }
}
