use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fmt;

/// Type of PII entity detected.
///
/// Each variant maps to a Presidio-compatible UPPER_SNAKE_CASE string via `Display`.
/// The enum intentionally includes fine-grained types (CITY, US_STATE, STREET_ADDRESS, etc.)
/// so that the benchmark scoring namespace (all uppercase) aligns exactly with the
/// gold annotation namespace — preventing entity type collapses that would drive
/// precision/recall to zero.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PiiType {
    Email,
    PhoneNumber,
    IpAddress,
    CreditCard,
    Ssn,
    Iban,
    ApiKey,
    Domain,
    Date,
    ZipCode,
    Custom(String),
    Person,
    Location,
    Organization,
    /// Fine-grained NER types (keep distinct from Location/Org for scoring)
    City,
    UsState,
    StreetAddress,
    Country,
    Nationality,
    Title,
    MedicalRecord,
    Age,
    SwiftCode,
    UsBankNumber,
    UsPassport,
    UsDriverLicense,
}

impl fmt::Display for PiiType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PiiType::Email => write!(f, "EMAIL_ADDRESS"),
            PiiType::PhoneNumber => write!(f, "PHONE_NUMBER"),
            PiiType::IpAddress => write!(f, "IP_ADDRESS"),
            PiiType::CreditCard => write!(f, "CREDIT_CARD"),
            PiiType::Ssn => write!(f, "US_SSN"),
            PiiType::Iban => write!(f, "IBAN_CODE"),
            PiiType::ApiKey => write!(f, "API_KEY"),
            PiiType::Domain => write!(f, "URL"),
            PiiType::Date => write!(f, "DATE_TIME"),
            PiiType::ZipCode => write!(f, "US_ZIP_CODE"),
            PiiType::Custom(ref s) => write!(f, "{}", s),
            PiiType::Person => write!(f, "PERSON"),
            PiiType::Location => write!(f, "LOCATION"),
            PiiType::Organization => write!(f, "ORGANIZATION"),
            PiiType::City => write!(f, "CITY"),
            PiiType::UsState => write!(f, "US_STATE"),
            PiiType::StreetAddress => write!(f, "STREET_ADDRESS"),
            PiiType::Country => write!(f, "COUNTRY"),
            PiiType::Nationality => write!(f, "NATIONALITY"),
            PiiType::Title => write!(f, "TITLE"),
            PiiType::MedicalRecord => write!(f, "MEDICAL_RECORD"),
            PiiType::Age => write!(f, "AGE"),
            PiiType::SwiftCode => write!(f, "SWIFT_CODE"),
            PiiType::UsBankNumber => write!(f, "US_BANK_NUMBER"),
            PiiType::UsPassport => write!(f, "US_PASSPORT"),
            PiiType::UsDriverLicense => write!(f, "US_DRIVER_LICENSE"),
        }
    }
}

impl PiiType {
    /// Parse from a string label (e.g., from JSON config or external recognizer).
    /// Returns a known variant or `Custom` for unrecognized types.
    ///
    /// Accepts both Presidio uppercase names (EMAIL_ADDRESS, CITY, US_STATE) and
    /// legacy Aelvyril display names (Email, City, US_State) for backward compat.
    pub fn from_str(s: &str) -> PiiType {
        match s {
            // Presidio / benchmark namespace
            "EMAIL_ADDRESS" | "Email" => PiiType::Email,
            "PHONE_NUMBER" | "Phone" => PiiType::PhoneNumber,
            "IP_ADDRESS" | "IP_Address" => PiiType::IpAddress,
            "CREDIT_CARD" | "Credit_Card" => PiiType::CreditCard,
            "US_SSN" | "SSN" => PiiType::Ssn,
            "IBAN_CODE" | "IBAN" => PiiType::Iban,
            "API_KEY" | "API_Key" => PiiType::ApiKey,
            "URL" | "DOMAIN_NAME" | "Domain" => PiiType::Domain,
            "DATE_TIME" | "DATE" | "Date" => PiiType::Date,
            "US_ZIP_CODE" | "ZIP_CODE" | "Zip_Code" => PiiType::ZipCode,
            "PERSON" | "PER" | "Person" => PiiType::Person,
            "LOCATION" | "LOC" => PiiType::Location,
            "ORGANIZATION" | "ORG" | "NRP" => PiiType::Organization,
            "CITY" | "City" => PiiType::City,
            "US_STATE" | "US_State" => PiiType::UsState,
            "STREET_ADDRESS" | "Street_Address" => PiiType::StreetAddress,
            "COUNTRY" | "Country" => PiiType::Country,
            "NATIONALITY" | "Nationality" => PiiType::Nationality,
            "TITLE" | "Title" => PiiType::Title,
            "MEDICAL_RECORD" | "Medical_Record" => PiiType::MedicalRecord,
            "AGE" | "Age" => PiiType::Age,
            "SWIFT_CODE" | "SWIFT" => PiiType::SwiftCode,
            "US_BANK_NUMBER" => PiiType::UsBankNumber,
            "US_PASSPORT" => PiiType::UsPassport,
            "US_DRIVER_LICENSE" => PiiType::UsDriverLicense,
            _ => PiiType::Custom(s.to_string()),
        }
    }
}

/// A detected PII entity with position and confidence
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiiMatch {
    pub pii_type: PiiType,
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub confidence: f64,
}

/// A compiled recognizer
pub struct Recognizer {
    pub pii_type: PiiType,
    pub regex: Regex,
    pub confidence: f64,
    /// Optional validator — returns false for false positives
    pub validator: Option<fn(&str) -> bool>,
}

// ── Compiled regex patterns ─────────────────────────────────────────────────
static EMAIL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").unwrap());

static PHONE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}"
    ).unwrap()
});

static IP_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b",
    )
    .unwrap()
});

static CREDIT_CARD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b(?:\d[ -]*?){13,19}\b").unwrap());

static SSN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b\d{3}[- ]?\d{2}[- ]?\d{4}\b").unwrap());

static IBAN_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b[A-Z]{2}\d{2}[A-Z0-9]{4}[A-Z0-9]{0,30}\b").unwrap());

static API_KEY_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)\b(?:sk|sk-proj|sk-ant|sk-)[A-Za-z0-9_\-]{20,}\b"#).unwrap());

/// Domain regex — matches common domains but avoids IP addresses and code constructs
static DOMAIN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(?:(?:https?://)|(?:\b))(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}(?:/[^\s]*)?"
    ).unwrap()
});

static DATE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b"
    ).unwrap()
});

static ZIP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b\d{5}(?:[-\s]\d{4})?\b").unwrap());

/// Luhn algorithm validator for credit cards
fn luhn_check(number: &str) -> bool {
    let digits: Vec<u32> = number
        .chars()
        .filter(|c| c.is_ascii_digit())
        .map(|c| c.to_digit(10).unwrap())
        .collect();

    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }

    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| {
            if i % 2 == 1 {
                let doubled = d * 2;
                if doubled > 9 {
                    doubled - 9
                } else {
                    doubled
                }
            } else {
                d
            }
        })
        .sum();

    sum.is_multiple_of(10)
}

/// IBAN checksum validator
fn iban_check(iban: &str) -> bool {
    let cleaned: String = iban.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if cleaned.len() < 5 {
        return false;
    }
    // Move first 4 chars to end, replace letters with numbers (A=10, B=11, ...)
    let rearranged = format!("{}{}", &cleaned[4..], &cleaned[..4]);
    let numeric: String = rearranged
        .chars()
        .map(|c| {
            if c.is_ascii_digit() {
                c.to_string()
            } else {
                ((c as u32) - 55).to_string()
            }
        })
        .collect();

    // Verify mod 97 == 1
    numeric.len() >= 2 && {
        let num = numeric.parse::<u128>();
        num.map(|n| n % 97 == 1).unwrap_or(false)
    }
}

/// Get all recognizers
pub fn all_recognizers() -> Vec<Recognizer> {
    vec![
        // API keys — highest priority, most specific patterns first
        Recognizer {
            pii_type: PiiType::ApiKey,
            regex: API_KEY_RE.clone(),
            confidence: 0.95,
            validator: None,
        },
        // Email
        Recognizer {
            pii_type: PiiType::Email,
            regex: EMAIL_RE.clone(),
            confidence: 0.90,
            validator: None,
        },
        // SSN (before phone to avoid partial overlap)
        Recognizer {
            pii_type: PiiType::Ssn,
            regex: SSN_RE.clone(),
            confidence: 0.85,
            validator: None,
        },
        // Credit card (with Luhn validation)
        Recognizer {
            pii_type: PiiType::CreditCard,
            regex: CREDIT_CARD_RE.clone(),
            confidence: 0.80,
            validator: Some(luhn_check),
        },
        // IBAN (with checksum validation)
        Recognizer {
            pii_type: PiiType::Iban,
            regex: IBAN_RE.clone(),
            confidence: 0.85,
            validator: Some(iban_check),
        },
        // IP address
        Recognizer {
            pii_type: PiiType::IpAddress,
            regex: IP_RE.clone(),
            confidence: 0.90,
            validator: None,
        },
        // Phone numbers
        Recognizer {
            pii_type: PiiType::PhoneNumber,
            regex: PHONE_RE.clone(),
            confidence: 0.70,
            validator: None,
        },
        // Domain (lower confidence — lots of false positives in code)
        Recognizer {
            pii_type: PiiType::Domain,
            regex: DOMAIN_RE.clone(),
            confidence: 0.50,
            validator: None,
        },
        // Dates
        Recognizer {
            pii_type: PiiType::Date,
            regex: DATE_RE.clone(),
            confidence: 0.60,
            validator: None,
        },
        // ZIP codes — moderate-high confidence for standalone 5-digit numbers.
        // Higher than Date (0.60) so ZIP wins overlap resolution when both
        // Presidio and regex match the same text.
        Recognizer {
            pii_type: PiiType::ZipCode,
            regex: ZIP_RE.clone(),
            confidence: 0.65,
            validator: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_email() {
        let recognizers = all_recognizers();
        let r = recognizers
            .iter()
            .find(|r| r.pii_type == PiiType::Email)
            .unwrap();
        let text = "Contact john.doe@example.com for details";
        let m = r.regex.find(text);
        assert!(m.is_some());
        assert_eq!(m.unwrap().as_str(), "john.doe@example.com");
    }

    #[test]
    fn test_detect_api_key() {
        let recognizers = all_recognizers();
        let r = recognizers
            .iter()
            .find(|r| r.pii_type == PiiType::ApiKey)
            .unwrap();
        let text = "sk-proj-abc123def456ghi789jkl012mno345pqr678";
        let m = r.regex.find(text);
        assert!(m.is_some());
    }

    #[test]
    fn test_detect_ssn() {
        let recognizers = all_recognizers();
        let r = recognizers
            .iter()
            .find(|r| r.pii_type == PiiType::Ssn)
            .unwrap();
        let text = "SSN: 123-45-6789";
        let m = r.regex.find(text);
        assert!(m.is_some());
        assert_eq!(m.unwrap().as_str(), "123-45-6789");
    }

    #[test]
    fn test_detect_ip() {
        let recognizers = all_recognizers();
        let r = recognizers
            .iter()
            .find(|r| r.pii_type == PiiType::IpAddress)
            .unwrap();
        let text = "Server at 192.168.1.100 responded";
        let m = r.regex.find(text);
        assert!(m.is_some());
        assert_eq!(m.unwrap().as_str(), "192.168.1.100");
    }

    #[test]
    fn test_luhn_valid_card() {
        assert!(luhn_check("4532015112830366")); // Valid Visa test number
    }

    #[test]
    fn test_luhn_invalid_card() {
        assert!(!luhn_check("4532015112830367")); // Invalid — last digit wrong
    }

    #[test]
    fn test_detect_phone() {
        let recognizers = all_recognizers();
        let r = recognizers
            .iter()
            .find(|r| r.pii_type == PiiType::PhoneNumber)
            .unwrap();
        let text = "Call me at (555) 123-4567";
        let m = r.regex.find(text);
        assert!(m.is_some());
    }

    #[test]
    fn test_display_person_location_organization() {
        // PiiType::Display now emits UPPER_SNAKE_CASE to match the benchmark
        // scoring namespace (gold annotations use PRESIDIO-style uppercase).
        assert_eq!(PiiType::Person.to_string(), "PERSON");
        assert_eq!(PiiType::Location.to_string(), "LOCATION");
        assert_eq!(PiiType::Organization.to_string(), "ORGANIZATION");
    }

    #[test]
    fn test_display_fine_grained_types() {
        assert_eq!(PiiType::City.to_string(), "CITY");
        assert_eq!(PiiType::UsState.to_string(), "US_STATE");
        assert_eq!(PiiType::StreetAddress.to_string(), "STREET_ADDRESS");
        assert_eq!(PiiType::Country.to_string(), "COUNTRY");
        assert_eq!(PiiType::Age.to_string(), "AGE");
        assert_eq!(PiiType::Title.to_string(), "TITLE");
        assert_eq!(PiiType::SwiftCode.to_string(), "SWIFT_CODE");
        assert_eq!(PiiType::UsBankNumber.to_string(), "US_BANK_NUMBER");
        assert_eq!(PiiType::UsPassport.to_string(), "US_PASSPORT");
        assert_eq!(PiiType::UsDriverLicense.to_string(), "US_DRIVER_LICENSE");
        assert_eq!(PiiType::MedicalRecord.to_string(), "MEDICAL_RECORD");
        assert_eq!(PiiType::Nationality.to_string(), "NATIONALITY");
    }

    #[test]
    fn test_from_str_bidirectional() {
        // Both display names and uppercase Presidio names should parse correctly
        assert_eq!(PiiType::from_str("PERSON"), PiiType::Person);
        assert_eq!(PiiType::from_str("Person"), PiiType::Person);
        assert_eq!(PiiType::from_str("CITY"), PiiType::City);
        assert_eq!(PiiType::from_str("City"), PiiType::City);
        assert_eq!(PiiType::from_str("US_SSN"), PiiType::Ssn);
        assert_eq!(PiiType::from_str("SSN"), PiiType::Ssn);
        assert_eq!(PiiType::from_str("SWIFT_CODE"), PiiType::SwiftCode);
        assert_eq!(PiiType::from_str("US_ZIP_CODE"), PiiType::ZipCode);
        assert_eq!(PiiType::from_str("EMAIL_ADDRESS"), PiiType::Email);
        // Unknown types become Custom so no information is lost
        let custom = PiiType::from_str("MY_CUSTOM_TYPE");
        if let PiiType::Custom(s) = custom {
            assert_eq!(s, "MY_CUSTOM_TYPE");
        } else {
            panic!("Expected Custom variant, got {:?}", custom);
        }
    }
}
