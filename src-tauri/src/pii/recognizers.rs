use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fmt;

/// Type of PII entity detected
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
}

impl fmt::Display for PiiType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PiiType::Email => write!(f, "Email"),
            PiiType::PhoneNumber => write!(f, "Phone"),
            PiiType::IpAddress => write!(f, "IP_Address"),
            PiiType::CreditCard => write!(f, "Credit_Card"),
            PiiType::Ssn => write!(f, "SSN"),
            PiiType::Iban => write!(f, "IBAN"),
            PiiType::ApiKey => write!(f, "API_Key"),
            PiiType::Domain => write!(f, "Domain"),
            PiiType::Date => write!(f, "Date"),
            PiiType::ZipCode => write!(f, "Zip_Code"),
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

static EMAIL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
    ).unwrap()
});

static PHONE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}"
    ).unwrap()
});

static IP_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b"
    ).unwrap()
});

static CREDIT_CARD_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"\b(?:\d[ -]*?){13,19}\b"
    ).unwrap()
});

static SSN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"\b\d{3}[- ]?\d{2}[- ]?\d{4}\b"
    ).unwrap()
});

static IBAN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"\b[A-Z]{2}\d{2}[A-Z0-9]{4}[A-Z0-9]{0,30}\b"
    ).unwrap()
});

static API_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)\b(?:sk|sk-proj|sk-ant|sk-)[A-Za-z0-9_\-]{20,}\b"#
    ).unwrap()
});

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

static ZIP_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"\b\d{5}(?:[-\s]\d{4})?\b"
    ).unwrap()
});

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
                if doubled > 9 { doubled - 9 } else { doubled }
            } else {
                d
            }
        })
        .sum();

    sum % 10 == 0
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
        // ZIP codes
        Recognizer {
            pii_type: PiiType::ZipCode,
            regex: ZIP_RE.clone(),
            confidence: 0.40,
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
        let r = recognizers.iter().find(|r| r.pii_type == PiiType::Email).unwrap();
        let text = "Contact john.doe@example.com for details";
        let m = r.regex.find(text);
        assert!(m.is_some());
        assert_eq!(m.unwrap().as_str(), "john.doe@example.com");
    }

    #[test]
    fn test_detect_api_key() {
        let recognizers = all_recognizers();
        let r = recognizers.iter().find(|r| r.pii_type == PiiType::ApiKey).unwrap();
        let text = "sk-proj-abc123def456ghi789jkl012mno345pqr678";
        let m = r.regex.find(text);
        assert!(m.is_some());
    }

    #[test]
    fn test_detect_ssn() {
        let recognizers = all_recognizers();
        let r = recognizers.iter().find(|r| r.pii_type == PiiType::Ssn).unwrap();
        let text = "SSN: 123-45-6789";
        let m = r.regex.find(text);
        assert!(m.is_some());
        assert_eq!(m.unwrap().as_str(), "123-45-6789");
    }

    #[test]
    fn test_detect_ip() {
        let recognizers = all_recognizers();
        let r = recognizers.iter().find(|r| r.pii_type == PiiType::IpAddress).unwrap();
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
        let r = recognizers.iter().find(|r| r.pii_type == PiiType::PhoneNumber).unwrap();
        let text = "Call me at (555) 123-4567";
        let m = r.regex.find(text);
        assert!(m.is_some());
    }
}
