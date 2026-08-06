use crate::pii::liquid::LiquidPiiClient;
use crate::pii::presidio::PresidioClient;
use crate::pii::recognizers::{self, PiiMatch, PiiType, Recognizer};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Arc;

/// Minimum confidence threshold for detection
const MIN_CONFIDENCE: f64 = 0.5;

static RECOGNIZERS: Lazy<Vec<Recognizer>> = Lazy::new(recognizers::all_recognizers);

/// The PII detection engine.
///
/// Detection strategy (layered):
///   0. **Liquid PII encoder** (optional, default off) — `LFM2.5-Encoder-350M-PII-Detector`
///      via the Python sidecar. Token-classification with 40 PII types / 16 languages.
///      Highest recall on trained types; degrades to layer 1+ if the sidecar is unreachable.
///   1. **Presidio** (primary) — Microsoft Presidio via the same local sidecar.
///      Best-in-class NLP-based detection with NER support.
///   2. **Custom recognizers** (safety layer) — Our own regex-based patterns.
///      Always run alongside Presidio to catch anything it misses.
///   3. **Denylist** (user-defined) — Custom patterns the user marks as always-flag.
///
/// Allowlist is applied last — matched entities on the allowlist are removed
/// regardless of which layer detected them.
#[derive(Clone)]
pub struct PiiEngine {
    /// Allowlist patterns — these are never flagged
    allow_patterns: Vec<regex::Regex>,
    /// Denylist patterns — these are always flagged (even if no recognizer matches)
    deny_patterns: Vec<regex::Regex>,
    /// Presidio client for NLP-based detection
    presidio: PresidioClient,
    /// Liquid LFM2.5 PII encoder client (optional Layer 0)
    liquid_pii: Option<LiquidPiiClient>,
    /// External (JSON-loaded) recognizers — hot-reloaded pattern mining output
    external_recognizers: Arc<tokio::sync::RwLock<Vec<Recognizer>>>,
}

impl Default for PiiEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PiiEngine {
    pub fn new() -> Self {
        Self {
            allow_patterns: Vec::new(),
            deny_patterns: Vec::new(),
            presidio: PresidioClient::new("http://localhost:3000".into(), true),
            liquid_pii: Some(LiquidPiiClient::new(
                "http://localhost:3000".into(),
                false, // disabled by default until bootstrap confirms sidecar
            )),
            external_recognizers: Arc::new(tokio::sync::RwLock::new(Vec::new())),
        }
    }

    /// Create an engine with a custom Presidio configuration.
    pub fn with_presidio(base_url: String, enabled: bool) -> Self {
        Self {
            allow_patterns: Vec::new(),
            deny_patterns: Vec::new(),
            presidio: PresidioClient::new(base_url.clone(), enabled),
            liquid_pii: Some(LiquidPiiClient::new(base_url, false)),
            external_recognizers: Arc::new(tokio::sync::RwLock::new(Vec::new())),
        }
    }

    /// Add an allowlist regex pattern
    pub fn add_allow_pattern(&mut self, pattern: &str) -> Result<(), regex::Error> {
        self.allow_patterns.push(regex::Regex::new(pattern)?);
        Ok(())
    }

    /// Add a denylist regex pattern
    pub fn add_deny_pattern(&mut self, pattern: &str) -> Result<(), regex::Error> {
        self.deny_patterns.push(regex::Regex::new(pattern)?);
        Ok(())
    }

    /// Check if the Presidio service is enabled
    pub fn presidio_enabled(&self) -> bool {
        self.presidio.is_enabled()
    }

    /// Enable or disable the Presidio service
    pub fn set_presidio_enabled(&mut self, enabled: bool) {
        self.presidio.set_enabled(enabled);
    }

    /// Update the Presidio service URL
    pub fn set_presidio_url(&mut self, url: String) {
        self.presidio.set_url(url.clone());
        if let Some(lp) = self.liquid_pii.as_mut() {
            lp.set_url(url);
        }
    }

    /// Get a reference to the Presidio client (for health checks etc.)
    pub fn presidio_client(&self) -> &PresidioClient {
        &self.presidio
    }

    /// Enable/disable the Liquid PII encoder client. Idempotent; safe to call at runtime.
    pub fn set_liquid_pii_enabled(&mut self, enabled: bool) {
        if let Some(lp) = self.liquid_pii.as_mut() {
            lp.set_enabled(enabled);
        }
    }

    /// Check if the Liquid PII encoder client is currently enabled.
    pub fn liquid_pii_enabled(&self) -> bool {
        self.liquid_pii.as_ref().is_some_and(|lp| lp.is_enabled())
    }

    /// Reload external recognizers from the configured JSON file.
    /// Errors are logged but do not panic — old patterns remain active.
    /// Currently stubbed — not needed for LLM detection.
    pub async fn reload_external_recognizers(&self) -> Result<usize, String> {
        Ok(0)
    }

    /// Run our custom recognizers (the safety layer).
    /// Always runs regardless of Presidio status.
    async fn detect_custom(&self, text: &str) -> Vec<PiiMatch> {
        let mut matches = self.detect_with_recognizers(text);
        self.detect_with_denylist(text, &mut matches);

        // External recognizers (pattern mining output) — async-safe read
        let external = self.external_recognizers.read().await;
        for recognizer in external.iter() {
            if recognizer.confidence < MIN_CONFIDENCE {
                continue;
            }

            for mat in recognizer.regex.find_iter(text) {
                let matched_text = mat.as_str();
                if self.is_allowed(matched_text) {
                    continue;
                }
                if let Some(validator) = recognizer.validator {
                    if !validator(matched_text) {
                        continue;
                    }
                }

                // Skip if an earlier recognizer already matched this exact span
                if matches.iter().any(|m| m.start == mat.start() && m.end == mat.end()) {
                    continue;
                }

                matches.push(PiiMatch {
                    pii_type: recognizer.pii_type.clone(),
                    text: matched_text.to_string(),
                    start: mat.start(),
                    end: mat.end(),
                    confidence: recognizer.confidence,
                });
            }
        }

        matches
    }

    /// Run all built-in recognizers against the text.
    fn detect_with_recognizers(&self, text: &str) -> Vec<PiiMatch> {
        let mut matches = Vec::new();

        // Built-in recognizers (high-confidence defaults)
        for recognizer in RECOGNIZERS.iter() {
            if recognizer.confidence < MIN_CONFIDENCE {
                continue;
            }

            for mat in recognizer.regex.find_iter(text) {
                let matched_text = mat.as_str();
                if self.is_allowed(matched_text) {
                    continue;
                }
                if let Some(validator) = recognizer.validator {
                    if !validator(matched_text) {
                        continue;
                    }
                }

                matches.push(PiiMatch {
                    pii_type: recognizer.pii_type.clone(),
                    text: matched_text.to_string(),
                    start: mat.start(),
                    end: mat.end(),
                    confidence: recognizer.confidence,
                });
            }
        }

        matches
    }

    /// Check denylist patterns and append any non-duplicate matches.
    fn detect_with_denylist(&self, text: &str, matches: &mut Vec<PiiMatch>) {
        for pattern in &self.deny_patterns {
            for mat in pattern.find_iter(text) {
                let matched_text = mat.as_str();
                if self.is_allowed(matched_text) {
                    continue;
                }
                if matches.iter().any(|m| m.start == mat.start() && m.end == mat.end()) {
                    continue;
                }

                matches.push(PiiMatch {
                    pii_type: PiiType::ApiKey,
                    text: matched_text.to_string(),
                    start: mat.start(),
                    end: mat.end(),
                    confidence: 0.95,
                });
            }
        }
    }

    /// Scan text for PII entities and return all matches above the confidence threshold.
    ///
    /// **Detection is layered:**
    /// 1. If Presidio is available, its results are collected first.
    /// 2. Our custom recognizers always run as a safety net.
    /// 3. Results are merged, duplicates resolved, and allowlist applied.
    /// 4. If Presidio is down, custom recognizers provide full coverage.
    pub async fn detect(&self, text: &str) -> Vec<PiiMatch> {
        let mut matches: Vec<PiiMatch> = Vec::new();

        // Layer 0: Liquid LFM2.5-Encoder-350M-PII-Detector (token-classification)
        if let Some(ref liquid) = self.liquid_pii {
            if liquid.is_enabled() {
                if let Some(liquid_matches) = liquid.analyze(text).await {
                    let count = liquid_matches.len();
                    for m in liquid_matches {
                        if !self.is_allowed(&m.text) {
                            matches.push(m);
                        }
                    }
                    tracing::debug!(count, "Liquid PII detected {} entities", count);
                }
            }
        }

        // Layer 1: Presidio (primary NLP-based detection)
        if let Some(presidio_matches) = self.presidio.analyze(text, MIN_CONFIDENCE).await {
            // Apply allowlist to Presidio results
            for m in presidio_matches {
                if !self.is_allowed(&m.text) {
                    matches.push(m);
                }
            }
        }

        // Layer 2: Custom recognizers (safety layer — always runs)
        let custom_matches = self.detect_custom(text).await;
        for m in custom_matches {
            if !self.is_allowed(&m.text) {
                matches.push(m);
            }
        }

        // Layer 3: Resolve overlapping matches — keep highest confidence
        resolve_overlaps(&mut matches);

        matches
    }

    /// Synchronous version of `detect` — for use in non-async contexts
    /// (e.g. clipboard monitor polling). Uses `block_in_place`.
    pub fn detect_sync(&self, text: &str) -> Vec<PiiMatch> {
        let engine = self.clone();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(engine.detect(text))
        })
    }

    /// Quick check if text contains any PII
    pub async fn contains_pii(&self, text: &str) -> bool {
        !self.detect(text).await.is_empty()
    }

    fn is_allowed(&self, text: &str) -> bool {
        self.allow_patterns.iter().any(|re| re.is_match(text))
    }
}

/// Resolve overlapping matches — when two matches cover the same text region,
/// apply tie-breaking rules:
///
/// 1. Sort by (start, -confidence)
/// 2. For overlapping matches, prefer the one whose span is more specific
///    (shorter span = more precise). If spans are identical, prefer higher
///    confidence. If confidence is within 0.1, prefer the type that is more
///    specific (e.g., ZipCode over Date when the text is a bare 5-digit number).
fn resolve_overlaps(matches: &mut Vec<PiiMatch>) {
    if matches.is_empty() {
        return;
    }

    matches.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then_with(|| {
                // Prefer shorter (more specific) spans first
                a.end
                    .cmp(&b.end)
                    .then_with(|| {
                        b.confidence
                            .partial_cmp(&a.confidence)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
            })
    });

    let mut result: Vec<PiiMatch> = Vec::new();

    for m in matches.iter() {
        // Find the last result that this match overlaps with
        let mut dominated = false;
        for existing in result.iter_mut().rev() {
            // No overlap if this match starts after the existing one ends
            if m.start >= existing.end {
                break;
            }

            // There is overlap. Decide who wins.

            // Same span — pick by specificity then confidence
            if m.start == existing.start && m.end == existing.end {
                // Type specificity: more specific types win over generic ones
                let spec_m = type_specificity(&m.pii_type);
                let spec_e = type_specificity(&existing.pii_type);

                if spec_m > spec_e {
                    // New match is more specific — replace
                    *existing = m.clone();
                    dominated = true;
                    break;
                } else if spec_m == spec_e && m.confidence > existing.confidence {
                    // Same specificity, new has higher confidence — replace
                    *existing = m.clone();
                    dominated = true;
                    break;
                } else {
                    // Existing wins
                    dominated = true;
                    break;
                }
            }

            // Strict containment — the containing match wins: an entity that fully
            // contains another is the more complete detection (email > its domain).
            if m.start >= existing.start && m.end <= existing.end {
                dominated = true;
                break; // existing (containing) wins
            }
            if existing.start >= m.start && existing.end <= m.end {
                *existing = m.clone();
                dominated = true;
                break; // m (containing) wins
            }
            // True partial overlap — specificity, then confidence
            let spec_m = type_specificity(&m.pii_type);
            let spec_e = type_specificity(&existing.pii_type);
            if spec_m > spec_e {
                *existing = m.clone();
            } else if spec_m == spec_e && m.confidence > existing.confidence {
                *existing = m.clone();
            }
            dominated = true;
            break;
        }

        if !dominated {
            result.push(m.clone());
        }
    }

    *matches = result;
}

/// Type specificity score for overlap resolution.
///
/// More specific types (ZipCode, SSN, IBAN) should win over generic types
/// (Date, PhoneNumber) when both match the same text.
///
/// The scoring is:
/// - 3: Very specific (SSN, IBAN, CreditCard, ZipCode, API key, Email)
/// - 2: Moderately specific (IP address, Phone, Domain)
/// - 1: Generic / ambiguous (Date, Person, Location, Organization, Custom)
fn type_specificity(pii_type: &PiiType) -> u8 {
    use PiiType::*;
    match pii_type {
        // Legacy very-specific
        Ssn | Iban | CreditCard | ZipCode | ApiKey | Email | SwiftCode | UsBankNumber
        | UsPassport | UsDriverLicense | UsState | StreetAddress | City | Country
        | MedicalRecord => 3,
        Age | Title | Nationality | IpAddress | PhoneNumber | Domain => 2,
        // Liquid encoder — Identity / Contact / Financial / Credential (specific)
        IdentityPersonName | IdentityNationalId | IdentityPassport | IdentityDriversLicense
        | IdentityDateOfBirth | IdentityTaxId | ContactEmail | ContactPhone | ContactAddress
        | ContactPostalCode | ContactIpAddress | FinancialCreditCard | FinancialIban
        | FinancialBankAccount | FinancialSwiftBic | FinancialCryptoWallet
        | CredentialApiKey | CredentialPassword | CredentialPrivateKey | CredentialJwt
        | CredentialConnectionString | DeveloperLoginCredentials => 3,
        // Liquid encoder — Device / Location / Healthcare / Org / Legal (specific)
        DeviceMacAddress | DeviceImei | DeveloperDeviceId | LocationGpsCoordinates
        | HealthcareMedicalRecord | HealthcareHealthPlanId | OrgCompanyName
        | LegalCaseNumber => 3,
        // Liquid encoder — Online: URL is specific, Username is moderate
        OnlineUrl => 3,
        // Moderately specific — amount, username, and clinical context
        FinancialAmount | OnlineUsername | HealthcareCondition
        | HealthcareMedication => 2,
        // Liquid encoder — Special category (sensitive but low precision)
        SpecialReligion | SpecialPolitical | SpecialOrientation | SpecialHealthStatus => 1,
        // Generic / ambiguous
        Date | Person | Location | Organization | Custom(_) => 1,
        // Fallthrough for any future variant
        _ => 1,
    }
}

/// Build a summary of detected entities by type
pub fn summarize_matches(matches: &[PiiMatch]) -> HashMap<String, usize> {
    let mut summary = HashMap::new();
    for m in matches {
        *summary.entry(m.pii_type.to_string()).or_insert(0) += 1;
    }
    summary
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_detect_email_in_text() {
        let engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        let matches = engine.detect("Send it to alice@example.com please").await;
        assert!(!matches.is_empty());
        assert!(matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    #[tokio::test]
    async fn test_detect_multiple_types() {
        let engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        let text = "Contact john@test.com or call 555-123-4567, server is 10.0.0.1";
        let matches = engine.detect(text).await;
        let types: Vec<&PiiType> = matches.iter().map(|m| &m.pii_type).collect();
        assert!(types.contains(&&PiiType::Email));
        assert!(types.contains(&&PiiType::PhoneNumber));
        assert!(types.contains(&&PiiType::IpAddress));
    }

    #[tokio::test]
    async fn test_allowlist_skips_match() {
        let mut engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        engine.add_allow_pattern(r"example\.com").unwrap();
        let matches = engine.detect("Contact alice@example.com").await;
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    #[tokio::test]
    async fn test_denylist_catches_custom() {
        let mut engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        engine.add_deny_pattern(r"PROJECT_ALPHA_\w+").unwrap();
        let matches = engine.detect("The code is PROJECT_ALPHA_SECRET").await;
        assert!(matches.iter().any(|m| m.text == "PROJECT_ALPHA_SECRET"));
    }

    #[tokio::test]
    async fn test_no_false_positive_ip_in_code() {
        let engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        // Version numbers should not match IP regex
        let matches = engine.detect("version 1.0.0 released").await;
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::IpAddress));
    }

    #[tokio::test]
    async fn test_summarize() {
        let engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        let matches = engine.detect("a@b.com and c@d.com and 192.168.1.1").await;
        let summary = summarize_matches(&matches);
        assert_eq!(*summary.get("EMAIL_ADDRESS").unwrap(), 2);
        assert_eq!(*summary.get("IP_ADDRESS").unwrap(), 1);
    }

    #[tokio::test]
    async fn test_presidio_disabled_skips_gracefully() {
        let engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        // Should still work with custom recognizers
        let matches = engine.detect("john@test.com").await;
        assert!(matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    #[tokio::test]
    async fn test_presidio_unreachable_falls_back() {
        let engine = PiiEngine::with_presidio("http://localhost:19999".into(), true);
        // Should fall back to custom recognizers when Presidio is unreachable
        let matches = engine.detect("john@test.com").await;
        assert!(matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    #[test]
    fn test_ner_types_in_summarize() {
        // Verify that Person, Location, Organization PiiTypes are included
        // in summarize_matches output when present.
        let matches = vec![
            PiiMatch {
                pii_type: PiiType::Person,
                text: "John Smith".into(),
                start: 0,
                end: 10,
                confidence: 0.85,
            },
            PiiMatch {
                pii_type: PiiType::Location,
                text: "New York".into(),
                start: 15,
                end: 23,
                confidence: 0.80,
            },
            PiiMatch {
                pii_type: PiiType::Organization,
                text: "Acme Corp".into(),
                start: 28,
                end: 37,
                confidence: 0.75,
            },
        ];
        let summary = summarize_matches(&matches);
        assert_eq!(summary.get("PERSON"), Some(&1));
        assert_eq!(summary.get("LOCATION"), Some(&1));
        assert_eq!(summary.get("ORGANIZATION"), Some(&1));
    }

    #[test]
    fn test_resolve_overlaps_zip_beats_date() {
        // Simulate the bug: Presidio labels "90210" as DATE_TIME (0.60),
        // while our regex labels it as ZipCode (0.65). ZipCode should win
        // because it has higher specificity AND higher confidence.
        let mut matches = vec![
            PiiMatch {
                pii_type: PiiType::Date,
                text: "90210".into(),
                start: 10,
                end: 15,
                confidence: 0.60,
            },
            PiiMatch {
                pii_type: PiiType::ZipCode,
                text: "90210".into(),
                start: 10,
                end: 15,
                confidence: 0.65,
            },
        ];
        resolve_overlaps(&mut matches);
        assert_eq!(matches.len(), 1, "Should keep exactly one match");
        assert_eq!(
            matches[0].pii_type,
            PiiType::ZipCode,
            "ZipCode should win over Date for 5-digit number"
        );
    }

    #[test]
    fn test_resolve_overlaps_email_beats_contained_domain() {
        // Regression: EMAIL_RE matches "alice@example.com" (0.90), while
        // DOMAIN_RE matches the contained "example.com" (0.50). The email is
        // the containing detection and must win — the domain must be dropped,
        // NOT promoted over the email.
        let mut matches = vec![
            PiiMatch {
                pii_type: PiiType::Email,
                text: "alice@example.com".into(),
                start: 11,
                end: 28,
                confidence: 0.90,
            },
            PiiMatch {
                pii_type: PiiType::Domain,
                text: "example.com".into(),
                start: 17,
                end: 28,
                confidence: 0.50,
            },
        ];
        resolve_overlaps(&mut matches);
        assert_eq!(matches.len(), 1, "Should keep exactly one match");
        assert_eq!(
            matches[0].pii_type,
            PiiType::Email,
            "Containing email must beat its contained domain"
        );
    }

    #[test]
    fn test_resolve_overlaps_specificity_beats_confidence() {
        // Even when Date has higher confidence, ZipCode (specificity 3)
        // should beat Date (specificity 1) for the exact same span.
        let mut matches = vec![
            PiiMatch {
                pii_type: PiiType::Date,
                text: "90210".into(),
                start: 0,
                end: 5,
                confidence: 0.80,
            },
            PiiMatch {
                pii_type: PiiType::ZipCode,
                text: "90210".into(),
                start: 0,
                end: 5,
                confidence: 0.65,
            },
        ];
        resolve_overlaps(&mut matches);
        assert_eq!(matches.len(), 1);
        assert_eq!(
            matches[0].pii_type,
            PiiType::ZipCode,
            "ZipCode specificity (3) should beat Date specificity (1)"
        );
    }

    #[test]
    fn test_resolve_overlaps_keeps_non_overlapping() {
        let mut matches = vec![
            PiiMatch {
                pii_type: PiiType::Email,
                text: "a@b.com".into(),
                start: 0,
                end: 7,
                confidence: 0.90,
            },
            PiiMatch {
                pii_type: PiiType::ZipCode,
                text: "90210".into(),
                start: 20,
                end: 25,
                confidence: 0.65,
            },
        ];
        resolve_overlaps(&mut matches);
        assert_eq!(matches.len(), 2, "Non-overlapping matches should both be kept");
    }

    #[test]
    fn test_type_specificity_scoring() {
        assert_eq!(type_specificity(&PiiType::ZipCode), 3);
        assert_eq!(type_specificity(&PiiType::Ssn), 3);
        assert_eq!(type_specificity(&PiiType::Email), 3);
        assert_eq!(type_specificity(&PiiType::CreditCard), 3);
        assert_eq!(type_specificity(&PiiType::Date), 1);
        assert_eq!(type_specificity(&PiiType::Person), 1);
        assert_eq!(type_specificity(&PiiType::IpAddress), 2);
        // Explicit arms for the new/tightened recognizers (full 40-type coverage)
        assert_eq!(type_specificity(&PiiType::CredentialJwt), 3);
        assert_eq!(type_specificity(&PiiType::CredentialPrivateKey), 3);
        assert_eq!(type_specificity(&PiiType::CredentialPassword), 3);
        assert_eq!(type_specificity(&PiiType::CredentialConnectionString), 3);
        assert_eq!(type_specificity(&PiiType::DeveloperLoginCredentials), 3);
        assert_eq!(type_specificity(&PiiType::FinancialCryptoWallet), 3);
        assert_eq!(type_specificity(&PiiType::DeviceImei), 3);
        assert_eq!(type_specificity(&PiiType::DeveloperDeviceId), 3);
        assert_eq!(type_specificity(&PiiType::IdentityTaxId), 3);
        assert_eq!(type_specificity(&PiiType::IdentityPassport), 3);
        assert_eq!(type_specificity(&PiiType::IdentityDriversLicense), 3);
        assert_eq!(type_specificity(&PiiType::IdentityNationalId), 3);
        assert_eq!(type_specificity(&PiiType::HealthcareHealthPlanId), 3);
        assert_eq!(type_specificity(&PiiType::HealthcareMedicalRecord), 3);
        assert_eq!(type_specificity(&PiiType::FinancialBankAccount), 3);
        assert_eq!(type_specificity(&PiiType::LegalCaseNumber), 3);
        assert_eq!(type_specificity(&PiiType::LocationGpsCoordinates), 3);
        assert_eq!(type_specificity(&PiiType::OnlineUrl), 3);
        assert_eq!(type_specificity(&PiiType::FinancialAmount), 2);
        assert_eq!(type_specificity(&PiiType::OnlineUsername), 2);
        assert_eq!(type_specificity(&PiiType::HealthcareCondition), 2);
        assert_eq!(type_specificity(&PiiType::HealthcareMedication), 2);
        assert_eq!(type_specificity(&PiiType::SpecialReligion), 1);
        assert_eq!(type_specificity(&PiiType::SpecialPolitical), 1);
        assert_eq!(type_specificity(&PiiType::SpecialOrientation), 1);
        assert_eq!(type_specificity(&PiiType::SpecialHealthStatus), 1);
    }
}
