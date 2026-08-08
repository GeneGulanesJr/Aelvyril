pub mod engine;
pub mod liquid;
pub mod presidio;
pub mod presidio_service;
pub mod recognizers;
pub mod sync;

pub use engine::PiiEngine;
pub use liquid::{LiquidPiiClient, LiquidPiiClientBuilder, LiquidPiiError};
pub use presidio::{PresidioClient, PresidioClientBuilder, PresidioError};
pub use presidio_service::PresidioService;

/// Convert a char-offset position (as returned by the Python sidecar) into a byte offset.
///
/// The Presidio / Liquid sidecars compute span `start`/`end` with Python `str`
/// semantics, i.e. **character** indices. The Rust engine slices `&str` by
/// **bytes**, so for non-ASCII (multibyte UTF-8) input a raw char offset lands
/// inside a character: pre-safe_slice that PANICKED; with `safe_slice` it
/// returns `None` and the span is silently skipped → the PII leaks RAW on the
/// wire. Converting char offsets to byte offsets (always on char boundaries)
/// at the client boundary makes `safe_slice` always return `Some` and the span
/// survives.
///
/// For ASCII inputs char offsets == byte offsets, so this is a no-op there.
/// `char_pos` beyond the string length maps to the end of the string.
pub fn char_to_byte_offset(text: &str, char_pos: usize) -> usize {
    text.char_indices()
        .nth(char_pos)
        .map(|(i, _)| i)
        .unwrap_or(text.len())
}

/// Char-boundary-safe substring extraction.
///
/// All PII span offsets entering the engine are **byte** offsets (from regex
/// `Match` ranges, Presidio `start`/`end`, or the Liquid encoder). Slicing a
/// `&str` directly with byte offsets panics if either boundary falls inside a
/// multibyte UTF-8 sequence — and a panicking tokio worker drops the whole
/// request, violating the gateway's "any layer failing must degrade
/// gracefully, never break the gateway" contract.
///
/// This helper is the single chokepoint every span-slice site must go
/// through. It returns:
///   - `Some(slice)` when `[start, end)` lands on char boundaries (the
///     common case, including every ASCII input),
///   - `None` when the range is out of bounds or splits a character — callers
///     then skip the span (never emit a corrupt half-char token).
///
/// For ASCII inputs the behavior is identical to a direct `text[start..end]`,
/// so the 38/40 ASCII corpus is unaffected. Only non-ASCII boundary cases
/// change, and there they trade a panic for a graceful skip.
pub fn safe_slice(text: &str, start: usize, end: usize) -> Option<&str> {
    // Reject obviously-bad ranges up front so we never index past the end.
    if start > end || end > text.len() {
        return None;
    }
    // `str::get` returns `None` exactly when the range is not on char
    // boundaries — that is the property we want.
    text.get(start..end)
}

#[cfg(test)]
mod safe_slice_tests {
    use super::safe_slice;

    #[test]
    fn ascii_slice_is_identity() {
        // Identical to direct indexing for ASCII inputs.
        assert_eq!(safe_slice("Email john@acme.com", 6, 19), Some("john@acme.com"));
        assert_eq!(safe_slice("abc", 0, 3), Some("abc"));
        assert_eq!(safe_slice("abc", 1, 2), Some("b"));
    }

    #[test]
    fn multibyte_aligned_boundaries_slice_cleanly() {
        // 'é' is 2 bytes; "Héllo" = [H][é][l][l][o] → byte offsets 0,1,3,4,5,6.
        assert_eq!(safe_slice("Héllo", 0, 6), Some("Héllo"));
        assert_eq!(safe_slice("Héllo", 3, 6), Some("llo"));
        assert_eq!(safe_slice("Héllo", 1, 3), Some("é"));
    }

    #[test]
    fn multibyte_misaligned_boundary_returns_none_not_panic() {
        // start=1,end=2 falls INSIDE the 'é' (bytes 1..3). Direct indexing
        // would panic; the helper must return None instead.
        assert_eq!(safe_slice("Héllo", 1, 2), None);
        // end=2 splits 'é' at the tail.
        assert_eq!(safe_slice("Héllo", 0, 2), None);
        // start=2 splits 'é' at the head.
        assert_eq!(safe_slice("Héllo", 2, 3), None);
    }

    #[test]
    fn out_of_range_returns_none() {
        assert_eq!(safe_slice("abc", 0, 99), None);
        assert_eq!(safe_slice("abc", 5, 2), None); // start > end
        assert_eq!(safe_slice("", 0, 1), None);
    }
}

#[cfg(test)]
mod char_to_byte_offset_tests {
    use super::char_to_byte_offset;

    #[test]
    fn ascii_passthrough() {
        // For ASCII, char offsets == byte offsets.
        assert_eq!(char_to_byte_offset("abc", 0), 0);
        assert_eq!(char_to_byte_offset("abc", 1), 1);
        assert_eq!(char_to_byte_offset("abc", 3), 3);
        // Past the end maps to the string length (no panic).
        assert_eq!(char_to_byte_offset("abc", 99), 3);
        assert_eq!(char_to_byte_offset("", 0), 0);
    }

    #[test]
    fn latin_extended_multibyte() {
        // "Héllo" bytes: H=0, é=1..3, l=3, l=4, o=5 (len 6).
        // Char positions:  H=0, é=1, l=2, l=3, o=4.
        assert_eq!(char_to_byte_offset("Héllo", 0), 0); // H
        assert_eq!(char_to_byte_offset("Héllo", 1), 1); // é head (2 bytes: char1→byte2)
        assert_eq!(char_to_byte_offset("Héllo", 2), 3); // first l
        assert_eq!(char_to_byte_offset("Héllo", 5), 6); // past last char → len
    }

    #[test]
    fn cjk_multibyte() {
        // "我的名字是张三。" — 7 CJK chars + 1 fullwidth period = 8 chars,
        // each CJK char is 3 bytes in UTF-8.
        let s = "我的名字是张三。";
        assert_eq!(s.chars().count(), 8);
        // char5 (张) → byte 15
        assert_eq!(char_to_byte_offset(s, 5), 15);
        // char7 (。) → byte 21
        assert_eq!(char_to_byte_offset(s, 7), 21);
        // char8 is past the last char → string length (24)
        assert_eq!(char_to_byte_offset(s, 8), 24);
    }

    #[test]
    fn arabic_and_cyrillic() {
        // Arabic: each char is 2 bytes in UTF-8.
        let ar = "أحمد";
        assert_eq!(char_to_byte_offset(ar, 2), 4);
        // Cyrillic: each char is 2 bytes.
        let ru = "Телефон";
        assert_eq!(char_to_byte_offset(ru, 3), 6);
    }
}
