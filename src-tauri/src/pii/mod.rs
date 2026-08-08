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
