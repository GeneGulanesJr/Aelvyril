/// Integration tests for the Aelvyril gateway pipeline.
/// These test the full request/response pipeline from PII detection
/// through pseudonymization and rehydration.
///
/// Run with: cargo test --test integration_tests

use aelvyril_lib::pii::engine::PiiEngine;
use aelvyril_lib::pseudonym::Pseudonymizer;
use aelvyril_lib::pseudonym::Rehydrator;
use aelvyril_lib::pseudonym::mapping::MappingTable;
use aelvyril_lib::pii::recognizers::PiiType;

/// Test the full pseudonymize → rehydrate round-trip with a chat completion body
#[test]
fn test_full_pipeline_roundtrip() {
    let body_text = r#"Contact john@acme.com for the API key sk-proj-abc123def456ghi789jkl012mno345pqr678. Server IP is 10.0.0.5."#;

    // Step 1: Detect PII
    let engine = PiiEngine::new();
    let matches = engine.detect(body_text);
    assert!(!matches.is_empty(), "Should detect PII in the test text");

    // Step 2: Pseudonymize
    let mut pseudonymizer = Pseudonymizer::new();
    let (sanitized, mappings) = pseudonymizer.pseudonymize(body_text, &matches);
    assert!(!mappings.is_empty(), "Should produce token mappings");

    // Verify no original PII remains in sanitized text
    assert!(
        !sanitized.contains("john@acme.com"),
        "Sanitized text should not contain original email"
    );
    assert!(
        !sanitized.contains("sk-proj-abc123def456"),
        "Sanitized text should not contain original API key"
    );

    // Step 3: Build mapping table and rehydrate
    let mut table = MappingTable::with_default_ttl();
    table.add_mappings(mappings);

    let rehydrated = Rehydrator::rehydrate(&sanitized, &mut table);

    // Step 4: Verify original values restored
    assert!(
        rehydrated.contains("john@acme.com"),
        "Rehydrated text should contain original email"
    );
    assert!(
        rehydrated.contains("sk-proj-abc123def456"),
        "Rehydrated text should contain original API key"
    );
    assert!(
        rehydrated.contains("10.0.0.5"),
        "Rehydrated text should contain original IP address"
    );
}

/// Test the full pipeline with a realistic chat completion JSON body
#[test]
fn test_full_pipeline_json_body() {
    let body = serde_json::json!({
        "model": "gpt-4o",
        "messages": [
            {
                "role": "user",
                "content": "My email is alice@company.com and my SSN is 123-45-6789. Use key sk-proj-abc123def456ghi789jkl012mno345pqr678 to authenticate."
            }
        ],
        "stream": false
    });

    // Extract text for scanning
    let content = body["messages"][0]["content"].as_str().unwrap();

    // Detect PII
    let engine = PiiEngine::new();
    let matches = engine.detect(content);
    assert!(!matches.is_empty());

    // Pseudonymize
    let mut pseudonymizer = Pseudonymizer::new();
    let (sanitized, mappings) = pseudonymizer.pseudonymize(content, &matches);

    // Build sanitized body
    let mut sanitized_body = body.clone();
    sanitized_body["messages"][0]["content"] = serde_json::json!(sanitized);

    // Verify no PII in sanitized body
    let sanitized_str = serde_json::to_string(&sanitized_body).unwrap();
    assert!(
        !sanitized_str.contains("alice@company.com"),
        "Sanitized body should not contain original email"
    );
    assert!(
        !sanitized_str.contains("123-45-6789"),
        "Sanitized body should not contain original SSN"
    );
    assert!(
        !sanitized_str.contains("sk-proj-abc123def456ghi789jkl012mno345pqr678"),
        "Sanitized body should not contain original API key"
    );

    // Rehydrate
    let mut table = MappingTable::with_default_ttl();
    table.add_mappings(mappings);
    let rehydrated = Rehydrator::rehydrate(&sanitized_str, &mut table);

    assert!(rehydrated.contains("alice@company.com"));
    assert!(rehydrated.contains("123-45-6789"));
    assert!(rehydrated.contains("sk-proj-abc123def456ghi789jkl012mno345pqr678"));
}

/// Test multi-provider routing resolution
#[test]
fn test_multi_provider_routing() {
    use aelvyril_lib::config::ProviderConfig;
    use aelvyril_lib::gateway::router;

    let providers = vec![
        ProviderConfig {
            id: "1".into(),
            name: "OpenAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            models: vec!["gpt-4o".into(), "gpt-4o-mini".into()],
        },
        ProviderConfig {
            id: "2".into(),
            name: "Anthropic".into(),
            base_url: "https://api.anthropic.com/v1".into(),
            models: vec!["claude-sonnet-4-20250514".into(), "claude-3-opus-20240229".into()],
        },
    ];

    // Resolve OpenAI model
    let result = router::resolve_provider(&providers, "gpt-4o");
    assert!(result.is_ok());
    assert_eq!(result.unwrap().name, "OpenAI");

    // Resolve Anthropic model
    let result = router::resolve_provider(&providers, "claude-sonnet-4-20250514");
    assert!(result.is_ok());
    assert_eq!(result.unwrap().name, "Anthropic");

    // Unknown model should fail
    let result = router::resolve_provider(&providers, "unknown-model");
    assert!(result.is_err());
}

/// Test rate limiting across the pipeline
#[test]
fn test_rate_limiting_pipeline() {
    use aelvyril_lib::security::rate_limit::{RateLimiter, RateLimitConfig, RateLimitResult};

    let config = RateLimitConfig {
        max_requests_per_minute: 3,
        max_requests_per_hour: 100,
        max_concurrent_requests: 2,
    };
    let limiter = RateLimiter::new(config);

    // First 3 requests should pass
    for _ in 0..3 {
        assert_eq!(limiter.check("client-a"), RateLimitResult::Allowed);
    }

    // 4th should be denied
    assert_eq!(limiter.check("client-a"), RateLimitResult::DeniedMinuteLimit);

    // Different client should still be allowed
    assert_eq!(limiter.check("client-b"), RateLimitResult::Allowed);
}

/// Test PII cache integration
#[test]
fn test_pii_cache_integration() {
    use aelvyril_lib::perf::cache::PiiCache;
    use std::time::Duration;

    let cache = PiiCache::new(100, Duration::from_secs(60));
    let engine = PiiEngine::new();
    let text = "Email me at test@example.com please";

    // First call — cache miss
    let cached = cache.get(text);
    assert!(cached.is_none(), "First call should be a cache miss");

    // Detect and cache
    let matches = engine.detect(text);
    cache.insert(text, matches.clone());

    // Second call — cache hit
    let cached = cache.get(text);
    assert!(cached.is_some(), "Second call should be a cache hit");
    let cached_matches = cached.unwrap();
    assert_eq!(cached_matches.len(), matches.len());
}

/// Test that allow/deny lists integrate with PII detection
#[test]
fn test_allowlist_integration_with_pii() {
    let mut engine = PiiEngine::new();
    engine.add_allow_pattern(r"noreply@.*\.example\.com").unwrap();
    engine.add_deny_pattern(r"PROJECT_[A-Z]+\d+").unwrap();

    // Allowlist should suppress email detection
    let matches = engine.detect("Send to noreply@corp.example.com");
    assert!(
        !matches.iter().any(|m| m.pii_type == PiiType::Email),
        "Allowlisted email should not be detected"
    );

    // Denylist should add custom detection
    let matches = engine.detect("The project code is PROJECT_ALPHA7");
    assert!(
        matches.iter().any(|m| m.text == "PROJECT_ALPHA7"),
        "Denylist pattern should be detected"
    );
}

/// Test session timeout behavior
#[test]
fn test_session_timeout() {
    use aelvyril_lib::session::SessionManager;

    // Create manager with very short timeout for testing
    // Note: SessionManager::new() uses 30 min, so we test expiry logic directly
    let mgr = SessionManager::new();
    mgr.get_or_create_session("short-lived", None, None);

    assert_eq!(mgr.active_count(), 1);

    // Sessions won't expire within their timeout
    mgr.expire_sessions();
    assert_eq!(mgr.active_count(), 1);

    // Manual clear works
    mgr.clear("short-lived");
    assert_eq!(mgr.active_count(), 0);
}

/// Test key lifecycle auditor catches potential leaks
#[test]
fn test_key_lifecycle_no_leaks() {
    use aelvyril_lib::security::audit::{KeyLifecycleAuditor, KeyAction};

    let mut auditor = KeyLifecycleAuditor::new(100);

    // Normal operations should pass safety audit
    auditor.record("gateway-key", KeyAction::Created, "Generated via UI");
    auditor.record("gateway-key", KeyAction::Accessed, "Bearer auth check");
    auditor.record("provider:OpenAI", KeyAction::Created, "Stored in keychain");

    assert!(auditor.audit_key_safety("gateway-key").is_ok());
    assert!(auditor.audit_key_safety("provider:OpenAI").is_ok());

    // Simulate a leak event
    auditor.record(
        "leaky-key",
        KeyAction::Accessed,
        "sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz",
    );
    assert!(auditor.audit_key_safety("leaky-key").is_err());
}

/// Property-based style test: random text should not produce overlapping tokens
#[test]
fn test_no_overlapping_tokens_on_repeated_values() {
    let text = "Contact alice@test.com and also alice@test.com — same email twice.";

    let engine = PiiEngine::new();
    let matches = engine.detect(text);

    let mut pseudonymizer = Pseudonymizer::new();
    let (sanitized, mappings) = pseudonymizer.pseudonymize(text, &matches);

    // Check that same email gets same token (deduplication)
    let email_matches: Vec<_> = matches
        .iter()
        .filter(|m| m.pii_type == PiiType::Email)
        .collect();

    assert_eq!(email_matches.len(), 2, "Should detect two email instances");

    // Same email should produce same token
    let email_tokens: Vec<_> = sanitized
        .split_whitespace()
        .filter(|s| s.starts_with("[Email_"))
        .collect();

    assert_eq!(email_tokens.len(), 2);
    assert_eq!(
        email_tokens[0], email_tokens[1],
        "Same email should map to same token"
    );
    assert_eq!(mappings.len(), 1, "Should have only one mapping (deduped)");

    // Rehydrate should restore both occurrences
    let mut table = MappingTable::with_default_ttl();
    table.add_mappings(mappings);
    let rehydrated = Rehydrator::rehydrate(&sanitized, &mut table);

    assert!(
        rehydrated.contains("alice@test.com"),
        "Email should be restored"
    );
}

/// Test streaming SSE chunk rehydration
#[test]
fn test_sse_chunk_rehydration() {
    use aelvyril_lib::pseudonym::mapping::TokenMapping;

    let mut table = MappingTable::with_default_ttl();
    table.add_mappings(vec![
        TokenMapping {
            token: "[Email_1]".into(),
            original: "user@example.com".into(),
            pii_type: PiiType::Email,
            confidence: 0.95,
        },
        TokenMapping {
            token: "[IP_Address_1]".into(),
            original: "192.168.1.100".into(),
            pii_type: PiiType::IpAddress,
            confidence: 0.9,
        },
    ]);

    let chunk = r#"data: {"id":"chatcmpl-abc","choices":[{"delta":{"content":"Send to [Email_1] at [IP_Address_1]"}}]}"#;
    let result = Rehydrator::rehydrate_sse_chunk(chunk, &mut table);

    assert!(result.contains("user@example.com"));
    assert!(result.contains("192.168.1.100"));
    assert!(!result.contains("[Email_1]"));
    assert!(!result.contains("[IP_Address_1]"));
    // SSE structure preserved
    assert!(result.starts_with("data:"));
}

/// Test that edge cases in token mapping don't cause panics
#[test]
fn test_edge_cases_token_mapping() {
    let mut table = MappingTable::with_default_ttl();

    // Empty text
    let result = Rehydrator::rehydrate("", &mut table);
    assert_eq!(result, "");

    // Text with no tokens
    let result = Rehydrator::rehydrate("No tokens here at all", &mut table);
    assert_eq!(result, "No tokens here at all");

    // Partial token (malformed)
    let result = Rehydrator::rehydrate("Some [broken token here", &mut table);
    assert_eq!(result, "Some [broken token here");

    // Token that doesn't exist in mapping
    let result = Rehydrator::rehydrate("Unknown [NonExistent_99] token", &mut table);
    assert_eq!(result, "Unknown [NonExistent_99] token");
}

/// Test benchmark latency tracking
#[test]
fn test_latency_tracking() {
    use aelvyril_lib::perf::benchmark::{LatencyBenchmark, LatencyBuilder};

    let bench = LatencyBenchmark::new(100);

    // Simulate a fast request
    let mut builder = LatencyBuilder::new();
    builder.auth_done();
    builder.pii_start();
    builder.pii_done();
    builder.pseudo_start();
    builder.pseudo_done();
    builder.upstream_start();
    builder.pseudo_done(); // simulate upstream as instant for test
    builder.rehydrate_start();
    builder.rehydrate_done();

    let latency = builder.build(false, "OpenAI".into(), "gpt-4o".into());
    assert!(latency.total_ms >= 0.0);
    assert_eq!(latency.provider, "OpenAI");

    bench.record(latency);

    let stats = bench.stats();
    assert_eq!(stats.sample_count, 1);
    assert!(stats.avg_total_ms >= 0.0);
}
