#[cfg(test)]
mod recognizer_tests {
    use aelvyril_lib::pii::recognizers::{all_recognizers, PiiType};

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
        // Tightened: ZIP now requires a "zip"/"postal" context prefix.
        let text = "ZIP code 12345 and postal 90210-1234";
        let matches: Vec<_> = r.regex.find_iter(text).map(|m| m.as_str()).collect();
        assert!(matches.iter().any(|m| m.contains("12345")), "Should match zip 12345");
        assert!(matches.iter().any(|m| m.contains("90210")), "Should match postal 90210");
    }

    #[test]
    fn test_zip_regex_no_bare_digits() {
        let recognizers = all_recognizers();
        let r = recognizers.iter().find(|r| r.pii_type == PiiType::ZipCode).unwrap();
        // Regression: bare 5-digit runs must NOT match (e.g. case numbers).
        assert!(r.regex.find("The case number is 23-CV-09876").is_none());
        assert!(r.regex.find("Shipping to 12345").is_none());
    }

    #[test]
    fn test_ssn_tightened_no_bare_digits() {
        let recognizers = all_recognizers();
        let r = recognizers.iter().find(|r| r.pii_type == PiiType::Ssn).unwrap();
        // Hyphenated form still matches
        assert!(r.regex.find("SSN: 123-45-6789").is_some());
        // Regression: bare 9-digit run must NOT match.
        assert!(r.regex.find("The national ID number is 890123456").is_none());
    }

    #[test]
    fn test_phone_tightened_no_bare_alnum() {
        let recognizers = all_recognizers();
        let r = recognizers
            .iter()
            .find(|r| r.pii_type == PiiType::PhoneNumber)
            .unwrap();
        // Real phone numbers still match
        assert!(r.regex.find("Call (555) 123-4567").is_some());
        assert!(r.regex.find("Call 555-123-4567").is_some());
        // Regression: bare alnum runs must NOT match.
        assert!(r.regex.find("Her passport number is AB1234567").is_none());
        assert!(r.regex.find("Her driver's license number is D12345678").is_none());
        assert!(r.regex.find("Meet at coordinates 37.7749, -122.4194").is_none());
        assert!(r.regex.find("bare run 12345678").is_none());
    }

    #[tokio::test]
    async fn test_detect_custom_recognizers_email() {
        let engine = aelvyril_lib::pii::engine::PiiEngine::with_presidio("http://localhost:9999".into(), false);
        let matches = engine.detect("Email: alice@example.com").await;
        assert!(!matches.is_empty(), "Should detect email");
        assert!(matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    // ── Helper: find a recognizer by type ──────────────────────────────────
    fn find(t: PiiType) -> aelvyril_lib::pii::recognizers::Recognizer {
        let recognizers = all_recognizers();
        recognizers.into_iter().find(|r| r.pii_type == t).unwrap()
    }

    // ── Positive cases for new recognizers ─────────────────────────────────

    #[test]
    fn test_tax_id() {
        let r = find(PiiType::IdentityTaxId);
        assert!(r.regex.find("His EIN is 12-3456789").is_some());
        assert!(r.regex.find("no tax here").is_none());
    }

    #[test]
    fn test_financial_amount() {
        let r = find(PiiType::FinancialAmount);
        assert!(r.regex.find("The total was $1,299.99").is_some());
        assert!(r.regex.find("Price $9.99 today").is_some());
        assert!(r.regex.find("100.00 USD").is_some());
    }

    #[test]
    fn test_crypto_wallet() {
        let r = find(PiiType::FinancialCryptoWallet);
        assert!(
            r.regex
                .find(&("bc1qxy2kgdygjrsqtzq2n0yr".to_string() + "f2493p83kkfjhx0wlh"))
                .is_some()
        );
    }

    #[test]
    fn test_jwt() {
        let r = find(PiiType::CredentialJwt);
        assert!(
            r.regex
                .find(&("Token: ".to_string() + "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"))
                .is_some()
        );
    }

    #[test]
    fn test_private_key() {
        let r = find(PiiType::CredentialPrivateKey);
        assert!(
            r.regex
                .find(&("-----BEGIN RSA ".to_string() + "PRIVATE KEY-----"))
                .is_some()
        );
        assert!(r.regex.find("no key here").is_none());
    }

    #[test]
    fn test_password() {
        let r = find(PiiType::CredentialPassword);
        assert!(r.regex.find(&("The account password is ".to_string() + "Tr0ub4dor" + "&3")).is_some());
        assert!(r.regex.find(&("password: ".to_string() + "hunt" + "er2")).is_some());
    }

    #[test]
    fn test_connection_string() {
        let r = find(PiiType::CredentialConnectionString);
        assert!(
            r.regex
                .find("Server=db;Database=app;User=admin;")
                .is_some()
        );
    }

    #[test]
    fn test_login_credentials() {
        let r = find(PiiType::DeveloperLoginCredentials);
        assert!(
            r.regex
                .find("username=admin password=secret")
                .is_some()
        );
    }

    #[test]
    fn test_login_credentials_colon_form() {
        let r = find(PiiType::DeveloperLoginCredentials);
        assert!(
            r.regex
                .find("login: example-user / password: example-pass")
                .is_some()
        );
    }

    #[test]
    fn test_mac_address() {
        let r = find(PiiType::DeviceMacAddress);
        // Colon form (E2E corpus sample).
        assert!(
            r.regex
                .find("The device MAC address is 00:1A:2B:3C:4D:5E.")
                .is_some()
        );
        // Hyphen form.
        assert!(r.regex.find("00-1A-2B-3C-4D-5E").is_some());
        // Bare 12-hex run without separators must NOT match.
        assert!(r.regex.find("001A2B3C4D5E").is_none());
    }

    #[test]
    fn test_imei() {
        let r = find(PiiType::DeviceImei);
        assert!(r.regex.find("The phone IMEI is 356789012345678").is_some());
    }

    #[test]
    fn test_device_id() {
        let r = find(PiiType::DeveloperDeviceId);
        assert!(r.regex.find("device_id: ABCD1234efgh").is_some());
    }

    #[test]
    fn test_health_plan_id() {
        let r = find(PiiType::HealthcareHealthPlanId);
        assert!(r.regex.find("member id: ABC123456").is_some());
    }

    #[test]
    fn test_passport() {
        let r = find(PiiType::IdentityPassport);
        assert!(r.regex.find("passport number AB1234567").is_some());
    }

    #[test]
    fn test_national_id() {
        let r = find(PiiType::IdentityNationalId);
        assert!(r.regex.find("national id: AB12345").is_some());
    }

    #[test]
    fn test_drivers_license() {
        let r = find(PiiType::IdentityDriversLicense);
        assert!(r.regex.find("driver's license D12345678").is_some());
    }

    #[test]
    fn test_medical_record() {
        let r = find(PiiType::HealthcareMedicalRecord);
        assert!(r.regex.find("MRN: 1234567").is_some());
    }

    #[test]
    fn test_bank_account() {
        let r = find(PiiType::FinancialBankAccount);
        assert!(r.regex.find("account number 123456789").is_some());
    }

    #[test]
    fn test_case_number() {
        let r = find(PiiType::LegalCaseNumber);
        assert!(r.regex.find("23-12345 docket").is_some());
    }

    #[test]
    fn test_gps() {
        let r = find(PiiType::LocationGpsCoordinates);
        assert!(r.regex.find("Meet at coordinates 37.7749, -122.4194").is_some());
    }

    #[test]
    fn test_username() {
        let r = find(PiiType::OnlineUsername);
        assert!(r.regex.find("handle @alice_dev").is_some());
        assert!(r.regex.find("username: alice_99").is_some());
    }

    #[test]
    fn test_url() {
        let r = find(PiiType::OnlineUrl);
        assert!(r.regex.find("visit https://example.com/path").is_some());
        assert!(r.regex.find("no url").is_none());
    }

    // ── Sensitive / semantic ────────────────────────────────────────────────

    #[test]
    fn test_religion() {
        let r = find(PiiType::SpecialReligion);
        assert!(r.regex.find("She is a practicing Catholic").is_some());
        assert!(r.regex.find("He is Muslim").is_some());
    }

    #[test]
    fn test_political() {
        let r = find(PiiType::SpecialPolitical);
        assert!(r.regex.find("a member of the Democratic Party").is_some());
    }

    #[test]
    fn test_orientation() {
        let r = find(PiiType::SpecialOrientation);
        assert!(r.regex.find("she identifies as bisexual").is_some());
    }

    #[test]
    fn test_health_status() {
        let r = find(PiiType::SpecialHealthStatus);
        assert!(r.regex.find("patient is HIV+").is_some());
    }

    #[test]
    fn test_condition() {
        let r = find(PiiType::HealthcareCondition);
        assert!(r.regex.find("diagnosed with type 2 diabetes").is_some());
        assert!(r.regex.find("has hypertension").is_some());
    }

    #[test]
    fn test_medication() {
        let r = find(PiiType::HealthcareMedication);
        assert!(r.regex.find("takes 10 mg of Lipitor").is_some());
        assert!(r.regex.find("prescribed metformin").is_some());
    }

    // ── End-to-end regression negatives via the engine ─────────────────────

    #[tokio::test]
    async fn test_regression_no_ssn_on_bare_national_id() {
        let engine = aelvyril_lib::pii::engine::PiiEngine::with_presidio(
            "http://localhost:9999".into(),
            false,
        );
        let matches = engine.detect("The national ID number is 890123456").await;
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::Ssn));
    }

    #[tokio::test]
    async fn test_regression_no_phone_on_passport() {
        let engine = aelvyril_lib::pii::engine::PiiEngine::with_presidio(
            "http://localhost:9999".into(),
            false,
        );
        let matches = engine.detect("Her passport number is AB1234567").await;
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::PhoneNumber));
    }

    #[tokio::test]
    async fn test_regression_no_phone_on_license() {
        let engine = aelvyril_lib::pii::engine::PiiEngine::with_presidio(
            "http://localhost:9999".into(),
            false,
        );
        let matches = engine.detect("Her driver's license number is D12345678").await;
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::PhoneNumber));
    }

    #[tokio::test]
    async fn test_regression_gps_not_phone() {
        let engine = aelvyril_lib::pii::engine::PiiEngine::with_presidio(
            "http://localhost:9999".into(),
            false,
        );
        let matches = engine.detect("Meet at coordinates 37.7749, -122.4194").await;
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::PhoneNumber));
        assert!(
            matches.iter().any(|m| m.pii_type == PiiType::LocationGpsCoordinates),
            "Should be GPS"
        );
    }

    #[tokio::test]
    async fn test_regression_case_number_not_zip() {
        let engine = aelvyril_lib::pii::engine::PiiEngine::with_presidio(
            "http://localhost:9999".into(),
            false,
        );
        let matches = engine.detect("The court case number is 23-CV-09876").await;
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::ZipCode));
        assert!(
            matches.iter().any(|m| m.pii_type == PiiType::LegalCaseNumber),
            "Should be a case number"
        );
    }
}
