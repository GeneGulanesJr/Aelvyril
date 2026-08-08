//! Policy enforcement + fallback integration tests.
//!
//! Drives the real gateway router in-process via `tower::ServiceExt::oneshot`
//! against mock sidecar/upstream HTTP servers, covering:
//!  - policy `block` short-circuiting the forward path (G2)
//!  - policy `warn` forwarding + pseudonymization on the wire + audit (G2)
//!  - sidecar-down / feature-off graceful degradation (G3)
//!  - the Liquid PII client wire contract against a mock sidecar
//!  - the regex fallback detection layer (no sidecars)
//!
//! NOTE: these tests deliberately do NOT use `#[tokio::test]`. `AppState::new()`
//! uses `reqwest::blocking` internally and panics inside an async runtime, so we
//! mirror `aelvyril-headless`: plain `#[test]` fn that constructs `AppState`
//! outside the runtime, then drives an async block via `Runtime::block_on`.

use std::sync::Arc;

use aelvyril_lib::audit::store::AuditStore;
use aelvyril_lib::config::ProviderConfig;
use aelvyril_lib::gateway::GatewayState;
use aelvyril_lib::pii::liquid::LiquidPiiClient;
use aelvyril_lib::pii::recognizers::{PiiMatch, PiiType};
use aelvyril_lib::pii::PiiEngine;
use aelvyril_lib::policy::linter::LiquidPolicyClient;
use aelvyril_lib::policy::{PolicyAction, PolicyRule};
use aelvyril_lib::state::AppState;

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue},
    routing::{get, post},
    Json, Router,
};
use std::sync::Mutex;
use tokio::runtime::Runtime;
use tower::ServiceExt;

// ── Fixtures ────────────────────────────────────────────────────────────────

/// Record of every request body a mock server received, in arrival order.
type ReceivedLog = Arc<Mutex<Vec<serde_json::Value>>>;

/// A mock sidecar implementing the Liquid policy + PII wire contracts.
///
/// - `POST /liquid/policy` → emits a violation per rule whose `text` occurs
///   case-insensitively in the input `text`.
/// - `POST /liquid/pii` → emits an email span when `text` contains
///   `"john@acme.com"`.
/// - `GET /health` → ok.
async fn mock_sidecar() -> (std::net::SocketAddr, ReceivedLog) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let received: ReceivedLog = Arc::new(Mutex::new(Vec::new()));

    let received_clone = received.clone();
    let app = Router::new().route(
        "/liquid/policy",
        post(move |State(_): State<()>, Json(body): Json<serde_json::Value>| {
            let received = received_clone.clone();
            async move {
                received.lock().unwrap().push(body.clone());
                let text = body
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                let text_lower = text.to_lowercase();
                let rules = body
                    .get("rules")
                    .and_then(|r| r.as_array())
                    .cloned()
                    .unwrap_or_default();
                let mut violations = Vec::new();
                for (i, rule) in rules.iter().enumerate() {
                    let rule_text = rule
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    let action = rule
                        .get("action")
                        .and_then(|a| a.as_str())
                        .unwrap_or("warn")
                        .to_string();
                    if let Some(idx) = text_lower.find(&rule_text.to_lowercase()) {
                        let end = idx + rule_text.len();
                        violations.push(serde_json::json!({
                            "rule_index": i,
                            "rule_text": rule_text,
                            "action": action,
                            "token_text": &text[idx..end],
                            "start": idx,
                            "end": end,
                            "score": 0.95,
                        }));
                    }
                }
                Json(serde_json::json!({ "violations": violations }))
            }
        }),
    );

    let received_clone2 = received.clone();
    let app = app.route(
        "/liquid/pii",
        post(move |State(_): State<()>, Json(body): Json<serde_json::Value>| {
            let _received = received_clone2.clone();
            async move {
                let text = body
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                let result = if let Some(start) = text.find("john@acme.com") {
                    let end = start + "john@acme.com".len();
                    vec![serde_json::json!({
                        "entity_type": "contact.email",
                        "start": start,
                        "end": end,
                        "score": 0.99,
                    })]
                } else {
                    Vec::new()
                };
                Json(serde_json::json!({ "result": result }))
            }
        }),
    );

    let app = app.route(
        "/health",
        get(|| async { Json(serde_json::json!({"status": "ok"})) }),
    );

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, received)
}

/// A mock OpenAI-compatible upstream. Records every received request body.
async fn mock_upstream() -> (std::net::SocketAddr, ReceivedLog) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let received: ReceivedLog = Arc::new(Mutex::new(Vec::new()));

    let received_clone = received.clone();
    let app = Router::new().route(
        "/chat/completions",
        post(move |State(_): State<()>, Json(body): Json<serde_json::Value>| {
            let received = received_clone.clone();
            async move {
                received.lock().unwrap().push(body);
                Json(serde_json::json!({
                    "id": "cmpl-test",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "none",
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": "ack"},
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
                }))
            }
        }),
    );

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, received)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Build a fully-wired `AppState` + `GatewayState` pointing at the given mock
/// upstream/sidecar, returning both plus the per-test audit DB path to clean up.
async fn build_state(
    app_state: &Arc<tokio::sync::RwLock<AppState>>,
    upstream_url: &str,
    sidecar_url: &str,
    liquid_policy_enabled: bool,
    rules: Vec<PolicyRule>,
) -> (GatewayState, std::path::PathBuf) {
    let audit_path = std::env::temp_dir().join(format!(
        "aelvyril-policy-test-{}-{}.db",
        std::process::id(),
        uuid_v4()
    ));
    // Remove any leftover DB from a previous run with the same unique id.
    let _ = std::fs::remove_file(&audit_path);

    {
        let mut state = app_state.write().await;
        state.gateway_key = Some("aelvyril-benchmark-key".to_string());
        state.providers.clear();
        state.providers.push(ProviderConfig {
            id: "benchmark-dummy".into(),
            name: "BenchmarkDummy".into(),
            base_url: upstream_url.into(),
            models: vec!["none".into()],
        });
        state.rate_limiter = aelvyril_lib::security::rate_limit::RateLimiter::new(
            aelvyril_lib::security::rate_limit::RateLimitConfig {
                max_requests_per_minute: 10_000,
                max_requests_per_hour: 1_000_000,
                max_concurrent_requests: 1_000,
            },
        );
        state.settings.liquid_policy_enabled = liquid_policy_enabled;
        state.settings.policy_rules = rules;
        state.policy_client = Arc::new(tokio::sync::RwLock::new(
            LiquidPolicyClient::builder(sidecar_url.to_string(), true).build(),
        ));
        state.audit_store = Some(AuditStore::open(&audit_path).expect("audit db open"));
    }

    let pii_engine = {
        let s = app_state.read().await;
        s.pii_engine.clone()
    };

    let gw_state = GatewayState {
        app_state: app_state.clone(),
        http_client: reqwest::Client::new(),
        pii_engine,
    };

    (gw_state, audit_path)
}

/// Cheap unique id without pulling another dep on uuid here.
fn uuid_v4() -> String {
    // AppState pulls uuid transitively; reuse the macro-free path.
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

fn build_request(session_id: &str, text: &str) -> axum::http::Request<axum::body::Body> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str("Bearer aelvyril-benchmark-key").unwrap(),
    );
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers.insert(
        "x-session-id",
        HeaderValue::from_str(session_id).unwrap(),
    );
    let body = serde_json::json!({
        "model": "none",
        "messages": [{"role": "user", "content": text}],
    });
    axum::http::Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .version(axum::http::Version::HTTP_11)
        .body(axum::body::Body::from(body.to_string()))
        .map(|mut r| {
            // builder().header() would be simpler, but we already assembled them.
            let _ = std::mem::replace(r.headers_mut(), headers);
            r
        })
        .unwrap()
}

// ── Tests ───────────────────────────────────────────────────────────────────

/// Test 1 — a `block` rule short-circuits the forward path with 400, leaves
/// the upstream untouched, and records a blocked policy event.
#[test]
fn policy_block_short_circuits_forward() {
    std::env::set_var("AELVYRIL_KEY_BENCHMARKDUMMY", "test-key");

    let app_state = Arc::new(tokio::sync::RwLock::new(AppState::new()));
    let rt = Runtime::new().unwrap();

    rt.block_on(async {
        let (upstream_addr, upstream_recv) = mock_upstream().await;
        let (sidecar_addr, _sidecar_recv) = mock_sidecar().await;
        let upstream_url = format!("http://{}", upstream_addr);
        let sidecar_url = format!("http://{}", sidecar_addr);

        let rules = vec![PolicyRule {
            text: "api keys".into(),
            action: PolicyAction::Block,
            enabled: true,
        }];
        let (gw_state, audit_path) = build_state(
            &app_state,
            &upstream_url,
            &sidecar_url,
            true,
            rules,
        )
        .await;

        let app = aelvyril_lib::gateway::build_gateway_router(gw_state.clone());
        let req = build_request(
            "block-test",
            "Please ship the api keys to the staging box",
        );
        let resp = app.oneshot(req).await.unwrap();

        // Give the upstream a beat to (not) be hit; it never should be.
        assert_eq!(resp.status(), axum::http::StatusCode::BAD_REQUEST);

        // Body must report the policy_violation type.
        let body_bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(
            body["error"]["type"].as_str(),
            Some("policy_violation"),
            "expected policy_violation error, got: {body}"
        );

        // Upstream never received a request.
        assert!(
            upstream_recv.lock().unwrap().is_empty(),
            "block must short-circuit the forward path"
        );

        // Audit store records a blocked event for the rule.
        let audit = gw_state.app_state.read().await;
        let events = audit
            .audit_store
            .as_ref()
            .expect("audit store")
            .get_policy_events(100)
            .expect("policy events");
        drop(audit);
        assert!(
            events.iter().any(|e| e.action == "block"
                && e.blocked
                && e.rule_text == "api keys"),
            "expected a blocked 'api keys' event, got: {events:?}"
        );

        let _ = std::fs::remove_file(&audit_path);
    });
}

/// Test 2 — a `warn` rule forwards the request, pseudonymizes PII on the wire,
/// and records a non-blocked audit event.
#[test]
fn policy_warn_forwards_and_audits() {
    std::env::set_var("AELVYRIL_KEY_BENCHMARKDUMMY", "test-key");

    let app_state = Arc::new(tokio::sync::RwLock::new(AppState::new()));
    let rt = Runtime::new().unwrap();

    rt.block_on(async {
        let (upstream_addr, upstream_recv) = mock_upstream().await;
        let (sidecar_addr, _sidecar_recv) = mock_sidecar().await;
        let upstream_url = format!("http://{}", upstream_addr);
        let sidecar_url = format!("http://{}", sidecar_addr);

        let rules = vec![PolicyRule {
            text: "demo meeting".into(),
            action: PolicyAction::Warn,
            enabled: true,
        }];
        let (gw_state, audit_path) = build_state(
            &app_state,
            &upstream_url,
            &sidecar_url,
            true,
            rules,
        )
        .await;

        let app = aelvyril_lib::gateway::build_gateway_router(gw_state.clone());
        let req = build_request(
            "warn-test",
            "Reminder: demo meeting at 3pm, contact john@acme.com",
        );
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);

        // Drain the response body so the forward completes.
        let _ = axum::body::to_bytes(resp.into_body(), usize::MAX).await;

        // Exactly one upstream request, with the email pseudonymized.
        let recv = upstream_recv.lock().unwrap().clone();
        assert_eq!(recv.len(), 1, "upstream should receive exactly one request");
        let serialized = serde_json::to_string(&recv[0]).unwrap();
        assert!(
            !serialized.contains("john@acme.com"),
            "email must be pseudonymized on the wire, got: {serialized}"
        );
        assert!(
            regex::Regex::new(r"\[EMAIL_ADDRESS_\d+\]").unwrap().is_match(&serialized),
            "expected a pseudonym token matching [EMAIL_ADDRESS_<n>], got: {serialized}"
        );

        let audit = gw_state.app_state.read().await;
        let events = audit
            .audit_store
            .as_ref()
            .expect("audit store")
            .get_policy_events(100)
            .expect("policy events");
        drop(audit);
        assert!(
            events
                .iter()
                .any(|e| e.action == "warn" && !e.blocked),
            "expected a warn (non-blocked) event, got: {events:?}"
        );

        let _ = std::fs::remove_file(&audit_path);
    });
}

/// Test 3 — when the policy sidecar is unreachable, the linter degrades
/// gracefully and the request is forwarded normally (no policy events).
#[test]
fn policy_sidecar_down_degrades_to_forward() {
    std::env::set_var("AELVYRIL_KEY_BENCHMARKDUMMY", "test-key");

    let app_state = Arc::new(tokio::sync::RwLock::new(AppState::new()));
    let rt = Runtime::new().unwrap();

    rt.block_on(async {
        let (upstream_addr, upstream_recv) = mock_upstream().await;
        let upstream_url = format!("http://{}", upstream_addr);

        // Bind a port then immediately drop the listener → dead port.
        let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let sidecar_port = dead.local_addr().unwrap().port();
        drop(dead);
        let sidecar_url = format!("http://127.0.0.1:{}", sidecar_port);

        let rules = vec![PolicyRule {
            text: "api keys".into(),
            action: PolicyAction::Block,
            enabled: true,
        }];
        let (gw_state, audit_path) =
            build_state(&app_state, &upstream_url, &sidecar_url, true, rules).await;

        let app = aelvyril_lib::gateway::build_gateway_router(gw_state.clone());
        let req = build_request(
            "sidecar-down",
            "Please ship the api keys to the staging box",
        );
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let _ = axum::body::to_bytes(resp.into_body(), usize::MAX).await;

        assert_eq!(upstream_recv.lock().unwrap().len(), 1);

        let audit = gw_state.app_state.read().await;
        let events = audit
            .audit_store
            .as_ref()
            .expect("audit store")
            .get_policy_events(100)
            .expect("policy events");
        drop(audit);
        assert!(
            events.is_empty(),
            "sidecar-down must not record any policy events, got: {events:?}"
        );

        let _ = std::fs::remove_file(&audit_path);
    });
}

/// Test 4 — with the feature disabled, enforcement is skipped entirely.
#[test]
fn policy_disabled_skips_enforcement() {
    std::env::set_var("AELVYRIL_KEY_BENCHMARKDUMMY", "test-key");

    let app_state = Arc::new(tokio::sync::RwLock::new(AppState::new()));
    let rt = Runtime::new().unwrap();

    rt.block_on(async {
        let (upstream_addr, upstream_recv) = mock_upstream().await;
        let (sidecar_addr, _sidecar_recv) = mock_sidecar().await;
        let upstream_url = format!("http://{}", upstream_addr);
        let sidecar_url = format!("http://{}", sidecar_addr);

        let rules = vec![PolicyRule {
            text: "api keys".into(),
            action: PolicyAction::Block,
            enabled: true,
        }];
        let (gw_state, audit_path) =
            build_state(&app_state, &upstream_url, &sidecar_url, false, rules).await;

        let app = aelvyril_lib::gateway::build_gateway_router(gw_state.clone());
        let req = build_request(
            "disabled-test",
            "Please ship the api keys to the staging box",
        );
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let _ = axum::body::to_bytes(resp.into_body(), usize::MAX).await;

        assert_eq!(upstream_recv.lock().unwrap().len(), 1);

        let audit = gw_state.app_state.read().await;
        let events = audit
            .audit_store
            .as_ref()
            .expect("audit store")
            .get_policy_events(100)
            .expect("policy events");
        drop(audit);
        assert!(
            events.is_empty(),
            "disabled policy must not record any events, got: {events:?}"
        );

        let _ = std::fs::remove_file(&audit_path);
    });
}

/// Test 5 — the Liquid PII client wire contract against a mock sidecar.
#[test]
fn liquid_pii_detection_via_mock_sidecar() {
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        let (sidecar_addr, _recv) = mock_sidecar().await;
        let url = format!("http://{}", sidecar_addr);

        let client = LiquidPiiClient::new(url, true);
        let matches = client
            .analyze("Contact john@acme.com for details")
            .await
            .expect("sidecar up → Some(matches)");

        assert!(
            matches.iter().any(|m: &PiiMatch| {
                m.pii_type == PiiType::ContactEmail && m.text == "john@acme.com"
            }),
            "expected a ContactEmail match for john@acme.com, got: {matches:?}"
        );
    });
}

/// Test 6 — the regex fallback detects PII without any sidecar (Presidio + Liquid
/// both disabled, proving the layered regex layer alone).
#[test]
fn regex_fallback_detects_without_sidecars() {
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        let mut engine = PiiEngine::new();
        engine.set_presidio_enabled(false); // Liquid is disabled by default.

        let matches = engine.detect("Contact john@acme.com or 10.0.0.5").await;

        // The regex layer emits the legacy (Presidio-compatible) namespace via
        // Display: Email → "EMAIL_ADDRESS", IpAddress → "IP_ADDRESS". Compare by
        // Display so this is robust to whichever variant the detector produces.
        let has_email = matches
            .iter()
            .any(|m| m.pii_type.to_string() == "EMAIL_ADDRESS");
        let has_ip = matches
            .iter()
            .any(|m| m.pii_type.to_string() == "IP_ADDRESS");
        assert!(
            has_email,
            "regex fallback must detect an email, got: {matches:?}"
        );
        assert!(
            has_ip,
            "regex fallback must detect an IP address, got: {matches:?}"
        );
    });
}

// ── Multibyte span-safety regression tests ─────────────────────────────────
//
// The PII span offsets from Presidio / the Liquid encoder are byte offsets.
// Slicing a `&str` directly with byte offsets that split a multibyte UTF-8
// char panics the tokio worker and drops the request. These tests drive the
// real client paths against an in-process mock sidecar that deliberately
// returns a span landing inside a multibyte char, asserting NO PANIC and a
// graceful skip (the misaligned span is dropped, others survive).

/// A mock sidecar whose `/liquid/pii` echoes back a caller-controlled span set
/// so we can feed it a span that splits a multibyte char.
async fn mock_sidecar_fixed_spans(
    spans: Vec<serde_json::Value>,
) -> std::net::SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let app = Router::new().route(
        "/liquid/pii",
        post(move |State(_): State<()>, Json(body): Json<serde_json::Value>| {
            let spans = spans.clone();
            async move {
                // Sanity: echo only when the request actually carried text.
                let _ = body.get("text").and_then(|t| t.as_str());
                Json(serde_json::json!({ "result": spans }))
            }
        }),
    );

    let app = app.route(
        "/health",
        get(|| async { Json(serde_json::json!({"status": "ok"})) }),
    );

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

/// Test 7 — the Liquid PII client must not panic on a multibyte-misaligned
/// span from the sidecar; the misaligned span is skipped and any aligned
/// span survives.
#[test]
fn liquid_pii_multibyte_misaligned_span_does_not_panic() {
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        // "Mi correo es josé@x.com" — 'é' in "josé" is 2 bytes at byte
        // offsets 16..18. We hand the client two spans: one that splits the
        // 'é' (must be skipped), and one valid email span (must survive).
        let text = "Mi correo es josé@x.com";
        // A span [16..17] splits the 'é' (bytes 16..18).
        let split_span = serde_json::json!({
            "entity_type": "contact.email",
            "start": 16,
            "end": 17,
            "score": 0.99,
        });
        // A fully valid, char-aligned email span.
        let email_start = text.find("josé@x.com").unwrap();
        let valid_span = serde_json::json!({
            "entity_type": "contact.email",
            "start": email_start,
            "end": email_start + "josé@x.com".len(),
            "score": 0.99,
        });

        let addr = mock_sidecar_fixed_spans(vec![split_span, valid_span]).await;
        let url = format!("http://{}", addr);
        let client = LiquidPiiClient::new(url, true);

        // Must NOT panic.
        let matches = client
            .analyze(text)
            .await
            .expect("sidecar up → Some(matches)");

        // The misaligned span was dropped; the aligned email span survived
        // with its correct text.
        let emails: Vec<&PiiMatch> = matches
            .iter()
            .filter(|m| m.pii_type == PiiType::ContactEmail)
            .collect();
        assert_eq!(
            emails.len(),
            1,
            "misaligned span must be skipped, aligned span kept: {matches:?}"
        );
        assert_eq!(emails[0].text, "josé@x.com");
    });
}

/// Test 8 — detect → pseudonymize through the real engine on an accented
/// sentence must complete without panic. Uses the regex fallback layer (no
/// sidecar) so it runs anywhere; the point is the full pipeline never panics
/// on multibyte input.
#[test]
fn engine_detect_pseudonymize_accented_sentence_no_panic() {
    use aelvyril_lib::pseudonym::tokenizer::Pseudonymizer;

    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        let text = "Mi correo es josé@example.com y mi teléfono es 555-123-4567.";
        let mut engine = PiiEngine::new();
        engine.set_presidio_enabled(false); // regex fallback only (no sidecar).

        // Must not panic on the accented input.
        let matches = engine.detect(text).await;
        // Refuse to panic: the test reaching this line is the primary
        // assertion. As a secondary check, SOMETHING PII-like must be
        // detected (the accented input still carries a domain + phone). The
        // email recognizer is ASCII-focused, so on this accented local part
        // it surfaces as a Domain match rather than an Email — that is the
        // existing recognizer behavior and is not what this regression test
        // is about; the point is NO PANIC through detect → pseudonymize.
        assert!(
            !matches.is_empty(),
            "regex layer must still detect *something* on accented input: {matches:?}"
        );

        // Pseudonymize must also not panic — all returned spans are
        // char-aligned (they come from regex matches), so the tokens are
        // substituted in place.
        let mut p = Pseudonymizer::new();
        let (pseudonymized, mappings) = p.pseudonymize(text, &matches);
        assert!(
            mappings.iter().any(|m| m.original == "example.com"),
            "domain mapping must be recorded: {mappings:?}"
        );
        assert!(
            pseudonymized.contains("[URL_1]"),
            "a token must appear: {pseudonymized}"
        );
    });
}
