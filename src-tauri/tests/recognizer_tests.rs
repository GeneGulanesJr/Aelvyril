#[cfg(test)]
mod recognizer_tests {
    use super::*;
    use crate::pii::recognizers::{all_recognizers, PiiType};

    #[test]
    fn test_email_regex() {
        let recognizers = all_recognizers();
        let r = recognizers.iter().find(|r| r.pii_type == PiiType::Email).unwrap();
        let text = "Contact me at test@example.com for details";
        let mat = r.regex.find(text).expect("Email regex should match");
        assert_eq!(mat.as_str(), "test@example.com");
    }

    #[test]
    fn test_phone_regex() {
        let recognizers = all_recognizers();
        let r = recognizers.iter().find(|r| r.pii_type == PiiType::PhoneNumber).unwrap();
        let text = "Call me at (555) 123-4567";
        let mat = r.regex.find(text).expect("Phone regex should match");
        assert!(mat.as_str().contains('5'));
    }

    #[test]
    fn test_zip_regex() {
        let recognizers = all_recognizers();
        let r = recognizers.iter().find(|r| r.pii_type == PiiType::ZipCode).unwrap();
        let text = "Shipping to 12345 and also 90210";
        let mut matches: Vec<_> = r.regex.find_iter(text).map(|m| m.as_str()).collect();
        assert!(matches.contains(&"12345"), "Should match 12345");
        assert!(matches.contains(&"90210"), "Should match 90210");
    }

    #[test]
    fn test_detect_custom_recognizers_email() {
        let engine = crate::pii::engine::PiiEngine::with_presidio("http://localhost:9999".into(), false);
        let matches = engine.detect("Email: alice@example.com").await;
        assert!(!matches.is_empty(), "Should detect email");
        assert!(matches.iter().any(|m| m.pii_type == PiiType::Email));
    }
}
