/// Cost estimation for known models.
///
/// Pricing is stored as integer cents to avoid float precision bugs.
/// Prices are based on publicly available pricing as of the PRICING_AS_OF date.
/// When pricing data is missing for a model, cost_unavailable = true and cost = 0.
///
/// **NOTE:** Pricing changes over time. The `pricing_as_of` field is included
/// in every event so historical data can be interpreted correctly. Re-index
/// this table when provider pricing changes.
use std::collections::HashMap;

use once_cell::sync::Lazy;

/// Date this pricing table was last verified.
pub const PRICING_AS_OF: &str = "2025-01-15";

/// Per-1M-token pricing in cents (integer).
#[derive(Debug, Clone, Copy)]
struct ModelPricing {
    /// Input price per 1M tokens, in cents.
    input_per_m_cents: u64,
    /// Cached input price per 1M tokens, in cents (0 = same as input).
    cached_input_per_m_cents: u64,
    /// Output price per 1M tokens, in cents.
    output_per_m_cents: u64,
    /// Estimated system prompt tokens for this model family (typical).
    system_prompt_estimate: u64,
}

/// Known model pricing table.
static PRICING_TABLE: Lazy<HashMap<&'static str, ModelPricing>> = Lazy::new(|| {
    let mut m = HashMap::new();

    // ── OpenAI ────────────────────────────────────────────────────────────
    // gpt-4o: $2.50/1M input, $1.25/1M cached, $10.00/1M output
    m.insert("gpt-4o", ModelPricing {
        input_per_m_cents: 250,
        cached_input_per_m_cents: 125,
        output_per_m_cents: 1000,
        system_prompt_estimate: 500,
    });
    // gpt-4o-mini: $0.15/1M input, $0.075/1M cached, $0.60/1M output
    m.insert("gpt-4o-mini", ModelPricing {
        input_per_m_cents: 15,
        cached_input_per_m_cents: 7,
        output_per_m_cents: 60,
        system_prompt_estimate: 400,
    });
    // gpt-4-turbo: $10.00/1M input, $5.00/1M cached, $30.00/1M output
    m.insert("gpt-4-turbo", ModelPricing {
        input_per_m_cents: 1000,
        cached_input_per_m_cents: 500,
        output_per_m_cents: 3000,
        system_prompt_estimate: 600,
    });
    // gpt-4: $30.00/1M input, $30.00/1M cached (no discount), $60.00/1M output
    m.insert("gpt-4", ModelPricing {
        input_per_m_cents: 3000,
        cached_input_per_m_cents: 3000,
        output_per_m_cents: 6000,
        system_prompt_estimate: 500,
    });
    // gpt-3.5-turbo: $0.50/1M input, $0.50/1M cached, $1.50/1M output
    m.insert("gpt-3.5-turbo", ModelPricing {
        input_per_m_cents: 50,
        cached_input_per_m_cents: 50,
        output_per_m_cents: 150,
        system_prompt_estimate: 300,
    });
    // o1: $15.00/1M input, $7.50/1M cached, $60.00/1M output
    m.insert("o1", ModelPricing {
        input_per_m_cents: 1500,
        cached_input_per_m_cents: 750,
        output_per_m_cents: 6000,
        system_prompt_estimate: 800,
    });
    // o1-mini: $3.00/1M input, $1.50/1M cached, $12.00/1M output
    m.insert("o1-mini", ModelPricing {
        input_per_m_cents: 300,
        cached_input_per_m_cents: 150,
        output_per_m_cents: 1200,
        system_prompt_estimate: 600,
    });
    // o1-pro: $60.00/1M input, $60.00/1M output
    m.insert("o1-pro", ModelPricing {
        input_per_m_cents: 6000,
        cached_input_per_m_cents: 6000,
        output_per_m_cents: 6000,
        system_prompt_estimate: 800,
    });
    // o3-mini: $1.10/1M input, $0.55/1M cached, $4.40/1M output
    m.insert("o3-mini", ModelPricing {
        input_per_m_cents: 110,
        cached_input_per_m_cents: 55,
        output_per_m_cents: 440,
        system_prompt_estimate: 600,
    });
    // gpt-4.1: $2.00/1M input, $0.50/1M cached, $8.00/1M output
    m.insert("gpt-4.1", ModelPricing {
        input_per_m_cents: 200,
        cached_input_per_m_cents: 50,
        output_per_m_cents: 800,
        system_prompt_estimate: 500,
    });
    // gpt-4.1-mini: $0.40/1M input, $0.10/1M cached, $1.60/1M output
    m.insert("gpt-4.1-mini", ModelPricing {
        input_per_m_cents: 40,
        cached_input_per_m_cents: 10,
        output_per_m_cents: 160,
        system_prompt_estimate: 400,
    });
    // gpt-4.1-nano: $0.10/1M input, $0.025/1M cached, $0.40/1M output
    m.insert("gpt-4.1-nano", ModelPricing {
        input_per_m_cents: 10,
        cached_input_per_m_cents: 2,
        output_per_m_cents: 40,
        system_prompt_estimate: 300,
    });

    // ── Anthropic ─────────────────────────────────────────────────────────
    // claude-3.5-sonnet: $3.00/1M input, $3.00/1M cached, $15.00/1M output
    m.insert("claude-3-5-sonnet", ModelPricing {
        input_per_m_cents: 300,
        cached_input_per_m_cents: 300,
        output_per_m_cents: 1500,
        system_prompt_estimate: 500,
    });
    // claude-3-opus: $15.00/1M input, $15.00/1M cached, $75.00/1M output
    m.insert("claude-3-opus", ModelPricing {
        input_per_m_cents: 1500,
        cached_input_per_m_cents: 1500,
        output_per_m_cents: 7500,
        system_prompt_estimate: 600,
    });
    // claude-3-haiku: $0.25/1M input, $0.25/1M cached, $1.25/1M output
    m.insert("claude-3-haiku", ModelPricing {
        input_per_m_cents: 25,
        cached_input_per_m_cents: 25,
        output_per_m_cents: 125,
        system_prompt_estimate: 400,
    });
    // claude-3.5-haiku: $1.00/1M input, $1.00/1M cached, $5.00/1M output
    m.insert("claude-3-5-haiku", ModelPricing {
        input_per_m_cents: 100,
        cached_input_per_m_cents: 100,
        output_per_m_cents: 500,
        system_prompt_estimate: 400,
    });
    // claude-sonnet-4: $3.00/1M input, $3.00/1M cached, $15.00/1M output
    m.insert("claude-sonnet-4", ModelPricing {
        input_per_m_cents: 300,
        cached_input_per_m_cents: 300,
        output_per_m_cents: 1500,
        system_prompt_estimate: 500,
    });

    // ── Google ─────────────────────────────────────────────────────────────
    // gemini-1.5-pro: $1.25/1M input (≤128K), $5.00/1M output
    m.insert("gemini-1.5-pro", ModelPricing {
        input_per_m_cents: 125,
        cached_input_per_m_cents: 125, // Google doesn't differentiate cached pricing
        output_per_m_cents: 500,
        system_prompt_estimate: 500,
    });
    // gemini-1.5-flash: $0.075/1M input, $0.30/1M output
    m.insert("gemini-1.5-flash", ModelPricing {
        input_per_m_cents: 7,
        cached_input_per_m_cents: 7,
        output_per_m_cents: 30,
        system_prompt_estimate: 400,
    });
    // gemini-2.0-flash: $0.10/1M input, $0.40/1M output
    m.insert("gemini-2.0-flash", ModelPricing {
        input_per_m_cents: 10,
        cached_input_per_m_cents: 10,
        output_per_m_cents: 40,
        system_prompt_estimate: 400,
    });
    // gemini-2.5-pro: $1.25/1M input, $10.00/1M output
    m.insert("gemini-2.5-pro", ModelPricing {
        input_per_m_cents: 125,
        cached_input_per_m_cents: 125,
        output_per_m_cents: 1000,
        system_prompt_estimate: 600,
    });

    m
});

/// Estimate the cost in cents for a given model and token counts.
///
/// Returns `(cost_cents, pricing_as_of, cost_unavailable)`.
/// If the model is unknown, returns `(0, PRICING_AS_OF, true)`.
pub fn estimate_cost_cents(
    model_id: &str,
    tokens_in_system: u64,
    tokens_in_user: u64,
    tokens_in_cached: u64,
    tokens_out: u64,
) -> (u64, String, bool) {
    // Try exact match first, then prefix match
    let pricing = PRICING_TABLE
        .get(model_id)
        .or_else(|| {
            // Try prefix matching (e.g., "gpt-4o-2024-05-13" → "gpt-4o")
            PRICING_TABLE
                .keys()
                .find(|k| model_id.starts_with(*k))
                .and_then(|k| PRICING_TABLE.get(k))
        });

    match pricing {
        Some(p) => {
            let fresh_input = tokens_in_system + tokens_in_user;
            let input_cost = fresh_input * p.input_per_m_cents / 1_000_000;
            let cached_cost = tokens_in_cached * p.cached_input_per_m_cents / 1_000_000;
            let output_cost = tokens_out * p.output_per_m_cents / 1_000_000;
            let total = input_cost + cached_cost + output_cost;
            (total, PRICING_AS_OF.to_string(), false)
        }
        None => (0, PRICING_AS_OF.to_string(), true),
    }
}

/// Get an estimated system prompt token count for a model family.
/// Returns 0 if the model is unknown (caller should set token_count_source accordingly).
pub fn estimate_system_tokens(model_id: &str) -> u64 {
    PRICING_TABLE
        .get(model_id)
        .or_else(|| {
            PRICING_TABLE
                .keys()
                .find(|k| model_id.starts_with(*k))
                .and_then(|k| PRICING_TABLE.get(k))
        })
        .map(|p| p.system_prompt_estimate)
        .unwrap_or(0)
}

/// Check if a model has known pricing.
pub fn has_pricing(model_id: &str) -> bool {
    PRICING_TABLE
        .contains_key(model_id)
        || PRICING_TABLE
            .keys()
            .any(|k| model_id.starts_with(*k))
}

/// Extract token usage from an OpenAI-style API response.
/// OpenAI responses include: `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`
pub fn extract_openai_usage(response: &serde_json::Value) -> OpenAiUsage {
    let usage = response.get("usage");

    let prompt_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let completion_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let prompt_tokens_details = usage.and_then(|u| u.get("prompt_tokens_details"));

    // OpenAI sometimes reports cached_tokens inside prompt_tokens_details
    let cached_tokens = prompt_tokens_details
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    OpenAiUsage {
        prompt_tokens,
        completion_tokens,
        cached_tokens,
        total_tokens: usage
            .and_then(|u| u.get("total_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(prompt_tokens + completion_tokens),
    }
}

/// Extract token usage from an Anthropic-style API response.
/// Anthropic responses include: `usage.input_tokens`, `usage.output_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`
pub fn extract_anthropic_usage(response: &serde_json::Value) -> AnthropicUsage {
    let usage = response.get("usage");

    let input_tokens = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as u64;

    let output_tokens = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as u64;

    let cache_creation_input_tokens = usage
        .and_then(|u| u.get("cache_creation_input_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as u64;

    let cache_read_input_tokens = usage
        .and_then(|u| u.get("cache_read_input_tokens"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as u64;

    AnthropicUsage {
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
    }
}

/// Parsed OpenAI usage data.
#[derive(Debug, Clone, Copy)]
pub struct OpenAiUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
}

/// Parsed Anthropic usage data.
#[derive(Debug, Clone, Copy)]
pub struct AnthropicUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_known_model_pricing() {
        let (cost, _, unavailable) =
            estimate_cost_cents("gpt-4o", 1000, 1000, 0, 1000);
        assert!(!unavailable, "gpt-4o should have pricing");
        assert!(cost > 0, "gpt-4o should have non-zero cost");
    }

    #[test]
    fn test_unknown_model_pricing() {
        let (cost, _, unavailable) =
            estimate_cost_cents("unknown-model-xyz", 1000, 1000, 0, 1000);
        assert!(unavailable, "unknown model should mark cost as unavailable");
        assert_eq!(cost, 0, "unknown model should have zero cost estimate");
    }

    #[test]
    fn test_prefix_matching() {
        assert!(has_pricing("gpt-4o-2024-05-13"), "should match gpt-4o prefix");
        assert!(has_pricing("claude-3-5-sonnet-20241022"), "should match claude-3-5-sonnet prefix");
    }

    #[test]
    fn test_cost_calculation() {
        // gpt-4o: $2.50/1M input, $10.00/1M output
        // 1M input + 1M output = $2.50 + $10.00 = $12.50 = 1250 cents
        let (cost, _, _) = estimate_cost_cents("gpt-4o", 1_000_000, 0, 0, 1_000_000);
        // Approximate — integer division means some rounding
        assert!((1200..=1300).contains(&cost), "Expected ~1250 cents, got {}", cost);
    }

    #[test]
    fn test_cached_tokens_discount() {
        // gpt-4o: $2.50/1M input, $1.25/1M cached, $10.00/1M output
        // 500K fresh + 500K cached + 1M output
        // = (500K * 250 / 1M) + (500K * 125 / 1M) + (1M * 1000 / 1M)
        // = 125 + 62 + 1000 = ~1187 cents
        let (cost, _, _) = estimate_cost_cents("gpt-4o", 500_000, 0, 500_000, 1_000_000);
        assert!(cost > 0, "cached tokens should produce a cost");
    }

    #[test]
    fn test_openai_usage_extraction() {
        let response = serde_json::json!({
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "total_tokens": 150
            }
        });
        let usage = extract_openai_usage(&response);
        assert_eq!(usage.prompt_tokens, 100);
        assert_eq!(usage.completion_tokens, 50);
        assert_eq!(usage.total_tokens, 150);
        assert_eq!(usage.cached_tokens, 0);
    }

    #[test]
    fn test_openai_usage_with_cache() {
        let response = serde_json::json!({
            "usage": {
                "prompt_tokens": 1000,
                "completion_tokens": 200,
                "total_tokens": 1200,
                "prompt_tokens_details": {
                    "cached_tokens": 500
                }
            }
        });
        let usage = extract_openai_usage(&response);
        assert_eq!(usage.prompt_tokens, 1000);
        assert_eq!(usage.cached_tokens, 500);
    }

    #[test]
    fn test_anthropic_usage_extraction() {
        let response = serde_json::json!({
            "usage": {
                "input_tokens": 100,
                "output_tokens": 50,
                "cache_creation_input_tokens": 10,
                "cache_read_input_tokens": 30
            }
        });
        let usage = extract_anthropic_usage(&response);
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);
        assert_eq!(usage.cache_creation_input_tokens, 10);
        assert_eq!(usage.cache_read_input_tokens, 30);
    }

    #[test]
    fn test_cents_formatting() {
        assert_eq!(super::super::GlobalTokenStats::cents_to_usd(42), "$0.42");
        assert_eq!(super::super::GlobalTokenStats::cents_to_usd(100), "$1.00");
        assert_eq!(super::super::GlobalTokenStats::cents_to_usd(0), "$0.00");
        assert_eq!(super::super::GlobalTokenStats::cents_to_usd(1234), "$12.34");
    }
}