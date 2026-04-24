use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;

/// Configuration for Tauri command rate limiting
#[derive(Debug, Clone)]
pub struct TauriRateLimitConfig {
    /// Maximum command invocations per minute (global across all commands)
    pub max_per_minute: u32,
    /// Maximum command invocations per hour (global)
    pub max_per_hour: u32,
}

impl Default for TauriRateLimitConfig {
    fn default() -> Self {
        Self {
            max_per_minute: 300,   // 5 per second average; generous for UI polling
            max_per_hour: 10_000,  // generous but caps abuse
        }
    }
}

/// Token bucket for Tauri command rate limiting
#[derive(Debug)]
pub struct TauriRateLimiter {
    config: TauriRateLimitConfig,
    requests: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
}

impl TauriRateLimiter {
    pub fn new(config: TauriRateLimitConfig) -> Self {
        Self {
            config,
            requests: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(TauriRateLimitConfig::default())
    }

    /// Check if a command invocation is allowed.
    /// Returns `Ok(())` if allowed, `Err(reason)` if denied.
    pub fn check(&self, command: &str) -> Result<(), RateLimitError> {
        let now = Instant::now();
        let mut requests = self.requests.lock();

        let bucket = requests.entry(command.to_string()).or_default();

        // Prune entries older than 1 hour (covers both windows)
        let minute_ago = now - std::time::Duration::from_secs(60);
        let hour_ago = now - std::time::Duration::from_secs(3600);
        bucket.retain(|t| *t > hour_ago);

        let minute_count = bucket.iter().filter(|t| **t > minute_ago).count();
        let hour_count = bucket.len();

        if minute_count >= self.config.max_per_minute as usize {
            return Err(RateLimitError::MinuteLimit {
                command: command.to_string(),
                limit: self.config.max_per_minute,
            });
        }

        if hour_count >= self.config.max_per_hour as usize {
            return Err(RateLimitError::HourLimit {
                command: command.to_string(),
                limit: self.config.max_per_hour,
            });
        }

        bucket.push(now);
        Ok(())
    }

    pub fn config(&self) -> &TauriRateLimitConfig {
        &self.config
    }

    #[cfg(test)]
    pub fn clear(&self) {
        let mut requests = self.requests.lock();
        requests.clear();
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RateLimitError {
    #[error("rate limit: {command} — too many requests per minute (max {limit})")]
    MinuteLimit { command: String, limit: u32 },

    #[error("rate limit: {command} — too many requests per hour (max {limit})")]
    HourLimit { command: String, limit: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_allows_up_to_minute_limit() {
        let limiter = TauriRateLimiter::with_defaults();
        // Default: 300/min
        for i in 0..300 {
            assert!(limiter.check("test_cmd").is_ok(), "Request {i} should be allowed");
        }
    }

    #[test]
    fn test_rejects_over_minute_limit() {
        let limiter = TauriRateLimiter::with_defaults();
        for _ in 0..300 {
            let _ = limiter.check("test_cmd");
        }
        let result = limiter.check("test_cmd");
        assert!(result.is_err(), "Should be rate-limited after exceeding per-minute bucket");
    }

    #[test]
    fn test_rejects_over_hour_limit() {
        let limiter = TauriRateLimiter::with_defaults();
        for _ in 0..10_000 {
            let _ = limiter.check("test_cmd");
        }
        let result = limiter.check("test_cmd");
        assert!(result.is_err(), "Should be rate-limited after exceeding per-hour bucket");
    }

    #[test]
    fn test_per_command_bucket_is_isolated() {
        let limiter = TauriRateLimiter::with_defaults();
        for _ in 0..300 {
            let _ = limiter.check("cmd_a");
        }
        assert!(limiter.check("cmd_b").is_ok(), "Different commands have separate buckets");
    }

    #[test]
    fn test_clear_resets_buckets() {
        let limiter = TauriRateLimiter::with_defaults();
        for _ in 0..300 {
            let _ = limiter.check("cmd");
        }
        assert!(limiter.check("cmd").is_err());
        limiter.clear();
        assert!(limiter.check("cmd").is_ok(), "After clear, bucket should be empty");
    }
}
