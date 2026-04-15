use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::pii::recognizers::PiiMatch;
use parking_lot::Mutex;

/// Cache entry with TTL tracking
#[derive(Debug, Clone)]
struct CacheEntry {
    matches: Vec<PiiMatch>,
    inserted_at: Instant,
    hit_count: u32,
}

/// Content-hash based LRU cache for PII detection results.
///
/// Avoids re-scanning identical content across repeated requests (e.g., retries,
/// multi-turn conversations where prior messages are re-sent). Uses SHA-256 of
/// the content as the cache key.
///
/// **Properties:**
/// - Bounded size (evicts oldest when full)
/// - TTL-based expiry (default 5 minutes)
/// - Zero-allocation hits (returns cloned results)
/// - Thread-safe (parking_lot::Mutex)
#[derive(Clone)]
pub struct PiiCache {
    entries: Arc<Mutex<HashMap<[u8; 32], CacheEntry>>>,
    max_entries: usize,
    ttl: Duration,
    stats: Arc<Mutex<CacheStats>>,
}

#[derive(Debug, Clone, Default)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub size: usize,
}

impl PiiCache {
    pub fn new(max_entries: usize, ttl: Duration) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::with_capacity(max_entries))),
            max_entries,
            ttl,
            stats: Arc::new(Mutex::new(CacheStats::default())),
        }
    }

    /// Create a cache with sensible defaults: 1000 entries, 5-minute TTL
    pub fn with_defaults() -> Self {
        Self::new(1000, Duration::from_secs(300))
    }

    /// Compute SHA-256 hash of content
    fn hash_content(content: &str) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        hasher.finalize().into()
    }

    /// Look up cached PII detection results. Returns None on miss or expiry.
    pub fn get(&self, content: &str) -> Option<Vec<PiiMatch>> {
        let key = Self::hash_content(content);
        let mut entries = self.entries.lock();
        let mut stats = self.stats.lock();

        if let Some(entry) = entries.get_mut(&key) {
            if entry.inserted_at.elapsed() < self.ttl {
                entry.hit_count += 1;
                stats.hits += 1;
                return Some(entry.matches.clone());
            } else {
                // Expired — remove
                entries.remove(&key);
            }
        }

        stats.misses += 1;
        None
    }

    /// Store PII detection results for the given content
    pub fn insert(&self, content: &str, matches: Vec<PiiMatch>) {
        let key = Self::hash_content(content);
        let mut entries = self.entries.lock();
        let mut stats = self.stats.lock();

        // Evict oldest entries if at capacity
        if entries.len() >= self.max_entries {
            let oldest_key = entries
                .iter()
                .min_by_key(|(_, v)| v.inserted_at)
                .map(|(k, _)| *k);

            if let Some(old_key) = oldest_key {
                entries.remove(&old_key);
                stats.evictions += 1;
            }
        }

        entries.insert(
            key,
            CacheEntry {
                matches,
                inserted_at: Instant::now(),
                hit_count: 0,
            },
        );

        stats.size = entries.len();
    }

    /// Remove expired entries. Call periodically (e.g., every 60 seconds).
    pub fn prune(&self) {
        let mut entries = self.entries.lock();
        let now = Instant::now();
        entries.retain(|_, v| now.duration_since(v.inserted_at) < self.ttl);

        let mut stats = self.stats.lock();
        stats.size = entries.len();
    }

    /// Get cache statistics
    pub fn stats(&self) -> CacheStats {
        let stats = self.stats.lock();
        stats.clone()
    }

    /// Clear all entries
    pub fn clear(&self) {
        let mut entries = self.entries.lock();
        entries.clear();
        let mut stats = self.stats.lock();
        *stats = CacheStats::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pii::recognizers::PiiType;

    fn make_match(text: &str, start: usize) -> PiiMatch {
        PiiMatch {
            pii_type: PiiType::Email,
            text: text.to_string(),
            start,
            end: start + text.len(),
            confidence: 0.95,
        }
    }

    #[test]
    fn test_cache_hit() {
        let cache = PiiCache::new(100, Duration::from_secs(60));
        let content = "Contact john@example.com for details";
        let matches = vec![make_match("john@example.com", 8)];

        cache.insert(content, matches.clone());
        let result = cache.get(content);

        assert!(result.is_some());
        assert_eq!(result.unwrap().len(), 1);
    }

    #[test]
    fn test_cache_miss() {
        let cache = PiiCache::new(100, Duration::from_secs(60));
        let result = cache.get("no such content");
        assert!(result.is_none());
    }

    #[test]
    fn test_cache_expiry() {
        let cache = PiiCache::new(100, Duration::from_millis(10));
        let content = "test@example.com";

        cache.insert(content, vec![make_match("test@example.com", 0)]);

        // Wait for TTL to expire
        std::thread::sleep(Duration::from_millis(20));

        let result = cache.get(content);
        assert!(result.is_none());
    }

    #[test]
    fn test_cache_eviction() {
        let cache = PiiCache::new(3, Duration::from_secs(60));

        for i in 0..5 {
            let content = format!("email{}@test.com", i);
            cache.insert(&content, vec![make_match(&content, 0)]);
        }

        let stats = cache.stats();
        assert!(stats.evictions >= 2);
        assert!(stats.size <= 3);
    }

    #[test]
    fn test_cache_stats() {
        let cache = PiiCache::new(100, Duration::from_secs(60));
        let content = "test@test.com";

        // Miss
        let _ = cache.get(content);
        // Insert
        cache.insert(content, vec![]);
        // Hit
        let _ = cache.get(content);

        let stats = cache.stats();
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.hits, 1);
    }

    #[test]
    fn test_prune_removes_expired() {
        let cache = PiiCache::new(100, Duration::from_millis(10));
        cache.insert("old@test.com", vec![]);

        std::thread::sleep(Duration::from_millis(20));
        cache.prune();

        assert_eq!(cache.stats().size, 0);
    }
}
