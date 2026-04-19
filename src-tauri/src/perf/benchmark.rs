use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;

/// Latency benchmarking for the gateway pipeline.
///
/// Tracks timing at each stage of request processing to identify bottlenecks:
/// 1. Authentication
/// 2. PII Detection
/// 3. Pseudonymization
/// 4. Upstream forwarding
/// 5. Rehydration
/// 6. Total end-to-end
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLatency {
    pub auth_ms: f64,
    pub pii_detect_ms: f64,
    pub pseudonymize_ms: f64,
    pub upstream_ms: f64,
    pub rehydrate_ms: f64,
    pub total_ms: f64,
    pub streaming: bool,
    pub provider: String,
    pub model: String,
    pub timestamp: String,
}

/// Rolling window benchmark tracker
#[derive(Clone)]
pub struct LatencyBenchmark {
    recent: Arc<Mutex<VecDeque<RequestLatency>>>,
    max_samples: usize,
}

impl LatencyBenchmark {
    pub fn new(max_samples: usize) -> Self {
        Self {
            recent: Arc::new(Mutex::new(VecDeque::with_capacity(max_samples))),
            max_samples,
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(1000)
    }

    /// Record a completed request's latency breakdown
    pub fn record(&self, latency: RequestLatency) {
        let mut recent = self.recent.lock();
        if recent.len() >= self.max_samples {
            recent.pop_front();
        }
        recent.push_back(latency);
    }

    /// Get aggregate statistics over the recorded samples
    pub fn stats(&self) -> LatencyStats {
        let recent = self.recent.lock();
        if recent.is_empty() {
            return LatencyStats::default();
        }

        let count = recent.len() as u64;
        let mut total_auth = 0.0;
        let mut total_pii = 0.0;
        let mut total_pseudo = 0.0;
        let mut total_upstream = 0.0;
        let mut total_rehydrate = 0.0;
        let mut total_end_to_end = 0.0;

        for req in recent.iter() {
            total_auth += req.auth_ms;
            total_pii += req.pii_detect_ms;
            total_pseudo += req.pseudonymize_ms;
            total_upstream += req.upstream_ms;
            total_rehydrate += req.rehydrate_ms;
            total_end_to_end += req.total_ms;
        }

        LatencyStats {
            sample_count: count,
            avg_auth_ms: total_auth / count as f64,
            avg_pii_detect_ms: total_pii / count as f64,
            avg_pseudonymize_ms: total_pseudo / count as f64,
            avg_upstream_ms: total_upstream / count as f64,
            avg_rehydrate_ms: total_rehydrate / count as f64,
            avg_total_ms: total_end_to_end / count as f64,
            p95_total_ms: percentile(&recent.iter().map(|r| r.total_ms).collect::<Vec<_>>(), 95.0),
            p99_total_ms: percentile(&recent.iter().map(|r| r.total_ms).collect::<Vec<_>>(), 99.0),
            max_total_ms: recent.iter().map(|r| r.total_ms).fold(0.0, f64::max),
            min_total_ms: recent
                .iter()
                .map(|r| r.total_ms)
                .fold(f64::INFINITY, f64::min),
        }
    }

    /// Clear all recorded samples
    pub fn clear(&self) {
        self.recent.lock().clear();
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LatencyStats {
    pub sample_count: u64,
    pub avg_auth_ms: f64,
    pub avg_pii_detect_ms: f64,
    pub avg_pseudonymize_ms: f64,
    pub avg_upstream_ms: f64,
    pub avg_rehydrate_ms: f64,
    pub avg_total_ms: f64,
    pub p95_total_ms: f64,
    pub p99_total_ms: f64,
    pub max_total_ms: f64,
    pub min_total_ms: f64,
}

/// Helper to build latency measurements inline during request processing
pub struct LatencyBuilder {
    start: Instant,
    auth_start: Instant,
    auth_ms: f64,
    pii_start: Option<Instant>,
    pii_ms: f64,
    pseudo_start: Option<Instant>,
    pseudo_ms: f64,
    upstream_start: Option<Instant>,
    upstream_ms: f64,
    rehydrate_start: Option<Instant>,
    rehydrate_ms: f64,
}

impl Default for LatencyBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl LatencyBuilder {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            auth_start: Instant::now(),
            auth_ms: 0.0,
            pii_start: None,
            pii_ms: 0.0,
            pseudo_start: None,
            pseudo_ms: 0.0,
            upstream_start: None,
            upstream_ms: 0.0,
            rehydrate_start: None,
            rehydrate_ms: 0.0,
        }
    }

    pub fn auth_done(&mut self) {
        self.auth_ms = self.auth_start.elapsed().as_secs_f64() * 1000.0;
    }

    pub fn pii_start(&mut self) {
        self.pii_start = Some(Instant::now());
    }

    pub fn pii_done(&mut self) {
        self.pii_ms = self
            .pii_start
            .map(|t| t.elapsed().as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
    }

    pub fn pseudo_start(&mut self) {
        self.pseudo_start = Some(Instant::now());
    }

    pub fn pseudo_done(&mut self) {
        self.pseudo_ms = self
            .pseudo_start
            .map(|t| t.elapsed().as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
    }

    pub fn upstream_start(&mut self) {
        self.upstream_start = Some(Instant::now());
    }

    pub fn upstream_done(&mut self) {
        self.upstream_ms = self
            .upstream_start
            .map(|t| t.elapsed().as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
    }

    pub fn rehydrate_start(&mut self) {
        self.rehydrate_start = Some(Instant::now());
    }

    pub fn rehydrate_done(&mut self) {
        self.rehydrate_ms = self
            .rehydrate_start
            .map(|t| t.elapsed().as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
    }

    pub fn build(self, streaming: bool, provider: String, model: String) -> RequestLatency {
        RequestLatency {
            auth_ms: self.auth_ms,
            pii_detect_ms: self.pii_ms,
            pseudonymize_ms: self.pseudo_ms,
            upstream_ms: self.upstream_ms,
            rehydrate_ms: self.rehydrate_ms,
            total_ms: self.start.elapsed().as_secs_f64() * 1000.0,
            streaming,
            provider,
            model,
            timestamp: chrono::Utc::now().to_rfc3339(),
        }
    }
}

/// Calculate percentile from a sorted slice of values
fn percentile(values: &[f64], pct: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((pct / 100.0) * (sorted.len() - 1) as f64).ceil() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_latency_builder() {
        let mut builder = LatencyBuilder::new();
        builder.auth_done();
        builder.pii_start();
        std::thread::sleep(std::time::Duration::from_millis(1));
        builder.pii_done();
        builder.pseudo_start();
        builder.pseudo_done();
        builder.upstream_start();
        std::thread::sleep(std::time::Duration::from_millis(1));
        builder.upstream_done();
        builder.rehydrate_start();
        builder.rehydrate_done();

        let latency = builder.build(false, "OpenAI".into(), "gpt-4o".into());

        assert!(latency.pii_detect_ms > 0.0);
        assert!(latency.upstream_ms > 0.0);
        assert!(latency.total_ms > 0.0);
    }

    #[test]
    fn test_benchmark_stats() {
        let bench = LatencyBenchmark::new(100);

        for i in 0..10 {
            bench.record(RequestLatency {
                auth_ms: 1.0,
                pii_detect_ms: 5.0 + i as f64,
                pseudonymize_ms: 2.0,
                upstream_ms: 100.0,
                rehydrate_ms: 1.0,
                total_ms: 109.0 + i as f64,
                streaming: false,
                provider: "OpenAI".into(),
                model: "gpt-4o".into(),
                timestamp: chrono::Utc::now().to_rfc3339(),
            });
        }

        let stats = bench.stats();
        assert_eq!(stats.sample_count, 10);
        assert!(stats.avg_total_ms > 109.0);
        assert!(stats.p95_total_ms > 0.0);
    }

    #[test]
    fn test_percentile() {
        let values: Vec<f64> = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        let p50 = percentile(&values, 50.0);
        assert!(
            (4.0..=6.0).contains(&p50),
            "p50 should be around 5.0, got {}",
            p50
        );
        let p100 = percentile(&values, 100.0);
        assert_eq!(p100, 10.0);
        let p0 = percentile(&values, 0.0);
        assert_eq!(p0, 1.0);
    }
}
