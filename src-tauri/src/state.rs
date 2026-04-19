use std::sync::Arc;

use tokio::sync::RwLock;

use crate::audit::store::AuditStore;
use crate::clipboard::monitor::ClipboardMonitor;
use crate::config::{self, AppSettings};
use crate::lists::ListManager;
use crate::perf::benchmark::LatencyBenchmark;
use crate::perf::cache::PiiCache;
use crate::pii::{PiiEngine, PresidioService};
use crate::security::audit::KeyLifecycleAuditor;
use crate::security::rate_limit::RateLimiter;
use crate::session::SessionManager;
use crate::token_usage::store::TokenUsageStore;
use crate::token_usage::tracker::TokenUsageTracker;

pub type SharedState = Arc<RwLock<AppState>>;

/// Shared application state
pub struct AppState {
    pub gateway_key: Option<String>,
    pub gateway_port: u16,
    pub gateway_bind_address: String,
    pub providers: Vec<config::ProviderConfig>,
    pub session_manager: SessionManager,
    pub audit_store: Option<AuditStore>,
    pub settings: AppSettings,
    pub list_manager: ListManager,
    pub clipboard_monitor: Arc<ClipboardMonitor>,
    pub onboarding_complete: bool,
    /// Rate limiter for gateway requests
    pub rate_limiter: RateLimiter,
    /// PII detection result cache
    pub pii_cache: PiiCache,
    /// Latency benchmark tracker
    pub latency_benchmark: LatencyBenchmark,
    /// Key lifecycle auditor
    pub key_auditor: Arc<parking_lot::Mutex<KeyLifecycleAuditor>>,
    /// Shared PII engine — gateway and Tauri commands both reference this
    /// so allow/deny list changes propagate to the hot path immediately.
    pub pii_engine: Arc<RwLock<PiiEngine>>,
    /// Presidio Python service lifecycle manager
    pub presidio_service: Arc<parking_lot::Mutex<PresidioService>>,
    /// Token usage statistics tracker
    pub token_usage_tracker: Arc<TokenUsageTracker>,
    /// Persistent token usage store (SQLite)
    pub token_usage_store: Option<TokenUsageStore>,
}

/// Open the token usage SQLite database.
/// Returns None on failure (graceful degradation).
fn open_token_usage_db() -> Option<TokenUsageStore> {
    let db_path = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("aelvyril")
        .join("token_usage.db");

    if let Some(parent) = db_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!("Failed to create token usage DB directory: {}", e);
        }
    }

    match TokenUsageStore::open(&db_path) {
        Ok(store) => {
            tracing::info!("📊 Token usage database opened at {:?}", db_path);
            Some(store)
        }
        Err(e) => {
            tracing::warn!("Failed to open token usage database: {}", e);
            None
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        let pii_engine = crate::pii::PiiEngine::new();
        let shared_pii_engine = Arc::new(RwLock::new(pii_engine.clone()));
        let clipboard_monitor = Arc::new(ClipboardMonitor::new(pii_engine));
        let settings = crate::config::store::load_settings();
        let rate_limit_config = crate::security::rate_limit::RateLimitConfig {
            max_requests_per_minute: settings.rate_limit_max_requests_per_minute,
            max_requests_per_hour: settings.rate_limit_max_requests_per_hour,
            max_concurrent_requests: settings.rate_limit_max_concurrent_requests,
        };

        // Try to open audit database
        let audit_store = crate::audit::open::open_audit_db();

        // Try to open token usage database
        let token_usage_store = open_token_usage_db();
        let token_usage_tracker = Arc::new(TokenUsageTracker::with_store(
            token_usage_store.as_ref().map(|s| std::sync::Arc::new(s.clone())),
        ));

        Self {
            gateway_key: None,
            gateway_port: settings.gateway_port,
            gateway_bind_address: settings.gateway_bind_address.clone(),
            providers: Vec::new(),
            session_manager: SessionManager::new(),
            audit_store,
            settings,
            list_manager: ListManager::new(),
            clipboard_monitor,
            onboarding_complete: false,
            rate_limiter: RateLimiter::new(rate_limit_config),
            pii_cache: PiiCache::with_defaults(),
            latency_benchmark: LatencyBenchmark::with_defaults(),
            key_auditor: Arc::new(parking_lot::Mutex::new(
                KeyLifecycleAuditor::with_default_capacity(),
            )),
            pii_engine: shared_pii_engine,
            presidio_service: Arc::new(parking_lot::Mutex::new(PresidioService::new())),
            token_usage_tracker,
            token_usage_store,
        }
    }
}

