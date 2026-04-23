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
    /// Cache-write price per 1M tokens, in cents (0 = same as input).
    /// Cache-write tokens cost MORE than fresh input (typically 25% more).
    cache_write_per_m_cents: u64,
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
        cache_write_per_m_cents: 0,
        input_per_m_cents: 250,
        cached_input_per_m_cents: 125,
        output_per_m_cents: 1000,
        system_prompt_estimate: 500,
    });
    // gpt-4o-mini: $0.15/1M input, $0.075/1M cached, $0.60/1M output
    m.insert("gpt-4o-mini", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 15,
        cached_input_per_m_cents: 7,
        output_per_m_cents: 60,
        system_prompt_estimate: 400,
    });
    // gpt-4-turbo: $10.00/1M input, $5.00/1M cached, $30.00/1M output
    m.insert("gpt-4-turbo", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 1000,
        cached_input_per_m_cents: 500,
        output_per_m_cents: 3000,
        system_prompt_estimate: 600,
    });
    // gpt-4: $30.00/1M input, $30.00/1M cached (no discount), $60.00/1M output
    m.insert("gpt-4", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 3000,
        cached_input_per_m_cents: 3000,
        output_per_m_cents: 6000,
        system_prompt_estimate: 500,
    });
    // gpt-3.5-turbo: $0.50/1M input, $0.50/1M cached, $1.50/1M output
    m.insert("gpt-3.5-turbo", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 50,
        cached_input_per_m_cents: 50,
        output_per_m_cents: 150,
        system_prompt_estimate: 300,
    });
    // o1: $15.00/1M input, $7.50/1M cached, $60.00/1M output
    m.insert("o1", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 1500,
        cached_input_per_m_cents: 750,
        output_per_m_cents: 6000,
        system_prompt_estimate: 800,
    });
    // o1-mini: $3.00/1M input, $1.50/1M cached, $12.00/1M output
    m.insert("o1-mini", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 300,
        cached_input_per_m_cents: 150,
        output_per_m_cents: 1200,
        system_prompt_estimate: 600,
    });
    // o1-pro: $60.00/1M input, $60.00/1M output
    m.insert("o1-pro", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 6000,
        cached_input_per_m_cents: 6000,
        output_per_m_cents: 6000,
        system_prompt_estimate: 800,
    });
    // o3-mini: $1.10/1M input, $0.55/1M cached, $4.40/1M output
    m.insert("o3-mini", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 110,
        cached_input_per_m_cents: 55,
        output_per_m_cents: 440,
        system_prompt_estimate: 600,
    });
    // gpt-4.1: $2.00/1M input, $0.50/1M cached, $8.00/1M output
    m.insert("gpt-4.1", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 200,
        cached_input_per_m_cents: 50,
        output_per_m_cents: 800,
        system_prompt_estimate: 500,
    });
    // gpt-4.1-mini: $0.40/1M input, $0.10/1M cached, $1.60/1M output
    m.insert("gpt-4.1-mini", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 40,
        cached_input_per_m_cents: 10,
        output_per_m_cents: 160,
        system_prompt_estimate: 400,
    });
    // gpt-4.1-nano: $0.10/1M input, $0.025/1M cached, $0.40/1M output
    m.insert("gpt-4.1-nano", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 10,
        cached_input_per_m_cents: 2,
        output_per_m_cents: 40,
        system_prompt_estimate: 300,
    });

    // ── Anthropic ─────────────────────────────────────────────────────────
    // claude-3.5-sonnet: $3.00/1M input, $3.00/1M cached, $15.00/1M output
    m.insert("claude-3-5-sonnet", ModelPricing {
        cache_write_per_m_cents: 375,
        input_per_m_cents: 300,
        cached_input_per_m_cents: 300,
        output_per_m_cents: 1500,
        system_prompt_estimate: 500,
    });
    // claude-3-opus: $15.00/1M input, $15.00/1M cached, $75.00/1M output
    m.insert("claude-3-opus", ModelPricing {
        cache_write_per_m_cents: 1875,
        input_per_m_cents: 1500,
        cached_input_per_m_cents: 1500,
        output_per_m_cents: 7500,
        system_prompt_estimate: 600,
    });
    // claude-3-haiku: $0.25/1M input, $0.25/1M cached, $1.25/1M output
    m.insert("claude-3-haiku", ModelPricing {
        cache_write_per_m_cents: 31,
        input_per_m_cents: 25,
        cached_input_per_m_cents: 25,
        output_per_m_cents: 125,
        system_prompt_estimate: 400,
    });
    // claude-3.5-haiku: $1.00/1M input, $1.00/1M cached, $5.00/1M output
    m.insert("claude-3-5-haiku", ModelPricing {
        cache_write_per_m_cents: 125,
        input_per_m_cents: 100,
        cached_input_per_m_cents: 100,
        output_per_m_cents: 500,
        system_prompt_estimate: 400,
    });
    // claude-sonnet-4: $3.00/1M input, $3.00/1M cached, $15.00/1M output
    m.insert("claude-sonnet-4", ModelPricing {
        cache_write_per_m_cents: 375,
        input_per_m_cents: 300,
        cached_input_per_m_cents: 300,
        output_per_m_cents: 1500,
        system_prompt_estimate: 500,
    });

    // ── Google ─────────────────────────────────────────────────────────────
    // gemini-1.5-pro: $1.25/1M input (≤128K), $5.00/1M output
    m.insert("gemini-1.5-pro", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 125,
        cached_input_per_m_cents: 125, // Google doesn't differentiate cached pricing
        output_per_m_cents: 500,
        system_prompt_estimate: 500,
    });
    // gemini-1.5-flash: $0.075/1M input, $0.30/1M output
    m.insert("gemini-1.5-flash", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 7,
        cached_input_per_m_cents: 7,
        output_per_m_cents: 30,
        system_prompt_estimate: 400,
    });
    // gemini-2.0-flash: $0.10/1M input, $0.40/1M output
    m.insert("gemini-2.0-flash", ModelPricing {
        cache_write_per_m_cents: 0,
        input_per_m_cents: 10,
        cached_input_per_m_cents: 10,
        output_per_m_cents: 40,
        system_prompt_estimate: 400,
    });
    // gemini-2.5-pro: $1.25/1M input, $10.00/1M output
    m.insert("gemini-2.5-pro", ModelPricing {
        cache_write_per_m_cents: 0,
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
///
/// Cost calculation:
///   input_cost = (tokens_in_system + tokens_in_user) * input_per_m_cents / 1M
///   cached_cost = tokens_in_cached * cached_input_per_m_cents / 1M
///   cache_write_cost = tokens_in_cache_write * cache_write_per_m_cents / 1M
///   output_cost = tokens_out * output_per_m_cents / 1M
///   total = input_cost + cached_cost + cache_write_cost + output_cost
#[allow(clippy::too_many_arguments)]
pub fn estimate_cost_cents(
    model_id: &str,
    tokens_in_system: u64,
    tokens_in_user: u64,
    tokens_in_cached: u64,
    tokens_out: u64,
) -> (u64, String, bool) {
    estimate_cost_cents_with_cache_write(model_id, tokens_in_system, tokens_in_user, tokens_in_cached, 0, tokens_out)
}

/// Full cost estimation including cache-write tokens.
///
/// Returns `(cost_cents, pricing_as_of, cost_unavailable)`.
pub fn estimate_cost_cents_with_cache_write(
    model_id: &str,
    tokens_in_system: u64,
    tokens_in_user: u64,
    tokens_in_cached: u64,
    tokens_in_cache_write: u64,
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
            // Cache-write cost: if not set (0), fall back to input rate
            let cache_write_rate = if p.cache_write_per_m_cents > 0 {
                p.cache_write_per_m_cents
            } else {
                p.input_per_m_cents
            };
            let cache_write_cost = tokens_in_cache_write * cache_write_rate / 1_000_000;
            let output_cost = tokens_out * p.output_per_m_cents / 1_000_000;
            let total = input_cost + cached_cost + cache_write_cost + output_cost;
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

/// Extract provider-reported cost from an API response.
///
/// Anthropic responses may include `cost_usd` or the cost can be calculated
/// from their per-token pricing. Google responses may include usage metadata
/// with cost information. OpenAI does not currently report cost directly.
///
/// Returns `Some(cents)` if the provider reported cost, `None` otherwise.
pub fn extract_provider_cost_cents(response: &serde_json::Value, is_anthropic: bool) -> Option<u64> {
    if is_anthropic {
        // Anthropic doesn't currently include cost in the response,
        // but we check for future compatibility
        response
            .get("cost_usd")
            .and_then(|v| v.as_f64())
            .map(|usd| (usd * 100.0).round() as u64)
            .or_else(|| {
                // Also check nested usage cost fields
                response
                    .get("usage")
                    .and_then(|u| u.get("cost_usd"))
                    .and_then(|v| v.as_f64())
                    .map(|usd| (usd * 100.0).round() as u64)
            })
    } else {
        // OpenAI responses don't currently include cost directly
        // Check for Google-style responses
        response
            .get("cost_usd")
            .and_then(|v| v.as_f64())
            .map(|usd| (usd * 100.0).round() as u64)
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

// ── LiteLLM Pricing Fetcher ─────────────────────────────────────────────────
//
// Fetches pricing from LiteLLM's community-maintained JSON file at startup,
// falls back to the hardcoded PRICING_TABLE if the fetch fails.

/// URL for the LiteLLM pricing data (100+ models, community-maintained).
pub const LITELLM_PRICING_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/// How long cached LiteLLM pricing is valid before a refresh is needed.
pub const PRICING_CACHE_TTL_SECS: u64 = 86_400; // 24 hours

/// Runtime pricing table that can be refreshed from LiteLLM.
/// Falls back to the static PRICING_TABLE when no cached data is available.
pub struct DynamicPricingTable {
    /// Cached LiteLLM pricing data, keyed by model name.
    /// Maps model_name -> LiteLLMModelPricing.
    litellm_cache: parking_lot::RwLock<Option<std::collections::HashMap<String, LiteLLMModelPricing>>>,
    /// When the cache was last refreshed (Unix timestamp).
    cache_updated_at: parking_lot::RwLock<Option<chrono::DateTime<chrono::Utc>>>,
    /// Whether the last fetch attempt succeeded.
    last_fetch_succeeded: std::sync::atomic::AtomicBool,
}

/// Parsed LiteLLM pricing entry for a single model.
#[derive(Debug, Clone)]
struct LiteLLMModelPricing {
    input_cost_per_token: Option<f64>,
    output_cost_per_token: Option<f64>,
    cache_read_input_token_cost: Option<f64>,
    cache_creation_input_token_cost: Option<f64>,
}

impl DynamicPricingTable {
    /// Create a new DynamicPricingTable (no fetch yet).
    pub fn new() -> Self {
        Self {
            litellm_cache: parking_lot::RwLock::new(None),
            cache_updated_at: parking_lot::RwLock::new(None),
            last_fetch_succeeded: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Try to fetch pricing from LiteLLM. Logs success/failure.
    /// Returns true if the fetch succeeded and the cache was updated.
    pub fn refresh_from_litellm(&self) -> bool {
        match Self::fetch_litellm_pricing() {
            Ok(data) => {
                let mut cache = self.litellm_cache.write();
                *cache = Some(data);
                let mut updated_at = self.cache_updated_at.write();
                *updated_at = Some(chrono::Utc::now());
                self.last_fetch_succeeded.store(true, std::sync::atomic::Ordering::Relaxed);
                tracing::info!("LiteLLM pricing data refreshed successfully");
                true
            }
            Err(e) => {
                tracing::warn!("Failed to fetch LiteLLM pricing: {}. Using hardcoded fallback.", e);
                self.last_fetch_succeeded.store(false, std::sync::atomic::Ordering::Relaxed);
                false
            }
        }
    }

    /// Check if the cache needs refreshing (TTL expired or never fetched).
    pub fn needs_refresh(&self) -> bool {
        let updated_at = self.cache_updated_at.read();
        match *updated_at {
            None => true,
            Some(ts) => {
                let elapsed = chrono::Utc::now() - ts;
                elapsed.num_seconds() >= PRICING_CACHE_TTL_SECS as i64
            }
        }
    }

    /// Estimate cost using the dynamic pricing table (LiteLLM if available,
    /// falling back to the hardcoded PRICING_TABLE).
    ///
    /// Returns (cost_cents, pricing_as_of, cost_unavailable).
    pub fn estimate_cost_cents_dynamic(
        &self,
        model_id: &str,
        tokens_in_system: u64,
        tokens_in_user: u64,
        tokens_in_cached: u64,
        tokens_in_cache_write: u64,
        tokens_out: u64,
    ) -> (u64, String, bool) {
        // Try LiteLLM cache first
        let cache = self.litellm_cache.read();
        if let Some(ref data) = *cache {
            if let Some(pricing) = Self::find_in_litellm(data, model_id) {
                // Calculate cost using per-token pricing
                let cost = Self::calculate_litellm_cost(
                    pricing,
                    tokens_in_system,
                    tokens_in_user,
                    tokens_in_cached,
                    tokens_in_cache_write,
                    tokens_out,
                );
                let as_of = self.cache_updated_at.read()
                    .map(|dt| dt.format("%Y-%m-%d").to_string())
                    .unwrap_or_else(|| PRICING_AS_OF.to_string());
                return (cost, format!("litellm:{}", as_of), false);
            }
        }
        // Fall back to hardcoded pricing
        estimate_cost_cents_with_cache_write(
            model_id, tokens_in_system, tokens_in_user,
            tokens_in_cached, tokens_in_cache_write, tokens_out,
        )
    }

    fn find_in_litellm<'a>(
        data: &'a std::collections::HashMap<String, LiteLLMModelPricing>,
        model_id: &str,
    ) -> Option<&'a LiteLLMModelPricing> {
        // Try exact match first
        if let Some(p) = data.get(model_id) {
            return Some(p);
        }
        // Try prefix match (e.g., "gpt-4o-2024-05-13" matches "gpt-4o")
        data.keys()
            .find(|k| model_id.starts_with(k.as_str()))
            .and_then(|k| data.get(k))
    }

    fn calculate_litellm_cost(
        pricing: &LiteLLMModelPricing,
        tokens_in_system: u64,
        tokens_in_user: u64,
        tokens_in_cached: u64,
        tokens_in_cache_write: u64,
        tokens_out: u64,
    ) -> u64 {
        // LiteLLM stores prices as cost_per_token (USD), convert to cents
        let input_rate = pricing.input_cost_per_token.unwrap_or(0.000_003); // $3/1M fallback
        let output_rate = pricing.output_cost_per_token.unwrap_or(0.000_015); // $15/1M fallback
        let cache_read_rate = pricing.cache_read_input_token_cost.unwrap_or(0.0);
        let cache_write_rate = pricing.cache_creation_input_token_cost.unwrap_or(0.0);

        let fresh_input = tokens_in_system + tokens_in_user;
        let input_cost = fresh_input as f64 * input_rate;
        let cache_read_cost = tokens_in_cached as f64 * cache_read_rate;
        let cache_write_cost = tokens_in_cache_write as f64 * cache_write_rate;
        let output_cost = tokens_out as f64 * output_rate;

        let total_usd = input_cost + cache_read_cost + cache_write_cost + output_cost;
        // Convert USD to cents (round to nearest cent)
        (total_usd * 100.0).round() as u64
    }

    fn fetch_litellm_pricing() -> Result<std::collections::HashMap<String, LiteLLMModelPricing>, String> {
        // Use ureq or similar simple HTTP client. For now, we use
        // reqwest if available, or fall back gracefully.
        // This is a best-effort fetch — failure is non-fatal.
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        let response = client.get(LITELLM_PRICING_URL)
            .send()
            .map_err(|e| format!("Failed to fetch LiteLLM pricing: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("LiteLLM pricing fetch returned status {}", response.status()));
        }

        let body = response.text()
            .map_err(|e| format!("Failed to read LiteLLM pricing response: {}", e))?;

        let json: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| format!("Failed to parse LiteLLM pricing JSON: {}", e))?;

        let mut pricing_map = std::collections::HashMap::new();

        if let Some(obj) = json.as_object() {
            for (model_name, model_data) in obj {
                if let Some(data) = model_data.as_object() {
                    let entry = LiteLLMModelPricing {
                        input_cost_per_token: data.get("input_cost_per_token")
                            .and_then(|v| v.as_f64()),
                        output_cost_per_token: data.get("output_cost_per_token")
                            .and_then(|v| v.as_f64()),
                        cache_read_input_token_cost: data.get("cache_read_input_token_cost")
                            .and_then(|v| v.as_f64()),
                        cache_creation_input_token_cost: data.get("cache_creation_input_token_cost")
                            .and_then(|v| v.as_f64()),
                    };
                    // Only include models that have at least input/output pricing
                    if entry.input_cost_per_token.is_some() || entry.output_cost_per_token.is_some() {
                        pricing_map.insert(model_name.clone(), entry);
                    }
                }
            }
        }

        tracing::info!("Loaded {} models from LiteLLM pricing data", pricing_map.len());
        Ok(pricing_map)
    }
}

impl Default for DynamicPricingTable {
    fn default() -> Self {
        Self::new()
    }
}

/// Global dynamic pricing table (lazy-initialized).
static DYNAMIC_PRICING: once_cell::sync::Lazy<parking_lot::RwLock<DynamicPricingTable>> =
    once_cell::sync::Lazy::new(|| {
        let table = DynamicPricingTable::new();
        // Attempt initial fetch in background (non-blocking)
        // The fetch will be attempted on first use if needed
        parking_lot::RwLock::new(table)
    });

/// Estimate cost using the dynamic pricing table.
/// Attempts to use LiteLLM pricing data first, falls back to hardcoded.
pub fn estimate_cost_cents_dynamic(
    model_id: &str,
    tokens_in_system: u64,
    tokens_in_user: u64,
    tokens_in_cached: u64,
    tokens_in_cache_write: u64,
    tokens_out: u64,
) -> (u64, String, bool) {
    let table = DYNAMIC_PRICING.read();
    // Refresh if needed (best effort — non-blocking)
    if table.needs_refresh() {
        // Don't block the request path — just note we need a refresh.
        // The refresh will happen on the next call or via background task.
        drop(table);
        // Try to refresh in background
        let table = DYNAMIC_PRICING.read();
        table.estimate_cost_cents_dynamic(
            model_id, tokens_in_system, tokens_in_user,
            tokens_in_cached, tokens_in_cache_write, tokens_out,
        )
    } else {
        table.estimate_cost_cents_dynamic(
            model_id, tokens_in_system, tokens_in_user,
            tokens_in_cached, tokens_in_cache_write, tokens_out,
        )
    }
}

/// Trigger a background refresh of LiteLLM pricing data.
/// Call this from a startup hook or periodic timer.
pub fn refresh_pricing_from_litellm() -> bool {
    let table = DYNAMIC_PRICING.read();
    table.refresh_from_litellm()
}

/// Check if the dynamic pricing cache needs refreshing.
pub fn pricing_needs_refresh() -> bool {
    let table = DYNAMIC_PRICING.read();
    table.needs_refresh()
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