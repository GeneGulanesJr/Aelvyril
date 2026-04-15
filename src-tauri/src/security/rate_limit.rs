use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Configuration for rate limiting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitConfig {
    /// Maximum requests per minute per client
    pub max_requests_per_minute: u32,
    /// Maximum requests per hour per client
    pub max_requests_per_hour: u32,
    /// Maximum concurrent requests globally
    pub max_concurrent_requests: u32,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            max_requests_per_minute: 60,
            max_requests_per_hour: 1000,
            max_concurrent_requests: 10,
        }
    }
}

#[derive(Debug)]
struct ClientBucket {
    /// Timestamps of requests in the current minute window
    minute_requests: Vec<Instant>,
    /// Timestamps of requests in the current hour window
    hour_requests: Vec<Instant>,
}

impl ClientBucket {
    fn new() -> Self {
        Self {
            minute_requests: Vec::new(),
            hour_requests: Vec::new(),
        }
    }

    fn prune(&mut self, now: Instant) {
        let minute_ago = now - std::time::Duration::from_secs(60);
        let hour_ago = now - std::time::Duration::from_secs(3600);

        self.minute_requests.retain(|t| *t > minute_ago);
        self.hour_requests.retain(|t| *t > hour_ago);
    }

    fn record(&mut self, now: Instant) {
        self.minute_requests.push(now);
        self.hour_requests.push(now);
    }

    fn minute_count(&self) -> usize {
        self.minute_requests.len()
    }

    fn hour_count(&self) -> usize {
        self.hour_requests.len()
    }
}

/// Token-bucket rate limiter keyed by client identity (derived from auth header hash)
#[derive(Debug, Clone)]
pub struct RateLimiter {
    config: RateLimitConfig,
    buckets: Arc<Mutex<HashMap<String, ClientBucket>>>,
    active_requests: Arc<Mutex<u32>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RateLimitResult {
    Allowed,
    DeniedMinuteLimit,
    DeniedHourLimit,
    DeniedConcurrentLimit,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            buckets: Arc::new(Mutex::new(HashMap::new())),
            active_requests: Arc::new(Mutex::new(0)),
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(RateLimitConfig::default())
    }

    /// Check if a request from the given client is allowed.
    /// Call this BEFORE processing the request.
    pub fn check(&self, client_id: &str) -> RateLimitResult {
        let now = Instant::now();

        // Check concurrent limit first (global)
        {
            let active = self.active_requests.lock();
            if *active >= self.config.max_concurrent_requests {
                return RateLimitResult::DeniedConcurrentLimit;
            }
        }

        let mut buckets = self.buckets.lock();
        let bucket = buckets
            .entry(client_id.to_string())
            .or_insert_with(ClientBucket::new);

        bucket.prune(now);

        if bucket.minute_count() >= self.config.max_requests_per_minute as usize {
            return RateLimitResult::DeniedMinuteLimit;
        }

        if bucket.hour_count() >= self.config.max_requests_per_hour as usize {
            return RateLimitResult::DeniedHourLimit;
        }

        bucket.record(now);
        RateLimitResult::Allowed
    }

    /// Acquire a concurrent request slot. Call after check() passes.
    /// Returns a guard that releases the slot on drop.
    pub fn acquire_concurrent(&self) -> ConcurrentGuard {
        let mut active = self.active_requests.lock();
        *active += 1;
        ConcurrentGuard {
            active_requests: self.active_requests.clone(),
        }
    }

    /// Prune stale entries from all buckets (call periodically)
    pub fn prune_all(&self) {
        let now = Instant::now();
        let mut buckets = self.buckets.lock();
        buckets.retain(|_, bucket| {
            bucket.prune(now);
            bucket.hour_count() > 0
        });
    }
}

/// RAII guard that releases the concurrent slot on drop
pub struct ConcurrentGuard {
    active_requests: Arc<Mutex<u32>>,
}

impl Drop for ConcurrentGuard {
    fn drop(&mut self) {
        let mut active = self.active_requests.lock();
        *active = active.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rate_limiter_allows_under_limit() {
        let config = RateLimitConfig {
            max_requests_per_minute: 5,
            max_requests_per_hour: 100,
            max_concurrent_requests: 10,
        };
        let limiter = RateLimiter::new(config);

        for _ in 0..5 {
            assert_eq!(limiter.check("client-1"), RateLimitResult::Allowed);
        }
    }

    #[test]
    fn test_rate_limiter_denies_over_minute_limit() {
        let config = RateLimitConfig {
            max_requests_per_minute: 3,
            max_requests_per_hour: 100,
            max_concurrent_requests: 10,
        };
        let limiter = RateLimiter::new(config);

        for _ in 0..3 {
            assert_eq!(limiter.check("client-1"), RateLimitResult::Allowed);
        }
        assert_eq!(
            limiter.check("client-1"),
            RateLimitResult::DeniedMinuteLimit
        );
    }

    #[test]
    fn test_rate_limiter_independent_clients() {
        let config = RateLimitConfig {
            max_requests_per_minute: 2,
            max_requests_per_hour: 100,
            max_concurrent_requests: 10,
        };
        let limiter = RateLimiter::new(config);

        assert_eq!(limiter.check("client-1"), RateLimitResult::Allowed);
        assert_eq!(limiter.check("client-1"), RateLimitResult::Allowed);
        assert_eq!(
            limiter.check("client-1"),
            RateLimitResult::DeniedMinuteLimit
        );

        // Different client is independent
        assert_eq!(limiter.check("client-2"), RateLimitResult::Allowed);
    }

    #[test]
    fn test_concurrent_guard_releases() {
        let config = RateLimitConfig {
            max_requests_per_minute: 100,
            max_requests_per_hour: 1000,
            max_concurrent_requests: 2,
        };
        let limiter = RateLimiter::new(config);

        let _g1 = limiter.acquire_concurrent();
        let _g2 = limiter.acquire_concurrent();

        // Third concurrent should be denied
        assert_eq!(
            limiter.check("client-1"),
            RateLimitResult::DeniedConcurrentLimit
        );

        // Drop one guard
        drop(_g2);

        // Now allowed again
        assert_eq!(limiter.check("client-1"), RateLimitResult::Allowed);
    }

    #[test]
    fn test_prune_removes_stale() {
        let config = RateLimitConfig {
            max_requests_per_minute: 5,
            max_requests_per_hour: 5,
            max_concurrent_requests: 10,
        };
        let limiter = RateLimiter::new(config);
        limiter.check("ephemeral");
        // With hour limit = 5 and minute limit = 5, prune keeps entries in the hour window
        limiter.prune_all();
        let buckets = limiter.buckets.lock();
        // Should still have the entry (it's within the hour window)
        assert_eq!(buckets.len(), 1);
    }
}
