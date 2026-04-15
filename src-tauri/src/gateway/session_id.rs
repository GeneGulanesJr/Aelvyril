//! Session ID derivation from request headers.

use axum::http::HeaderMap;
use sha2::{Digest, Sha256};

/// Derive a session ID from request headers.
///
/// Strategy:
/// 1. Prefer an explicit `x-session-id` header.
/// 2. Otherwise, build a composite fingerprint from available headers
///    so different clients don't accidentally merge into one session.
/// 3. If no identifying headers at all, generate a unique UUID per request.
pub fn derive_session_id(headers: &HeaderMap) -> String {
    // 1. Prefer explicit session header
    if let Some(session_header) = headers.get("x-session-id") {
        if let Ok(id) = session_header.to_str() {
            if !id.is_empty() {
                return id.to_string();
            }
        }
    }

    // 2. Build a composite fingerprint from available headers
    let mut hasher = Sha256::new();
    let mut has_identifying_info = false;

    // Authorization key (primary identity)
    if let Some(val) = header_str(headers, "authorization") {
        hasher.update(b"auth:");
        hasher.update(val.as_bytes());
        has_identifying_info = true;
    }

    // User-Agent (correlates requests from the same tool)
    if let Some(val) = header_str(headers, "user-agent") {
        hasher.update(b"ua:");
        hasher.update(val.as_bytes());
        has_identifying_info = true;
    }

    // Origin / Referer (distinguishes browser tabs / apps)
    if let Some(val) = header_str(headers, "origin") {
        hasher.update(b"origin:");
        hasher.update(val.as_bytes());
        has_identifying_info = true;
    } else if let Some(val) = header_str(headers, "referer") {
        hasher.update(b"referer:");
        hasher.update(val.as_bytes());
        has_identifying_info = true;
    }

    // Forwarded-For (distinguishes different machines behind a proxy)
    if let Some(val) = header_str(headers, "x-forwarded-for") {
        hasher.update(b"xff:");
        hasher.update(val.as_bytes());
        has_identifying_info = true;
    }

    if has_identifying_info {
        let hash = hasher.finalize();
        hex::encode(&hash[..12])
    } else {
        // 3. No identifying headers — unique session per request
        uuid::Uuid::new_v4().to_string()
    }
}

/// Extract a header value as a string slice.
fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_explicit_session_header() {
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", "my-session-123".parse().unwrap());
        assert_eq!(derive_session_id(&headers), "my-session-123");
    }

    #[test]
    fn test_empty_session_header_falls_through() {
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", "".parse().unwrap());
        headers.insert("authorization", "Bearer key".parse().unwrap());
        // Should not return empty string — should fall through to fingerprint
        assert_ne!(derive_session_id(&headers), "");
    }

    #[test]
    fn test_same_auth_same_session() {
        let mut h1 = HeaderMap::new();
        h1.insert("authorization", "Bearer same-key".parse().unwrap());
        let mut h2 = HeaderMap::new();
        h2.insert("authorization", "Bearer same-key".parse().unwrap());
        assert_eq!(derive_session_id(&h1), derive_session_id(&h2));
    }

    #[test]
    fn test_no_headers_gives_unique_sessions() {
        let h1 = HeaderMap::new();
        let h2 = HeaderMap::new();
        assert_ne!(derive_session_id(&h1), derive_session_id(&h2));
    }
}
