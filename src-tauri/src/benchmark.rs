use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tokio::fs;
use tokio::sync::Semaphore;

use crate::pii::recognizers::PiiMatch;
use serde::{Deserialize, Serialize};

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkConfig {
    pub backend: BackendKind,
    pub presidio_url: Option<String>,
    pub test_jsonl_path: String,
    pub gguf_path: Option<String>,
    pub sample_limit: Option<usize>,
    pub workers: Option<usize>,
    pub include_labels: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Presidio,
    Regex,
    Llama,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpanTruth {
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentTruth {
    pub text: String,
    pub spans: Vec<SpanTruth>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PerEntityMetrics {
    pub label: String,
    pub precision: f64,
    pub recall: f64,
    pub f1: f64,
    pub support: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkResult {
    pub backend: String,
    pub documents_evaluated: usize,
    pub total_spans_truth: usize,
    pub total_spans_pred: usize,
    pub exact_match: usize,
    pub partial_match: usize,
    pub micro_precision: f64,
    pub micro_recall: f64,
    pub micro_f1: f64,
    pub per_entity: Vec<PerEntityMetrics>,
    pub avg_latency_ms: f64,
    pub errors: Vec<String>,
}

// ── Detection backend trait ──────────────────────────────────────────────────

#[async_trait::async_trait]
trait Detector {
    async fn detect(&self, text: &str) -> Result<Vec<PiiMatch>, String>;
}

// ── Presidio HTTP client ─────────────────────────────────────────────────────

struct PresidioClient {
    endpoint: String,
    client: reqwest::Client,
}

impl PresidioClient {
    async fn new(endpoint: &str) -> Result<Self, String> {
        let endpoint = endpoint.trim_end_matches('/').to_string();
        let client = reqwest::Client::new();
        // Verify endpoint is reachable
        let _ = client
            .get(format!("{}/v1/recognizers", endpoint))
            .send()
            .await
            .map_err(|e| format!("Presidio endpoint unreachable: {e}"))?;
        Ok(Self { endpoint, client })
    }

    async fn detect(&self, text: &str) -> Result<Vec<PiiMatch>, String> {
        #[derive(Serialize)]
        struct Req<'a> {
            text: &'a str,
        }
        let resp: serde_json::Value = self
            .client
            .post(format!("{}/v1/analyze", self.endpoint))
            .json(&Req { text })
            .send()
            .await
            .map_err(|e| format!("HTTP error: {e}"))?
            .json()
            .await
            .map_err(|e| format!("JSON error: {e}"))?;

        let mut out = Vec::new();
        if let Some(arr) = resp.get("recognizerResults").and_then(|v| v.as_array()) {
            for item in arr {
                if let (Some(t), Some(s), Some(e)) = (
                    item.get("text").and_then(|v| v.as_str()),
                    item.get("start").and_then(|v| v.as_i64()),
                    item.get("end").and_then(|v| v.as_i64()),
                ) {
                    let label = item
                        .get("entityType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    out.push(PiiMatch {
                        pii_type: entity_to_pii_type(&label),
                        text: t.to_string(),
                        start: s as usize,
                        end: e as usize,
                        confidence: item
                            .get("confidenceScore")
                            .and_then(|v| v.as_f64())
                            .unwrap_or(0.5),
                    });
                }
            }
        }
        Ok(out)
    }
}

// ── Regex backend ────────────────────────────────────────────────────────────

struct RegexDetector {
    patterns: Vec<(regex::Regex, String)>,
}

impl RegexDetector {
    async fn new(label_patterns: &[(&str, &str)]) -> Result<Self, String> {
        let mut patterns = Vec::new();
        for (label, pat) in label_patterns {
            let re = regex::Regex::new(pat).map_err(|e| format!("bad regex '{pat}': {e}"))?;
            patterns.push((re, label.to_string()));
        }
        Ok(Self { patterns })
    }

    async fn detect(&self, text: &str) -> Result<Vec<PiiMatch>, String> {
        let mut out = Vec::new();
        for (re, label) in &self.patterns {
            for m in re.find_iter(text) {
                out.push(PiiMatch {
                    pii_type: entity_to_pii_type(label),
                    text: m.as_str().to_string(),
                    start: m.start(),
                    end: m.end(),
                    confidence: 1.0,
                });
            }
        }
        // Deduplicate overlapping matches — keep highest confidence + longest span.
        out.sort_by_key(|m| (m.start, m.end));
        out.dedup_by(|a, b| a.start == b.start && a.end == b.end);
        Ok(out)
    }
}

// ── Llama backend (requires llama-server in PATH) ──────────────────────────

#[cfg(feature = "llama")]
mod llama_backend {
    use super::*;
    use crate::llama::LlamaDetector;

    pub struct LlamaBenchmarkDetector {
        inner: crate::llama::LlamaDetector,
    }

    impl LlamaBenchmarkDetector {
        pub async fn new(gguf_path: &str) -> Result<Self, String> {
            let inner = crate::llama::LlamaDetector::new(gguf_path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(Self { inner })
        }
    }

    #[async_trait::async_trait]
    impl Detector for LlamaBenchmarkDetector {
        async fn detect(&self, text: &str) -> Result<Vec<PiiMatch>, String> {
            self.inner.detect(text).await.map_err(|e| e.to_string())
        }
    }
}

#[cfg(not(feature = "llama"))]
mod llama_backend {
    use super::*;

    pub struct LlamaBenchmarkDetector;

    impl LlamaBenchmarkDetector {
        pub async fn new(_: &str) -> Result<Self, String> {
            Err("llama backend not compiled — enable feature 'llama' and provide llama-server".to_string())
        }
    }

    #[async_trait::async_trait]
    impl Detector for LlamaBenchmarkDetector {
        async fn detect(&self, _text: &str) -> Result<Vec<PiiMatch>, String> {
            Err("llama backend not compiled".to_string())
        }
    }
}

// ── Metrics & evaluation ─────────────────────────────────────────────────────

fn entity_to_pii_type(label: &str) -> String {
    // Normalize Nemotron label → canonical form. Define mapping here or
    // forward to Aelvyril's PiiType schema.
    match label {
        "person" | "first_name" | "last_name" => "person_name".to_string(),
        "email_address" => "email".to_string(),
        "phone_number" => "phone".to_string(),
        "address" => "address".to_string(),
        "credit_debit_card" => "credit_card".to_string(),
        "social_security_number" => "ssn".to_string(),
        "date_of_birth" => "dob".to_string(),
        "ip_address" => "ip".to_string(),
        "url" => "url".to_string(),
        "user_name" => "username".to_string(),
        "account_number" => "account".to_string(),
        "bank_routing_number" => "routing".to_string(),
        "city" => "city".to_string(),
        "state" => "state".to_string(),
        _ => label.to_lowercase(),
    }
}

/// Exact-match predicate: spans agree on start/end/type.
fn spans_match_exact(p: &PiiMatch, t: &SpanTruth, allow_partial: bool) -> bool {
    if p.pii_type != entity_to_pii_type(&t.label) {
        return false;
    }
    if p.start == t.start && p.end == t.end {
        return true;
    }
    if allow_partial {
        // Partial: any overlap of at least 50% of the smaller span
        let p_len = p.end - p.start;
        let t_len = t.end - t.start;
        let overlap = (p.end.min(t.end) - p.start.max(t.start)).max(0);
        let min_len = p_len.min(t_len) as f64;
        if min_len > 0.0 && (overlap as f64 / min_len) >= 0.5 {
            return true;
        }
    }
    false
}

async fn load_truth(jsonl: &str, limit: Option<usize>) -> Result<Vec<DocumentTruth>, String> {
    let mut docs = Vec::new();
    let mut count = 0;
    let file = fs::File::open(jsonl).await.map_err(|e| format!("open {jsonl}: {e}"))?;
    let reader = tokio::io::BufReader::new(file);
    let mut lines = tokio::io::lines(reader);
    while let Some(Ok(line)) = lines.next().await {
        if let Some(max) = limit {
            if count >= max {
                break;
            }
        }
        let doc: DocumentTruth = serde_json::from_str(&line)
            .map_err(|e| format!("JSONL parse error line {count}: {e}"))?;
        count += 1;
        docs.push(doc);
    }
    Ok(docs)
}

fn best_metric(p: &PiiMatch, t: &SpanTruth) -> f64 {
    let tp_len = (p.end.min(t.end) - p.start.max(t.start)).max(0);
    let p_len = p.end - p.start;
    let t_len = t.end - t.start;
    let denom = (p_len + t_len) as f64;
    if denom == 0.0 { 1.0 } else { 2.0 * tp_len as f64 / denom }
}

// ── Main benchmark orchestration ────────────────────────────────────────────

pub async fn benchmark_pii_run(
    config: BenchmarkConfig,
    _state: crate::state::AppState,  // Future: pass shared state
) -> Result<BenchmarkResult, String> {
    // 1. Load ground truth
    let truths = load_truth(&config.test_jsonl_path, config.sample_limit).await?;
    let workers = config.workers.unwrap_or_4);
    let semaphore = Arc::new(Semaphore::new(workers));

    // 2. Build detector
    let detector: Box<dyn Detector + Send + Sync> = match config.backend {
        BackendKind::Presidio => {
            let url = config.presidio_url.clone().ok_or("presidio_url required")?;
            let client = PresidioClient::new(&url).await?;
            Box::new(client)
        }
        BackendKind::Regex => {
            let patterns = [
                ("person", r"\b(?:[A-Z][a-z]+ [A-Z][a-z]+|[A-Z][a-z]+\s+[A-Z][a-z]+)\b"),
                ("email",  r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
                ("phone",  r"\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b"),
            ];
            Box::new(RegexDetector::new(&patterns).await?)
        }
        BackendKind::Llama => {
            let gguf = config.gguf_path.clone().ok_or("gguf_path required for llama backend")?;
            Box::new(llama_backend::LlamaBenchmarkDetector::new(&gguf).await?)
        }
    };

    // 3. Run evaluation
    let mut total_exact = 0;
    let mut total_partial = 0;
    let mut truth_spans = 0;
    let mut pred_spans = 0;
    let mut latencies = Vec::new();
    let mut entity_metrics: HashMap<String, (usize, usize, usize)> = Default::default(); // (tp, pred, truth)
    let mut errors = Vec::new();

    for doc in &truths {
        truth_spans += doc.spans.len();
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let detector = &*detector;
        let text = doc.text.clone();
        let spans = doc.spans.clone();
        let label_filter = config.include_labels.clone();

        // Spawn task
        let handle = tokio::spawn(async move {
            let _permit = permit; // held until task exits
            let start = std::time::Instant::now();
            let preds = detector.detect(&text).await;
            let elapsed = start.elapsed();
            (text, spans, preds, elapsed)
        });

        // For simplicity here: process sequentially. Could batch with join_all.
        let (text, truth_spans_doc, preds_res, elapsed) = handle.await.map_err(|e| e.to_string())??;
        latencies.push(elapsed.as_secs_f64() * 1000.0);

        let preds = preds_res?;
        pred_spans += preds.len();

        // Per-entity counts
        for truth in &truth_spans_doc {
            let label = entity_to_pii_type(&truth.label);
            let mut hit = false;
            for pred in &preds {
                if spans_match_exact(pred, truth, false) {
                    total_exact += 1;
                    *entity_metrics.entry(label.clone()).or_default().0 += 1; // TP
                    hit = true;
                    break;
                }
            }
            if !hit {
                // Check partial
                for pred in &preds {
                    if spans_match_exact(pred, truth, true) {
                        total_partial += 1;
                        hit = true;
                        break;
                    }
                }
            }
        }

        for pred in &preds {
            if let Some(label_filter) = &label_filter {
                if !label_filter.contains(&pred.pii_type) {
                    continue;
                }
            }
            let label = pred.pii_type.clone();
            *entity_metrics.entry(label).or_default().1 += 1; // pred count
        }

        for truth in &truth_spans_doc {
            let label = entity_to_pii_type(&truth.label);
            if let Some(label_filter) = &label_filter {
                if !label_filter.contains(&label) {
                    continue;
                }
            }
            *entity_metrics.entry(label).or_default().2 += 1; // truth count
        }
    }

    // 4. Aggregate metrics
    let micro_tp = total_exact as f64;
    let micro_fp = (pred_spans.saturating_sub(total_exact)) as f64;
    let micro_fn = (truth_spans.saturating_sub(total_exact)) as f64;

    let micro_precision = if micro_tp + micro_fp == 0.0 { 0.0 } else { micro_tp / (micro_tp + micro_fp) };
    let micro_recall    = if micro_tp + micro_fn == 0.0 { 0.0 } else { micro_tp / (micro_tp + micro_fn) };
    let micro_f1       = if micro_precision + micro_recall == 0.0 { 0.0 } else { 2.0 * micro_precision * micro_recall / (micro_precision + micro_recall) };

    let mut per_entity = Vec::new();
    for (label, (tp, pred, truth)) in entity_metrics {
        let precision = if pred as f64 == 0.0 { 0.0 } else { tp as f64 / pred as f64 };
        let recall    = if truth as f64 == 0.0 { 0.0 } else { tp as f64 / truth as f64 };
        let f1        = if precision + recall == 0.0 { 0.0 } else { 2.0 * precision * recall / (precision + recall) };
        per_entity.push(PerEntityMetrics {
            label,
            precision,
            recall,
            f1,
            support: truth,
        });
    }
    per_entity.sort_by(|a, b| b.f1.total_cmp(&a.f1));

    let avg_latency = if latencies.is_empty() { 0.0 } else { latencies.iter().sum::<f64>() / latencies.len() as f64 };

    Ok(BenchmarkResult {
        backend: format!("{:?}", config.backend),
        documents_evaluated: truths.len(),
        total_spans_truth: truth_spans,
        total_spans_pred: pred_spans,
        exact_match: total_exact,
        partial_match: total_partial,
        micro_precision,
        micro_recall,
        micro_f1,
        per_entity,
        avg_latency_ms: avg_latency,
        errors,
    })
}

// ── Helper: PiiType resolution ──────────────────────────────────────────────

fn entity_to_pii_type(label: &str) -> String {
    // Normalize Nemotron label → canonical form
    match label {
        "person" | "first_name" | "last_name" => "person_name".to_string(),
        "email_address" => "email".to_string(),
        "phone_number" => "phone".to_string(),
        "address" => "address".to_string(),
        "credit_debit_card" => "credit_card".to_string(),
        "social_security_number" => "ssn".to_string(),
        "date_of_birth" => "dob".to_string(),
        "ip_address" => "ip".to_string(),
        "url" => "url".to_string(),
        "user_name" => "username".to_string(),
        "account_number" => "account".to_string(),
        "bank_routing_number" => "routing".to_string(),
        "city" => "city".to_string(),
        "state" => "state".to_string(),
        _ => label.to_lowercase(),
    }
}
